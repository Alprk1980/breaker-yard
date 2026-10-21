import { describe, expect, it } from 'vitest';
import { FixedTimestep } from './FixedTimestep';

describe('FixedTimestep', () => {
  it('emits one tick per 50 ms and carries the remainder', () => {
    const clock = new FixedTimestep(50);
    expect(clock.advance(16)).toBe(0);
    expect(clock.advance(16)).toBe(0);
    expect(clock.advance(20)).toBe(1);
    expect(clock.alpha).toBeCloseTo(2 / 50, 6);
    expect(clock.advance(100)).toBe(2);
  });

  it('clamps long frame gaps', () => {
    const clock = new FixedTimestep(50, 250);
    expect(clock.advance(10_000)).toBe(5);
  });
});
