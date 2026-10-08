import { AudioEngine, type RecvStats } from './audio/engine';
import { canDecodeOpus, opusConfig } from './audio/opus';
import { bluetoothWarning } from './devices';
import {
  BUDGET_MS,
  DEFAULT_CAPTURE_MS,
  PingTracker,
  QUANTUM_MS,
  captureFromRoundTrip,
  jitterCapQuanta,
  loadDeviceRoundTrip,
  oneWayTotal,
  type OneWayParts,
} from './latency';
import { Metronome, fromPeerClock, toPeerClock } from './metronome';
import { AudioLink, type CodecName } from './net/link';
import { Peer, fetchIceServers, type ConnInfo } from './peer';
import { Signaling, type ServerMsg } from './signaling';

export type Phase = 'idle' | 'waiting' | 'connecting' | 'connected' | 'full' | 'error';

interface PartnerInfo {
  captureMs: number;
  outputMs: number;
  jitterMs: number;
  packetMs: number;
  opus: boolean;
  measured: boolean;
}

export interface Hud {
  phase: Phase;
  signaling: string;
  dcOpen: boolean;
  rttMs: number | null;
  conn: ConnInfo | null;
  codec: CodecName;
  compat: boolean;
  recv: RecvStats | null;
  lossPct: number;
  rxRate: number;
  txRate: number;
  kbpsOut: number;
  inbound: OneWayParts & { total: number };
  outbound: (OneWayParts & { total: number }) | null;
  captureMeasured: boolean;
  outputMs: number;
  btWarning: boolean;
  guard: boolean;
  maxDepth: number;
  budgetMs: number;
}

/**
 * Wires the audio engine, signaling, peer connection and audio link together
 * and keeps the latency HUD state. UI code reads `hud` and calls methods; the
 * audio hot path never touches the DOM.
 */
export class Session {
  readonly clientId: string;
  engine: AudioEngine | null = null;
  link: AudioLink | null = null;
  metronome: Metronome | null = null;
  peer: Peer | null = null;
  sig: Signaling | null = null;
  room: string | null = null;
  phase: Phase = 'idle';
  guard = true;
  compat = false;
  jitterSetting: number | 'auto' = 'auto';
  inputLabels: string[] = [];
  onHud: ((h: Hud) => void) | null = null;
  onPhase: ((p: Phase) => void) | null = null;
  onMetronome: ((on: boolean, bpm: number) => void) | null = null;

  readonly pings = new PingTracker();
  private conn: ConnInfo | null = null;
  private recv: RecvStats | null = null;
  private prevRecv: RecvStats | null = null;
  private prevLink = { sent: 0, received: 0, bytesOut: 0 };
  private lossPct = 0;
  private rxRate = 0;
  private txRate = 0;
  private kbpsOut = 0;
  private partner: PartnerInfo | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopRemote: (() => void) | null = null;
  private compatJitterMs = 0;
  private dcWatchdog: ReturnType<typeof setTimeout> | null = null;
  private sigStatus = 'idle';
  private sigChain: Promise<void> = Promise.resolve();
  /** Recent signaling events, for diagnostics. */
  readonly trace: string[] = [];
  private log(line: string): void {
    this.trace.push(`${Math.round(performance.now())} ${line}`);
    if (this.trace.length > 60) this.trace.splice(0, this.trace.length - 60);
  }
  maxDepth = 12;

