import { QUANTUM } from '../net/packet';
import receiverUrl from './receiver.worklet.ts?worker&url';
import { RECV_RING, Ring, SEND_RING, createRingBuffer } from './ring';
import senderUrl from './sender.worklet.ts?worker&url';

export interface RecvStats {
  received: number;
  played: number;
  plc: number;
  late: number;
  skips: number;
  inserts: number;
  depth: number;
  delay: number;
  minDepth: number;
  margin: number;
  maxDepth: number;
  playing: boolean;
  rms: number;
  peak: number;
}

export interface InputOptions {
  deviceId?: string;
}

/**
 * Owns the AudioContext and the audio graph:
 *
 *   mic ─► inputGain ─┬─► jam-sender (worklet) ─► main thread ─► DataChannel
 *                     ├─► inputAnalyser (meter)
 *                     └─► monitorGain ─────────────┐
 *   DataChannel ─► jam-receiver (worklet) ─► remoteGain ─┴─► destination
 *                                          └► outAnalyser
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly shared: boolean;
  readonly inputGain: GainNode;
  readonly inputAnalyser: AnalyserNode;
  readonly monitorGain: GainNode;
  readonly remoteGain: GainNode;
  readonly outAnalyser: AnalyserNode;
  /** Mix bus for locally generated sounds (metronome, test clicks). */
  readonly localBus: GainNode;
  sender!: AudioWorkletNode;
  receiver!: AudioWorkletNode;
  stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private compatDest: MediaStreamAudioDestinationNode | null = null;
  private sendRing: Ring | null = null;
  private recvRing: Ring | null = null;
  private readonly sendHdr = new Float64Array(1);
  private readonly sendBuf = new Float32Array(QUANTUM);
  private readonly recvHdr = [0];

  /** Hot path: called once per captured 128-frame quantum. `samples` is reused. */
  onQuantum: ((sampleTime: number, samples: Float32Array) => void) | null = null;
  onRecvStats: ((s: RecvStats) => void) | null = null;
  onSenderOnset: ((frame: number) => void) | null = null;
  onReceiverOnset: ((frame: number) => void) | null = null;
  recvDropped = 0;

  private constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // `?noshared` forces the postMessage fallback (diagnostics/tests).
    const forceMessages = typeof location !== 'undefined' && /[?&]noshared\b/.test(location.search);
    this.shared = !forceMessages && typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
    this.inputGain = ctx.createGain();
    this.inputAnalyser = ctx.createAnalyser();
    this.inputAnalyser.fftSize = 512;
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;
    this.remoteGain = ctx.createGain();
    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.localBus = ctx.createGain();
    this.inputGain.connect(this.inputAnalyser);
    this.inputGain.connect(this.monitorGain).connect(ctx.destination);
    this.remoteGain.connect(ctx.destination);
    this.remoteGain.connect(this.outAnalyser);
    this.localBus.connect(ctx.destination);
  }

  static supported(): boolean {
    return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
  }

  static async create(): Promise<AudioEngine> {
    let ctx: AudioContext;
    try {
      // latencyHint 0 asks for the smallest output buffer the device allows.
      ctx = new AudioContext({ latencyHint: 0, sampleRate: 48000 });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    }
    const e = new AudioEngine(ctx);
    await e.init();
    return e;
  }

  private async init(): Promise<void> {
    const { ctx } = this;
    await ctx.audioWorklet.addModule(senderUrl);
    await ctx.audioWorklet.addModule(receiverUrl);

    const sendBuf = this.shared ? createRingBuffer(SEND_RING, true) : null;
    const recvBuf = this.shared ? createRingBuffer(RECV_RING, true) : null;
    this.sendRing = sendBuf ? new Ring(sendBuf, SEND_RING) : null;
    this.recvRing = recvBuf ? new Ring(recvBuf, RECV_RING) : null;

    this.sender = new AudioWorkletNode(ctx, 'jam-sender', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { ring: sendBuf ?? undefined },
    });
    this.receiver = new AudioWorkletNode(ctx, 'jam-receiver', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ring: recvBuf ?? undefined, margin: 'auto', maxDepth: 12 },
    });
    this.inputGain.connect(this.sender);
    this.receiver.connect(this.remoteGain);

    this.sender.port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d === 0) {
        const ring = this.sendRing!;
        while (ring.read(this.sendHdr, this.sendBuf)) this.onQuantum?.(this.sendHdr[0]!, this.sendBuf);
      } else if (d.q) {
        this.onQuantum?.(d.t, d.q);
      } else if (d.type === 'onset') {
        this.onSenderOnset?.(d.frame);
      }
    };
    this.receiver.port.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === 'stats') this.onRecvStats?.(d as RecvStats);
      else if (d.type === 'onset') this.onReceiverOnset?.(d.frame);
    };
  }

  /** Feeds one decoded quantum to the playout worklet. */
  receive(seq: number, samples: Float32Array): void {
    if (this.recvRing) {
      this.recvHdr[0] = seq;
      if (!this.recvRing.write(this.recvHdr, samples)) this.recvDropped++;
    } else {
      const q = samples.slice(0, QUANTUM);
      this.receiver.port.postMessage({ type: 'packet', seq, q }, [q.buffer]);
    }
  }

  configureJitter(c: { margin?: number | 'auto'; maxDepth?: number }): void {
    this.receiver.port.postMessage({ type: 'config', ...c });
  }

  detectOnsets(where: 'sender' | 'receiver', on: boolean, threshold = 0.2): void {
    (where === 'sender' ? this.sender : this.receiver).port.postMessage({ type: 'detect', on, threshold });
  }

  async setInput(opts: InputOptions = {}): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
        // Any of these would add latency and mangle a guitar tone.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        // Chrome-specific hint for the smallest capture buffer.
        latency: { ideal: 0 },
      } as MediaTrackConstraints,
    });
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.inputGain);
    return stream;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setInputGain(v: number): void {
    this.inputGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setMonitor(on: boolean): void {
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  setRemoteVolume(v: number): void {
    this.remoteGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  canSetSink(): boolean {
    return 'setSinkId' in AudioContext.prototype;
  }

  async setSink(id: string): Promise<void> {
    const c = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (c.setSinkId) await c.setSinkId(id);
  }

  /** Browser-reported output path latency in ms (render buffer + device). */
  outputLatencyMs(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return ((c.baseLatency ?? 0) + (c.outputLatency ?? 0)) * 1000;
  }

  /** Converts a performance.now() time to the AudioContext time audible at that moment. */
  perfToCtxTime(perfMs: number): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    return this.ctx.currentTime + (perfMs - performance.now()) / 1000 + this.outputLatencyMs() / 1000;
  }

  levels(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): { peak: number; rms: number } {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    return { peak, rms: Math.sqrt(sum / buf.length) };
  }

  /** Track for compatibility mode (standard WebRTC media path). */
  compatTrack(): MediaStreamTrack {
    if (!this.compatDest) {
      this.compatDest = this.ctx.createMediaStreamDestination();
      this.compatDest.channelCount = 1;
      this.inputGain.connect(this.compatDest);
    }
    return this.compatDest.stream.getAudioTracks()[0]!;
  }

  playRemoteStream(stream: MediaStream): () => void {
    // Chrome only pulls remote WebRTC audio into Web Audio if an element is attached.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    void el.play().catch(() => {});
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(this.remoteGain);
    return () => {
      src.disconnect();
      el.srcObject = null;
    };
  }

  async close(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
  }
}
