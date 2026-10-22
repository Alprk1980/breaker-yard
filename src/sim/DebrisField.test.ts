import { describe, expect, it } from 'vitest';
import { B_SPIN, B_VX, B_VY, B_X, B_Y, BODY_STRIDE, MAX_DEBRIS_SPEED } from './DebrisField';
import { HazardKind } from './HazardLog';
import { Bin, MATERIAL_VALUE, Material } from './materials';
import { MISSORT_FACTOR } from './materialSchema';
import { DEMO, buildDemoHull, towIntoGantry } from './scenes';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { World } from './World';

const { FLOOR, BULKHEAD, GIRDER } = TileFlags;
const PRESENT = FLOOR | BULKHEAD | GIRDER;
const v = { x: 0, y: 0 };

function presentTiles(w: World): number {
  let n = 0;
  for (let i = 0; i < w.tiles.length; i++) if ((w.tiles[i] & PRESENT) !== 0) n++;
  return n;
}

/** Tears the demo hull off its gantry and waits for it to lift out. */
function tornHull(w: World): number {
  buildDemoHull(w);
  w.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
  for (let t = 0; t < 100 && w.debris.count === 0; t++) w.tick();
  return w.debris.bodyAt(66.5, 64.5);
}

/** A w x h block of `flags` tiles lifted straight out of an empty world as one body. */
function block(w: World, x0: number, y0: number, bw: number, bh: number, flags: number = FLOOR, material?: number): number {
  const cells: number[] = [];
  for (let y = y0; y < y0 + bh; y++) {
    for (let x = x0; x < x0 + bw; x++) {
      w.setTile(x, y, flags, 1, material);
      cells.push(w.index(x, y));
    }
  }
  return w.debris.liftCells(w, cells);
}

describe('tearing free', () => {
  it('lifts the hull out of the grid as one body when its last arm snaps, keeping every tile', () => {
    const w = new World();
    buildDemoHull(w);
    const before = presentTiles(w) - 1; // the tile the torch takes
    const b = tornHull(w);
    expect(b).toBeGreaterThanOrEqual(0);
    const hullTiles = (DEMO.hull.x1 - DEMO.hull.x0 + 1) * (DEMO.hull.y1 - DEMO.hull.y0 + 1);
    expect(w.debris.tileCount[b]).toBeGreaterThanOrEqual(hullTiles);
    for (let y = DEMO.hull.y0; y <= DEMO.hull.y1; y++) {
      for (let x = DEMO.hull.x0; x <= DEMO.hull.x1; x++) expect(w.getTile(x, y)).toBe(TileFlags.VOID);
    }
    // Nothing is lost: tiles left in the grid plus tiles in debris add up.
    expect(presentTiles(w) + w.debris.tilesUsed).toBe(before);
    // The gantry stays docked, and once the lattice rebuilds nothing in the grid floats.
    expect(w.getTile(DEMO.gantry.x, DEMO.gantry.y0)).toBe(GIRDER);
    w.tick();
    expect(w.lattice.floatingCount).toBe(0);
    // Materials travel with the tiles.
    let engine = 0;
    let consoles = 0;
    for (let t = w.debris.tileStart[b]; t < w.debris.tileStart[b] + w.debris.tileCount[b]; t++) {
      if (w.debris.tileMaterial[t] === Material.ENGINE_PART) engine++;
      if (w.debris.tileMaterial[t] === Material.ELECTRONICS) consoles++;
    }
    expect(engine).toBe(DEMO.engine.y1 - DEMO.engine.y0 + 1);
    expect(consoles).toBe(DEMO.consoles.x1 - DEMO.consoles.x0 + 1);
  });

  it('carries the cabin air away with it: gas stays conserved', () => {
    const w = new World();
    buildDemoHull(w);
    const mass = w.gas.totalMass();
    tornHull(w);
    for (let t = 0; t < 50; t++) w.tick();
    expect(w.debris.gasCarried).toBeGreaterThan(mass * 0.9);
    expect(w.gas.totalMass() + w.gas.vacuumAbsorbed + w.debris.gasCarried).toBeCloseTo(mass, 1);
  });

  it('frees a pure deck chunk when the floor around it is cut away', () => {
    const w = new World();
    buildDemoHull(w);
    // Cut a closed ring of floor around a 3x3 patch in the main room.
    for (let x = 64; x <= 68; x++) {
      w.cutTile(x, 60);
      w.cutTile(x, 64);
    }
    for (let y = 61; y <= 63; y++) {
      w.cutTile(64, y);
      w.cutTile(68, y);
    }
    w.tick();
    const b = w.debris.bodyAt(66.5, 62.5);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(w.debris.tileCount[b]).toBe(9);
    expect(w.getTile(66, 62)).toBe(TileFlags.VOID);
    // Cutting destroyed the ring's deck plating.
    expect(w.salvage.destroyedValue).toBeCloseTo(16 * MATERIAL_VALUE[Material.DECK_PLATE], 5);
  });

  it('leaves a map with no anchors alone', () => {
    const w = new World();
    for (let x = 10; x < 20; x++) w.setTile(x, 10, GIRDER);
    for (let x = 10; x < 20; x++) w.setTile(x, 11, FLOOR);
    w.cutTile(15, 11);
    for (let t = 0; t < 10; t++) w.tick();
    expect(w.debris.count).toBe(0);
    expect(w.getTile(12, 10)).toBe(GIRDER);
  });

  it('takes its crew with it, and lets them go when it is delivered', () => {
    const sim = new Simulation();
    const w = sim.world;
    buildDemoHull(w);
    const p = sim.pawns.spawn(66, 64);
    w.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
    for (let t = 0; t < 100 && w.debris.count === 0; t++) sim.tick();
    const b = w.debris.bodyAt(66.5, 64.5);
    expect(sim.pawns.ride[p]).toBe(b);
    expect(sim.hazards.countOf(HazardKind.CARRIED_OFF)).toBe(1);
    // Shove the wreck: the rider moves with it.
    w.debris.body[b * BODY_STRIDE + B_VX] = 2;
    for (let t = 0; t < 20; t++) sim.tick();
    expect(sim.pawns.pos[p * 2]).toBeGreaterThan(66.5 + 1.5);
    w.debris.removeBody(b);
    sim.tick();
    expect(sim.pawns.ride[p]).toBe(-1);
    expect(sim.pawns.vel[p * 2]).toBeGreaterThan(1);
  });
});

