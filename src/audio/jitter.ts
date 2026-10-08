import { QUANTUM, unwrapSeq } from '../net/packet';

/**
 * Adaptive jitter buffer for 128-frame quanta, run inside the receiver
 * AudioWorklet (pure TS, no DOM, so it is unit-testable).
 *
 * Latency control: instead of guessing a depth from a jitter percentile, it
 * measures how much slack there actually was. At every pull it records the
 * buffered audio B (in quanta, including the unread part of the current
 * quantum). Over each ~1 s window it keeps the smallest B seen. Since playback
 * needs B >= 1 to avoid an underrun, `minB - (1 + margin)` is pure excess
 * latency, and the controller removes it:
 *   - excess >= 1 quantum   → skip whole quanta (with a short crossfade)
 *   - excess in (0.35, 1)   → drop one sample every few pulls (drift correction)
 *   - deficit (< -0.35)     → duplicate one sample every few pulls
 *   - packet arrived late   → (auto) insert one quantum now and raise the margin
 * The margin (safety headroom, in quanta) is fixed in manual mode and adapts in
 * auto mode: it grows on late arrivals and decays after clean windows, with
 * exponential backoff if a decrease is followed by lateness. `maxDepth` caps
 * the mean depth so the buffer can never eat the latency budget: past the cap
 * we accept a glitch rather than add delay.
 */
export interface JitterOptions {
  /** Ring capacity in quanta (power of two). */
  capacity?: number;
  /** 'auto' or a fixed margin in quanta (target depth − 1). */
  margin?: number | 'auto';
  /** Cap on mean buffer delay, in quanta (derived from the latency budget). */
  maxDepth?: number;
  /** Control window length in pulls (375 ≈ 1 s at 48 kHz). */
  windowPulls?: number;
}

export interface JitterStats {
  received: number;
  played: number;
  plc: number;
  late: number;
  skips: number;
  inserts: number;
  drops: number;
  dups: number;
  resets: number;
  /** Mean buffered audio over the last window, in quanta. */
  depth: number;
  /** Mean time a packet waits in the buffer before playout, in quanta. This is
   *  the jitter-buffer share of the one-way latency. */
  delay: number;
  /** Minimum buffered audio over the last window, in quanta. */
  minDepth: number;
  margin: number;
  maxDepth: number;
  playing: boolean;
}

const FADE = 32;
const PLC_MAX = 3; // repeat-with-fade quanta before going silent
const IDLE_AFTER = 32; // consecutive missing quanta (~85 ms) before re-priming
const DRIFT_EVERY = 4; // pulls between single-sample drift corrections

export class JitterBuffer {
  private readonly cap: number;
  private readonly mask: number;
  private readonly slots: Float32Array[];
  private readonly slotSeq: Float64Array;
  private readonly cur = new Float32Array(QUANTUM);
  private readonly last = new Float32Array(QUANTUM);
  private pos = QUANTUM;
  private state: 'idle' | 'priming' | 'playing' = 'idle';
  private highestExt = 0;
  private playExt = 0;
  private missingRun = 0;
  private lastValid = false;
  private lateRun = 0;

  private auto: boolean;
  private margin: number;
  private maxDepth: number;
  private readonly windowPulls: number;

  // Control state.
  private pendingSkip = 0;
  private pendingInsert = 0;
  private drift = 0; // +1 drop samples, −1 duplicate samples
  private pullCount = 0;
  private winPulls = 0;
  private winSumB = 0;
  private winMinB = Infinity;
  private winLate = 0;
  private winSumRes = 0;
  private winNRes = 0;
  private residency = 1;
  private cleanWindows = 0;
  private decreaseAfter = 5;
  private windowsSinceDecrease = 1e9;

  readonly stats: JitterStats;

  constructor(opts: JitterOptions = {}) {
    this.cap = opts.capacity ?? 128;
    this.mask = this.cap - 1;
    this.slots = Array.from({ length: this.cap }, () => new Float32Array(QUANTUM));
    this.slotSeq = new Float64Array(this.cap).fill(-1);
    this.auto = (opts.margin ?? 'auto') === 'auto';
    this.margin = this.auto ? 1 : (opts.margin as number);
    this.maxDepth = opts.maxDepth ?? 12;
    this.windowPulls = opts.windowPulls ?? 375;
    this.stats = {
      received: 0, played: 0, plc: 0, late: 0, skips: 0, inserts: 0, drops: 0, dups: 0,
      resets: 0, depth: 0, delay: 0, minDepth: 0, margin: this.margin, maxDepth: this.maxDepth,
      playing: false,
    };
  }

