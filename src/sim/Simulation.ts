import { TICK_DT } from './constants';
import { HazardLog } from './HazardLog';
import { PathGrid } from './PathGrid';
import { PawnManager } from './PawnManager';
import { TileFlags, isLoadBearing } from './TileFlags';
import { OrderKind, PRIORITY_DEFAULT, ToolKind, WorkOrderQueue } from './WorkOrderQueue';
import { World } from './World';

const PRESENT = TileFlags.FLOOR | TileFlags.BULKHEAD | TileFlags.GIRDER;

/**
 * Everything that advances on the 20 Hz tick: the world (gas, stress, debris), the path
 * cost grid derived from it, the work-order pool and the pawns.
 */
export class Simulation {
  readonly world: World;
  readonly paths = new PathGrid();
  readonly orders = new WorkOrderQueue();
  readonly hazards = new HazardLog();
  readonly pawns: PawnManager;

  constructor(world = new World()) {
    this.world = world;
    this.pawns = new PawnManager(world, this.paths, this.orders, this.hazards);
    this.paths.updateCostGrid(world.gas, world.lattice);
  }

  /** One fixed 50 ms tick. Allocation-free. */
  tick(): void {
    const world = this.world;
    world.tick();
    const debris = world.debris;
    if (debris.liftedCount > 0) {
      // Whatever just tore free takes its crew and its work orders with it.
      this.pawns.boardDebris();
      const w = world.width;
      for (let k = 0; k < debris.liftedCount; k++) {
        const i = debris.liftedList[k];
        this.orders.cancelOrder(i % w, (i / w) | 0);
      }
    }
    this.paths.updateCostGrid(world.gas, world.lattice);
    this.orders.tick();
    this.pawns.tick(TICK_DT);
  }

  /**
   * "Salvage this": orders the crew to sever every tile in the one-tile ring around the
   * rectangle (x0, y0)-(x1, y1), inclusive, so the block inside comes away in one piece.
   * Returns how many orders were placed.
   */
  designateSalvage(x0: number, y0: number, x1: number, y1: number, priority = PRIORITY_DEFAULT): number {
    const world = this.world;
    const lx = Math.min(x0, x1) - 1;
    const hx = Math.max(x0, x1) + 1;
    const ly = Math.min(y0, y1) - 1;
    const hy = Math.max(y0, y1) + 1;
    let placed = 0;
    for (let y = ly; y <= hy; y++) {
      for (let x = lx; x <= hx; x++) {
        if (x !== lx && x !== hx && y !== ly && y !== hy) continue;
        const flags = world.getTile(x, y);
        if ((flags & PRESENT) === 0) continue;
        const tool = isLoadBearing(flags) ? ToolKind.HEAVY_CUTTER : ToolKind.CUTTER;
        if (this.orders.addOrder(x, y, priority, tool, OrderKind.SEVER) >= 0) placed++;
      }
    }
    return placed;
  }

  /** Drops pawns, orders and hazard history; leaves the map alone. */
  resetCrew(): void {
    this.pawns.clear();
    this.orders.clear();
    this.hazards.clear();
    this.paths.updateCostGrid(this.world.gas, this.world.lattice);
  }
}