describe('debris motion', () => {
  it('drifts in a straight line in open space', () => {
    const w = new World();
    const b = block(w, 20, 20, 3, 2);
    const o = b * BODY_STRIDE;
    w.debris.body[o + B_VX] = 1;
    w.debris.body[o + B_VY] = -0.5;
    const x0 = w.debris.body[o + B_X];
    const y0 = w.debris.body[o + B_Y];
    for (let t = 0; t < 40; t++) w.tick();
    expect(w.debris.body[o + B_X] - x0).toBeCloseTo(2, 5);
    expect(w.debris.body[o + B_Y] - y0).toBeCloseTo(-1, 5);
  });

  it('caps its speed', () => {
    const w = new World();
    const b = block(w, 60, 60, 2, 2);
    w.debris.body[b * BODY_STRIDE + B_VX] = 100;
    w.tick();
    expect(w.debris.body[b * BODY_STRIDE + B_VX]).toBeCloseTo(MAX_DEBRIS_SPEED, 5);
  });

  it('bounces off a wall without passing through it', () => {
    const w = new World();
    for (let y = 10; y < 40; y++) w.setTile(50, y, BULKHEAD);
    const b = block(w, 40, 22, 4, 4);
    const o = b * BODY_STRIDE;
    w.debris.body[o + B_VX] = 4;
    let maxX = 0;
    for (let t = 0; t < 100; t++) {
      w.tick();
      maxX = Math.max(maxX, w.debris.bounds[b * 4 + 2]);
    }
    // Contacts are sampled at tile centres and inset corners, so a tile stops at the wall's
    // face: at most one tick of travel (0.2 tiles at 4 tiles/s) goes past it before the
    // contact pushes back, so the centre stays a quarter tile short of x = 50.
    expect(maxX).toBeLessThan(49.75);
    expect(w.debris.body[o + B_VX]).toBeLessThan(0);
    expect(w.debris.body[o + B_VX]).toBeGreaterThan(-4);
    expect(w.getTile(50, 24)).toBe(BULKHEAD);
  });

  it('spins when it clips a wall off-centre', () => {
    const w = new World();
    for (let y = 30; y < 34; y++) w.setTile(50, y, BULKHEAD);
    // A long bar whose top end hits the short wall.
    const b = block(w, 46, 31, 2, 12);
    w.debris.body[b * BODY_STRIDE + B_VX] = 3;
    for (let t = 0; t < 40; t++) w.tick();
    expect(Math.abs(w.debris.body[b * BODY_STRIDE + B_SPIN])).toBeGreaterThan(0.05);
  });

  it('conserves momentum when two bodies collide', () => {
    const w = new World();
    const a = block(w, 30, 40, 3, 3);
    const c = block(w, 40, 41, 3, 3, BULKHEAD);
    w.debris.body[a * BODY_STRIDE + B_VX] = 3;
    w.debris.body[c * BODY_STRIDE + B_VX] = -1;
    const before = { ...w.debris.momentum(v) };
    let touched = false;
    for (let t = 0; t < 80; t++) {
      w.tick();
      if (w.debris.contactsLastStep > 0) touched = true;
    }
    expect(touched).toBe(true);
    const after = w.debris.momentum(v);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    // They bounced: the lighter deck block now moves back left, or at least slower.
    expect(w.debris.body[a * BODY_STRIDE + B_VX]).toBeLessThan(w.debris.body[c * BODY_STRIDE + B_VX]);
  });

  it('is towed toward the grapple target and comes to rest there', () => {
    const w = new World();
    const b = block(w, 20, 20, 2, 2);
    w.debris.grabAt(b, 21, 21);
    w.debris.setGrappleTarget(40, 30);
    for (let t = 0; t < 400; t++) w.tick();
    const o = b * BODY_STRIDE;
    expect(w.debris.body[o + B_X]).toBeCloseTo(40, 0);
    expect(w.debris.body[o + B_Y]).toBeCloseTo(30, 0);
    expect(Math.hypot(w.debris.body[o + B_VX], w.debris.body[o + B_VY])).toBeLessThan(0.1);
  });

  it('hauls the torn-off hull slowly into the gantry, and the gantry holds', () => {
    const w = new World();
    tornHull(w);
    const gantryTiles = presentTiles(w);
    towIntoGantry(w, 600);
    expect(w.debris.contactsTotal).toBeGreaterThan(0);
    expect(presentTiles(w)).toBe(gantryTiles);
  });
});