  setMargin(m: number | 'auto'): void {
    this.auto = m === 'auto';
    if (!this.auto) this.margin = Math.max(0, Math.round(m as number));
    this.stats.margin = this.margin;
  }

  setMaxDepth(q: number): void {
    this.maxDepth = Math.max(1, q);
    this.stats.maxDepth = this.maxDepth;
  }

  /** Current buffered audio in quanta. */
  bufferedQuanta(): number {
    if (this.state === 'idle') return 0;
    const ahead = this.highestExt - this.playExt + 1;
    return this.state === 'playing' ? ahead + (QUANTUM - this.pos) / QUANTUM : ahead;
  }

  push(seq: number, samples: Float32Array): void {
    if (this.state === 'idle') {
      this.prime(seq);
    }
    const ext = unwrapSeq(seq, this.highestExt);
    const d = ext - this.playExt;
    if (d < 0) {
      this.stats.late++;
      this.winLate++;
      if (++this.lateRun >= 16) {
        // The sender restarted its sequence: follow it.
        this.prime(seq);
        this.store(this.playExt, samples);
        return;
      }
      if (this.auto && this.state === 'playing' && this.pendingInsert === 0 &&
          this.residency + 1 <= this.maxDepth) {
        this.pendingInsert = 1;
      }
      return;
    }
    this.lateRun = 0;
    if (d >= this.cap) {
      this.prime(seq);
      this.store(this.playExt, samples);
      return;
    }
    this.store(ext, samples);
    this.winSumRes += d + (this.state === 'playing' ? (QUANTUM - this.pos) / QUANTUM : 1);
    this.winNRes++;
  }

  pull(out: Float32Array): void {
    if (this.state === 'idle') {
      out.fill(0);
      return;
    }
    if (this.state === 'priming') {
      if (this.highestExt - this.playExt + 1 < 1 + this.margin) {
        out.fill(0);
        return;
      }
      this.state = 'playing';
      this.stats.playing = true;
      this.pos = QUANTUM;
    }

    const b = this.bufferedQuanta();
    this.winSumB += b;
    if (b < this.winMinB) this.winMinB = b;
    this.winPulls++;
    this.pullCount++;

    const correct = this.drift !== 0 && this.pullCount % DRIFT_EVERY === 0;
    const half = out.length >> 1;
    for (let i = 0; i < out.length; i++) {
      if (this.pos >= QUANTUM) this.fetch();
      let s = this.cur[this.pos++]!;
      if (correct && i === half) {
        if (this.drift > 0) {
          if (this.pos >= QUANTUM) this.fetch();
          s = 0.5 * (s + this.cur[this.pos++]!);
          this.stats.drops++;
        } else {
          this.pos--; // read the same sample again next time
          this.stats.dups++;
        }
      }
      out[i] = s;
    }

    // fetch() may have gone idle mid-pull.
    if ((this.state as string) === 'idle') return;
    if (this.winPulls >= this.windowPulls) this.control();
  }

  private prime(seq: number): void {
    if (this.stats.received > 0) this.stats.resets++;
    this.slotSeq.fill(-1);
    const ext = 0x10000 + seq; // keep extended values positive
    this.highestExt = ext - 1;
    this.playExt = ext;
    this.state = 'priming';
    this.stats.playing = false;
    this.pos = QUANTUM;
    this.missingRun = 0;
    this.lateRun = 0;
    this.pendingSkip = 0;
    this.pendingInsert = 0;
    this.drift = 0;
    this.resetWindow();
  }

  private store(ext: number, samples: Float32Array): void {
    const i = ext & this.mask;
    this.slots[i]!.set(samples.subarray(0, QUANTUM));
    this.slotSeq[i] = ext;
    if (ext > this.highestExt) this.highestExt = ext;
    this.stats.received++;
  }

  private has(ext: number): boolean {
    return this.slotSeq[ext & this.mask] === ext;
  }

  private take(ext: number): Float32Array {
    this.slotSeq[ext & this.mask] = -1;
    return this.slots[ext & this.mask]!;
  }

