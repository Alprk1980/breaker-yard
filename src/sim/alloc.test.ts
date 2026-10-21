import { getHeapSpaceStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { DEMO, buildDemoHull, warmUpKernels } from './scenes';
import { World } from './World';

declare const gc: (() => void) | undefined;

function newSpaceUsed(): number {
  for (const s of getHeapSpaceStatistics()) if (s.space_name === 'new_space') return s.space_used_size;
  throw new Error('new_space not reported');
}

/** Young-generation bytes allocated while running `ticks` world ticks. */
function bytesAllocatedDuring(world: World, ticks: number): number {
  gc?.();
  const before = newSpaceUsed();
  for (let t = 0; t < ticks; t++) world.tick();
  return newSpaceUsed() - before;
}

const TICKS = 2000;
// The smallest possible per-tick allocation (one boxed double) is 16 bytes, so anything
// allocated every tick shows up as >= 16 B/tick. A few KB of one-off cost (the measurement
// itself is ~2.5 KB with an empty loop) stays well under 4 B/tick over 2000 ticks.
const MAX_BYTES_PER_TICK = 4;

describe('tick loop allocations', () => {
  it('runs with --expose-gc so the heap starts clean', () => {
    expect(typeof gc).toBe('function');
  });

  it('allocates nothing per tick in steady state, while venting, and while snapping', { timeout: 30_000 }, () => {
    warmUpKernels(new World());
    const world = new World();
    buildDemoHull(world);
    // Let tier-up from the fresh build finish; the sealed hull does not change state.
    for (let t = 0; t < 500; t++) world.tick();

    const steady = bytesAllocatedDuring(world, TICKS);

    world.cutTile(DEMO.hull.x1, 64);
    const venting = bytesAllocatedDuring(world, TICKS);

    // Cutting an arm forces snaps, topology rebuilds and flood fills inside tick().
    world.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
    const snapping = bytesAllocatedDuring(world, TICKS);
    expect(world.lattice.totalSnapped).toBeGreaterThan(0);

    console.log(`new-space bytes over ${TICKS} ticks: steady=${steady} venting=${venting} snapping=${snapping}`);
    expect(steady / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(venting / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(snapping / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
  });
});
