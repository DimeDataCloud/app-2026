import { describe, expect, it } from 'vitest';
import { OnsetDetector } from '../src/audio/onset';

describe('OnsetDetector', () => {
  it('finds a click in noise and ignores its tail', () => {
    const d = new OnsetDetector(0.2, 4800);
    const sig = new Float32Array(48000);
    for (let i = 0; i < sig.length; i++) sig[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.01;
    for (let i = 0; i < 400; i++) sig[10000 + i] += 0.8 * Math.exp(-i / 80) * Math.sin(i * 0.3 + 1);
    sig[30000] = 0.9;
    const hits: number[] = [];
    for (let o = 0; o < sig.length; o += 128) {
      const f = d.feed(sig.subarray(o, o + 128), o);
      if (f >= 0) hits.push(f);
    }
    expect(hits).toEqual([10000, 30000]);
  });

  it('does not trigger on steady loud noise', () => {
    const d = new OnsetDetector(0.05, 4800);
    const sig = new Float32Array(48000);
    for (let i = 0; i < sig.length; i++) sig[i] = (i % 2 ? 1 : -1) * 0.04;
    let hits = 0;
    for (let o = 0; o < sig.length; o += 128) if (d.feed(sig.subarray(o, o + 128), o) >= 0) hits++;
    expect(hits).toBe(0);
  });
});