  /** Loads the next quantum into `cur`, applying skips, inserts and PLC. */
  private fetch(): void {
    const ext = this.playExt;
    const cur = this.cur;
    this.pos = 0;

    if (this.pendingSkip > 0 && !(this.has(ext) && this.has(ext + 1))) {
      // Can't crossfade (a neighbour is missing): drop `ext` outright; it would
      // only have been concealment or a lone quantum anyway.
      if (this.has(ext)) this.take(ext);
      this.playExt++;
      this.pendingSkip--;
      this.stats.skips++;
      return this.fetch();
    }

    if (this.pendingSkip > 0) {
      // Drop quantum `ext`: start on it (continuous with what just played) and
      // crossfade into `ext + 1`.
      const a = this.take(ext);
      const b = this.take(ext + 1);
      for (let i = 0; i < QUANTUM; i++) {
        const w = i < FADE ? i / FADE : 1;
        cur[i] = a[i]! * (1 - w) + b[i]! * w;
      }
      this.playExt += 2;
      this.pendingSkip--;
      this.stats.skips++;
      this.stats.played++;
      this.afterGood();
      return;
    }

    if (this.pendingInsert > 0 && this.lastValid && this.missingRun === 0) {
      // Play the previous quantum once more without advancing: start on the
      // natural continuation (`ext` if present) and crossfade into the repeat,
      // whose end flows back into `ext`.
      const next = this.has(ext) ? this.slots[ext & this.mask]! : null;
      for (let i = 0; i < QUANTUM; i++) {
        const w = i < FADE ? i / FADE : 1;
        cur[i] = (next ? next[i]! * (1 - w) : 0) + this.last[i]! * (next ? w : 1);
      }
      this.pendingInsert--;
      this.stats.inserts++;
      return;
    }

    if (this.has(ext)) {
      const q = this.take(ext);
      if (this.missingRun > 0) {
        // Crossfade from the concealment tail into real audio.
        const g = this.missingRun <= PLC_MAX ? 1 - this.missingRun / PLC_MAX : 0;
        for (let i = 0; i < QUANTUM; i++) {
          const w = i < FADE ? i / FADE : 1;
          cur[i] = q[i]! * w + this.last[i]! * g * (1 - w);
        }
      } else {
        cur.set(q);
      }
      this.playExt++;
      this.stats.played++;
      this.afterGood();
      return;
    }

    // Packet concealment: repeat the last quantum with a fade, then silence.
    this.missingRun++;
    this.stats.plc++;
    this.playExt++;
    if (this.lastValid && this.missingRun <= PLC_MAX) {
      const g0 = 1 - (this.missingRun - 1) / PLC_MAX;
      const g1 = 1 - this.missingRun / PLC_MAX;
      for (let i = 0; i < QUANTUM; i++) cur[i] = this.last[i]! * (g0 + ((g1 - g0) * i) / QUANTUM);
    } else {
      cur.fill(0);
    }
    if (this.missingRun >= IDLE_AFTER) {
      // Stream stopped: re-prime on the next packet instead of letting a gap
      // turn into permanent extra latency.
      this.state = 'idle';
      this.stats.playing = false;
      this.lastValid = false;
    }
  }

  private afterGood(): void {
    this.last.set(this.cur);
    this.lastValid = true;
    this.missingRun = 0;
  }

  private control(): void {
    const meanB = this.winSumB / this.winPulls;
    const minB = this.winMinB;
    if (this.winNRes > 0) this.residency = this.winSumRes / this.winNRes;
    const res = this.residency;
    this.stats.depth = meanB;
    this.stats.delay = res;
    this.stats.minDepth = minB;

    if (this.auto) {
      if (this.winLate > 0) {
        if (this.windowsSinceDecrease <= 3) this.decreaseAfter = Math.min(this.decreaseAfter * 2, 64);
        if (res + 1 <= this.maxDepth) this.margin++;
        this.cleanWindows = 0;
      } else if (++this.cleanWindows >= this.decreaseAfter && this.margin > 0) {
        this.margin--;
        this.cleanWindows = 0;
        this.windowsSinceDecrease = 0;
      }
      this.windowsSinceDecrease++;
    }
    this.margin = Math.min(this.margin, Math.max(0, Math.floor(this.maxDepth) - 1));
    this.stats.margin = this.margin;

    const excess = minB - (1 + this.margin);
    let skip = excess >= 1 ? Math.floor(excess) : 0;
    // Hard budget cap: never let the buffer delay exceed maxDepth.
    if (res - skip > this.maxDepth + 0.5) skip = Math.ceil(res - this.maxDepth);
    this.pendingSkip = Math.min(skip, 32);
    this.drift = skip > 0 ? 0 : excess > 0.35 ? 1 : excess < -0.35 && res < this.maxDepth ? -1 : 0;

    this.resetWindow();
  }

  private resetWindow(): void {
    this.winPulls = 0;
    this.winSumB = 0;
    this.winMinB = Infinity;
    this.winLate = 0;
    this.winSumRes = 0;
    this.winNRes = 0;
  }
}
