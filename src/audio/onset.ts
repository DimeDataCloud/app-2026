/**
 * Click/transient detector used by the device loopback test and the end-to-end
 * latency check. Triggers when |x| exceeds both an absolute threshold and a
 * multiple of the running noise floor, then holds off to ignore the tail.
 */
export class OnsetDetector {
  private noise = 0.001;
  private hold = 0;

  constructor(
    private readonly threshold = 0.2,
    private readonly holdoffFrames = 9600,
    private readonly noiseRatio = 8,
  ) {}

  /** Returns the frame index of the first onset in `block`, or -1. */
  feed(block: Float32Array, startFrame: number): number {
    let found = -1;
    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i]!);
      if (this.hold > 0) {
        this.hold--;
        continue;
      }
      if (found < 0 && a > this.threshold && a > this.noise * this.noiseRatio) {
        found = startFrame + i;
        this.hold = this.holdoffFrames;
        continue;
      }
      this.noise += (a - this.noise) * 0.001;
    }
    return found;
  }
}