describe('salvage bins', () => {
  it('pays full value for a pure chunk in the right bin', () => {
    const w = new World();
    w.salvage.addZone(Bin.BARGE, 80, 80, 100, 100);
    const b = block(w, 70, 88, 2, 2, BULKHEAD, Material.ELECTRONICS);
    w.debris.body[b * BODY_STRIDE + B_VX] = 4;
    for (let t = 0; t < 100 && w.debris.count > 0; t++) w.tick();
    expect(w.debris.count).toBe(0);
    expect(w.salvage.credits).toBeCloseTo(4 * MATERIAL_VALUE[Material.ELECTRONICS], 5);
    expect(w.salvage.missortedTiles).toBe(0);
    expect(w.salvage.deliveredByMaterial[Material.ELECTRONICS]).toBe(4);
  });

  it('pays only the missort share for tiles in the wrong bin', () => {
    const w = new World();
    w.salvage.addZone(Bin.BARGE, 80, 80, 100, 100);
    const b = block(w, 85, 85, 3, 3);
    expect(b).toBeGreaterThanOrEqual(0);
    w.tick();
    const value = 9 * MATERIAL_VALUE[Material.DECK_PLATE];
    expect(w.salvage.credits).toBeCloseTo(value * MISSORT_FACTOR, 5);
    expect(w.salvage.missortLoss).toBeCloseTo(value * (1 - MISSORT_FACTOR), 5);
    expect(w.salvage.missortedTiles).toBe(9);
  });

  it('does not take a chunk that only partly fits', () => {
    const w = new World();
    w.salvage.addZone(Bin.FURNACE, 80, 80, 84, 84);
    block(w, 79, 81, 3, 2);
    for (let t = 0; t < 5; t++) w.tick();
    expect(w.debris.count).toBe(1);
    expect(w.salvage.credits).toBe(0);
  });

  it('keeps the tile pool packed as bodies come and go', () => {
    const w = new World();
    const a = block(w, 10, 10, 2, 2);
    const b = block(w, 20, 10, 3, 1);
    const c = block(w, 30, 10, 1, 1);
    const cx = w.debris.body[c * BODY_STRIDE + B_X];
    w.debris.removeBody(b);
    expect(w.debris.tilesUsed).toBe(5);
    expect(w.debris.tileStart[c]).toBe(4);
    expect(w.debris.bodyAt(cx, 10.5)).toBe(c);
    expect(w.debris.bodyAt(10.5, 10.5)).toBe(a);
    expect(w.debris.bodyAt(21.5, 10.5)).toBe(-1);
  });
});
