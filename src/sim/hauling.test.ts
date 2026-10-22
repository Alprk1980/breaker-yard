import { describe, expect, it } from 'vitest';
import { HazardKind } from './HazardLog';
import { MATERIAL_VALUE, Material } from './materials';
import { JobKind, PawnState } from './PawnManager';
import { DEMO, buildDemoHull, looseDeckPatch, setRoomPressure } from './scenes';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { OrderKind } from './WorkOrderQueue';

/** The demo hull, already vented, so cuts do not set off blowouts mid-test. */
function ventedHull(): Simulation {
  const sim = new Simulation();
  buildDemoHull(sim.world);
  setRoomPressure(sim.world, 0);
  return sim;
}

function run(sim: Simulation, ticks: number, until: () => boolean = () => false): number {
  for (let t = 0; t < ticks; t++) {
    sim.tick();
    if (until()) return t;
  }
  return ticks;
}

describe('salvage designation', () => {
  it('orders the ring of tiles around the rectangle to be severed', () => {
    const sim = ventedHull();
    // The engine block on the right frame: ring is the floor column inside it and the frame
    // tiles above and below. The vacuum side has nothing to cut.
    const placed = sim.designateSalvage(DEMO.engine.x, DEMO.engine.y0, DEMO.engine.x, DEMO.engine.y1);
    const span = DEMO.engine.y1 - DEMO.engine.y0 + 3;
    expect(placed).toBe(span + 2);
    for (let y = DEMO.engine.y0 - 1; y <= DEMO.engine.y1 + 1; y++) {
      const slot = sim.orders.orderAt(DEMO.engine.x - 1, y);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(sim.orders.kind[slot]).toBe(OrderKind.SEVER);
    }
    expect(sim.orders.hasOrder(DEMO.engine.x, DEMO.engine.y0)).toBe(false);
  });

  it('keeps wall orders as they were: a cut wall becomes deck and the order is done', () => {
    const sim = ventedHull();
    const lockX = DEMO.hull.x0 + 7;
    sim.orders.addOrder(lockX, 56);
    sim.pawns.spawn(lockX + 2, 56);
    run(sim, 600, () => sim.orders.count === 0);
    expect(sim.orders.count).toBe(0);
    expect(sim.world.getTile(lockX, 56)).toBe(TileFlags.FLOOR);
  });
});

describe('crew hauling', () => {
  it('severs the engine free, tows it to the barge, and flies home', { timeout: 60_000 }, () => {
    const sim = ventedHull();
    for (const [x, y] of DEMO.crew) sim.pawns.spawn(x, y);
    sim.designateSalvage(DEMO.engine.x, DEMO.engine.y0, DEMO.engine.x, DEMO.engine.y1);
    let towed = false;
    run(sim, 20 * 150, () => {
      for (let p = 0; p < 3; p++) towed ||= sim.pawns.state[p] === PawnState.TUGGING;
      return sim.world.salvage.credits > 0;
    });
    expect(towed).toBe(true);
    expect(sim.world.salvage.deliveredByMaterial[Material.ENGINE_PART]).toBe(DEMO.engine.y1 - DEMO.engine.y0 + 1);
    expect(sim.world.salvage.credits).toBe(13 * MATERIAL_VALUE[Material.ENGINE_PART]);
    expect(sim.world.salvage.missortedTiles).toBe(0);
    // Everyone ends up back aboard: no one left flying, no claims left on dead bodies.
    run(sim, 20 * 60, () => {
      for (let p = 0; p < 3; p++) if (sim.pawns.state[p] === PawnState.RETURNING) return false;
      return true;
    });
    for (let p = 0; p < 3; p++) {
      expect(sim.pawns.state[p]).not.toBe(PawnState.RETURNING);
      expect(sim.pawns.haulBody[p]).toBe(-1);
      const tx = Math.floor(sim.pawns.pos[p * 2]);
      const ty = Math.floor(sim.pawns.pos[p * 2 + 1]);
      expect(sim.world.getTile(tx, ty) & TileFlags.FLOOR).not.toBe(0);
    }
    expect([...sim.pawns.bodyHauler].every((v) => v === -1)).toBe(true);
  });

  const looseDeck = (sim: Simulation): number => looseDeckPatch(sim.world);

  it('leaves loose chunks alone when hauling is switched off, and hauls them when it is on', { timeout: 60_000 }, () => {
    const off = ventedHull();
    const p = off.pawns.spawn(74, 64);
    off.pawns.setJobPriority(p, JobKind.HAUL, 0);
    looseDeck(off);
    run(off, 400);
    expect(off.pawns.haulBody[p]).toBe(-1);
    expect(off.world.salvage.credits).toBe(0);

    const on = ventedHull();
    on.pawns.spawn(74, 64);
    looseDeck(on);
    run(on, 20 * 60, () => on.world.salvage.credits > 0);
    expect(on.world.salvage.deliveredByMaterial[Material.DECK_PLATE]).toBe(9);
    expect(on.world.salvage.missortedTiles).toBe(0);
  });

  it('works through jobs in priority order', () => {
    const sim = ventedHull();
    const p = sim.pawns.spawn(74, 64);
    looseDeck(sim);
    sim.orders.addOrder(DEMO.hull.x0 + 7, 56);
    // Haul first: with a chunk and a wall order both waiting, the pawn goes for the chunk.
    sim.pawns.setJobPriority(p, JobKind.HAUL, 1);
    sim.pawns.setJobPriority(p, JobKind.CUT, 2);
    run(sim, 20, () => sim.pawns.state[p] !== PawnState.IDLE);
    expect(sim.pawns.state[p]).toBe(PawnState.APPROACHING);
  });

  it('cycles a job priority through 1-4 and off', () => {
    const sim = ventedHull();
    const p = sim.pawns.spawn(74, 64);
    expect(sim.pawns.jobPriority[p * 2 + JobKind.CUT]).toBe(1);
    expect(sim.pawns.jobPriority[p * 2 + JobKind.HAUL]).toBe(2);
    const seen = [1, 2, 3, 4].map(() => sim.pawns.cycleJobPriority(p, JobKind.HAUL));
    expect(seen).toEqual([3, 4, 0, 1]);
  });

  it('gives up on a tow that goes nowhere, and leaves that chunk alone for a while', { timeout: 60_000 }, () => {
    const sim = ventedHull();
    const p = sim.pawns.spawn(62, 64);
    // A deck patch inside the sealed room: its tow route runs into the hull wall.
    const cells: number[] = [];
    for (let y = 58; y <= 59; y++) for (let x = 66; x <= 67; x++) cells.push(sim.world.index(x, y));
    const b = sim.world.debris.liftCells(sim.world, cells);
    let abandonedAt = -1;
    run(sim, 20 * 60, () => {
      if (sim.hazards.countOf(HazardKind.HAUL_ABANDONED) > 0 && abandonedAt < 0) abandonedAt = sim.world.tickCount;
      return abandonedAt >= 0;
    });
    expect(abandonedAt).toBeGreaterThan(0);
    expect(sim.world.debris.haulBlockedUntil[b]).toBeGreaterThan(sim.world.tickCount);
    expect(sim.pawns.ride[p]).toBe(-1);
    run(sim, 200);
    expect(sim.pawns.haulBody[p]).toBe(-1);
  });
});