  constructor() {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem('jamlink.client');
      if (!id) sessionStorage.setItem('jamlink.client', (id = crypto.randomUUID()));
    } catch {
      /* storage unavailable */
    }
    this.clientId = id ?? crypto.randomUUID();
  }

  /** Must be called from a user gesture (creates/resumes the AudioContext). */
  async startAudio(): Promise<AudioEngine> {
    if (!this.engine) {
      this.engine = await AudioEngine.create();
      this.link = new AudioLink(this.engine);
      this.link.onPong = (t0, t1, t2) => this.pings.add(t0, t1, t2);
      this.metronome = new Metronome(this.engine);
      this.engine.onRecvStats = (s) => {
        this.recv = s;
      };
    }
    await this.engine.resume();
    return this.engine;
  }

  captureMs(): number {
    const rt = loadDeviceRoundTrip();
    return rt !== null && this.engine ? captureFromRoundTrip(rt, this.engine.outputLatencyMs()) : DEFAULT_CAPTURE_MS;
  }

  join(room: string): void {
    this.leave();
    this.room = room;
    this.setPhase('waiting');
    const sig = new Signaling(room, this.clientId);
    this.sig = sig;
    sig.onStatus = (s) => {
      this.sigStatus = s;
      if (s === 'full') this.setPhase('full');
    };
    // Handle signaling strictly in order: an offer or ICE candidate that arrives
    // while the peer is still being created must wait for it, not be dropped.
    sig.onMessage = (m) => {
      this.log(`in ${m.type}${m.type === 'sdp' ? ':' + m.description.type : ''}`);
      this.sigChain = this.sigChain.then(() => this.onSignal(m)).catch((e) => console.warn('signal', e));
    };
    void fetchIceServers();
    sig.connect();
    this.timers.push(setInterval(() => this.link?.ping(), 500));
    this.timers.push(setInterval(() => void this.tick(), 1000));
    this.timers.push(setInterval(() => this.onHud?.(this.hud()), 250));
  }

  leave(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.closePeer();
    this.sig?.close();
    this.sig = null;
    this.room = null;
    this.metronome?.stop();
    this.setPhase('idle');
  }

  private setPhase(p: Phase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.onPhase?.(p);
  }

  private async onSignal(m: ServerMsg): Promise<void> {
    switch (m.type) {
      case 'joined':
        if (m.peers > 0) await this.createPeer(m.polite);
        else this.setPhase('waiting');
        return;
      case 'peer-joined':
        await this.createPeer(false);
        return;
      case 'peer-left':
        this.closePeer();
        this.setPhase('waiting');
        return;
      case 'sdp':
      case 'ice':
        await this.peer?.handleSignal(m);
        return;
    }
  }

  private async createPeer(polite: boolean): Promise<void> {
    this.closePeer();
    this.setPhase('connecting');
    const ice = await fetchIceServers();
    if (!this.sig) return;
    const peer = new Peer(this.sig, polite, ice);
    peer.log = (l) => this.log(l);
    this.log(`peer created polite=${polite}`);
    this.peer = peer;
    this.pings.reset();
    peer.onAudio = (d) => this.link?.handle(d);
    peer.onCtrl = (msg) => this.onCtrl(msg);
    peer.onTrack = (stream) => {
      this.stopRemote?.();
      this.stopRemote = this.engine?.playRemoteStream(stream) ?? null;
    };
    peer.onState = (s) => {
      if (s === 'connected') {
        this.setPhase('connected');
        // If the DataChannel can't open (rare middleboxes), fall back to a media track.
        this.dcWatchdog = setTimeout(() => {
          if (peer === this.peer && peer.audio?.readyState !== 'open') this.setCompat(true);
        }, 6000);
      } else if (s === 'failed' || s === 'disconnected') {
        this.setPhase('connecting');
      }
    };
    peer.onChannels = (audio, ctrl) => {
      audio.onopen = () => this.link?.attach(audio);
      audio.onclose = () => this.link?.attach(null);
      ctrl.onopen = () => void this.sendHello();
    };
    if (!polite) peer.start();
    if (this.compat) peer.setCompatTrack(this.engine!.compatTrack());
  }

  private closePeer(): void {
    if (this.dcWatchdog) clearTimeout(this.dcWatchdog);
    this.stopRemote?.();
    this.stopRemote = null;
    this.link?.attach(null);
    this.peer?.close();
    this.peer = null;
    this.partner = null;
    this.conn = null;
  }

  private async sendHello(): Promise<void> {
    this.peer?.sendCtrl({ t: 'hello', opus: await canDecodeOpus(), ...this.localInfo() });
  }

  private localInfo() {
    return {
      captureMs: this.captureMs(),
      captureMeasured: loadDeviceRoundTrip() !== null,
      outputMs: this.engine?.outputLatencyMs() ?? 0,
      jitterMs: this.inboundJitterMs(),
      packetMs: (this.link?.quantaPerPacket ?? 1) * QUANTUM_MS,
    };
  }

  private onCtrl(m: Record<string, unknown>): void {
    switch (m.t) {
      case 'hello':
      case 'info':
        this.partner = {
          captureMs: Number(m.captureMs) || DEFAULT_CAPTURE_MS,
          outputMs: Number(m.outputMs) || 0,
          jitterMs: Number(m.jitterMs) || 0,
          packetMs: Number(m.packetMs) || QUANTUM_MS,
          opus: m.opus === undefined ? (this.partner?.opus ?? false) : m.opus === true,
          measured: m.captureMeasured === true,
        };
        if (m.t === 'hello' && m.compat === undefined && this.compat) this.peer?.sendCtrl({ t: 'compat', on: true });
        return;
      case 'compat':
        if (Boolean(m.on) !== this.compat) this.setCompat(Boolean(m.on), false);
        return;
      case 'metro': {
        const offset = this.pings.offset() ?? 0;
        if (m.on) this.metronome?.start(Number(m.bpm), fromPeerClock(Number(m.startAt), offset));
        else this.metronome?.stop();
        this.onMetronome?.(Boolean(m.on), Number(m.bpm));
        return;
      }
    }
  }

  private inboundJitterMs(): number {
    if (this.compat) return this.compatJitterMs;
    return (this.recv?.delay ?? 0) * QUANTUM_MS;
  }

  private async tick(): Promise<void> {
    const peer = this.peer;
    if (peer) {
      this.conn = await peer.connInfo().catch(() => null);
      if (this.compat) await this.updateCompatStats(peer);
      peer.sendCtrl({ t: 'info', ...this.localInfo() });
    }
    // Loss and rates over the last second.
    if (this.recv && this.prevRecv) {
      const played = this.recv.played - this.prevRecv.played;
      const plc = this.recv.plc - this.prevRecv.plc;
      this.lossPct = played + plc > 0 ? (100 * plc) / (played + plc) : 0;
    }
    this.prevRecv = this.recv;
    if (this.link) {
      const s = this.link.stats;
      this.rxRate = s.received - this.prevLink.received;
      this.txRate = s.sent - this.prevLink.sent;
      this.kbpsOut = ((s.bytesOut - this.prevLink.bytesOut) * 8) / 1000;
      this.prevLink = { sent: s.sent, received: s.received, bytesOut: s.bytesOut };
    }
    this.applyJitterCap();
  }

  private async updateCompatStats(peer: Peer): Promise<void> {
    const stats = await peer.pc.getStats();
    stats.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio' && s.jitterBufferEmittedCount) {
        this.compatJitterMs = (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000;
      }
    });
  }

  /** Keeps the receiver's jitter buffer inside what the latency budget leaves over. */
  private applyJitterCap(): void {
    if (!this.engine) return;
    const parts = this.inboundParts();
    const cap = this.guard ? jitterCapQuanta(parts) : 48;
    if (cap !== this.maxDepth) {
      this.maxDepth = cap;
      this.engine.configureJitter({ maxDepth: cap });
    }
  }

  private networkMs(): number {
    const rtt = this.pings.rtt() ?? this.conn?.rttMs ?? null;
    return rtt !== null ? rtt / 2 : 0;
  }

  private inboundParts(): Omit<OneWayParts, 'jitterMs'> {
    return {
      captureMs: this.partner?.captureMs ?? DEFAULT_CAPTURE_MS,
      packetMs: this.partner?.packetMs ?? QUANTUM_MS,
      networkMs: this.networkMs(),
      outputMs: this.engine?.outputLatencyMs() ?? 0,
    };
  }

  hud(): Hud {
    const inParts: OneWayParts = { ...this.inboundParts(), jitterMs: this.inboundJitterMs() };
    const p = this.partner;
    const outParts: OneWayParts | null = p
      ? {
          captureMs: this.captureMs(),
          packetMs: (this.link?.quantaPerPacket ?? 1) * QUANTUM_MS,
          networkMs: this.networkMs(),
          jitterMs: p.jitterMs,
          outputMs: p.outputMs,
        }
      : null;
    const outMs = this.engine?.outputLatencyMs() ?? 0;
    return {
      phase: this.phase,
      signaling: this.sigStatus,
      dcOpen: this.peer?.audio?.readyState === 'open',
      rttMs: this.pings.rtt() ?? this.conn?.rttMs ?? null,
      conn: this.conn,
      codec: this.link?.codec ?? 'pcm16',
      compat: this.compat,
      recv: this.recv,
      lossPct: this.lossPct,
      rxRate: this.rxRate,
      txRate: this.txRate,
      kbpsOut: this.kbpsOut,
      inbound: { ...inParts, total: oneWayTotal(inParts) },
      outbound: outParts ? { ...outParts, total: oneWayTotal(outParts) } : null,
      captureMeasured: loadDeviceRoundTrip() !== null,
      outputMs: outMs,
      btWarning: bluetoothWarning(this.inputLabels, outMs),
      guard: this.guard,
      maxDepth: this.maxDepth,
      budgetMs: BUDGET_MS,
    };
  }

  setGuard(on: boolean): void {
    this.guard = on;
    this.applyJitterCap();
  }

  setJitter(v: number | 'auto'): void {
    this.jitterSetting = v;
    this.engine?.configureJitter({ margin: v === 'auto' ? 'auto' : Math.max(0, v - 1) });
  }

  async setCodec(c: CodecName): Promise<void> {
    if (!this.link) return;
    if (c === 'opus') {
      const cfg = await opusConfig();
      if (!cfg || !this.partner?.opus) throw new Error('Opus is not supported on both devices');
      this.link.setCodec('opus', cfg);
    } else {
      this.link.setCodec(c);
    }
  }

  setQuantaPerPacket(n: number): void {
    this.link?.setQuantaPerPacket(n);
  }

  /** Compatibility mode: standard WebRTC Opus media track (higher latency). */
  setCompat(on: boolean, propagate = true): void {
    if (!this.engine || !this.link) return;
    this.compat = on;
    this.link.sending = !on;
    this.peer?.setCompatTrack(on ? this.engine.compatTrack() : null);
    if (!on) {
      this.stopRemote?.();
      this.stopRemote = null;
    }
    if (propagate) this.peer?.sendCtrl({ t: 'compat', on });
  }

  startMetronome(bpm: number): void {
    if (!this.metronome) return;
    const startAt = performance.now() + 600;
    this.metronome.start(bpm, startAt);
    const offset = this.pings.offset() ?? 0;
    this.peer?.sendCtrl({ t: 'metro', on: true, bpm, startAt: toPeerClock(startAt, offset) });
    this.onMetronome?.(true, bpm);
  }

  stopMetronome(): void {
    this.metronome?.stop();
    this.peer?.sendCtrl({ t: 'metro', on: false, bpm: this.metronome?.bpm ?? 0 });
    this.onMetronome?.(false, this.metronome?.bpm ?? 0);
  }
}
