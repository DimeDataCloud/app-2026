import { describe, expect, it } from 'vitest';
import { decodeMulaw, decodePcm16, encodeMulaw, encodePcm16, linearToMulaw, mulawToLinear } from '../src/audio/codec';

function sine(n: number, amp: number) {
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 440 * i) / 48000));
}

describe('pcm16', () => {
  it('round-trips within one LSB and clamps', () => {
    const src = sine(128, 0.9);
    src[0] = 1.5;
    src[1] = -1.5;
    const v = new DataView(new ArrayBuffer(256));
    encodePcm16(src, v, 0);
    const out = new Float32Array(128);
    decodePcm16(v, 0, out);
    expect(out[0]).toBeCloseTo(1, 4);
    expect(out[1]).toBeCloseTo(-1, 4);
    for (let i = 2; i < 128; i++) expect(Math.abs(out[i]! - src[i]!)).toBeLessThan(1 / 32767 + 1e-6);
  });
});

describe('mu-law', () => {
  it('matches G.711 reference points', () => {
    expect(linearToMulaw(0)).toBe(0xff);
    expect(linearToMulaw(1)).toBe(0x80);
    expect(linearToMulaw(-1)).toBe(0x00);
    expect(mulawToLinear(0xff)).toBe(0);
  });

  it('keeps relative error small across the range (SNR > 30 dB on a sine)', () => {
    for (const amp of [0.9, 0.3, 0.05, 0.01]) {
      const src = sine(4800, amp);
      const bytes = new Uint8Array(src.length);
      encodeMulaw(src, bytes, 0);
      const out = new Float32Array(src.length);
      decodeMulaw(bytes, 0, out);
      let sig = 0;
      let err = 0;
      for (let i = 0; i < src.length; i++) {
        sig += src[i]! ** 2;
        err += (src[i]! - out[i]!) ** 2;
      }
      expect(10 * Math.log10(sig / err)).toBeGreaterThan(30);
    }
  });

  it('is monotonic', () => {
    let prev = -Infinity;
    for (let x = -1; x <= 1; x += 1 / 512) {
      const y = mulawToLinear(linearToMulaw(x));
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});
