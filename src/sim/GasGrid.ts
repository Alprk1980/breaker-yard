import { HEIGHT, WIDTH } from './constants';

/** Per-cell gas boundary type. */
export const GasCell = {
  OPEN: 0,
  WALL: 1,
  VACUUM: 2,
} as const;

export type GasCell = (typeof GasCell)[keyof typeof GasCell];

const OPEN = GasCell.OPEN;
const WALL = GasCell.WALL;
const VACUUM = GasCell.VACUUM;

/** Largest stable explicit diffusion coefficient for a 4-neighbour Laplacian. */
export const MAX_STABLE_DIFFUSION = 0.25;

/**
 * Flow stability limits. On its own the flow pass (a damped symplectic-Euler wave equation
 * on the 5-point Laplacian) is stable up to a gain of 0.5, but each tick follows it with
 * diffusion passes that change pressure without touching the face fluxes, and that pairing
 * can pump energy into mid-frequency modes. The per-mode spectral radius of a whole tick
 * (4 to 8 flow substeps, then 8 diffusion substeps at k = 0.24) stays at or below about
 * 0.91 with gain <= 0.25 and keep <= 0.9; at keep 0.95 it passes 1 and a sealed room
 * slowly rings up from float rounding. The setters clamp to these values.
 */
export const MAX_STABLE_FLOW_GAIN = 0.25;
export const MAX_STABLE_FLOW_KEEP = 0.9;

/**
 * Vent impulse per bar of gas streaming through a cell each tick. Tuned on the 1 bar demo
 * room breached by one tile, one second in: the breach cell reads about 2.2 bar/tile, one
 * tile in 1.5 and two tiles in 0.6, all past the 0.5 that magboots hold; the stream stays
 * above the pawns' 0.15 flee threshold about five tiles back; and the jet just outside the
 * hole reads about 1.9, several times what an adrift pawn's suit thrusters can fight.
 */
export const STREAM_IMPULSE_GAIN = 0.5;

/** Fire needs at least this much gas (bar) to burn; below it, it is smothered. */
export const FIRE_MIN_BAR = 0.3;
/** Growth toward full intensity per second, spread to each open neighbour per second (times intensity). */
export const FIRE_GROWTH = 0.6;
export const FIRE_SPREAD = 0.35;
/** Gas a fully burning cell consumes per second, in bar; half of it turns to smoke (toxin). */
export const FIRE_BURN = 0.12;
export const FIRE_SMOKE = 0.5;
/** Share of a smothered fire left after each tick. */
export const FIRE_SMOTHER = 0.85;
/** Intensity below which a fire is out. */
export const FIRE_OUT = 0.01;

/**
 * A fresh scratch vector. Its fields start fractional on purpose: a `{ x: 0, y: 0 }` literal
 * starts with integer fields, and the first fraction written into it changes the object's
 * shape, throwing away optimised code and feedback built against the old one. Callers always
 * overwrite both fields before reading them.
 */
