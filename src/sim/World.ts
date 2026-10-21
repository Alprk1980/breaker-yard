import { CELL_COUNT, HEIGHT, INJECT_PRESSURE_BAR, WIDTH } from './constants';
import { GasCell, GasGrid } from './GasGrid';
import { StressLattice } from './StressLattice';
import { TileFlags, isLoadBearing, isSolid, isVoid } from './TileFlags';

/** Gas added per tick by a HAZARD_LEAK tile, in bar. */
const LEAK_RATE_BAR = 0.05;
const DEFAULT_GIRDER_MASS = 1;

/**
 * Owns the tile map and keeps the gas and stress layers in sync with it.
 * The layers never read `tiles` themselves; every tile edit goes through `setTile`.
 */
export class World {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly tiles = new Uint8Array(CELL_COUNT);
  readonly gas = new GasGrid(WIDTH, HEIGHT);
  readonly lattice = new StressLattice(WIDTH, HEIGHT);
  tickCount = 0;

  constructor() {
    this.clear();
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Resets the whole map to open space. */
  clear(): void {
    this.tiles.fill(TileFlags.VOID);
    this.gas.cells.fill(GasCell.VACUUM);
    this.gas.clear();
    this.lattice.clear();
    this.tickCount = 0;
  }

  getTile(x: number, y: number): number {
    return this.inBounds(x, y) ? this.tiles[y * this.width + x] : TileFlags.VOID;
  }

  setTile(x: number, y: number, flags: number, girderMass = DEFAULT_GIRDER_MASS): void {
    if (!this.inBounds(x, y)) return;
    this.tiles[y * this.width + x] = flags;
    this.gas.setCell(x, y, isSolid(flags) ? GasCell.WALL : isVoid(flags) ? GasCell.VACUUM : GasCell.OPEN);
    if (isLoadBearing(flags)) {
      if (!this.lattice.hasNode(x, y)) this.lattice.addNode(x, y, girderMass);
      else this.lattice.setMass(x, y, girderMass);
    } else {
      this.lattice.removeNode(x, y);
    }
  }

  /**
   * Cutting torch. Solid tiles (bulkheads, girders) are cut open to floor, which
   * removes any structural node and lets gas through. Cutting a floor tile
   * removes it entirely, leaving vacuum.
   */
  cutTile(x: number, y: number): void {
    const flags = this.getTile(x, y);
    if (isSolid(flags)) this.setTile(x, y, TileFlags.FLOOR);
    else if ((flags & TileFlags.FLOOR) !== 0) this.setTile(x, y, TileFlags.VOID);
  }

  /** Raises open cells in a square brush to at least `bar`. */
  injectGas(cx: number, cy: number, bar = INJECT_PRESSURE_BAR, radius = 1): void {
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (this.gas.getPressure(x, y) < bar) this.gas.setPressure(x, y, bar);
      }
    }
  }

  toggleAnchor(x: number, y: number): boolean {
    return this.lattice.toggleAnchor(x, y);
  }

  /** One fixed 50 ms tick. Allocation-free. */
  tick(): void {
    const tiles = this.tiles;
    for (let i = 0; i < CELL_COUNT; i++) {
      if ((tiles[i] & TileFlags.HAZARD_LEAK) !== 0) this.gas.addPressure(i, LEAK_RATE_BAR);
    }
    this.gas.step();
    this.lattice.step();
    this.tickCount++;
  }
}
