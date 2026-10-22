import { describe, expect, it } from 'vitest';
import { FIRE_MIN_BAR } from './GasGrid';
import { HazardKind } from './HazardLog';
import { PawnState, PawnWarning } from './PawnManager';
import { DEMO, addFuelTank, buildDemoHull } from './scenes';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { World } from './World';

function hull(): World {
  const w = new World();
  buildDemoHull(w);
  return w;
}

function run(w: { tick(): void }, ticks: number, until: () => boolean = () => false): number {
  for (let t = 0; t < ticks; t++) {
    w.tick();
    if (until()) return t;
  }
  return ticks;
}

describe('fire', () => {
  it('grows and spreads through a pressurised room, burning its gas into smoke, and the books balance', () => {
    const w = hull();
    const mass = w.gas.totalMass();
    w.gas.ignite(w.index(66, 64), 0.5);
    run(w, 20 * 10);
    expect(w.gas.burningCount).toBeGreaterThan(20);
    expect(w.gas.fire[w.index(66, 64)]).toBeGreaterThan(0.9);
    expect(w.gas.totalMass()).toBeLessThan(mass * 0.97);
    expect(w.gas.totalToxin()).toBeGreaterThan(0);
    expect(w.gas.totalMass() + w.gas.vacuumAbsorbed + w.gas.burned).toBeCloseTo(mass, 0);
  });

  it('cannot burn where there is too little gas, and venting the room smothers it', { timeout: 30_000 }, () => {
    const w = hull();
    w.gas.ignite(w.index(66, 64), 1);
    run(w, 20 * 5);
    expect(w.gas.burningCount).toBeGreaterThan(0);
    for (let y = 60; y <= 68; y++) w.cutTile(DEMO.hull.x1, y);
    run(w, 20 * 60, () => w.gas.burningCount === 0);
    expect(w.gas.burningCount).toBe(0);
    // A vented cell will not take fire at all.
    w.gas.ignite(w.index(66, 64), 1);
    expect(w.gas.current[w.index(66, 64)]).toBeLessThan(FIRE_MIN_BAR);
    expect(w.gas.fire[w.index(66, 64)]).toBe(0);
  });

  it('weakens the members it burns beside', () => {
    const w = hull();
    const node = w.index(DEMO.hull.x0, 64);
    const e = w.lattice.edgeAdjacency[node * 4 + 2];
    const before = w.lattice.edgeCapacity[e];
    w.gas.ignite(w.index(DEMO.hull.x0 + 1, 64), 1);
    run(w, 20 * 5);
    expect(w.lattice.edgeCapacity[e]).toBeLessThan(before);
  });
});

describe('fuel tanks', () => {
  it('explode when cut: the tank goes, the gas spikes, fire takes hold, and members beside it tear', () => {
    const w = hull();
    // A one-tile tank against the left frame.
    addFuelTank(w, DEMO.hull.x0 + 1, 64, 1, 1);
    expect(w.getTile(DEMO.hull.x0 + 1, 64) & TileFlags.FUEL).not.toBe(0);
    w.cutTile(DEMO.hull.x0 + 1, 64);
    expect(w.explosionsTotal).toBe(1);
    expect(w.getTile(DEMO.hull.x0 + 1, 64)).toBe(TileFlags.FLOOR);
    expect(w.gas.current[w.index(DEMO.hull.x0 + 2, 64)]).toBeGreaterThan(2);
    expect(w.gas.fire[w.index(DEMO.hull.x0 + 2, 64)]).toBeGreaterThan(0.3);
    expect(w.lattice.totalSnapped).toBeGreaterThan(0);
  });

  it('set each other off in a chain, one link per tick', () => {
    const w = hull();
    addFuelTank(w, 64, 60, 1, 1);
    addFuelTank(w, 67, 60, 1, 1);
    addFuelTank(w, 70, 60, 1, 1);
    w.cutTile(64, 60);
    expect(w.explosionsTotal).toBe(1);
    w.tick();
    expect(w.explosionsTotal).toBe(2);
    w.tick();
    expect(w.explosionsTotal).toBe(3);
    for (const x of [64, 67, 70]) expect(w.getTile(x, 60) & TileFlags.FUEL).toBe(0);
  });

  it('cook off when fire burns beside them', { timeout: 30_000 }, () => {
    const w = hull();
    addFuelTank(w, 70, 64, 1, 1);
    w.gas.ignite(w.index(69, 64), 1);
    run(w, 20 * 20, () => w.explosionsTotal > 0);
    expect(w.explosionsTotal).toBe(1);
  });

  it('hurt and throw the crew nearby, and crews will not put a torch to one', () => {
    const sim = new Simulation();
    buildDemoHull(sim.world);
    const near = sim.pawns.spawn(66, 64);
    const far = sim.pawns.spawn(56, 52);
    addFuelTank(sim.world, 68, 64, 1, 1);
    sim.world.cutTile(68, 64);
    sim.tick();
    expect(sim.hazards.countOf(HazardKind.EXPLOSION)).toBe(1);
    expect(sim.pawns.health[near]).toBeLessThan(80);
    expect(sim.pawns.vel[near * 2]).toBeLessThan(-1);
    expect(sim.pawns.health[far]).toBeGreaterThan(95);

    const crew = new Simulation();
    buildDemoHull(crew.world);
    crew.pawns.spawn(66, 64);
    addFuelTank(crew.world, 70, 64, 1, 1);
    crew.orders.addOrder(70, 64);
    run(crew, 200, () => crew.hazards.countOf(HazardKind.CUT_REFUSED_FUEL) > 0);
    expect(crew.hazards.countOf(HazardKind.CUT_REFUSED_FUEL)).toBe(1);
    expect(crew.world.getTile(70, 64) & TileFlags.FUEL).not.toBe(0);
    expect(crew.world.explosionsTotal).toBe(0);
  });

  it('send the crew running from the flames, which burn them', { timeout: 30_000 }, () => {
    const sim = new Simulation();
    buildDemoHull(sim.world);
    const p = sim.pawns.spawn(66, 64);
    for (let y = 62; y <= 66; y++) for (let x = 64; x <= 68; x++) sim.world.gas.ignite(sim.world.index(x, y), 1);
    sim.tick();
    expect(sim.paths.getCost(66, 64)).toBeGreaterThan(sim.paths.getCost(56, 52));
    let fled = false;
    let warned = false;
    run(sim, 40, () => {
      fled ||= sim.pawns.state[p] === PawnState.FLEEING;
      warned ||= (sim.pawns.warnings[p] & PawnWarning.FIRE) !== 0;
      return false;
    });
    expect(warned).toBe(true);
    expect(fled).toBe(true);
    expect(sim.pawns.health[p]).toBeLessThan(100);
  });
});
