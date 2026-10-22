import { describe, expect, it } from 'vitest';
import { HazardKind } from './HazardLog';
import { FLEE_CONFIRM_TICKS, PawnState, PawnWarning } from './PawnManager';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { ToolKind } from './WorkOrderQueue';

const { FLOOR, BULKHEAD, GIRDER } = TileFlags;

/** Room with interior x/y in [11, 19], walled at 10 and 20, in open space. */
const ROOM = { x0: 10, y0: 10, x1: 20, y1: 20 };
/** East wall tile; vacuum lies directly behind it at x = 21. */
const WALL = { x: ROOM.x1, y: 15 };

function pressurisedRoom(bar: number, wallFlags: number = BULKHEAD): Simulation {
  const sim = new Simulation();
  const { world } = sim;
  for (let y = ROOM.y0; y <= ROOM.y1; y++) {
    for (let x = ROOM.x0; x <= ROOM.x1; x++) {
      const edge = x === ROOM.x0 || x === ROOM.x1 || y === ROOM.y0 || y === ROOM.y1;
      world.setTile(x, y, edge ? wallFlags : FLOOR);
    }
  }
  if (wallFlags & GIRDER) world.lattice.setAnchor(ROOM.x0, ROOM.y0, true);
  for (let y = ROOM.y0 + 1; y < ROOM.y1; y++) {
    for (let x = ROOM.x0 + 1; x < ROOM.x1; x++) world.gas.setPressure(x, y, bar);
  }
  world.lattice.solve();
  sim.paths.updateCostGrid(world.gas, world.lattice);
  return sim;
}

/** Ticks until `pred` holds or `max` ticks pass; returns ticks used. */
function runUntil(sim: Simulation, pred: () => boolean, max: number): number {
  for (let t = 0; t < max; t++) {
    if (pred()) return t;
    sim.tick();
  }
  return max;
}

describe('PawnManager pre-cut safety', () => {
  it('refuses to cut a wall separating a 5.0 bar room from vacuum', () => {
    const sim = pressurisedRoom(5.0);
    const { world, pawns, orders, hazards } = sim;
    expect(world.gas.getCell(WALL.x + 1, WALL.y)).toBe(2); // vacuum behind the wall
    expect(world.gas.getPressureDelta(WALL.x, WALL.y)).toBeCloseTo(5.0, 3);

    const p = pawns.spawn(14, 15);
    const slot = orders.addOrder(WALL.x, WALL.y, 3);
    const massBefore = world.gas.totalMass();

    let reachedPreCut = false;
    let everCut = false;
    for (let t = 0; t < 400; t++) {
      sim.tick();
      if (pawns.state[p] === PawnState.PRE_CUT) reachedPreCut = true;
      if (pawns.state[p] === PawnState.DISASSEMBLING || pawns.progress[p] > 0) everCut = true;
    }

    expect(reachedPreCut).toBe(true);
    expect(everCut).toBe(false);
    expect(world.getTile(WALL.x, WALL.y)).toBe(BULKHEAD);
    expect(world.gas.vacuumAbsorbed).toBe(0);
    expect(world.gas.totalMass()).toBeCloseTo(massBefore, 2);

    expect(hazards.countOf(HazardKind.CUT_REFUSED_PRESSURE)).toBeGreaterThan(0);
    const first = hazards.at(0);
    expect(hazards.kind[first]).toBe(HazardKind.CUT_REFUSED_PRESSURE);
    expect(hazards.x[first]).toBe(WALL.x);
    expect(hazards.y[first]).toBe(WALL.y);
    expect(hazards.value[first]).toBeCloseTo(5.0, 3);
    expect(pawns.warnings[p] & PawnWarning.PRESSURE).toBe(PawnWarning.PRESSURE);

    // The order survives, unclaimed and with no progress, for a later attempt.
    expect(orders.cell[slot]).toBe(world.index(WALL.x, WALL.y));
    expect(orders.progress[slot]).toBe(0);
  });

  it('cuts the same wall when the room holds 1.0 bar, and the room vents', () => {
    const sim = pressurisedRoom(1.0);
    const { world, pawns, orders, hazards } = sim;
    const p = pawns.spawn(14, 15);
    orders.addOrder(WALL.x, WALL.y, 3);
    runUntil(sim, () => world.getTile(WALL.x, WALL.y) === FLOOR, 600);
    expect(world.getTile(WALL.x, WALL.y)).toBe(FLOOR);
    expect(orders.count).toBe(0);
    expect(hazards.countOf(HazardKind.CUT_REFUSED_PRESSURE)).toBe(0);
    for (let t = 0; t < 40; t++) sim.tick();
    expect(world.gas.vacuumAbsorbed).toBeGreaterThan(0);
    expect(pawns.alive[p]).toBe(1);
  });

  it('aborts mid-cut when the differential climbs past 2 bar, keeping the partial progress on the order', () => {
    const sim = pressurisedRoom(1.0);
    const { world, pawns, orders, hazards } = sim;
    const p = pawns.spawn(14, 15);
    const slot = orders.addOrder(WALL.x, WALL.y, 3);
    runUntil(sim, () => pawns.progress[p] > 20, 400);
    expect(pawns.state[p]).toBe(PawnState.DISASSEMBLING);
    for (let y = ROOM.y0 + 1; y < ROOM.y1; y++) {
      for (let x = ROOM.x0 + 1; x < ROOM.x1; x++) world.gas.setPressure(x, y, 4);
    }
    sim.tick();
    expect(pawns.state[p]).toBe(PawnState.IDLE);
    expect(hazards.countOf(HazardKind.CUT_ABORTED_PRESSURE)).toBe(1);
    expect(world.getTile(WALL.x, WALL.y)).toBe(BULKHEAD);
    expect(orders.claimedBy[slot]).toBe(-1);
    expect(orders.suspended[slot]).toBeGreaterThan(0);
    expect(orders.progress[slot]).toBeGreaterThan(20);
  });
});

