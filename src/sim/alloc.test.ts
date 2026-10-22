import { Session } from 'node:inspector/promises';
import { getHeapSpaceStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { PawnState } from './PawnManager';
import { HazardKind } from './HazardLog';
import {
  DEMO,
  buildDemoHull,
  grappleHull,
  looseDeckPatch,
  seedDemoCrew,
  setRoomPressure,
  strandedCrewman,
  warmUpCrew,
  warmUpKernels,
} from './scenes';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { ToolKind } from './WorkOrderQueue';
import { World } from './World';

declare const gc: (() => void) | undefined;

interface SamplingNode {
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children: SamplingNode[];
}
interface SamplingProfile {
  head: SamplingNode;
}

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
/**
 * One-off allowance per tile lifted on the tick a structure tears free. Building a body is
 * an event, not per-tick work, and it runs too rarely to stay optimised: V8 drops the
 * optimised per-tile code once the warm-up world is collected, so the first real tear
 * runs interpreted (~640 B per tile, one scavenge for the whole hull). The ticks after it
 * are held to the per-tick limit by the drifting and towing phases.
 */
const TEAR_OFF_BYTES_PER_TILE = 1024;

describe('tick loop allocations', () => {
  it('runs with --expose-gc so the heap starts clean', () => {
    expect(typeof gc).toBe('function');
  });

  it('allocates nothing per tick sealed, venting, venting toxin, tearing free, drifting and towing', { timeout: 90_000 }, () => {
    warmUpKernels(new World());
    const world = new World();
    buildDemoHull(world);
    // Let tier-up from the fresh build finish; the sealed hull does not change state.
    for (let t = 0; t < 500; t++) world.tick();

    const steady = bytesAllocatedDuring(world, TICKS);

    world.cutTile(DEMO.hull.x1, 64);
    const venting = bytesAllocatedDuring(world, TICKS);

    // A second, wider breach with a toxic leak feeding the room: the flow pass carries the
    // toxin out through both holes.
    for (let y = 70; y < 74; y++) world.cutTile(DEMO.hull.x1, y);
    world.setTile(70, 64, TileFlags.FLOOR | TileFlags.HAZARD_LEAK);
    const toxic = bytesAllocatedDuring(world, TICKS);
    expect(world.gas.toxinVented).toBeGreaterThan(0);

    // On a fresh hull, cutting an arm forces snaps, topology rebuilds and flood fills inside
    // tick(), and the hull tears free into debris.
    buildDemoHull(world);
    for (let t = 0; t < 500; t++) world.tick();
    world.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
    const tearing = bytesAllocatedDuring(world, TICKS);
    expect(world.lattice.totalSnapped).toBeGreaterThan(0);
    expect(world.debris.count).toBeGreaterThan(0);
    const lifted = world.debris.tilesUsed;

    const drifting = bytesAllocatedDuring(world, TICKS);
    // Grapple the wreck into the gantry: contacts, impulses and position corrections.
    expect(grappleHull(world)).toBe(true);
    const contacts = world.debris.contactsTotal;
    const towing = bytesAllocatedDuring(world, TICKS);
    expect(world.debris.contactsTotal).toBeGreaterThan(contacts);

    console.log(
      `new-space bytes over ${TICKS} ticks: steady=${steady} venting=${venting} toxic=${toxic} ` +
        `tearing=${tearing} drifting=${drifting} towing=${towing}`,
    );
    expect(steady / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(venting / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(toxic / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect((tearing - lifted * TEAR_OFF_BYTES_PER_TILE) / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(drifting / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    expect(towing / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
  });

  it('allocates nothing per tick with pawns pathing, cutting, refusing and fleeing', { timeout: 300_000 }, () => {
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

  it('allocates nothing per tick while a cabin fire spreads and the crew runs from it', { timeout: 300_000 }, () => {
    warmUpKernels(new World());
    warmUpCrew(new Simulation());
    const scenario = (sim: Simulation, measure: boolean): number => {
      buildDemoHull(sim.world);
      sim.resetCrew();
      seedDemoCrew(sim);
      sim.world.gas.ignite(sim.world.index(66, 64), 1);
      if (measure) return bytesAllocatedDuring(sim, TICKS);
      for (let t = 0; t < TICKS; t++) sim.tick();
      return 0;
    };
    // Four warm-up runs, not two: the knockouts, deaths and rescues happen only about ten
    // times a run, so V8 needs a few runs to optimise that code. Measured across repeats,
    // runs 1 and 2 still allocate ~10 KB while it tiers up; from run 3 on the whole run
    // allocates ~350 B beyond the measurement itself (0.2 B/tick).
    for (let r = 0; r < 4; r++) scenario(new Simulation(), false);
    const sim = new Simulation();
    const bytes = scenario(sim, true);
    console.log(`new-space bytes over ${TICKS} sim ticks: fire=${bytes}`);
    expect(sim.world.gas.burned).toBeGreaterThan(1);
    expect(bytes / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
  });

  it('allocates nothing per tick through a space rescue: suit air, knockout, flight out, carry back', { timeout: 300_000 }, () => {
    warmUpKernels(new World());
    warmUpCrew(new Simulation());
    rescueScenario(new Simulation(), false);
    rescueScenario(new Simulation(), false);
    const sim = new Simulation();
    const bytes = rescueScenario(sim, true);
    console.log(`new-space bytes over ${TICKS} sim ticks: rescue=${bytes}`);
    expect(sim.hazards.countOf(HazardKind.RESCUED)).toBe(1);
    expect(bytes / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
  });

  it(
    'allocates nothing per tick while the crew tows a chunk to a bin and flies home',
    { timeout: 300_000 },
    async () => {
      warmUpKernels(new World());
      warmUpCrew(new Simulation());
      haulScenario(new Simulation(), false);
      haulScenario(new Simulation(), false);
      const sim = new Simulation();
      // Sample every allocation during the measured run and charge each to the function that
      // made it. Only setup (clearing and spawning the crew) and the once-per-tow steps
      // (boarding, letting go, logging) may allocate in PawnManager; the per-tick approach,
      // tug and return code must not.
      const session = new Session();
      session.connect();
      await session.post('HeapProfiler.startSampling', { samplingInterval: 16 });
      const { bytes, towed } = haulScenario(sim, true);
      const { profile } = (await session.post('HeapProfiler.stopSampling')) as { profile: SamplingProfile };
      session.disconnect();
      let pawnBytes = 0;
      const ONE_OFF = new Set(['clear', 'spawn', 'board', 'endTow', 'abandonHaul', 'releaseHaul', 'log']);
      const walk = (n: SamplingNode): void => {
        if (n.callFrame.url.includes('PawnManager') && !ONE_OFF.has(n.callFrame.functionName)) pawnBytes += n.selfSize;
        for (const c of n.children) walk(c);
      };
      walk(profile.head);
      console.log(`new-space bytes over ${TICKS} sim ticks: hauling=${bytes} (PawnManager per-tick: ${pawnBytes})`);
      expect(towed).toBe(true);
      expect(sim.world.salvage.credits).toBeGreaterThan(0);
      expect(pawnBytes).toBe(0);
      // Boarding and delivery are one-offs of a few KB; everything else must be allocation-free.
      expect(bytes / TICKS).toBeLessThan(MAX_BYTES_PER_TICK);
    },
  );
});

/**
 * A crewman blown out unconscious and a rescue: knockout, walk to the edge, flight out, grab,
 * flight back, carry, set down, recovery. Two unmeasured runs, then one measured.
 */
function rescueScenario(sim: Simulation, measure: boolean): number {
  strandedCrewman(sim);
  if (measure) return bytesAllocatedDuring(sim, TICKS);
  for (let t = 0; t < TICKS; t++) sim.tick();
  return 0;
}

/**
 * Four pawns in a vented demo hull with a loose deck patch by an opened stern: one tows it
 * to the furnace and flies home. Measures the 2000 ticks after the chunk is set loose
 * (approach, boarding, tug, delivery, return, idle) when `measure` is set.
 */
function haulScenario(sim: Simulation, measure: boolean): { bytes: number; towed: boolean } {
  const { world, pawns } = sim;
  buildDemoHull(world);
  setRoomPressure(world, 0);
  sim.resetCrew();
  for (let k = 0; k < 4; k++) pawns.spawn(74, 60 + k * 2);
  for (let t = 0; t < 40; t++) sim.tick();
  looseDeckPatch(world);
  let towed = false;
  let bytes = 0;
  if (measure) bytes = bytesAllocatedDuring(sim, TICKS);
  else for (let t = 0; t < TICKS; t++) sim.tick();
  for (let p = 0; p < 4; p++) towed ||= pawns.state[p] === PawnState.IDLE && world.salvage.credits > 0;
  return { bytes, towed };
}

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
