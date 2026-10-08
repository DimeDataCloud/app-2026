/**
 * Audio packet wire format (little endian), 8-byte header + payload:
 *   u16 seq        sequence number of the first quantum (wraps at 65536)
 *   u32 sampleTime sender frame counter of the first sample (wraps at 2^32)
 *   u8  codec      see Codec
 *   u8  quanta     number of 128-frame quanta in the payload (pcm codecs)
 * Ping/pong packets reuse the header with codec PING/PONG and carry two f64 timestamps.
 */
export const QUANTUM = 128;
export const HEADER_BYTES = 8;

export const Codec = {
  PCM16: 1,
  MULAW8: 2,
  OPUS: 3,
  PING: 254,
  PONG: 255,
} as const;
export type CodecId = (typeof Codec)[keyof typeof Codec];

export interface PacketHeader {
  seq: number;
  sampleTime: number;
  codec: number;
  quanta: number;
}

export function writeHeader(view: DataView, h: PacketHeader): void {
  view.setUint16(0, h.seq & 0xffff, true);
  view.setUint32(2, h.sampleTime >>> 0, true);
  view.setUint8(6, h.codec);
  view.setUint8(7, h.quanta);
}

export function readHeader(view: DataView): PacketHeader {
  return {
    seq: view.getUint16(0, true),
    sampleTime: view.getUint32(2, true),
    codec: view.getUint8(6),
    quanta: view.getUint8(7),
  };
}

/** Signed distance a - b on the 16-bit sequence circle, in [-32768, 32767]. */
export function seqDiff(a: number, b: number): number {
  return (((a - b) & 0xffff) << 16) >> 16;
}

/** Extends a wrapping 16-bit seq to a monotonic integer relative to a reference. */
export function unwrapSeq(seq: number, refExt: number): number {
  return refExt + seqDiff(seq, refExt & 0xffff);
}

export function encodePing(codec: typeof Codec.PING | typeof Codec.PONG, a: number, b: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_BYTES + 16);
  const v = new DataView(buf);
  writeHeader(v, { seq: 0, sampleTime: 0, codec, quanta: 0 });
  v.setFloat64(8, a, true);
  v.setFloat64(16, b, true);
  return buf;
}

export function decodePing(view: DataView): [number, number] {
  return [view.getFloat64(8, true), view.getFloat64(16, true)];
}