describe('PawnManager disassembly', () => {
  it('removes a girder and its lattice node, weakening the member while cutting', () => {
    const sim = pressurisedRoom(0.5, GIRDER | BULKHEAD);
    const { world, pawns, orders } = sim;
    const L = world.lattice;
    const target = { x: 15, y: ROOM.y1 };
    expect(L.hasNode(target.x, target.y)).toBe(true);
    pawns.spawn(15, 15);
    orders.addOrder(target.x, target.y, 3, ToolKind.HEAVY_CUTTER);

    runUntil(sim, () => pawns.progress[0] > 50, 600);
    const e = L.edgeAdjacency[L.index(target.x, target.y) * 4];
    expect(L.edgeCapacity[e]).toBeLessThan(L.breakThreshold);

    runUntil(sim, () => world.getTile(target.x, target.y) === FLOOR, 600);
    expect(world.getTile(target.x, target.y)).toBe(FLOOR);
    expect(L.hasNode(target.x, target.y)).toBe(false);
    expect(pawns.state[0]).toBe(PawnState.IDLE);
  });

  it('skips orders whose tool the pawn lacks', () => {
    const sim = pressurisedRoom(0.5, GIRDER | BULKHEAD);
    const p = sim.pawns.spawn(15, 15, ToolKind.CUTTER);
    sim.orders.addOrder(15, ROOM.y1, 3, ToolKind.HEAVY_CUTTER);
    for (let t = 0; t < 20; t++) sim.tick();
    expect(sim.pawns.state[p]).toBe(PawnState.IDLE);
    expect(sim.orders.claimedBy[0]).toBe(-1);
  });

  it('drops to IDLE when its order is cancelled', () => {
    const sim = pressurisedRoom(1.0);
    const p = sim.pawns.spawn(12, 12);
    sim.orders.addOrder(WALL.x, WALL.y, 3);
    sim.tick();
    expect(sim.pawns.state[p]).toBe(PawnState.NAVIGATING);
    sim.orders.cancelOrder(WALL.x, WALL.y);
    sim.tick();
    expect(sim.pawns.state[p]).toBe(PawnState.IDLE);
    expect(sim.pawns.orderSlot[p]).toBe(-1);
  });
});

