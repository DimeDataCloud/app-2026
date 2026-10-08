/**
 * Single-producer/single-consumer ring of fixed-size slots, backed by a
 * SharedArrayBuffer when the page is cross-origin isolated (zero-copy between
 * the main thread and an AudioWorklet) or a plain ArrayBuffer otherwise.
 *
 * Each slot holds `headerLen` float64 header values and `frames` float32 samples.
 */
export interface RingLayout {
  slots: number;
  frames: number;
  headerLen: number;
}

/** Capture worklet → main thread. Header: [sampleTime]. */
export const SEND_RING: RingLayout = { slots: 64, frames: 128, headerLen: 1 };
/** Main thread → playout worklet. Header: [seq]. */
export const RECV_RING: RingLayout = { slots: 128, frames: 128, headerLen: 1 };

const CTRL_BYTES = 8; // Int32 writeIndex, Int32 readIndex

export function ringBytes(l: RingLayout): number {
  return CTRL_BYTES + l.slots * l.headerLen * 8 + l.slots * l.frames * 4;
}

export function createRingBuffer(l: RingLayout, shared: boolean): ArrayBuffer | SharedArrayBuffer {
  const n = ringBytes(l);
  return shared ? new SharedArrayBuffer(n) : new ArrayBuffer(n);
}

export class Ring {
  private readonly ctrl: Int32Array;
  private readonly headers: Float64Array;
  private readonly samples: Float32Array;

  constructor(
    buffer: ArrayBuffer | SharedArrayBuffer,
    readonly layout: RingLayout,
  ) {
    const { slots, frames, headerLen } = layout;
    this.ctrl = new Int32Array(buffer, 0, 2);
    this.headers = new Float64Array(buffer, CTRL_BYTES, slots * headerLen);
    this.samples = new Float32Array(buffer, CTRL_BYTES + slots * headerLen * 8, slots * frames);
  }

  available(): number {
    const w = Atomics.load(this.ctrl, 0);
    const r = Atomics.load(this.ctrl, 1);
    return (w - r + this.layout.slots) % this.layout.slots;
  }

  /** Returns false (and drops the slot) when full: never block the audio thread. */
  write(header: ArrayLike<number>, samples: Float32Array): boolean {
    const { slots, frames, headerLen } = this.layout;
    const w = Atomics.load(this.ctrl, 0);
    const next = (w + 1) % slots;
    if (next === Atomics.load(this.ctrl, 1)) return false;
    for (let i = 0; i < headerLen; i++) this.headers[w * headerLen + i] = header[i] ?? 0;
    this.samples.set(samples.subarray(0, frames), w * frames);
    Atomics.store(this.ctrl, 0, next);
    return true;
  }

  read(header: Float64Array, samples: Float32Array): boolean {
    const { slots, frames, headerLen } = this.layout;
    const r = Atomics.load(this.ctrl, 1);
    if (r === Atomics.load(this.ctrl, 0)) return false;
    for (let i = 0; i < headerLen; i++) header[i] = this.headers[r * headerLen + i]!;
    samples.set(this.samples.subarray(r * frames, r * frames + frames));
    Atomics.store(this.ctrl, 1, (r + 1) % slots);
    return true;
  }
}
