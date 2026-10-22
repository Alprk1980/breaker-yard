import { TICK_DT } from './constants';
import { HazardLog } from './HazardLog';
import { PathGrid } from './PathGrid';
import { PawnManager } from './PawnManager';
import { WorkOrderQueue } from './WorkOrderQueue';
import { World } from './World';

/**
 * Everything that advances on the 20 Hz tick: the world (gas + stress), the path cost
 * grid derived from it, the work-order pool and the pawns.
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
    this.paths.updateCostGrid(world.gas, world.lattice);
    this.orders.tick();
    this.pawns.tick(TICK_DT);
  }

  /** Drops pawns, orders and hazard history; leaves the map alone. */
  resetCrew(): void {
    this.pawns.clear();
    this.orders.clear();
    this.hazards.clear();
    this.paths.updateCostGrid(this.world.gas, this.world.lattice);
  }
}