describe('PawnManager decompression', () => {
  it('flees a breach and clamps to a braced floor anchor', () => {
    const sim = pressurisedRoom(5.0);
    const { world, pawns, hazards } = sim;
    const p = pawns.spawn(WALL.x - 2, WALL.y);
    sim.tick();
    expect(pawns.state[p]).toBe(PawnState.IDLE);

    world.cutTile(WALL.x, WALL.y); // blow the wall out by hand
    sim.tick();
    expect(pawns.state[p]).toBe(PawnState.IDLE); // one gust is not a breach yet
    for (let t = 1; t < FLEE_CONFIRM_TICKS; t++) sim.tick();
    expect(pawns.state[p]).toBe(PawnState.FLEEING);
    expect(hazards.countOf(HazardKind.DECOMPRESSION)).toBe(1);

    for (let t = 0; t < 80; t++) sim.tick();
    const x = Math.floor(pawns.pos[p * 2]);
    const y = Math.floor(pawns.pos[p * 2 + 1]);
    // Still aboard, on a floor tile braced against a wall, boots engaged, well clear of the breach.
    expect(world.getTile(x, y)).toBe(FLOOR);
    expect(pawns.magBoot[p]).toBe(1);
    expect(pawns.vel[p * 2]).toBe(0);
    expect(pawns.vel[p * 2 + 1]).toBe(0);
    const braced =
      world.getTile(x - 1, y) === BULKHEAD ||
      world.getTile(x + 1, y) === BULKHEAD ||
      world.getTile(x, y - 1) === BULKHEAD ||
      world.getTile(x, y + 1) === BULKHEAD;
    expect(braced).toBe(true);
    expect(Math.hypot(x - WALL.x, y - WALL.y)).toBeGreaterThan(5);
  });

  it('is dragged toward the breach when the vent stream beats its magboot grip', () => {
    const sim = pressurisedRoom(10.0);
    const { world, pawns } = sim;
    world.cutTile(WALL.x, WALL.y);
    const p = pawns.spawn(WALL.x, WALL.y); // standing in the hole
    sim.tick();
    expect(pawns.vel[p * 2]).toBeGreaterThan(1); // pushed out toward +x, the vacuum side
    for (let t = 1; t < FLEE_CONFIRM_TICKS; t++) sim.tick();
    expect(pawns.state[p]).toBe(PawnState.FLEEING);
  });

  it('is dragged out through a 1 bar breach once the stream builds, and the jet beats its thrusters', () => {
    const sim = pressurisedRoom(1.0);
    const { world, pawns } = sim;
    world.cutTile(WALL.x, WALL.y);
    for (let t = 0; t < 10; t++) sim.tick();
    const booted = pawns.spawn(WALL.x, WALL.y); // standing in the hole
    const adrift = pawns.spawn(WALL.x - 2, WALL.y);
    pawns.pos[adrift * 2] = WALL.x + 1.5; // just outside, in the jet
    sim.tick();
    expect(pawns.magBoot[booted]).toBe(1);
    expect(pawns.vel[booted * 2]).toBeGreaterThan(0.3); // magboots slip
    expect(pawns.magBoot[adrift]).toBe(0);
    expect(pawns.vel[adrift * 2]).toBeGreaterThan(0); // thrusters aim back aboard, the jet wins
    for (let t = 0; t < 10; t++) sim.tick();
    expect(pawns.pos[adrift * 2]).toBeGreaterThan(WALL.x + 2); // carried clear of the jet cell
  });

  it('thrusts back to the nearest floor when knocked adrift, then clamps on', () => {
    const sim = new Simulation();
    const { world, pawns, hazards } = sim;
    // A bare deck plate in open space.
    for (let y = 30; y <= 34; y++) for (let x = 30; x <= 34; x++) world.setTile(x, y, FLOOR);
    sim.paths.updateCostGrid(world.gas, world.lattice);
    const p = pawns.spawn(32, 32);
    pawns.pos[p * 2] = 36.5; // two tiles off the edge, in vacuum
    sim.tick();
    expect(pawns.state[p]).toBe(PawnState.FLEEING);
    expect(pawns.magBoot[p]).toBe(0);
    expect(pawns.warnings[p] & PawnWarning.ADRIFT).toBe(PawnWarning.ADRIFT);
    expect(hazards.countOf(HazardKind.ADRIFT)).toBe(1);
    runUntil(sim, () => pawns.state[p] === PawnState.IDLE, 400);
    expect(pawns.state[p]).toBe(PawnState.IDLE);
    expect(world.getTile(Math.floor(pawns.pos[p * 2]), Math.floor(pawns.pos[p * 2 + 1]))).toBe(FLOOR);
    expect(pawns.magBoot[p]).toBe(1);
  });
});
