/// <reference path="./worklet-env.d.ts" />
import { QUANTUM } from '../net/packet';
import { OnsetDetector } from './onset';
import { SEND_RING, Ring } from './ring';

/**
 * Capture worklet: hands every 128-frame render quantum to the main thread,
 * which packetizes and sends it. With a SharedArrayBuffer the samples go into a
 * lock-free ring and only a 1-number wake-up message crosses threads.
 */

interface Options {
  ring?: SharedArrayBuffer;
}

class SenderProcessor extends AudioWorkletProcessor {
  private readonly ring: Ring | null;
  private readonly mono = new Float32Array(QUANTUM);
  private readonly header = [0];
  private sampleTime = 0;
  private onset: OnsetDetector | null = null;

  constructor(options: { processorOptions?: unknown }) {
    super();
    const o = (options.processorOptions ?? {}) as Options;
    this.ring = o.ring ? new Ring(o.ring, SEND_RING) : null;
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; on?: boolean; threshold?: number };
      if (m.type === 'detect') this.onset = m.on ? new OnsetDetector(m.threshold ?? 0.2, 4800) : null;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const chans = inputs[0];
    const mono = this.mono;
    if (!chans || chans.length === 0) {
      mono.fill(0);
    } else if (chans.length === 1) {
      mono.set(chans[0]!);
    } else {
      // Guitar is mono: take the louder-is-fine average of the channels.
      const n = chans.length;
      for (let i = 0; i < QUANTUM; i++) {
        let s = 0;
        for (let c = 0; c < n; c++) s += chans[c]![i]!;
        mono[i] = s / n;
      }
    }

    if (this.onset) {
      const f = this.onset.feed(mono, currentFrame);
      if (f >= 0) this.port.postMessage({ type: 'onset', frame: f, sampleTime: this.sampleTime + (f - currentFrame) });
    }

    this.header[0] = this.sampleTime;
    if (this.ring) {
      this.ring.write(this.header, mono);
      this.port.postMessage(0);
    } else {
      const copy = mono.slice();
      this.port.postMessage({ t: this.sampleTime, q: copy }, [copy.buffer]);
    }
    this.sampleTime = (this.sampleTime + QUANTUM) >>> 0;
    return true;
  }
}

registerProcessor('jam-sender', SenderProcessor);
