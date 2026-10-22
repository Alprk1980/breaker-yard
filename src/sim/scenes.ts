import { B_X, B_Y, BODY_STRIDE } from './DebrisField';
import { Bin, Material } from './materials';
import type { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { ToolKind } from './WorkOrderQueue';
import type { World } from './World';

const { FLOOR, BULKHEAD, GIRDER } = TileFlags;
const FRAME = GIRDER | BULKHEAD;

/** Layout of the demo hull, exported so tests can probe it. */
export const DEMO = {
  /** Pressurised room, outer frame inclusive. */
  hull: { x0: 48, y0: 50, x1: 84, y1: 78 },
  /** Vertical gantry column, docked to the yard at both ends. */
  gantry: { x: 38, y0: 42, y1: 86 },
  /** Rows where gantry arms reach across to the hull's left frame. */
  armRows: [54, 74],
  /** Engine block on the right frame: heavy nodes that make the hull a cantilever. */
  engine: { x: 84, y0: 58, y1: 70, mass: 6 },
  /** Control consoles along the top wall: solid electronics tiles. */
  consoles: { y: 51, x0: 70, x1: 75 },
  /**
   * Salvage bins out in open space, right of the hull. Each is smaller than the hull, so
   * the ship has to be cut into pieces before anything fits.
   */
  zones: [
    { bin: Bin.FURNACE, x0: 92, y0: 10, x1: 124, y1: 40 },
    { bin: Bin.PROCESSOR, x0: 92, y0: 49, x1: 124, y1: 79 },
    { bin: Bin.BARGE, x0: 92, y0: 88, x1: 124, y1: 118 },
  ],
  roomPressure: 1.0,
  /** Member capacity. The intact hull peaks around 0.7 utilisation; losing an arm overloads the other. */
  breakThreshold: 180,
  /** Starting crew positions, inside the main room. */
  crew: [
    [62, 60],
    [66, 66],
    [70, 72],
  ],
} as const;

/**
 * Small demo salvage target in the centre of the map: a pressurised room framed by
 * load-bearing girders, hanging off a docking gantry by two arms. The gantry's end
 * tiles are dock anchors.
 */
export function buildDemoHull(world: World): void {
  world.clear();
  world.lattice.breakThreshold = DEMO.breakThreshold;
  world.lattice.edgeCapacity.fill(DEMO.breakThreshold);

  const { x0, y0, x1, y1 } = DEMO.hull;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const edge = x === x0 || x === x1 || y === y0 || y === y1;
      world.setTile(x, y, edge ? FRAME : FLOOR);
    }
  }

  // Interior bulkhead splitting off an airlock at the bow, with a doorway.
  const lockX = x0 + 7;
  for (let y = y0 + 1; y < y1; y++) {
    if (y < 63 || y > 65) world.setTile(lockX, y, BULKHEAD);
  }

  const { x: gx, y0: gy0, y1: gy1 } = DEMO.gantry;
  for (let y = gy0; y <= gy1; y++) world.setTile(gx, y, GIRDER);
  for (const row of DEMO.armRows) {
    for (let x = gx + 1; x < x0; x++) world.setTile(x, row, GIRDER);
  }
  // Dock clamps: two anchor tiles at each end of the gantry.
  world.setTile(gx - 1, gy0, GIRDER);
  world.setTile(gx - 1, gy1, GIRDER);
  world.lattice.setAnchor(gx, gy0, true);
  world.lattice.setAnchor(gx - 1, gy0, true);
  world.lattice.setAnchor(gx, gy1, true);
  world.lattice.setAnchor(gx - 1, gy1, true);

  const { engine, consoles } = DEMO;
  for (let y = engine.y0; y <= engine.y1; y++) world.setTile(engine.x, y, FRAME, engine.mass, Material.ENGINE_PART);
  for (let x = consoles.x0; x <= consoles.x1; x++) world.setTile(x, consoles.y, BULKHEAD, 1, Material.ELECTRONICS);
  for (const z of DEMO.zones) world.salvage.addZone(z.bin, z.x0, z.y0, z.x1, z.y1);

  setRoomPressure(world, DEMO.roomPressure);
  world.lattice.solve();
}

/** Sets every open tile inside the demo hull's frame to `bar`. */
export function setRoomPressure(world: World, bar: number): void {
  const { x0, y0, x1, y1 } = DEMO.hull;
  for (let y = y0 + 1; y < y1; y++) {
    for (let x = x0 + 1; x < x1; x++) world.gas.setPressure(x, y, bar);
  }
}

/**
 * Runs every tick-loop branch (sealed, venting, leaking, snapping, tearing free, debris
 * towed into the gantry and colliding) on a throwaway world so V8 optimises the kernels
 * before the real scene starts. Without this, the first breach or snap runs briefly in
 * unoptimised code, which boxes doubles.
 */
export function warmUpKernels(world: World, ticksPerPhase = 300): void {
  buildDemoHull(world);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  world.cutTile(DEMO.hull.x1, 64);
  world.injectGas(DEMO.hull.x0 + 3, 64);
  world.setTile(DEMO.hull.x0 + 20, 64, FLOOR | TileFlags.HAZARD_LEAK);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  world.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  towIntoGantry(world, ticksPerPhase);
  world.clear();
}

