/** Zero-algorithmic-delay sample codecs. Opus (WebCodecs) lives in opus.ts. */

export function encodePcm16(src: Float32Array, dst: DataView, offset: number): void {
  for (let i = 0; i < src.length; i++) {
    let s = src[i]!;
    s = s > 1 ? 1 : s < -1 ? -1 : s;
    dst.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

export function decodePcm16(src: DataView, offset: number, dst: Float32Array): void {
  for (let i = 0; i < dst.length; i++) {
    const v = src.getInt16(offset + i * 2, true);
    dst[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
}

// ITU-T G.711 μ-law.
const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.round((sample > 1 ? 1 : sample < -1 ? -1 : sample) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const MULAW_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const mag = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    t[i] = (sign ? -mag : mag) / 32768;
  }
  return t;
})();

export function mulawToLinear(byte: number): number {
  return MULAW_TABLE[byte & 0xff]!;
}

export function encodeMulaw(src: Float32Array, dst: Uint8Array, offset: number): void {
  for (let i = 0; i < src.length; i++) dst[offset + i] = linearToMulaw(src[i]!);
}

export function decodeMulaw(src: Uint8Array, offset: number, dst: Float32Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] = MULAW_TABLE[src[offset + i]!]!;
}
