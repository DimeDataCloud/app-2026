import { minimizeJitterBuffer, mungeOpusSdp } from './audio/fallback';
import type { ServerMsg, Signaling } from './signaling';

export interface ConnInfo {
  rttMs: number | null;
  relay: boolean;
  localType: string;
  remoteType: string;
  protocol: string;
}

const DEFAULT_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

let iceCache: Promise<RTCIceServer[]> | null = null;

/** STUN by default; the Worker adds Cloudflare TURN credentials when configured. */
export function fetchIceServers(): Promise<RTCIceServer[]> {
  iceCache ??= fetch('/turn')
    .then((r) => (r.ok ? r.json() : { iceServers: DEFAULT_ICE }))
    .then((b: { iceServers: RTCIceServer[] }) => b.iceServers)
    .catch(() => DEFAULT_ICE);
  return iceCache;
}

/**
 * One RTCPeerConnection with no media tracks by default, just two
 * pre-negotiated DataChannels:
 *   audio (id 0): unordered, no retransmits — UDP-like, for PCM packets
 *   ctrl  (id 1): reliable, ordered — JSON control messages
 * The impolite peer (already in the room) makes the first offer; the polite
 * newcomer only answers, so the initial handshake never glares. Later
 * renegotiation (compatibility mode adds a media track) may start from either
 * side and follows the "perfect negotiation" pattern.
 */
export class Peer {
  readonly pc: RTCPeerConnection;
  audio: RTCDataChannel | null = null;
  ctrl: RTCDataChannel | null = null;
  /** Fires once the DataChannels exist (immediately for the initiator). */
  onChannels: ((audio: RTCDataChannel, ctrl: RTCDataChannel) => void) | null = null;
  onCtrl: ((m: Record<string, unknown>) => void) | null = null;
  onAudio: ((data: ArrayBuffer) => void) | null = null;
  onState: ((s: RTCPeerConnectionState) => void) | null = null;
  onTrack: ((stream: MediaStream) => void) | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private compatSender: RTCRtpSender | null = null;
  /** Diagnostics sink for negotiation events. */
  log: (line: string) => void = () => {};

  constructor(
    private readonly sig: Signaling,
    readonly polite: boolean,
    iceServers: RTCIceServer[],
  ) {
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });

    this.pc.onicecandidate = ({ candidate }) => this.sig.send({ type: 'ice', candidate });
    this.pc.onconnectionstatechange = () => {
      this.onState?.(this.pc.connectionState);
      if (this.pc.connectionState === 'failed') this.pc.restartIce();
    };
    this.pc.ontrack = (e) => {
      minimizeJitterBuffer(e.receiver);
      this.onTrack?.(e.streams[0] ?? new MediaStream([e.track]));
    };
    this.pc.onnegotiationneeded = async () => {
      this.log(`negotiationneeded ${this.pc.signalingState}`);
      try {
        this.makingOffer = true;
        const offer = await this.pc.createOffer();
        if (this.pc.signalingState !== 'stable') {
          this.log(`offer abandoned (${this.pc.signalingState})`);
          return;
        }
        offer.sdp = mungeOpusSdp(offer.sdp ?? '');
        await this.pc.setLocalDescription(offer);
        this.log('sent offer');
        this.sig.send({ type: 'sdp', description: this.pc.localDescription });
      } catch (err) {
        console.warn('negotiation', err);
      } finally {
        this.makingOffer = false;
      }
    };
  }

  async handleSignal(m: ServerMsg): Promise<void> {
    if (m.type === 'sdp') {
      const d = m.description;
      const collision = d.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      this.log(`got ${d.type} state=${this.pc.signalingState} making=${this.makingOffer} ignore=${this.ignoreOffer}`);
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(d);
      // The responder adds its pre-negotiated channels only once the offer's
      // SCTP section exists, so doing so doesn't trigger a competing offer.
      if (!this.audio) this.createChannels();
      if (d.type === 'offer') {
        const answer = await this.pc.createAnswer();
        answer.sdp = mungeOpusSdp(answer.sdp ?? '');
        await this.pc.setLocalDescription(answer);
        this.sig.send({ type: 'sdp', description: this.pc.localDescription });
      }
    } else if (m.type === 'ice') {
      try {
        await this.pc.addIceCandidate(m.candidate ?? undefined);
      } catch (err) {
        if (!this.ignoreOffer) console.warn('ice', err);
      }
    }
  }

  /** The initiator (the peer already in the room) creates the channels and makes the first offer. */
  start(): void {
    if (!this.audio) this.createChannels();
  }

  private createChannels(): void {
    const audio = this.pc.createDataChannel('audio', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const ctrl = this.pc.createDataChannel('ctrl', { negotiated: true, id: 1, ordered: true });
    audio.binaryType = 'arraybuffer';
    audio.onmessage = (e) => this.onAudio?.(e.data as ArrayBuffer);
    ctrl.onmessage = (e) => {
      try {
        this.onCtrl?.(JSON.parse(e.data as string));
      } catch {
        /* ignore malformed */
      }
    };
    this.audio = audio;
    this.ctrl = ctrl;
    this.onChannels?.(audio, ctrl);
  }

  sendCtrl(m: Record<string, unknown>): void {
    if (this.ctrl?.readyState === 'open') this.ctrl.send(JSON.stringify(m));
  }

  /** Compatibility mode: send a standard Opus media track (triggers renegotiation). */
  setCompatTrack(track: MediaStreamTrack | null): void {
    if (track && !this.compatSender) {
      this.compatSender = this.pc.addTrack(track, new MediaStream([track]));
    } else if (!track && this.compatSender) {
      this.pc.removeTrack(this.compatSender);
      this.compatSender = null;
    }
  }

  async connInfo(): Promise<ConnInfo> {
    const stats = await this.pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
    }
    const local = pair ? stats.get(pair.localCandidateId) : undefined;
    const remote = pair ? stats.get(pair.remoteCandidateId) : undefined;
    return {
      rttMs: pair?.currentRoundTripTime !== undefined ? pair.currentRoundTripTime * 1000 : null,
      relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay',
      localType: local?.candidateType ?? '?',
      remoteType: remote?.candidateType ?? '?',
      protocol: local?.protocol ?? '?',
    };
  }

  close(): void {
    this.pc.close();
  }
}