/**
 * Hooks the grapple onto the biggest piece of debris (the torn-off hull) at its centre
 * and aims it through the gantry. Returns false when there is no debris.
 */
export function grappleHull(world: World): boolean {
  const debris = world.debris;
  let best = -1;
  for (let b = 0; b < debris.alive.length; b++) {
    if (debris.alive[b] === 1 && (best < 0 || debris.tileCount[b] > debris.tileCount[best])) best = b;
  }
  if (best < 0) return false;
  const o = best * BODY_STRIDE;
  debris.grabAt(best, debris.body[o + B_X], debris.body[o + B_Y]);
  debris.setGrappleTarget(DEMO.gantry.x - 12, 70);
  return true;
}

/** Hauls the torn-off hull into the gantry so it hits and grinds along it. Used by warm-up and tests. */
export function towIntoGantry(world: World, ticks: number): void {
  if (!grappleHull(world)) return;
  for (let t = 0; t < ticks; t++) world.tick();
  world.debris.releaseGrapple();
}

/**
 * Opens the demo hull's stern and lifts a 3x3 deck patch beside the hole loose, with a
 * one-tile gap to the deck around it: a light chunk a hauler can reach and tow out at once.
 * Returns the chunk's body. Used by warm-up and tests.
 */
export function looseDeckPatch(world: World): number {
  for (let y = 60; y <= 68; y++) {
    world.cutTile(DEMO.engine.x, y);
    world.cutTile(DEMO.engine.x, y);
    world.cutTile(DEMO.engine.x - 1, y);
  }
  const cells: number[] = [];
  for (let y = 63; y <= 65; y++) for (let x = 80; x <= 82; x++) cells.push(world.index(x, y));
  const b = world.debris.liftCells(world, cells);
  for (let x = 79; x <= 83; x++) {
    world.cutTile(x, 62);
    world.cutTile(x, 66);
  }
  for (let y = 62; y <= 66; y++) world.cutTile(79, y);
  return b;
}

/** Spawns the demo crew inside the main room. */
export function seedDemoCrew(sim: Simulation): void {
  for (const [x, y] of DEMO.crew) sim.pawns.spawn(x, y);
}

/**
 * Like `warmUpKernels`, for the crew: a full 32-pawn crew runs through navigating,
 * cutting, refused high-pressure cuts, a breach, drag, fleeing, riding a torn-off hull and
 * hauling a loose chunk to a bin on a throwaway simulation, several times over, then it is
 * cleared. Pawn code paths are individually
 * cold (one pawn flees now and then), so V8 only optimises them with a big crew; until
 * then they run in the interpreter, which boxes every double.
 */
export function warmUpCrew(sim: Simulation, cycles = 3, ticksPerPhase = 300): void {
  const { world, orders, pawns } = sim;
  const { x0, y0, x1, y1 } = DEMO.hull;
  const lockX = x0 + 7;
  for (let c = 0; c < cycles; c++) {
    buildDemoHull(world);
    sim.resetCrew();
    for (let y = y0 + 2; y < y1 - 1 && pawns.count < pawns.capacity; y += 4) {
      for (let x = lockX + 3; x < x1 - 1 && pawns.count < pawns.capacity; x += 4) pawns.spawn(x, y);
    }
    for (let y = y0 + 1; y < y1; y++) orders.addOrder(lockX, y, 3, ToolKind.CUTTER);
    for (let t = 0; t < ticksPerPhase; t++) sim.tick();
    // Overpressure the room behind outer-frame orders: the pre-cut scan refuses them.
    setRoomPressure(world, 5);
    for (let x = x0 + 10; x < x1; x += 6) orders.addOrder(x, y0, 5, ToolKind.HEAVY_CUTTER);
    for (let t = 0; t < ticksPerPhase; t++) sim.tick();
    // Blow the hull open next to the crew: drag, fleeing, refuge search, clamping.
    for (let x = x0 + 10; x < x1; x += 6) world.cutTile(x, y0);
    world.cutTile(x1, 64);
    // A few pawns knocked out into space, to run the adrift and thruster paths.
    for (let p = 0; p < 4; p++) {
      pawns.pos[p * 2] = x1 + 2.5;
      pawns.pos[p * 2 + 1] = 60.5 + p * 2;
    }
    for (let t = 0; t < ticksPerPhase; t++) sim.tick();
    // Tear the hull off with the crew aboard and tow it.
    world.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
    for (let t = 0; t < 30; t++) sim.tick();
    grappleHull(world);
    for (let t = 0; t < ticksPerPhase; t++) sim.tick();
    // A crew hauls a loose deck patch out of a vented hull: approach, board, tug, deliver, fly home.
    buildDemoHull(world);
    setRoomPressure(world, 0);
    sim.resetCrew();
    for (let k = 0; k < 4; k++) pawns.spawn(74, 60 + k * 2);
    looseDeckPatch(world);
    for (let t = 0; t < ticksPerPhase * 2; t++) sim.tick();
  }
  world.clear();
  sim.resetCrew();
}