export function newVec2(): Vec2 {
  return { x: 0.5, y: 0.5 };
}

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
 * Before diffusing, each tick runs `flowSubsteps` passes of pressure-driven flow: every
 * open face carries a signed mass flux (`flowX`, `flowY`) that the pressure difference
 * across it accelerates (`flowGain`) and `flowKeep` damps, like the "virtual pipes" water
 * model. A limiter scales a cell's outgoing fluxes so it never gives away more than it
 * holds, so pressure stays non-negative. Each face moves gas from one cell to the other, so flow
 * conserves mass the same way diffusion does; flux into vacuum is tallied and dropped.
 * The flux keeps its momentum between ticks, which is what lets a breach blow a room out
 * in seconds instead of seeping.
 *
 * `toxin` is the toxic partial pressure carried inside the bulk gas. Diffusion runs it
 * through the same kernel; flow moves it upwind, as the donor cell's toxic share of each
 * face flux. Either way it spreads and vents with the gas and stays <= `current`.
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
  /** Gas flux per flow substep from cell i to cell i + 1, in bar. 0 on the east edge. */
  readonly flowX: Float32Array;
  /** Gas flux per flow substep from cell i to cell i + width, in bar. 0 on the south edge. */
  readonly flowY: Float32Array;
  /** Per-cell outflow total, then limiter scale, within one flow substep. */
  private readonly outflow: Float32Array;
  /** Per-cell toxic share of the bulk gas (toxin / pressure) within one flow substep. */
  private readonly toxinShare: Float32Array;

  /** Diffusion coefficient per substep, clamped to `MAX_STABLE_DIFFUSION`. */
  private k: number;
  /** Diffusion substeps per tick. Higher values spread gas faster. */
  substeps: number;
  /** Flow gain per substep: flux added per bar of pressure difference across a face. */
  private g = MAX_STABLE_FLOW_GAIN;
  /** Fraction of each face's flux kept from one flow substep to the next. */
  private keep = MAX_STABLE_FLOW_KEEP;
  /** Flow substeps per tick. 0 turns the flow pass off, leaving pure diffusion. */
  flowSubsteps = 8;
  /**
   * Running totals of gas and toxin drained into vacuum. Kept in a typed array, not as
   * number fields: a field that starts as integer 0 and turns fractional changes its
   * representation, which keeps invalidating the optimised kernels that update it.
   */
  private readonly vented = new Float64Array(4);
  /** Fire intensity per cell, 0 (none) to 1 (fully ablaze). Only open cells burn. */
  readonly fire: Float32Array;
  private readonly fireNext: Float32Array;
  /** Cells burning after the last `fireStep`, and how many. */
  readonly burningList: Int32Array;
  burningCount = 0;

  /** Running total of gas drained into vacuum cells since construction or `clear()`. */
  get vacuumAbsorbed(): number {
    return this.vented[0];
  }

  set vacuumAbsorbed(value: number) {
    this.vented[0] = value;
  }

  /** Running total of toxin drained into vacuum. */
  get toxinVented(): number {
    return this.vented[1];
  }

  set toxinVented(value: number) {
    this.vented[1] = value;
  }

  /** Running total of gas consumed by fire (net of what it turned into smoke). */
  get burned(): number {
    return this.vented[2];
  }

  /** Sum of fire intensity after the last `fireStep` (in the tally array, like the totals above). */
  get fireTotal(): number {
    return this.vented[3];
  }

  private readonly scratch: Vec2 = newVec2();
  /** Result slot for `measurePressureDelta`: a double returned from a call that V8 does not inline gets boxed. */
  private readonly delta = new Float64Array(1);

  constructor(width = WIDTH, height = HEIGHT, diffusion = 0.24, substeps = 8) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    this.current = new Float32Array(this.cellCount);
    this.next = new Float32Array(this.cellCount);
    this.cells = new Uint8Array(this.cellCount);
    this.toxin = new Float32Array(this.cellCount);
    this.toxinNext = new Float32Array(this.cellCount);
    this.flowX = new Float32Array(this.cellCount);
    this.flowY = new Float32Array(this.cellCount);
    this.outflow = new Float32Array(this.cellCount);
    this.toxinShare = new Float32Array(this.cellCount);
    this.fire = new Float32Array(this.cellCount);
    this.fireNext = new Float32Array(this.cellCount);
    this.burningList = new Int32Array(this.cellCount);
    this.k = Math.min(Math.max(diffusion, 0), MAX_STABLE_DIFFUSION);
    this.substeps = substeps;
  }

  get diffusion(): number {
    return this.k;
  }

  set diffusion(value: number) {
    this.k = Math.min(Math.max(value, 0), MAX_STABLE_DIFFUSION);
  }

  get flowGain(): number {
    return this.g;
  }

  set flowGain(value: number) {
    this.g = Math.min(Math.max(value, 0), MAX_STABLE_FLOW_GAIN);
  }

  get flowKeep(): number {
    return this.keep;
  }

  set flowKeep(value: number) {
    this.keep = Math.min(Math.max(value, 0), MAX_STABLE_FLOW_KEEP);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * Changes a cell's boundary type. Gas held in a cell that stops being OPEN is discarded,
   * and the flux on the cell's four faces restarts from rest.
   */
  setCell(x: number, y: number, type: GasCell): void {
    if (!this.inBounds(x, y)) return;
    const i = y * this.width + x;
    this.cells[i] = type;
    this.flowX[i] = 0;
    this.flowY[i] = 0;
    if (x > 0) this.flowX[i - 1] = 0;
    if (y > 0) this.flowY[i - this.width] = 0;
    if (type !== GasCell.OPEN) {
      this.current[i] = 0;
      this.next[i] = 0;
      this.toxin[i] = 0;
      this.toxinNext[i] = 0;
      this.fire[i] = 0;
    }
  }

  /** Sets cell `i` burning at least at `intensity`, if it is open and has the gas to burn. */
  ignite(i: number, intensity: number): void {
    if (this.cells[i] !== GasCell.OPEN || this.current[i] < FIRE_MIN_BAR) return;
    if (this.fire[i] < intensity) this.fire[i] = intensity;
    if (this.burningCount === 0) this.burningCount = 1;
  }

  /**
   * One fixed tick of fire, after `step`. A burning cell with gas to spare grows toward full
   * intensity, spreads to open neighbours that have gas, and burns its gas (half to smoke,
   * which is toxin); one without enough gas is smothered. Records the burning cells in
   * `burningList`. Does nothing while nothing burns. Allocation-free.
   */
  fireStep(dt: number): void {
    if (this.burningCount === 0) return;
    const n = this.cellCount;
    const w = this.width;
    const h = this.height;
    const f = this.fire;
    const fn = this.fireNext;
    const cells = this.cells;
    const cur = this.current;
    const tox = this.toxin;
    const OPEN = GasCell.OPEN;
    fn.fill(0);
    let burned = 0;
    for (let i = 0; i < n; i++) {
      const fi = f[i];
      if (fi <= FIRE_OUT || cells[i] !== OPEN) continue;
      const p = cur[i];
      if (p < FIRE_MIN_BAR) {
        fn[i] += fi * FIRE_SMOTHER;
        continue;
      }
      fn[i] += fi + FIRE_GROWTH * dt * (1 - fi);
      const want = FIRE_BURN * fi * dt;
      const take = want < p ? want : p;
      const left = p - take * (1 - FIRE_SMOKE);
      cur[i] = left;
      const smoke = tox[i] + take * FIRE_SMOKE;
      tox[i] = smoke < left ? smoke : left;
      burned += take * (1 - FIRE_SMOKE);
      const spread = FIRE_SPREAD * fi * dt;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && cells[i - 1] === OPEN && cur[i - 1] >= FIRE_MIN_BAR) fn[i - 1] += spread;
      if (x < w - 1 && cells[i + 1] === OPEN && cur[i + 1] >= FIRE_MIN_BAR) fn[i + 1] += spread;
      if (y > 0 && cells[i - w] === OPEN && cur[i - w] >= FIRE_MIN_BAR) fn[i - w] += spread;
      if (y < h - 1 && cells[i + w] === OPEN && cur[i + w] >= FIRE_MIN_BAR) fn[i + w] += spread;
    }
    let count = 0;
    let total = 0;
    const list = this.burningList;
    for (let i = 0; i < n; i++) {
      const v = fn[i] > 1 ? 1 : fn[i];
      const out = v <= FIRE_OUT ? 0 : v;
      f[i] = out;
      if (out > 0) {
        list[count++] = i;
        total += out;
      }
    }
    this.burningCount = count;
    this.vented[3] = total;
    this.vented[2] += burned;
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
    this.flowX.fill(0);
    this.flowY.fill(0);
    this.vacuumAbsorbed = 0;
    this.toxinVented = 0;
    this.vented[2] = 0;
    this.vented[3] = 0;
    this.fire.fill(0);
    this.burningCount = 0;
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

  /** Advances one fixed tick: `flowSubsteps` flow passes, then `substeps` diffusion passes. */
  step(): void {
    for (let s = 0; s < this.flowSubsteps; s++) this.flow();
    for (let s = 0; s < this.substeps; s++) this.diffuse();
  }

  /** One pressure-driven flow substep. See the class comment. */
  private flow(): void {
    const w = this.width;
    const h = this.height;
    const cur = this.current;
    const nxt = this.next;
    const tox = this.toxin;
    const toxNxt = this.toxinNext;
    const cells = this.cells;
    const fx = this.flowX;
    const fy = this.flowY;
    const out = this.outflow;
    const share = this.toxinShare;
    const g = this.g;
    const keep = this.keep;

    // 1. Accelerate each cell's east and south faces by the pressure difference across them.
    //    Walls carry nothing, and vacuum (0 bar, no gas) only ever takes gas from an open
    //    neighbour. The west and north faces were done earlier in this raster pass, so the
    //    same pass sets the limiter (the scale that stops an open cell giving away more gas
    //    than it holds) and the cell's toxic share.
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const lastRow = y === h - 1;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const ci = cells[i];
        const ce = x < w - 1 ? cells[i + 1] : WALL;
        const cs = lastRow ? WALL : cells[i + w];
        if (ci !== OPEN) {
          const fe = fx[i] * keep - (ce === OPEN ? g * cur[i + 1] : 0);
          const fs = fy[i] * keep - (cs === OPEN ? g * cur[i + w] : 0);
          fx[i] = ci === VACUUM && ce === OPEN && fe < 0 ? fe : 0;
          fy[i] = ci === VACUUM && cs === OPEN && fs < 0 ? fs : 0;
          out[i] = 1;
          share[i] = 0;
          continue;
        }
        const p = cur[i];
        const fe = fx[i] * keep + g * (p - (ce === OPEN ? cur[i + 1] : 0));
        const fs = fy[i] * keep + g * (p - (cs === OPEN ? cur[i + w] : 0));
        const e = ce === WALL ? 0 : ce === VACUUM && fe < 0 ? 0 : fe;
        const s = cs === WALL ? 0 : cs === VACUUM && fs < 0 ? 0 : fs;
        fx[i] = e;
        fy[i] = s;
        const wf = x > 0 ? fx[i - 1] : 0;
        const nf = y > 0 ? fy[i - w] : 0;
        const leaving = (e > 0 ? e : 0) + (s > 0 ? s : 0) - (wf < 0 ? wf : 0) - (nf < 0 ? nf : 0);
        out[i] = leaving > p ? p / leaving : 1;
        share[i] = p > 0 ? tox[i] / p : 0;
      }
    }

    // 2. Scale each face by its donor's limiter and move the gas, with toxin travelling as
    //    the donor's toxic share of the flux. As in pass 1, the west and north faces are
    //    already final when a cell is reached. A face only carries flux from a neighbour that
    //    exists, so the neighbour reads below never leave the grid.
    let drained = 0;
    let toxDrained = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const e0 = fx[i];
        const s0 = fy[i];
        const e = e0 > 0 ? e0 * out[i] : e0 < 0 ? e0 * out[i + 1] : 0;
        const s = s0 > 0 ? s0 * out[i] : s0 < 0 ? s0 * out[i + w] : 0;
        fx[i] = e;
        fy[i] = s;
        const wf = x > 0 ? fx[i - 1] : 0;
        const nf = y > 0 ? fy[i - w] : 0;
        const si = share[i];
        const net = wf + nf - e - s;
        const toxNet =
          (wf > 0 ? wf * share[i - 1] : wf * si) +
          (nf > 0 ? nf * share[i - w] : nf * si) -
          (e < 0 ? e * share[i + 1] : e * si) -
          (s < 0 ? s * share[i + w] : s * si);
        if (cells[i] === OPEN) {
          const np = cur[i] + net;
          const nq = tox[i] + toxNet;
          nxt[i] = np > 0 ? np : 0;
          toxNxt[i] = nq < 0 ? 0 : nq > np ? (np > 0 ? np : 0) : nq;
        } else {
          // Vacuum only ever receives, so everything flowing in is gone. Walls carry no flux.
          drained += net;
          toxDrained += toxNet;
          nxt[i] = 0;
          toxNxt[i] = 0;
        }
      }
    }

    this.vented[0] += drained;
    this.vented[1] += toxDrained;
    this.current = nxt;
    this.next = cur;
    this.toxin = toxNxt;
    this.toxinNext = tox;
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
    // Cell types read once here: a property load inside a branch that warm-up never took has
    // no type feedback, and deoptimises the whole kernel the first time it runs.
    const OPEN = GasCell.OPEN;
    const VACUUM = GasCell.VACUUM;
    let drained = 0;
    let toxDrained = 0;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (cells[i] !== OPEN) {
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
          if (c === OPEN) {
            lap += cur[i - 1] - p;
            toxLap += tox[i - 1] - q;
          } else if (c === VACUUM) vacuumSides++;
        }
        if (x < w - 1) {
          const c = cells[i + 1];
          if (c === OPEN) {
            lap += cur[i + 1] - p;
            toxLap += tox[i + 1] - q;
          } else if (c === VACUUM) vacuumSides++;
        }
        if (y > 0) {
          const c = cells[i - w];
          if (c === OPEN) {
            lap += cur[i - w] - p;
            toxLap += tox[i - w] - q;
          } else if (c === VACUUM) vacuumSides++;
        }
        if (y < h - 1) {
          const c = cells[i + w];
          if (c === OPEN) {
            lap += cur[i + w] - p;
            toxLap += tox[i + w] - q;
          } else if (c === VACUUM) vacuumSides++;
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

    this.vented[0] += drained;
    this.vented[1] += toxDrained;
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
    this.measurePressureDelta(x, y);
    return this.delta[0];
  }

  /**
   * `getPressureDelta(x, y) > limitBar`, for per-tick safety checks. Returning a boolean
   * instead of a double keeps the check allocation-free even when V8 does not inline it,
   * and so does reading the delta through `delta` rather than a double return value.
   */
  exceedsPressureDelta(x: number, y: number, limitBar: number): boolean {
    this.measurePressureDelta(x, y);
    return this.delta[0] > limitBar;
  }

  /** Writes `getPressureDelta(x, y)` to `delta[0]`. */
  private measurePressureDelta(x: number, y: number): void {
    this.delta[0] = 0;
    if (!this.inBounds(x, y)) return;
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
    this.delta[0] = samples < 2 ? 0 : hi - lo;
  }

  /**
   * Vent impulse at a cell, pointing the way gas is pushing. Two parts:
   *   - Pressure: at an OPEN cell, the negative central-difference pressure gradient.
   *     Vacuum neighbours read as 0 bar and wall neighbours mirror the centre cell, so
   *     it is large where a breached wall opens onto vacuum and zero across intact walls.
   *   - Stream: the gas flowing through the cell this tick (the mean of the flux on its
   *     opposite faces, times `flowSubsteps`), scaled by `STREAM_IMPULSE_GAIN`. At a vacuum
   *     cell just outside a breach it is the whole flux coming in rather than the mean, as
   *     the jet carries on past the hole, so it keeps pushing whatever it blew out.
   * Walls read zero.
   *
   * Writes into `out` (default: an internal scratch vector) and returns it; never allocates.
   */
  getVentImpulse(x: number, y: number, out: Vec2 = this.scratch): Vec2 {
    out.x = 0;
    out.y = 0;
    if (!this.inBounds(x, y)) return out;
    const w = this.width;
    const i = y * w + x;
    const c = this.cells[i];
    if (c === GasCell.WALL) return out;
    const fx = this.flowX;
    const fy = this.flowY;
    const gain = STREAM_IMPULSE_GAIN * (c === GasCell.OPEN ? 0.5 : 1) * this.flowSubsteps;
    out.x = ((x > 0 ? fx[i - 1] : 0) + fx[i]) * gain;
    out.y = ((y > 0 ? fy[i - w] : 0) + fy[i]) * gain;
    if (c !== GasCell.OPEN) return out;
    const p = this.current[i];
    out.x += (this.sampleForGradient(x - 1, y, p) - this.sampleForGradient(x + 1, y, p)) * 0.5;
    out.y += (this.sampleForGradient(x, y - 1, p) - this.sampleForGradient(x, y + 1, p)) * 0.5;
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
