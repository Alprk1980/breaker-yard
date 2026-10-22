import { HEIGHT, WIDTH } from './constants';

/** Per-cell gas boundary type. */
export const GasCell = {
  OPEN: 0,
  WALL: 1,
  VACUUM: 2,
} as const;

export type GasCell = (typeof GasCell)[keyof typeof GasCell];

/** Largest stable explicit diffusion coefficient for a 4-neighbour Laplacian. */
export const MAX_STABLE_DIFFUSION = 0.25;

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Eulerian pressure field on a uniform grid, double-buffered.
 *
 * Each substep applies the explicit discrete Laplacian
 *   p'[i] = p[i] + k * sum_n (p[n] - p[i])
 * over the four neighbours, where:
 *   - WALL neighbours (and the grid edge) contribute nothing: zero-flux boundary.
 *   - VACUUM neighbours are pinned at 0 bar: they drain gas and never store it.
 * Fluxes between OPEN cells are symmetric, so mass is conserved exactly up to
 * float rounding, and everything lost to vacuum is tallied in `vacuumAbsorbed`.
 *
 * `toxin` is the toxic partial pressure carried inside the bulk gas. It runs through
 * the same kernel, so it spreads and vents with the gas and stays <= `current`.
 */
export class GasGrid {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  /** Pressure in bar, read side of the double buffer. */
  current: Float32Array;
  /** Pressure in bar, write side of the double buffer. */
  next: Float32Array;
  /** GasCell value per cell. */
  readonly cells: Uint8Array;
  /** Toxic partial pressure in bar, read side of its own double buffer. */
  toxin: Float32Array;
  /** Toxic partial pressure in bar, write side. */
  toxinNext: Float32Array;

  /** Diffusion coefficient per substep, clamped to `MAX_STABLE_DIFFUSION`. */
  private k: number;
  /** Diffusion substeps per tick. Higher values spread gas faster. */
  substeps: number;
  /** Running total of gas drained into vacuum cells since construction or `clear()`. */
  vacuumAbsorbed = 0;
  /** Running total of toxin drained into vacuum. */
  toxinVented = 0;

  private readonly scratch: Vec2 = { x: 0, y: 0 };

