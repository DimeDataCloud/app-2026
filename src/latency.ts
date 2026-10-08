import type { AudioEngine } from './audio/engine';

export const QUANTUM_MS = (128 / 48000) * 1000;
/** The user's hard requirement: one-way latency reliably under this. */
export const BUDGET_MS = 60;

export interface PingSample {
  rtt: number;
  /** peerClock − myClock, in ms. */
  offset: number;
}

/** NTP-style estimate from one ping: t0 sent, t1 peer receive time, t2 received back. */
export function pingSample(t0: number, t1Peer: number, t2: number): PingSample {
  const rtt = t2 - t0;
  return { rtt, offset: t1Peer - (t0 + t2) / 2 };
}

/** The offset from the lowest-RTT sample is the least affected by queueing. */
export function bestOffset(samples: PingSample[]): number | null {
  let best: PingSample | null = null;
  for (const s of samples) if (!best || s.rtt < best.rtt) best = s;
  return best ? best.offset : null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class PingTracker {
  private samples: PingSample[] = [];

  add(t0: number, t1Peer: number, t2: number): void {
    this.samples.push(pingSample(t0, t1Peer, t2));
    if (this.samples.length > 40) this.samples.shift();
  }

  /** Median of recent RTTs (robust to one slow ping). */
  rtt(): number | null {
    return median(this.samples.slice(-6).map((s) => s.rtt));
  }

  offset(): number | null {
    return bestOffset(this.samples);
  }

  reset(): void {
    this.samples = [];
  }
}

export interface OneWayParts {
  /** Sender capture path (mic → worklet). */
  captureMs: number;
  /** Packetization (quanta per packet). */
  packetMs: number;
  /** Network one-way ≈ RTT / 2. */
  networkMs: number;
  /** Receiver jitter-buffer delay. */
  jitterMs: number;
  /** Receiver output path (worklet → ears). */
  outputMs: number;
}

export function oneWayTotal(p: OneWayParts): number {
  return p.captureMs + p.packetMs + p.networkMs + p.jitterMs + p.outputMs;
}

export type Grade = 'good' | 'ok' | 'bad';

/** Green under 40 ms ("together"), amber up to the 60 ms budget, red beyond. */
export function grade(ms: number): Grade {
  return ms < 40 ? 'good' : ms < BUDGET_MS ? 'ok' : 'bad';
}

/**
 * Largest jitter-buffer delay (in quanta) that keeps the one-way total under
 * the budget, given everything else. Never below 1 quantum.
 */
export function jitterCapQuanta(p: Omit<OneWayParts, 'jitterMs'>, budgetMs = BUDGET_MS, safetyMs = 3): number {
  const room = budgetMs - safetyMs - (p.captureMs + p.packetMs + p.networkMs + p.outputMs);
  return Math.max(1, Math.min(48, Math.floor(room / QUANTUM_MS)));
}

/** Estimated capture latency when no loopback test has been run. */
export const DEFAULT_CAPTURE_MS = 10;

/**
 * Splits a measured device round trip (output → air/cable → input) into the
 * capture share, using the browser-reported output latency.
 */
export function captureFromRoundTrip(roundTripMs: number, outputMs: number): number {
  return Math.max(2, roundTripMs - outputMs);
}

const DEVICE_KEY = 'jamlink.deviceRoundTrip';

export function loadDeviceRoundTrip(): number | null {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function saveDeviceRoundTrip(ms: number): void {
  try {
    localStorage.setItem(DEVICE_KEY, String(Math.round(ms * 10) / 10));
  } catch {
    /* storage unavailable */
  }
}

/** Pairs click times with detected onsets; returns round trips in ms. */
export function matchClicks(clickFrames: number[], onsetFrames: number[], sr: number, maxMs = 400): number[] {
  const out: number[] = [];
  for (const c of clickFrames) {
    const o = onsetFrames.find((f) => f > c && (f - c) / sr <= maxMs / 1000);
    if (o !== undefined) out.push(((o - c) / sr) * 1000);
  }
  return out;
}

/**
 * Device loopback test: plays clicks and listens for them on the input (speaker
 * → mic, or a cable from headphone out to mic in). Measures the full device
 * round trip, the part of latency no network setting can fix.
 */
export async function runLoopbackTest(engine: AudioEngine, clicks = 6): Promise<number | null> {
  const { ctx } = engine;
  const sr = ctx.sampleRate;
  const click = ctx.createBuffer(1, Math.round(sr * 0.004), sr);
  const d = click.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (i % 8 < 4 ? 0.9 : -0.9) * (1 - i / d.length);

  const onsets: number[] = [];
  const prev = engine.onSenderOnset;
  engine.onSenderOnset = (f) => onsets.push(f);
  engine.detectOnsets('sender', true, 0.05);

  const t0 = ctx.currentTime + 0.4;
  const clickFrames: number[] = [];
  for (let i = 0; i < clicks; i++) {
    const t = t0 + i * 0.45;
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.connect(engine.localBus);
    src.start(t);
    clickFrames.push(Math.round(t * sr));
  }
  await new Promise((r) => setTimeout(r, (0.4 + clicks * 0.45 + 0.5) * 1000));
  engine.detectOnsets('sender', false);
  engine.onSenderOnset = prev;

  const rts = matchClicks(clickFrames, onsets, sr);
  if (rts.length < Math.ceil(clicks / 2)) return null;
  return median(rts);
}
