import { CELL_COUNT, HEIGHT, INJECT_PRESSURE_BAR, TICK_DT, WIDTH } from './constants';
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
/*
 * Enum values used in the hot loops, as plain module constants: `TileFlags.FUEL` in a loop is
 * a property load with its own type-feedback slot on every pass (see PawnManager).
 */
const HAZARD_LEAK = TileFlags.HAZARD_LEAK;
const FUEL = TileFlags.FUEL;
const OPEN = GasCell.OPEN;
const DT = TICK_DT;

/** Tank heat gained per second per unit of fire intensity in each neighbouring cell; a tank blows at 1. */
export const TANK_HEAT_RATE = 0.25;
/** Member capacity lost per second per unit of fire intensity beside it, down to `FIRE_MIN_CAPACITY` of new. */
export const FIRE_WEAKEN = 0.04;
export const FIRE_MIN_CAPACITY = 0.35;
/** Explosion: pressure spike (bar) out to `BLAST_GAS_RADIUS`, fire out to `BLAST_FIRE_RADIUS`, members torn within `BLAST_TEAR_RADIUS` and weakened (to `BLAST_WEAKEN` of their capacity) within `BLAST_FIRE_RADIUS`, other tanks set off within `BLAST_CHAIN_RADIUS`. */
export const BLAST_BAR = 3;
export const BLAST_GAS_RADIUS = 2;
export const BLAST_FIRE_RADIUS = 3;
export const BLAST_TEAR_RADIUS = 1;
export const BLAST_WEAKEN = 0.3;
export const BLAST_CHAIN_RADIUS = 4;
/** Explosions recorded per tick for the crew to feel. */
export const MAX_BLASTS = 64;

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
  /** Heat per fuel-tank tile, 0..1; at 1 it explodes. */
  readonly tankHeat = new Float32Array(CELL_COUNT);
  /**
   * Tank cells set off by a neighbouring blast or by fire, to explode next tick (a chain, one
   * link per tick). Double-buffered: tanks going off this tick queue their neighbours into
   * the other buffer, so they cannot overwrite entries still waiting their turn.
   */
  private fuses = new Int32Array(CELL_COUNT);
  private fusesNow = new Int32Array(CELL_COUNT);
  private fuseCount = 0;
  /** Cells that exploded since the simulation last cleared them, and how many; explosions ever. */
  readonly blasts = new Int32Array(MAX_BLASTS);
  blastCount = 0;
  explosionsTotal = 0;
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
    this.tankHeat.fill(0);
    this.fuseCount = 0;
    this.blastCount = 0;
    this.explosionsTotal = 0;
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
    if ((flags & TileFlags.FUEL) !== 0) {
      // A torch through a fuel tank sets it off.
      this.explode(y * this.width + x);
      return;
    }
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

  /**
   * A fuel tank at cell `i` blows: the tank is gone, the gas around it spikes, fire takes
   * hold around it, members beside it tear and those nearby weaken, and every other tank in
   * reach is set to go off next tick. Recorded in `blasts` for the crew to feel. A one-off
   * event, not per-tick work.
   */
  explode(i: number): void {
    if ((this.tiles[i] & TileFlags.FUEL) === 0) return;
    const w = this.width;
    const cx = i % w;
    const cy = (i / w) | 0;
    this.salvage.destroyTile(this.material[i]);
    this.setTile(cx, cy, TileFlags.FLOOR);
    this.tankHeat[i] = 0;
    const gas = this.gas;
    const L = this.lattice;
    const r = BLAST_CHAIN_RADIUS;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!this.inBounds(x, y)) continue;
        const j = y * w + x;
        const d2 = dx * dx + dy * dy;
        if (d2 <= BLAST_GAS_RADIUS * BLAST_GAS_RADIUS && gas.cells[j] === GasCell.OPEN && gas.current[j] < BLAST_BAR) {
          gas.current[j] = BLAST_BAR;
        }
        if (d2 <= BLAST_FIRE_RADIUS * BLAST_FIRE_RADIUS) {
          gas.ignite(j, 1 - Math.sqrt(d2) / (BLAST_FIRE_RADIUS + 1));
          if (L.nodeActive[j] === 1) {
            for (let k = 0; k < 4; k++) {
              const e = L.edgeAdjacency[j * 4 + k];
              if (e < 0) continue;
              if (d2 <= BLAST_TEAR_RADIUS * BLAST_TEAR_RADIUS) L.snapEdge(e);
              else L.edgeCapacity[e] *= BLAST_WEAKEN;
            }
          }
        }
        if (j !== i && (this.tiles[j] & TileFlags.FUEL) !== 0 && this.tankHeat[j] < 1) {
          this.tankHeat[j] = 1;
          this.fuses[this.fuseCount++] = j;
        }
      }
    }
    if (this.blastCount < MAX_BLASTS) this.blasts[this.blastCount++] = i;
    this.explosionsTotal++;
  }

  /**
   * Fire's effects on the structure: every burning cell heats the fuel tanks beside it
   * (queuing those that reach 1 to blow) and softens the members beside it.
   */
  private heatFromFire(): void {
    const gas = this.gas;
    if (gas.burningCount === 0) return;
    const list = gas.burningList;
    const fire = gas.fire;
    const tiles = this.tiles;
    const heat = this.tankHeat;
    const L = this.lattice;
    const active = L.nodeActive;
    const adj = L.edgeAdjacency;
    const cap = L.edgeCapacity;
    const floor = L.breakThreshold * FIRE_MIN_CAPACITY;
    const w = this.width;
    const dt = DT;
    for (let k = 0; k < gas.burningCount; k++) {
      const i = list[k];
      const f = fire[i];
      const x = i % w;
      for (let d = 0; d < 4; d++) {
        const j = d === 0 ? (x > 0 ? i - 1 : -1) : d === 1 ? (x < w - 1 ? i + 1 : -1) : d === 2 ? i - w : i + w;
        if (j < 0 || j >= CELL_COUNT) continue;
        if ((tiles[j] & FUEL) !== 0 && heat[j] < 1) {
          heat[j] += f * TANK_HEAT_RATE * dt;
          if (heat[j] >= 1) this.fuses[this.fuseCount++] = j;
        }
        if (active[j] === 1) {
          for (let e4 = 0; e4 < 4; e4++) {
            const e = adj[j * 4 + e4];
            if (e < 0) continue;
            const c = cap[e] * (1 - FIRE_WEAKEN * f * dt);
            cap[e] = c > floor ? c : floor;
          }
        }
      }
    }
  }

  /** One fixed 50 ms tick. Allocation-free (explosions, rare events, aside). */
  tick(): void {
    // Tanks primed last tick (by a blast or by fire) go off now. `blasts` collects every
    // explosion (the player's torch can set one off between ticks) until the simulation has
    // let the crew feel them and cleared it.
    const lit = this.fuses;
    const count = this.fuseCount;
    this.fuses = this.fusesNow;
    this.fusesNow = lit;
    this.fuseCount = 0;
    for (let k = 0; k < count; k++) this.explode(lit[k]);
    const tiles = this.tiles;
    // Inlined `GasGrid.addToxicGas`: a leak is often a single tile, so a call per leak would
    // stay cold, and V8's unoptimised tiers box every double they add.
    const gas = this.gas;
    const cells = gas.cells;
    const cur = gas.current;
    const tox = gas.toxin;
    for (let i = 0; i < CELL_COUNT; i++) {
      if ((tiles[i] & HAZARD_LEAK) !== 0 && cells[i] === OPEN) {
        cur[i] += LEAK_RATE_BAR;
        tox[i] += LEAK_RATE_BAR;
      }
    }
    this.gas.step();
    this.gas.fireStep(DT);
    // Called every tick (it returns at once when nothing burns): a call made only while
    // something burns would be a property load with no type feedback until the first fire.
    this.heatFromFire();
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
