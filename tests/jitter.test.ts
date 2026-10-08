import { describe, expect, it } from 'vitest';
import { JitterBuffer, type JitterOptions } from '../src/audio/jitter';
import { QUANTUM } from '../src/net/packet';

/** Deterministic PRNG so simulations are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

interface SimOptions {
  seconds: number;
  /** Uniform random extra network delay, in quanta. */
  jitter?: number;
  loss?: number;
  /** Swap adjacent packets with this probability. */
  reorder?: number;
  /** Sender clock rate relative to receiver (1.0005 = 500 ppm fast). */
  skew?: number;
  /** Consumer pulls in bursts of this many quanta (phone audio callback). */
  burst?: number;
  /** Producer emits in bursts of this many quanta. */
  sendBurst?: number;
  jb?: JitterOptions;
  seed?: number;
  warmupSeconds?: number;
}

function simulate(o: SimOptions) {
  const rand = rng(o.seed ?? 1);
  const jb = new JitterBuffer({ ...o.jb });
  const pulls = Math.round((o.seconds * 48000) / QUANTUM);
  const burst = o.burst ?? 1;
  const sendBurst = o.sendBurst ?? 1;
  const skew = o.skew ?? 1;
  // Pre-generate arrivals (in receiver frames).
  const packets: { seq: number; at: number }[] = [];
  const total = Math.ceil(pulls * skew) + 64;
  for (let i = 0; i < total; i++) {
    if (rand() < (o.loss ?? 0)) continue;
    const gen = (Math.floor(i / sendBurst) + 1) * sendBurst * QUANTUM / skew;
    const at = gen + 200 + rand() * (o.jitter ?? 0) * QUANTUM;
    packets.push({ seq: i & 0xffff, at });
  }
  if (o.reorder) {
    for (let i = 0; i + 1 < packets.length; i++) {
      if (rand() < o.reorder) {
        const a = packets[i]!, b = packets[i + 1]!;
        [a.at, b.at] = [b.at, a.at];
      }
    }
  }
  packets.sort((a, b) => a.at - b.at);

  const out = new Float32Array(QUANTUM);
  let next = 0;
  const warm = Math.round(((o.warmupSeconds ?? 5) * 48000) / QUANTUM);
  let maxDepthAfterWarm = 0;
  let sumDepth = 0;
  let nDepth = 0;
  let snap = { ...jb.stats };
  for (let p = 0; p < pulls; p++) {
    // Consumer wakes once per burst; all pulls in a burst see the same arrivals.
    const wake = (Math.floor(p / burst) + 1) * burst * QUANTUM;
    while (next < packets.length && packets[next]!.at <= wake - (burst - 1 - (p % burst)) * 0 ) {
      const pk = packets[next++]!;
      const q = new Float32Array(QUANTUM).fill(0.5);
      q[0] = pk.seq; // tag for ordering checks
      jb.push(pk.seq, q);
    }
    jb.pull(out);
    if (p === warm) snap = { ...jb.stats };
    if (p > warm) {
      const b = jb.bufferedQuanta();
      maxDepthAfterWarm = Math.max(maxDepthAfterWarm, b);
      sumDepth += b;
      nDepth++;
    }
  }
  const s = jb.stats;
  const played = s.played - snap.played;
  const plc = s.plc - snap.plc;
  return {
    jb,
    stats: s,
    plcRate: plc / Math.max(1, played + plc),
    late: s.late - snap.late,
    meanDepth: sumDepth / Math.max(1, nDepth),
    maxDepth: maxDepthAfterWarm,
  };
}

