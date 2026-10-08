import { describe, expect, it } from 'vitest';
import { Codec, HEADER_BYTES, decodePing, encodePing, readHeader, seqDiff, unwrapSeq, writeHeader } from '../src/net/packet';

describe('packet', () => {
  it('round-trips the header', () => {
    const v = new DataView(new ArrayBuffer(HEADER_BYTES));
    writeHeader(v, { seq: 65535, sampleTime: 0xfffffff0, codec: Codec.MULAW8, quanta: 2 });
    expect(readHeader(v)).toEqual({ seq: 65535, sampleTime: 0xfffffff0, codec: Codec.MULAW8, quanta: 2 });
  });

  it('wraps seq to 16 bits', () => {
    const v = new DataView(new ArrayBuffer(HEADER_BYTES));
    writeHeader(v, { seq: 65536 + 7, sampleTime: 0, codec: Codec.PCM16, quanta: 1 });
    expect(readHeader(v).seq).toBe(7);
  });

  it('computes signed seq distance across the wrap', () => {
    expect(seqDiff(2, 65534)).toBe(4);
    expect(seqDiff(65534, 2)).toBe(-4);
    expect(seqDiff(100, 100)).toBe(0);
    expect(seqDiff(32767, 0)).toBe(32767);
    expect(seqDiff(32768, 0)).toBe(-32768);
  });

  it('unwraps seq monotonically', () => {
    let ref = 65530;
    const out: number[] = [];
    for (const s of [65531, 65535, 0, 3, 2, 10]) {
      ref = Math.max(ref, unwrapSeq(s, ref));
      out.push(unwrapSeq(s, ref));
    }
    expect(out).toEqual([65531, 65535, 65536, 65539, 65538, 65546]);
  });

  it('round-trips ping timestamps', () => {
    const v = new DataView(encodePing(Codec.PONG, 1234.5678, 98765.4321));
    expect(readHeader(v).codec).toBe(Codec.PONG);
    expect(decodePing(v)).toEqual([1234.5678, 98765.4321]);
  });
});
