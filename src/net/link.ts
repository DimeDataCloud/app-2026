import type { AudioEngine } from '../audio/engine';
import { decodeMulaw, decodePcm16, encodeMulaw, encodePcm16 } from '../audio/codec';
import { OpusReceiver, OpusSender } from '../audio/opus';
import { Codec, HEADER_BYTES, QUANTUM, decodePing, encodePing, readHeader, writeHeader } from './packet';

export type CodecName = 'pcm16' | 'mulaw8' | 'opus';

const CODEC_ID: Record<CodecName, number> = { pcm16: Codec.PCM16, mulaw8: Codec.MULAW8, opus: Codec.OPUS };

/** Bytes queued in the DataChannel beyond which we drop instead of queueing (queue = latency). */
const MAX_BUFFERED = 6 * 1024;

export interface LinkStats {
  sent: number;
  dropped: number;
  received: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Packetizes captured quanta onto the unordered audio DataChannel and decodes
 * incoming packets into the playout worklet. Runs on the main thread, so it
 * stays allocation-light: one reusable packet buffer per quanta-per-packet size.
 */
export class AudioLink {
  codec: CodecName = 'pcm16';
  quantaPerPacket = 1;
  sending = true;
  readonly stats: LinkStats = { sent: 0, dropped: 0, received: 0, bytesIn: 0, bytesOut: 0 };
  onPong: ((t0: number, peerT: number, now: number) => void) | null = null;

  private dc: RTCDataChannel | null = null;
  private pending: Float32Array;
  private pendingCount = 0;
  private pendingStart = 0;
  private readonly rxQuantum = new Float32Array(QUANTUM);
  private opusTx: OpusSender | null = null;
  private opusRx: OpusReceiver | null = null;

  constructor(private readonly engine: AudioEngine) {
    this.pending = new Float32Array(QUANTUM * 4);
    engine.onQuantum = (t, s) => this.onCaptured(t, s);
  }

  attach(dc: RTCDataChannel | null): void {
    this.dc = dc;
    this.pendingCount = 0;
  }

  setCodec(codec: CodecName, opusConfig?: AudioEncoderConfig | null): void {
    this.opusTx?.close();
    this.opusTx = null;
    if (codec === 'opus') {
      if (!opusConfig) throw new Error('Opus not supported');
      this.opusTx = new OpusSender(opusConfig, (t, data) => this.sendOpus(t, data));
    }
    this.codec = codec;
    this.pendingCount = 0;
  }

  setQuantaPerPacket(n: number): void {
    this.quantaPerPacket = Math.max(1, Math.min(4, Math.round(n)));
    this.pendingCount = 0;
  }

  ping(): void {
    const dc = this.dc;
    if (dc?.readyState === 'open') dc.send(encodePing(Codec.PING, performance.now(), 0));
  }

  private onCaptured(sampleTime: number, samples: Float32Array): void {
    const dc = this.dc;
    if (!this.sending || !dc || dc.readyState !== 'open') return;
    if (this.codec === 'opus') {
      this.opusTx?.encode(sampleTime, samples);
      return;
    }
    if (this.pendingCount === 0) this.pendingStart = sampleTime;
    this.pending.set(samples, this.pendingCount * QUANTUM);
    if (++this.pendingCount < this.quantaPerPacket) return;
    const n = this.pendingCount;
    this.pendingCount = 0;

    if (dc.bufferedAmount > MAX_BUFFERED) {
      // Congested: a late packet is useless to the receiver, drop it here.
      this.stats.dropped++;
      return;
    }
    const frames = n * QUANTUM;
    const bytesPer = this.codec === 'pcm16' ? 2 : 1;
    const buf = new ArrayBuffer(HEADER_BYTES + frames * bytesPer);
    const view = new DataView(buf);
    writeHeader(view, {
      seq: this.pendingStart / QUANTUM,
      sampleTime: this.pendingStart,
      codec: CODEC_ID[this.codec],
      quanta: n,
    });
    const src = this.pending.subarray(0, frames);
    if (this.codec === 'pcm16') encodePcm16(src, view, HEADER_BYTES);
    else encodeMulaw(src, new Uint8Array(buf), HEADER_BYTES);
    dc.send(buf);
    this.stats.sent++;
    this.stats.bytesOut += buf.byteLength;
  }

  private sendOpus(sampleTime: number, data: Uint8Array): void {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return;
    if (dc.bufferedAmount > MAX_BUFFERED) {
      this.stats.dropped++;
      return;
    }
    const buf = new Uint8Array(HEADER_BYTES + data.length);
    writeHeader(new DataView(buf.buffer), {
      seq: Math.floor(sampleTime / QUANTUM),
      sampleTime,
      codec: Codec.OPUS,
      quanta: 0,
    });
    buf.set(data, HEADER_BYTES);
    dc.send(buf.buffer);
    this.stats.sent++;
    this.stats.bytesOut += buf.byteLength;
  }

  /** DataChannel onmessage handler for the audio channel. */
  handle(data: ArrayBuffer): void {
    if (data.byteLength < HEADER_BYTES) return;
    const view = new DataView(data);
    const h = readHeader(view);
    this.stats.bytesIn += data.byteLength;
    switch (h.codec) {
      case Codec.PING: {
        const [t0] = decodePing(view);
        this.dc?.send(encodePing(Codec.PONG, t0, performance.now()));
        return;
      }
      case Codec.PONG: {
        const [t0, peerT] = decodePing(view);
        this.onPong?.(t0, peerT, performance.now());
        return;
      }
      case Codec.PCM16:
      case Codec.MULAW8: {
        const bytesPer = h.codec === Codec.PCM16 ? 2 : 1;
        const n = Math.min(h.quanta, Math.floor((data.byteLength - HEADER_BYTES) / (QUANTUM * bytesPer)));
        const bytes = h.codec === Codec.MULAW8 ? new Uint8Array(data) : null;
        for (let i = 0; i < n; i++) {
          const off = HEADER_BYTES + i * QUANTUM * bytesPer;
          if (bytes) decodeMulaw(bytes, off, this.rxQuantum);
          else decodePcm16(view, off, this.rxQuantum);
          this.engine.receive((h.seq + i) & 0xffff, this.rxQuantum);
        }
        this.stats.received += n;
        return;
      }
      case Codec.OPUS: {
        this.opusRx ??= new OpusReceiver((seq, q) => this.engine.receive(seq, q));
        this.opusRx.decode(h.sampleTime, new Uint8Array(data, HEADER_BYTES));
        this.stats.received++;
        return;
      }
    }
  }

  close(): void {
    this.opusTx?.close();
    this.opusRx?.close();
    this.engine.onQuantum = null;
  }
}
