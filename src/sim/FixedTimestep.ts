import { TICK_MS } from './constants';

/**
 * Accumulator that converts variable frame time into whole fixed ticks.
 * Frame gaps are clamped so a backgrounded tab does not trigger a tick storm.
 */
export class FixedTimestep {
  private accumulator = 0;

  constructor(
    readonly stepMs = TICK_MS,
    readonly maxFrameMs = 250,
  ) {}

  /** Adds elapsed wall time and returns how many ticks are due. */
  advance(elapsedMs: number): number {
    this.accumulator += Math.min(Math.max(elapsedMs, 0), this.maxFrameMs);
    let ticks = 0;
    while (this.accumulator >= this.stepMs) {
      this.accumulator -= this.stepMs;
      ticks++;
    }
    return ticks;
  }

  /** Fraction of the next tick already elapsed, for render interpolation. */
  get alpha(): number {
    return this.accumulator / this.stepMs;
  }
}
