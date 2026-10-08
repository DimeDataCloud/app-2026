import type { AudioEngine } from './audio/engine';

/** Converts a time on my performance clock to the peer's, given offset = peer − mine. */
export function toPeerClock(myMs: number, offset: number): number {
  return myMs + offset;
}

export function fromPeerClock(peerMs: number, offset: number): number {
  return peerMs - offset;
}

/** Index and time of the first beat at or after `nowMs` for a grid starting at `startMs`. */
export function nextBeat(startMs: number, bpm: number, nowMs: number): { index: number; at: number } {
  const period = 60000 / bpm;
  const index = Math.max(0, Math.ceil((nowMs - startMs) / period));
  return { index, at: startMs + index * period };
}

/**
 * A metronome both phones generate locally from a shared start time (sent over
 * the control channel, converted with the ping-derived clock offset). Only the
 * start time crosses the network, so the clicks don't carry network delay.
 */
export class Metronome {
  bpm = 100;
  beatsPerBar = 4;
  private startMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextIndex = 0;
  private readonly hi: AudioBuffer;
  private readonly lo: AudioBuffer;
  private readonly gain: GainNode;
  onBeat: ((index: number) => void) | null = null;

  constructor(private readonly engine: AudioEngine) {
    const { ctx } = engine;
    this.hi = Metronome.tone(ctx, 2000);
    this.lo = Metronome.tone(ctx, 1200);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.6;
    this.gain.connect(engine.localBus);
  }

  private static tone(ctx: AudioContext, hz: number): AudioBuffer {
    const len = Math.round(ctx.sampleRate * 0.03);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * hz * i) / ctx.sampleRate) * Math.exp(-i / (len / 5));
    return b;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  setVolume(v: number): void {
    this.gain.gain.value = v;
  }

  /** Starts the grid at `startMs` on this device's performance clock. */
  start(bpm: number, startMs: number): void {
    this.stop();
    this.bpm = bpm;
    this.startMs = startMs;
    this.nextIndex = nextBeat(startMs, bpm, performance.now()).index;
    this.timer = setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const period = 60000 / this.bpm;
    const horizon = performance.now() + 120;
    while (this.startMs + this.nextIndex * period < horizon) {
      const i = this.nextIndex++;
      const at = this.startMs + i * period;
      const when = this.engine.perfToCtxTime(at);
      if (when < this.engine.ctx.currentTime) continue;
      const src = this.engine.ctx.createBufferSource();
      src.buffer = i % this.beatsPerBar === 0 ? this.hi : this.lo;
      src.connect(this.gain);
      src.start(when);
      const delay = Math.max(0, at - performance.now());
      setTimeout(() => this.onBeat?.(i), delay);
    }
  }
}