describe('JitterBuffer', () => {
  it('a clean stream settles at minimal depth with no concealment', () => {
    const r = simulate({ seconds: 20 });
    expect(r.plcRate).toBe(0);
    expect(r.late).toBe(0);
    expect(r.meanDepth).toBeLessThan(2.5);
  });

  it('absorbs reordering without loss', () => {
    const r = simulate({ seconds: 20, reorder: 0.1, jitter: 0.5 });
    expect(r.plcRate).toBeLessThan(0.002);
    expect(r.meanDepth).toBeLessThan(4);
  });

  it('conceals random loss and keeps depth bounded', () => {
    const r = simulate({ seconds: 30, loss: 0.05 });
    expect(r.plcRate).toBeGreaterThan(0.03);
    expect(r.plcRate).toBeLessThan(0.07);
    expect(r.maxDepth).toBeLessThan(4);
  });

  it('adapts to network jitter: few late packets, depth close to the jitter span', () => {
    const r = simulate({ seconds: 60, jitter: 4, warmupSeconds: 10 });
    expect(r.late / (60 * 375)).toBeLessThan(0.01);
    expect(r.meanDepth).toBeLessThan(4 + 3);
  });

  it('handles bursty phone audio callbacks on both ends', () => {
    const r = simulate({ seconds: 60, burst: 4, sendBurst: 4, warmupSeconds: 10 });
    expect(r.late / (60 * 375)).toBeLessThan(0.005);
    expect(r.meanDepth).toBeLessThan(8);
  });

  it.each([1.0005, 0.9995])('tracks clock skew %d without drifting', (skew) => {
    const r = simulate({ seconds: 120, skew, jitter: 1, warmupSeconds: 10 });
    expect(r.maxDepth).toBeLessThan(5);
    expect(r.plcRate).toBeLessThan(0.01);
    const s = r.stats;
    expect(s.drops + s.dups + s.skips + s.inserts).toBeGreaterThan(0);
  });

  it('never exceeds the latency cap, accepting glitches instead', () => {
    const r = simulate({ seconds: 30, jitter: 20, jb: { maxDepth: 6 } });
    expect(r.stats.delay).toBeLessThan(6.5);
    // Without the cap the same link settles much deeper.
    const free = simulate({ seconds: 30, jitter: 20, jb: { maxDepth: 64 } });
    expect(free.stats.delay).toBeGreaterThan(8);
  });

  it('manual depth holds the requested headroom', () => {
    const r = simulate({ seconds: 20, jb: { margin: 4 } });
    expect(r.meanDepth).toBeGreaterThan(3.5);
    expect(r.meanDepth).toBeLessThan(5.5);
  });

  it('PLC repeats with a fade, then goes silent after 3 missing quanta', () => {
    const jb = new JitterBuffer({ margin: 0 });
    const q = new Float32Array(QUANTUM).fill(1);
    const out = new Float32Array(QUANTUM);
    jb.push(0, q);
    jb.pull(out);
    expect(out[10]).toBe(1);
    const peaks: number[] = [];
    for (let i = 0; i < 5; i++) {
      jb.pull(out);
      peaks.push(Math.max(...out.map(Math.abs)));
    }
    expect(peaks[0]).toBeCloseTo(1, 1);
    expect(peaks[1]).toBeLessThan(peaks[0]!);
    expect(peaks[2]).toBeLessThan(peaks[1]!);
    expect(peaks[3]).toBe(0);
    expect(peaks[4]).toBe(0);
    expect(jb.stats.plc).toBe(5);
  });

  it('plays quanta in sequence order across 16-bit wrap', () => {
    const jb = new JitterBuffer({ margin: 2 });
    const out = new Float32Array(QUANTUM);
    const seen: number[] = [];
    let seq = 65530;
    for (let i = 0; i < 20; i++) {
      const q = new Float32Array(QUANTUM).fill(0.25);
      q[64] = i / 100; // marker in the middle, away from crossfades
      jb.push(seq & 0xffff, q);
      seq++;
      jb.pull(out);
      if (jb.stats.playing && out[64] !== 0) seen.push(Math.round(out[64]! * 100));
    }
    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
  });

  it('re-primes after the stream stops instead of keeping the gap as latency', () => {
    const jb = new JitterBuffer({ margin: 0 });
    const out = new Float32Array(QUANTUM);
    const q = new Float32Array(QUANTUM).fill(0.3);
    for (let i = 0; i < 50; i++) {
      jb.push(i, q);
      jb.pull(out);
    }
    for (let i = 0; i < 100; i++) jb.pull(out); // sender paused
    expect(jb.stats.playing).toBe(false);
    jb.push(500, q);
    jb.pull(out);
    expect(jb.bufferedQuanta()).toBeLessThanOrEqual(1);
    expect(out[100]).toBeCloseTo(0.3);
  });
});
