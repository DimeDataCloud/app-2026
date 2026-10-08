import { describe, expect, it } from 'vitest';
import {
  BUDGET_MS, PingTracker, QUANTUM_MS, bestOffset, captureFromRoundTrip, grade, jitterCapQuanta,
  matchClicks, oneWayTotal, pingSample,
} from '../src/latency';
import { fromPeerClock, nextBeat, toPeerClock } from '../src/metronome';

describe('clock offset', () => {
  it('recovers a known offset with symmetric delay', () => {
    // Peer clock = mine + 5000. One-way 10 ms each way.
    const s = pingSample(100, 100 + 10 + 5000, 120);
    expect(s.rtt).toBe(20);
    expect(s.offset).toBe(5000);
  });

  it('prefers the lowest-RTT sample', () => {
    const samples = [
      pingSample(0, 5000 + 40, 50), // asymmetric queueing: biased
      pingSample(100, 5000 + 105, 110),
    ];
    expect(bestOffset(samples)).toBe(5000);
  });

  it('round-trips metronome start times through the peer clock', () => {
    const offset = -1234.5;
    expect(fromPeerClock(toPeerClock(777, offset), offset)).toBeCloseTo(777);
  });

  it('computes the next beat on the shared grid', () => {
    expect(nextBeat(1000, 120, 999)).toEqual({ index: 0, at: 1000 });
    expect(nextBeat(1000, 120, 1001)).toEqual({ index: 1, at: 1500 });
    expect(nextBeat(1000, 120, 2500)).toEqual({ index: 3, at: 2500 });
  });

  it('PingTracker reports median RTT', () => {
    const p = new PingTracker();
    for (const rtt of [30, 31, 200, 29, 30]) p.add(0, 15, rtt);
    expect(p.rtt()).toBe(30);
  });
});

describe('latency budget', () => {
  const parts = { captureMs: 8, packetMs: QUANTUM_MS, networkMs: 15, outputMs: 12 };

  it('sums the one-way path', () => {
    expect(oneWayTotal({ ...parts, jitterMs: 5 })).toBeCloseTo(8 + QUANTUM_MS + 15 + 12 + 5);
  });

  it('grades against the 60 ms budget', () => {
    expect(BUDGET_MS).toBe(60);
    expect(grade(35)).toBe('good');
    expect(grade(55)).toBe('ok');
    expect(grade(60)).toBe('bad');
  });

  it('caps the jitter buffer to what the budget leaves', () => {
    const cap = jitterCapQuanta(parts);
    const total = oneWayTotal({ ...parts, jitterMs: cap * QUANTUM_MS });
    expect(total).toBeLessThan(BUDGET_MS);
    expect(oneWayTotal({ ...parts, jitterMs: (cap + 2) * QUANTUM_MS })).toBeGreaterThan(BUDGET_MS - 3);
  });

  it('never caps below one quantum even when over budget', () => {
    expect(jitterCapQuanta({ ...parts, networkMs: 80 })).toBe(1);
  });

  it('splits a device round trip into capture latency', () => {
    expect(captureFromRoundTrip(30, 12)).toBe(18);
    expect(captureFromRoundTrip(5, 12)).toBe(2);
  });

  it('matches clicks to onsets', () => {
    const sr = 48000;
    const clicks = [48000, 96000, 144000];
    const onsets = [48000 + 960, 96000 + 1008, 300000];
    expect(matchClicks(clicks, onsets, sr)).toEqual([20, 21]);
  });
});