  constructor(width = WIDTH, height = HEIGHT, diffusion = 0.24, substeps = 8) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.current = new Float32Array(this.cellCount);
    this.next = new Float32Array(this.cellCount);
    this.cells = new Uint8Array(this.cellCount);
    this.toxin = new Float32Array(this.cellCount);
    this.toxinNext = new Float32Array(this.cellCount);
    this.k = Math.min(Math.max(diffusion, 0), MAX_STABLE_DIFFUSION);
    this.substeps = substeps;
  }

  get diffusion(): number {
    return this.k;
  }

  set diffusion(value: number) {
    this.k = Math.min(Math.max(value, 0), MAX_STABLE_DIFFUSION);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Changes a cell's boundary type. Gas held in a cell that stops being OPEN is discarded. */
  setCell(x: number, y: number, type: GasCell): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    this.cells[i] = type;
    if (type !== GasCell.OPEN) {
      this.current[i] = 0;
      this.next[i] = 0;
      this.toxin[i] = 0;
      this.toxinNext[i] = 0;
    }
  }

  getCell(x: number, y: number): GasCell {
    if (!this.inBounds(x, y)) return GasCell.WALL;
    return this.cells[y * this.width + x] as GasCell;
  }

  getPressure(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.current[y * this.width + x];
  }

  /** Sets pressure on an OPEN cell. Ignored for walls and vacuum. */
  setPressure(x: number, y: number, bar: number): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    if (this.cells[i] !== GasCell.OPEN) return;
    this.current[i] = bar;
    if (this.toxin[i] > bar) this.toxin[i] = bar;
  }

  getToxin(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.toxin[y * this.width + x];
  }

  /** Adds toxic gas to an OPEN cell: raises both the bulk pressure and the toxic share. */
  addToxicGas(i: number, bar: number): void {
    if (this.cells[i] !== GasCell.OPEN) return;
    this.current[i] += bar;
    this.toxin[i] += bar;
  }

  /** Adds gas to an OPEN cell. Ignored for walls and vacuum. */
  addPressure(i: number, bar: number): void {
    if (this.cells[i] !== GasCell.OPEN) return;
    this.current[i] += bar;
  }

  clear(): void {
    this.current.fill(0);
    this.next.fill(0);
    this.toxin.fill(0);
    this.toxinNext.fill(0);
    this.vacuumAbsorbed = 0;
    this.toxinVented = 0;
  }

  /** Total gas held in OPEN cells. */
  totalMass(): number {
    const cur = this.current;
    const cells = this.cells;
    let sum = 0;
    for (let i = 0; i < this.cellCount; i++) {
      if (cells[i] === GasCell.OPEN) sum += cur[i];
    }
    return sum;
  }

  /** Total toxin held in OPEN cells. */
  totalToxin(): number {
    const tox = this.toxin;
    const cells = this.cells;
    let sum = 0;
    for (let i = 0; i < this.cellCount; i++) {
      if (cells[i] === GasCell.OPEN) sum += tox[i];
    }
    return sum;
  }

  /** Advances one fixed tick: `substeps` explicit diffusion passes. */
  step(): void {
    for (let s = 0; s < this.substeps; s++) this.diffuse();
  }

  private diffuse(): void {
    const w = this.width;
    const h = this.height;
    const cur = this.current;
    const nxt = this.next;
    const tox = this.toxin;
    const toxNxt = this.toxinNext;
    const cells = this.cells;
    const k = this.k;
    let drained = 0;
    let toxDrained = 0;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (cells[i] !== GasCell.OPEN) {
          nxt[i] = 0;
          toxNxt[i] = 0;
          continue;
        }
        const p = cur[i];
        const q = tox[i];
        let lap = 0;
        let toxLap = 0;
        let vacuumSides = 0;

        if (x > 0) {
          const c = cells[i - 1];
          if (c === GasCell.OPEN) {
            lap += cur[i - 1] - p;
            toxLap += tox[i - 1] - q;
          } else if (c === GasCell.VACUUM) vacuumSides++;
        }
        if (x < w - 1) {
          const c = cells[i + 1];
          if (c === GasCell.OPEN) {
            lap += cur[i + 1] - p;
            toxLap += tox[i + 1] - q;
          } else if (c === GasCell.VACUUM) vacuumSides++;
        }
        if (y > 0) {
          const c = cells[i - w];
          if (c === GasCell.OPEN) {
            lap += cur[i - w] - p;
            toxLap += tox[i - w] - q;
          } else if (c === GasCell.VACUUM) vacuumSides++;
        }
        if (y < h - 1) {
          const c = cells[i + w];
          if (c === GasCell.OPEN) {
            lap += cur[i + w] - p;
            toxLap += tox[i + w] - q;
          } else if (c === GasCell.VACUUM) vacuumSides++;
        }

        // Vacuum sits at 0 bar, so each vacuum side contributes (0 - p).
        const loss = k * p * vacuumSides;
        const toxLoss = k * q * vacuumSides;
        drained += loss;
        toxDrained += toxLoss;
        nxt[i] = p + k * lap - loss;
        toxNxt[i] = q + k * toxLap - toxLoss;
      }
    }

    this.vacuumAbsorbed += drained;
    this.toxinVented += toxDrained;
    this.current = nxt;
    this.next = cur;
    this.toxin = toxNxt;
    this.toxinNext = tox;
  }

  /** True when an OPEN cell touches vacuum, i.e. the cell is part of a hull breach. */
  isBreach(x: number, y: number): boolean {
    if (this.getCell(x, y) !== GasCell.OPEN) return false;
    return (
      this.getCell(x - 1, y) === GasCell.VACUUM ||
      this.getCell(x + 1, y) === GasCell.VACUUM ||
      this.getCell(x, y - 1) === GasCell.VACUUM ||
      this.getCell(x, y + 1) === GasCell.VACUUM
    );
  }

  /**
   * Pressure differential at a cell: max - min over the cell itself (when OPEN) and its
   * non-wall 4-neighbours, with vacuum reading 0 bar. For a wall tile this is the load the
   * wall is holding back, i.e. what would blow through if it were cut. 0 with fewer than
   * two gas-bearing samples. Never allocates.
   */
  getPressureDelta(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    const self = this.cells[y * this.width + x];
    let lo = Infinity;
    let hi = -Infinity;
    let samples = 0;
    if (self === GasCell.OPEN) {
      const p = this.current[y * this.width + x];
      lo = p;
      hi = p;
      samples = 1;
    }
    for (let d = 0; d < 4; d++) {
      const nx = d === 0 ? x - 1 : d === 1 ? x + 1 : x;
      const ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
      if (!this.inBounds(nx, ny)) continue;
      const i = ny * this.width + nx;
      const c = this.cells[i];
      if (c === GasCell.WALL) continue;
      const p = c === GasCell.OPEN ? this.current[i] : 0;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
      samples++;
    }
    return samples < 2 ? 0 : hi - lo;
  }

  /**
   * `getPressureDelta(x, y) > limitBar`, for per-tick safety checks. Returning a boolean
   * instead of a double keeps the check allocation-free even when V8 does not inline it.
   */
  exceedsPressureDelta(x: number, y: number, limitBar: number): boolean {
    return this.getPressureDelta(x, y) > limitBar;
  }

  /**
   * Vent impulse at an OPEN cell: the negative central-difference pressure gradient,
   * pointing the way gas is being pushed (toward lower pressure). Vacuum neighbours
   * read as 0 bar and wall neighbours mirror the centre cell, so the vector is large
   * where a breached wall opens onto vacuum and zero across intact walls.
   *
   * Writes into `out` (default: an internal scratch vector) and returns it; never allocates.
   */
  getVentImpulse(x: number, y: number, out: Vec2 = this.scratch): Vec2 {
    out.x = 0;
    out.y = 0;
    if (this.getCell(x, y) !== GasCell.OPEN) return out;
    const p = this.current[y * this.width + x];
    out.x = (this.sampleForGradient(x - 1, y, p) - this.sampleForGradient(x + 1, y, p)) * 0.5;
    out.y = (this.sampleForGradient(x, y - 1, p) - this.sampleForGradient(x, y + 1, p)) * 0.5;
    return out;
  }

  private sampleForGradient(x: number, y: number, centre: number): number {
    if (!this.inBounds(x, y)) return centre;
    const i = y * this.width + x;
    const c = this.cells[i];
    if (c === GasCell.OPEN) return this.current[i];
    if (c === GasCell.VACUUM) return 0;
    return centre;
  }
}
