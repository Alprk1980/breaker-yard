import { CELL_COUNT, HEIGHT, INJECT_PRESSURE_BAR, WIDTH } from './constants';
import { DebrisField } from './DebrisField';
import { GasCell, GasGrid } from './GasGrid';
import { defaultMaterial } from './materials';
import { Salvage } from './Salvage';
import { StressLattice } from './StressLattice';
import { TileFlags, isLoadBearing, isSolid, isVoid } from './TileFlags';

/** Toxic gas added per tick by a HAZARD_LEAK tile, in bar. */
const LEAK_RATE_BAR = 0.05;
const DEFAULT_GIRDER_MASS = 1;
const PRESENT = TileFlags.FLOOR | TileFlags.BULKHEAD | TileFlags.GIRDER;

/**
 * Owns the tile map and keeps the gas and stress layers in sync with it.
 * The layers never read `tiles` themselves; every tile edit goes through `setTile`.
 * Also owns what leaves the map: debris torn free of the anchors, and the salvage
 * ledger that pays for it.
 */
export class World {
  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly tiles = new Uint8Array(CELL_COUNT);
  readonly gas = new GasGrid(WIDTH, HEIGHT);
  readonly lattice = new StressLattice(WIDTH, HEIGHT);
  /** `Material` per tile. */
  readonly material = new Uint8Array(CELL_COUNT);
  readonly debris = new DebrisField();
  readonly salvage = new Salvage();
  tickCount = 0;
  /** Set when a tile disappears, so the next tick looks for pieces that came loose. */
  private detachPending = false;
  private seenTopology = -1;

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
    this.material.fill(0);
    this.gas.cells.fill(GasCell.VACUUM);
    this.gas.clear();
    this.lattice.clear();
    this.debris.clear();
    this.salvage.clear();
    this.detachPending = false;
    this.tickCount = 0;
  }

  getTile(x: number, y: number): number {
    return this.inBounds(x, y) ? this.tiles[y * this.width + x] : TileFlags.VOID;
  }

  setTile(x: number, y: number, flags: number, girderMass = DEFAULT_GIRDER_MASS, material = defaultMaterial(flags)): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    if ((this.tiles[i] & PRESENT) !== 0 && (flags & PRESENT) === 0) this.detachPending = true;
    this.tiles[i] = flags;
    this.material[i] = material;
    this.gas.setCell(x, y, isSolid(flags) ? GasCell.WALL : isVoid(flags) ? GasCell.VACUUM : GasCell.OPEN);
    if (isLoadBearing(flags)) {
      if (!this.lattice.hasNode(x, y)) this.lattice.addNode(x, y, girderMass);
      else this.lattice.setMass(x, y, girderMass);
    } else {
      this.lattice.removeNode(x, y);
    }
  }

  /**
   * Cutting torch. Solid tiles (bulkheads, girders) are cut open to floor where they
   * border a deck, which removes any structural node and lets gas through; out in open
   * space (a gantry arm) nothing is left but vacuum, so a cut member really parts. Cutting
   * a floor tile removes it entirely, leaving vacuum. Either way the cut tile's salvage
   * value is lost.
   */
  cutTile(x: number, y: number): void {
    const flags = this.getTile(x, y);
    if ((flags & PRESENT) !== 0) this.salvage.destroyTile(this.material[y * this.width + x]);
    if (isSolid(flags)) this.setTile(x, y, this.bordersFloor(x, y) ? TileFlags.FLOOR : TileFlags.VOID);
    else if ((flags & TileFlags.FLOOR) !== 0) this.setTile(x, y, TileFlags.VOID);
  }

  private bordersFloor(x: number, y: number): boolean {
    const F = TileFlags.FLOOR;
    return (
      (this.getTile(x - 1, y) & F) !== 0 ||
      (this.getTile(x + 1, y) & F) !== 0 ||
      (this.getTile(x, y - 1) & F) !== 0 ||
      (this.getTile(x, y + 1) & F) !== 0
    );
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
    // Inlined `GasGrid.addToxicGas`: a leak is often a single tile, so a call per leak would
    // stay cold, and V8's unoptimised tiers box every double they add.
    const gas = this.gas;
    const cells = gas.cells;
    const cur = gas.current;
    const tox = gas.toxin;
    for (let i = 0; i < CELL_COUNT; i++) {
      if ((tiles[i] & TileFlags.HAZARD_LEAK) !== 0 && cells[i] === GasCell.OPEN) {
        cur[i] += LEAK_RATE_BAR;
        tox[i] += LEAK_RATE_BAR;
      }
    }
    this.gas.step();
    const lattice = this.lattice;
    lattice.step();
    // Anything that lost its last path to an anchor tears free: after a snap or cut (the
    // lattice rebuilt with floating nodes) or when a tile vanished and may have cut a piece off.
    const debris = this.debris;
    debris.clearLifted();
    const regrounded = lattice.topologyVersion !== this.seenTopology;
    this.seenTopology = lattice.topologyVersion;
    if (this.detachPending || (regrounded && lattice.floatingCount > 0)) {
      this.detachPending = false;
      debris.detachFloating(this);
    }
    debris.step(this, this.salvage);
    this.tickCount++;
  }
}
