import { describe, expect, it } from 'vitest';
import { HazardKind } from './HazardLog';
import {
  DEATH_HEALTH,
  IMPACT_SPEED,
  JobKind,
  MAX_HEALTH,
  PawnState,
  SUIT_O2,
  WAKE_HEALTH,
} from './PawnManager';
import { DEMO, buildDemoHull, setRoomPressure, strandedCrewman } from './scenes';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';

function run(sim: Simulation, ticks: number, until: () => boolean = () => false): number {
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    if (until()) return t;
  }
  return ticks;
}

function hull(bar: number): Simulation {
  const sim = new Simulation();
  buildDemoHull(sim.world);
  setRoomPressure(sim.world, bar);
  return sim;
}

/** No one in the crew will go and fetch anyone. */
function noRescuers(sim: Simulation): void {
  for (let p = 0; p < sim.pawns.capacity; p++) if (sim.pawns.alive[p]) sim.pawns.setJobPriority(p, JobKind.RESCUE, 0);
}

describe('suit air and health', () => {
  it('draws on suit air in vacuum and tops it up in breathable air', () => {
    const vac = hull(0);
    const p = vac.pawns.spawn(66, 64);
    run(vac, 20 * 10);
    expect(vac.pawns.oxygen[p]).toBeCloseTo(SUIT_O2 - 10, 0);
    expect(vac.pawns.health[p]).toBe(MAX_HEALTH);

    const air = hull(1);
    const q = air.pawns.spawn(66, 64);
    air.pawns.oxygen[q] = 50;
    run(air, 20 * 10);
    expect(air.pawns.oxygen[q]).toBe(SUIT_O2);
  });

  it('suffocates with no air: knocked out, then dead if no one comes', () => {
    const sim = hull(0);
    const p = sim.pawns.spawn(66, 64);
    noRescuers(sim);
    sim.pawns.oxygen[p] = 1;
    run(sim, 20 * 20, () => sim.pawns.state[p] === PawnState.DOWN);
    expect(sim.pawns.state[p]).toBe(PawnState.DOWN);
    expect(sim.hazards.countOf(HazardKind.KNOCKED_OUT)).toBe(1);
    run(sim, 20 * 20, () => sim.pawns.alive[p] === 0);
    expect(sim.pawns.alive[p]).toBe(0);
    expect(sim.pawns.count).toBe(0);
    expect(sim.hazards.countOf(HazardKind.DIED)).toBe(1);
    expect(DEATH_HEALTH).toBeLessThan(0);
  });

  it('heals while the suit has air, and a downed pawn gets back up', () => {
    const sim = hull(1);
    const p = sim.pawns.spawn(66, 64);
    noRescuers(sim);
    sim.pawns.health[p] = -5;
    run(sim, 2);
    expect(sim.pawns.state[p]).toBe(PawnState.DOWN);
    run(sim, 20 * 30, () => sim.pawns.state[p] !== PawnState.DOWN);
    expect(sim.pawns.state[p]).toBe(PawnState.IDLE);
    expect(sim.pawns.health[p]).toBeGreaterThanOrEqual(WAKE_HEALTH);
  });

  it('hurts to hit a wall fast, and toxin eats the suit', () => {
    const sim = hull(0);
    const p = sim.pawns.spawn(80, 64);
    noRescuers(sim);
    // Adrift outside the hull and thrown back at its right frame, well over the impact speed.
    sim.pawns.pos[p * 2] = DEMO.hull.x1 + 4.5;
    sim.pawns.vel[p * 2] = -(IMPACT_SPEED + 6);
    run(sim, 10);
    expect(sim.pawns.health[p]).toBeLessThan(MAX_HEALTH - 20);
    expect(sim.pawns.suit[p]).toBeLessThan(100);

    // Half a bar of toxin through the whole room: 0.5 x 3 per second, so about 15 in 10 s.
    const tox = hull(1);
    const q = tox.pawns.spawn(66, 64);
    noRescuers(tox);
    const { x0, y0, x1, y1 } = DEMO.hull;
    for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) tox.world.gas.toxin[tox.world.index(x, y)] = 0.5;
    run(tox, 20 * 10);
    expect(tox.pawns.suit[q]).toBeLessThan(90);
    expect(tox.pawns.suit[q]).toBeGreaterThan(80);
  });
});

describe('rescue', () => {
  it('carries a downed pawn out of a toxic cloud to clean air, where it comes round', { timeout: 60_000 }, () => {
    const sim = hull(1);
    const victim = sim.pawns.spawn(70, 64);
    const rescuer = sim.pawns.spawn(58, 56);
    sim.pawns.setJobPriority(victim, JobKind.RESCUE, 0);
    // A thick toxic cloud around the victim, and the victim knocked out in it.
    for (let y = 60; y <= 68; y++) for (let x = 66; x <= 74; x++) sim.world.gas.toxin[sim.world.index(x, y)] = 1;
    sim.pawns.health[victim] = -5;
    let carried = false;
    run(sim, 20 * 60, () => {
      carried ||= sim.pawns.carriedBy[victim] === rescuer;
      return sim.hazards.countOf(HazardKind.RESCUED) > 0;
    });
    expect(carried).toBe(true);
    expect(sim.hazards.countOf(HazardKind.RESCUED)).toBe(1);
    expect(sim.pawns.carriedBy[victim]).toBe(-1);
    expect(sim.paths.breathable[sim.pawns.cellOf[victim]]).toBe(1);
    run(sim, 20 * 40, () => sim.pawns.state[victim] !== PawnState.DOWN);
    expect(sim.pawns.state[victim]).toBe(PawnState.IDLE);
    expect(sim.pawns.alive[victim]).toBe(1);
  });

  it('flies out for a pawn drifting in space and brings them back aboard', { timeout: 60_000 }, () => {
    const sim = new Simulation();
    const victim = strandedCrewman(sim);
    let flew = false;
    run(sim, 20 * 90, () => {
      for (let p = 0; p < 3; p++) flew ||= sim.pawns.state[p] === PawnState.RESCUE_FLY;
      return sim.hazards.countOf(HazardKind.RESCUED) > 0;
    });
    expect(flew).toBe(true);
    expect(sim.hazards.countOf(HazardKind.RESCUED)).toBe(1);
    const c = sim.pawns.cellOf[victim];
    expect(sim.world.tiles[c] & TileFlags.FLOOR).not.toBe(0);
    expect(sim.pawns.alive[victim]).toBe(1);
    // Rescuers are back to work, not still flying.
    run(sim, 20 * 30);
    for (let p = 0; p < 3; p++) {
      expect([PawnState.RESCUE_FLY, PawnState.RESCUE_CARRY, PawnState.RETURNING]).not.toContain(sim.pawns.state[p]);
    }
    expect(DEMO.engine.x).toBeGreaterThan(0);
  });
});
