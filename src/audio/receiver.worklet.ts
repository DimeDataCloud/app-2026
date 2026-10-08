/// <reference path="./worklet-env.d.ts" />
import { QUANTUM } from '../net/packet';
import { JitterBuffer } from './jitter';
import { OnsetDetector } from './onset';
import { RECV_RING, Ring } from './ring';

/**
 * Playout worklet: drains received quanta from the main thread (SAB ring or
 * messages) into the adaptive jitter buffer and renders one quantum per call.
 * Header: [seq].
 */

interface Options {
  ring?: SharedArrayBuffer;
  margin?: number | 'auto';
  maxDepth?: number;
}

type Msg =
  | { type: 'packet'; seq: number; q: Float32Array }
  | { type: 'config'; margin?: number | 'auto'; maxDepth?: number }
  | { type: 'detect'; on: boolean; threshold?: number };

class ReceiverProcessor extends AudioWorkletProcessor {
  private readonly ring: Ring | null;
  private readonly jb: JitterBuffer;
  private readonly hdr = new Float64Array(1);
  private readonly tmp = new Float32Array(QUANTUM);
  private readonly out = new Float32Array(QUANTUM);
  private onset: OnsetDetector | null = null;
  private calls = 0;
  private sumSq = 0;
  private peak = 0;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const o = (options.processorOptions ?? {}) as Options;
    this.ring = o.ring ? new Ring(o.ring, RECV_RING) : null;
    this.jb = new JitterBuffer({ margin: o.margin ?? 'auto', maxDepth: o.maxDepth ?? 12 });
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === 'packet') this.jb.push(m.seq, m.q);
      else if (m.type === 'config') {
        if (m.margin !== undefined) this.jb.setMargin(m.margin);
        if (m.maxDepth !== undefined) this.jb.setMaxDepth(m.maxDepth);
      } else if (m.type === 'detect') {
        this.onset = m.on ? new OnsetDetector(m.threshold ?? 0.2, 4800) : null;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.ring) {
      while (this.ring.read(this.hdr, this.tmp)) this.jb.push(this.hdr[0]!, this.tmp);
    }
    const out = this.out;
    this.jb.pull(out);
    const chans = outputs[0]!;
    for (const ch of chans) ch.set(out);

    for (let i = 0; i < QUANTUM; i++) {
      const s = out[i]!;
      this.sumSq += s * s;
      const a = s < 0 ? -s : s;
      if (a > this.peak) this.peak = a;
    }
    if (this.onset) {
      const f = this.onset.feed(out, currentFrame);
      if (f >= 0) this.port.postMessage({ type: 'onset', frame: f });
    }
    if (++this.calls % 94 === 0) {
      this.port.postMessage({
        type: 'stats',
        ...this.jb.stats,
        rms: Math.sqrt(this.sumSq / (94 * QUANTUM)),
        peak: this.peak,
      });
      this.sumSq = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('jam-receiver', ReceiverProcessor);
