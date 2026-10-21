import { TileFlags } from './TileFlags';
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
  roomPressure: 1.0,
  /** Member capacity. The intact hull peaks around 0.7 utilisation; losing an arm overloads the other. */
  breakThreshold: 180,
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

  const { engine } = DEMO;
  for (let y = engine.y0; y <= engine.y1; y++) world.lattice.setMass(engine.x, y, engine.mass);

  for (let y = y0 + 1; y < y1; y++) {
    for (let x = x0 + 1; x < x1; x++) world.gas.setPressure(x, y, DEMO.roomPressure);
  }

  world.lattice.solve();
}

/**
 * Runs every tick-loop branch (sealed, venting, snapping, floating) on a throwaway
 * world so V8 optimises the kernels before the real scene starts. Without this, the
 * first breach or snap runs briefly in unoptimised code, which boxes doubles.
 */
export function warmUpKernels(world: World, ticksPerPhase = 300): void {
  buildDemoHull(world);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  world.cutTile(DEMO.hull.x1, 64);
  world.injectGas(DEMO.hull.x0 + 3, 64);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  world.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
  for (let t = 0; t < ticksPerPhase; t++) world.tick();
  world.clear();
}
