import { getHeapSpaceStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { HazardKind } from './HazardLog';
import { DEMO, buildDemoHull, seedDemoCrew, setRoomPressure, warmUpCrew, warmUpKernels } from './scenes';
import { Simulation } from './Simulation';
import { ToolKind } from './WorkOrderQueue';
import { World } from './World';

declare const gc: (() => void) | undefined;

function newSpaceUsed(): number {
  for (const s of getHeapSpaceStatistics()) if (s.space_name === 'new_space') return s.space_used_size;
  throw new Error('new_space not reported');
}

/** Young-generation bytes allocated while running `ticks` world (or full simulation) ticks. */
function bytesAllocatedDuring(sim: { tick(): void }, ticks: number): number {
  gc?.();
  const before = newSpaceUsed();
  for (let t = 0; t < ticks; t++) sim.tick();
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

  it('allocates nothing per tick with pawns pathing, cutting, refusing and fleeing', { timeout: 90_000 }, () => {
    warmUpKernels(new World());
    warmUpCrew(new Simulation());
    // Pawn states are individually cold (one pawn refuses a cut now and then), so V8 tiers
    // them up late. Run the scenario once unmeasured, then measure an identical second run:
    // whatever is left is per-tick garbage, not JIT warm-up.
    crewScenario(new Simulation(), null);
    crewScenario(new Simulation(), null);
    const bytes = new Float64Array(3);
    const sim = crewScenario(new Simulation(), bytes);
    const [working, refusing, fleeing] = bytes;

    expect(sim.orders.count).toBeLessThan(13);
    expect(sim.hazards.countOf(HazardKind.CUT_REFUSED_PRESSURE)).toBeGreaterThan(0);
    expect(sim.hazards.countOf(HazardKind.DECOMPRESSION)).toBeGreaterThan(0);

    console.log(`new-space bytes over ${TICKS} sim ticks: working=${working} refusing=${refusing} fleeing=${fleeing}`);
    expect(working / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(refusing / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(fleeing / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
  });
});

/**
 * Demo crew cutting interior bulkheads, then refusing frame cuts in a 5 bar room, then
 * caught by a breach. Writes the bytes allocated in each phase into `out` when given.
 */
function crewScenario(sim: Simulation, out: Float64Array | null): Simulation {
  const { world, orders, pawns } = sim;
  const run = (phase: number): void => {
    if (out) out[phase] = bytesAllocatedDuring(sim, TICKS);
    else for (let t = 0; t < TICKS; t++) sim.tick();
  };
  buildDemoHull(world);
  seedDemoCrew(sim);
  for (let t = 0; t < 200; t++) sim.tick();

  // Pathing and cutting interior bulkheads.
  const lockX = DEMO.hull.x0 + 7;
  for (let y = 52; y < 62; y++) orders.addOrder(lockX, y, 3, ToolKind.CUTTER);
  run(0);

  // A 5 bar room against vacuum: every frame order is refused.
  setRoomPressure(world, 5);
  orders.addOrder(66, DEMO.hull.y0, 5, ToolKind.HEAVY_CUTTER);
  orders.addOrder(70, DEMO.hull.y1, 5, ToolKind.HEAVY_CUTTER);
  run(1);

  // Breach next to the crew: drag, fleeing, refuge search, clamping.
  for (let p = 0; p < pawns.capacity; p++) {
    if (pawns.alive[p] === 0) continue;
    pawns.pos[p * 2] = DEMO.hull.x1 - 1.5;
    pawns.pos[p * 2 + 1] = 64.5;
  }
  world.cutTile(DEMO.hull.x1, 64);
  run(2);
  return sim;
}
