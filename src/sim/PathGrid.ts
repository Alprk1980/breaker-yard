import { HEIGHT, WIDTH } from './constants';
import { GasCell, type GasGrid } from './GasGrid';
import type { StressLattice } from './StressLattice';

/** Cost of an impassable tile. */
export const COST_IMPASSABLE = 0xffff;
/** Cost of stepping orthogonally onto a calm, open floor tile. */
export const COST_BASE = 10;
/** Highest cost a passable tile can carry, so penalties never turn a tile into a wall. */
export const COST_MAX_PASSABLE = 0xfffe;

/** Penalty per bar of local pressure differential (max - min over the 4-neighbourhood). */
export const PRESSURE_PENALTY_PER_BAR = 40;
export const PRESSURE_PENALTY_CAP = 2000;
/** Penalty per bar of toxic partial pressure. */
export const TOXIN_PENALTY_PER_BAR = 400;
export const TOXIN_PENALTY_CAP = 4000;
/** Members above this utilisation make the tiles around them dangerous to stand on. */
export const STRESS_DANGER = 0.8;
/** Penalty at the danger threshold, rising linearly to `STRESS_PENALTY_AT_BREAK` at 100%. */
export const STRESS_PENALTY_MIN = 100;
export const STRESS_PENALTY_AT_BREAK = 600;

/** Returned by `findPath` when no route exists. */
export const PATH_NONE = -1;
/** Returned by `findPath` when a route exists but does not fit in the output buffer. */
export const PATH_TOO_LONG = -2;

// Plain constants: an imported enum member is a property load per use.
const OPEN = GasCell.OPEN;
const WALL = GasCell.WALL;

/** Pressure a suit can top its air up from, in bar (with toxin under `BREATHABLE_TOXIN_BAR`). */
export const BREATHABLE_BAR = 0.6;
export const BREATHABLE_TOXIN_BAR = 0.2;

/** Path cost added at full fire intensity: pawns route around flames where they can. */
export const FIRE_PENALTY = 2000;

const DIAG_NUM = 14;
const DIAG_DEN = 10;

/**
 * Writes traversal costs for every tile into `cost`:
 *   - WALL and VACUUM cells are impassable (0xFFFF). Pawns walk on floor; anything else is
 *     either solid or open space with nothing to stand on.
 *   - OPEN cells start at `COST_BASE` and gain penalties for the local pressure differential
 *     (where a breach would drag them), toxic partial pressure, and for sitting next to a
 *     structural member above 80% utilisation (where a snap would land on them).
 * Allocation-free; reads the gas and stress layers, owns nothing in them.
 */
export function updateCostGrid(
  gasGrid: GasGrid,
  stressLattice: StressLattice,
  cost: Uint16Array,
  breathable: Uint8Array | null = null,
): void {
  const w = gasGrid.width;
  const h = gasGrid.height;
  const cells = gasGrid.cells;
  const p = gasGrid.current;
  const tox = gasGrid.toxin;
  const fire = gasGrid.fire;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (cells[i] !== OPEN) {
        cost[i] = COST_IMPASSABLE;
        if (breathable !== null) breathable[i] = 0;
        continue;
      }
      if (breathable !== null) breathable[i] = p[i] >= BREATHABLE_BAR && tox[i] < BREATHABLE_TOXIN_BAR ? 1 : 0;
      // Inline getPressureDelta: the cell is OPEN, so it is always one of the samples.
      const pi = p[i];
      let lo = pi;
      let hi = pi;
      if (x > 0) {
        const c = cells[i - 1];
        if (c !== WALL) {
          const q = c === OPEN ? p[i - 1] : 0;
          if (q < lo) lo = q;
          if (q > hi) hi = q;
        }
      }
      if (x < w - 1) {
        const c = cells[i + 1];
        if (c !== WALL) {
          const q = c === OPEN ? p[i + 1] : 0;
          if (q < lo) lo = q;
          if (q > hi) hi = q;
        }
      }
      if (y > 0) {
        const c = cells[i - w];
        if (c !== WALL) {
          const q = c === OPEN ? p[i - w] : 0;
          if (q < lo) lo = q;
          if (q > hi) hi = q;
        }
      }
      if (y < h - 1) {
        const c = cells[i + w];
        if (c !== WALL) {
          const q = c === OPEN ? p[i + w] : 0;
          if (q < lo) lo = q;
          if (q > hi) hi = q;
        }
      }
      let pressurePenalty = (hi - lo) * PRESSURE_PENALTY_PER_BAR;
      if (pressurePenalty > PRESSURE_PENALTY_CAP) pressurePenalty = PRESSURE_PENALTY_CAP;
      let toxinPenalty = tox[i] * TOXIN_PENALTY_PER_BAR;
      if (toxinPenalty > TOXIN_PENALTY_CAP) toxinPenalty = TOXIN_PENALTY_CAP;
      let firePenalty = fire[i] * FIRE_PENALTY;
      if (firePenalty > FIRE_PENALTY) firePenalty = FIRE_PENALTY;
      cost[i] = (COST_BASE + pressurePenalty + toxinPenalty + firePenalty) | 0;
    }
  }

  // Stress: every member over the danger line taxes the passable tiles in its 3x3 block.
  const active = stressLattice.nodeActive;
  const stress = stressLattice.nodeStress;
  const n = stressLattice.nodeCount;
  const span = STRESS_PENALTY_AT_BREAK - STRESS_PENALTY_MIN;
  for (let i = 0; i < n; i++) {
    if (active[i] === 0) continue;
    const s = stress[i];
    if (s <= STRESS_DANGER) continue;
    const t = (s - STRESS_DANGER) / (1 - STRESS_DANGER);
    const penalty = (STRESS_PENALTY_MIN + (t > 1 ? 1 : t) * span) | 0;
    const nx = i % w;
    const ny = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = ny + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = nx + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        const c = cost[j];
        if (c === COST_IMPASSABLE) continue;
        const sum = c + penalty;
        cost[j] = sum > COST_MAX_PASSABLE ? COST_MAX_PASSABLE : sum;
      }
    }
  }
}

/**
 * Traversal cost grid plus an allocation-free A* solver.
 *
 * The solver is 8-connected (diagonals cost 1.4x and may not cut wall corners) with an
 * octile heuristic scaled by `COST_BASE`, which is the cheapest any tile can be, so the
 * heuristic is admissible and paths are optimal. Every per-node array (g, f, parent, heap
 * position) is a typed array sized to the grid at construction: the grid itself is the
 * node pool. A search generation stamp marks which entries are live, so nothing is
 * cleared between searches.
 */
export class PathGrid {
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;
  /** Traversal cost per tile; 0xFFFF is impassable. */
  readonly cost: Uint16Array;
  /**
   * 1 where a suit can refill its air (deck at `BREATHABLE_BAR` or more, little toxin), else 0.
   * Kept here, refreshed with the costs, so rescuers can look for air without reading floats.
   */
  readonly breathable: Uint8Array;

  /** Nodes expanded by the most recent search. */
  lastExpanded = 0;

  private readonly g: Uint32Array;
  private readonly f: Uint32Array;
  private readonly parent: Int32Array;
  /** Generation in which a node was first reached; g/f/parent are only valid when equal to `gen`. */
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  /** Binary min-heap of node ids ordered by f, with each node's slot for decrease-key. */
  private readonly heap: Int32Array;
  private readonly heapPos: Int32Array;
  private heapSize = 0;
  private gen = 0;

  constructor(width = WIDTH, height = HEIGHT) {
    this.width = width;
    this.height = height;
    this.cellCount = width * height;
    const n = this.cellCount;
    this.cost = new Uint16Array(n).fill(COST_IMPASSABLE);
    this.breathable = new Uint8Array(n);
    this.g = new Uint32Array(n);
    this.f = new Uint32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(n);
    this.heapPos = new Int32Array(n);
  }

  /** Recomputes `cost` from the gas and stress layers. */
  updateCostGrid(gasGrid: GasGrid, stressLattice: StressLattice): void {
    updateCostGrid(gasGrid, stressLattice, this.cost, this.breathable);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  isPassable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.cost[y * this.width + x] !== COST_IMPASSABLE;
  }

  getCost(x: number, y: number): number {
    return this.inBounds(x, y) ? this.cost[y * this.width + x] : COST_IMPASSABLE;
  }

  /**
   * A* from (sx, sy) to (tx, ty). With `adjacent` set, the goal is any passable tile
   * 4-adjacent to the target instead of the target itself, which is how a pawn reaches a
   * wall it is about to cut; with `diagonal` as well, 8-adjacent tiles count too (a torch
   * reaching across a corner). The start tile is allowed to be impassable (a pawn adrift).
   *
   * Writes tile indices from the first step after the start through the goal into
   * `out[offset .. offset + length)` and returns the length (0 when already at the goal),
   * `PATH_NONE` if unreachable, or `PATH_TOO_LONG` if the route needs more than `maxLength`.
   */
  findPath(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    adjacent: boolean,
    out: Int32Array,
    offset: number,
    maxLength: number,
    diagonal = false,
  ): number {
    if (!this.inBounds(sx, sy) || !this.inBounds(tx, ty)) return PATH_NONE;
    const w = this.width;
    const h = this.height;
    const cost = this.cost;
    const g = this.g;
    const f = this.f;
    const parent = this.parent;
    const seen = this.seen;
    const closed = this.closed;

    this.gen++;
    if (this.gen === 0xffffffff) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.gen = 1;
    }
    const gen = this.gen;
    this.heapSize = 0;

    const start = sy * w + sx;
    seen[start] = gen;
    g[start] = 0;
    parent[start] = -1;
    f[start] = this.heuristic(sx, sy, tx, ty, adjacent, diagonal);
    this.push(start);

    let goal = -1;
    let expanded = 0;
    while (this.heapSize > 0) {
      const node = this.pop();
      closed[node] = gen;
      expanded++;
      const nx = node % w;
      const ny = (node / w) | 0;
      if (this.isGoal(nx, ny, tx, ty, adjacent, diagonal) && (node !== start || cost[node] !== COST_IMPASSABLE)) {
        goal = node;
        break;
      }
      const gNode = g[node];
      for (let d = 0; d < 8; d++) {
        // E, W, S, N, then SE, SW, NE, NW.
        const dx = d === 0 || d === 4 || d === 6 ? 1 : d === 1 || d === 5 || d === 7 ? -1 : 0;
        const dy = d === 2 || d === 4 || d === 5 ? 1 : d === 3 || d === 6 || d === 7 ? -1 : 0;
        const mx = nx + dx;
        const my = ny + dy;
        if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
        const m = my * w + mx;
        const c = cost[m];
        if (c === COST_IMPASSABLE || closed[m] === gen) continue;
        let step = c;
        if (d >= 4) {
          // No squeezing diagonally between two wall corners.
          if (cost[ny * w + mx] === COST_IMPASSABLE || cost[my * w + nx] === COST_IMPASSABLE) continue;
          step = ((c * DIAG_NUM) / DIAG_DEN) | 0;
        }
        const tentative = gNode + step;
        if (seen[m] === gen && tentative >= g[m]) continue;
        g[m] = tentative;
        parent[m] = node;
        f[m] = tentative + this.heuristic(mx, my, tx, ty, adjacent, diagonal);
        if (seen[m] !== gen) {
          seen[m] = gen;
          this.push(m);
        } else {
          this.siftUp(this.heapPos[m]);
        }
      }
    }
    this.lastExpanded = expanded;
    if (goal < 0) return PATH_NONE;

    let length = 0;
    for (let k = goal; k !== start; k = parent[k]) length++;
    if (length > maxLength) return PATH_TOO_LONG;
    let write = offset + length - 1;
    for (let k = goal; k !== start; k = parent[k]) out[write--] = k;
    return length;
  }

  private isGoal(x: number, y: number, tx: number, ty: number, adjacent: boolean, diagonal: boolean): boolean {
    if (!adjacent) return x === tx && y === ty;
    const dx = x > tx ? x - tx : tx - x;
    const dy = y > ty ? y - ty : ty - y;
    return diagonal ? dx <= 1 && dy <= 1 && dx + dy > 0 : dx + dy === 1;
  }

  /** Octile distance in cost units, less one step when any neighbour of the target will do. */
  private heuristic(x: number, y: number, tx: number, ty: number, adjacent: boolean, diagonal: boolean): number {
    const dx = x > tx ? x - tx : tx - x;
    const dy = y > ty ? y - ty : ty - y;
    const lo = dx < dy ? dx : dy;
    const hi = dx < dy ? dy : dx;
    const h = (hi - lo) * COST_BASE + ((lo * COST_BASE * DIAG_NUM) / DIAG_DEN) | 0;
    if (!adjacent) return h;
    // Any 4-neighbour of the target is at most one orthogonal step closer than the target,
    // and an 8-neighbour at most one diagonal step.
    const step = diagonal ? ((COST_BASE * DIAG_NUM) / DIAG_DEN) | 0 : COST_BASE;
    return h > step ? h - step : 0;
  }

  private less(a: number, b: number): boolean {
    const fa = this.f[a];
    const fb = this.f[b];
    // Ties go to the deeper node, which keeps A* from fanning out across open floor.
    return fa < fb || (fa === fb && this.g[a] > this.g[b]);
  }

  private push(node: number): void {
    const i = this.heapSize++;
    this.heap[i] = node;
    this.heapPos[node] = i;
    this.siftUp(i);
  }

  private pop(): number {
    const heap = this.heap;
    const top = heap[0];
    const last = heap[--this.heapSize];
    if (this.heapSize > 0) {
      heap[0] = last;
      this.heapPos[last] = 0;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const pos = this.heapPos;
    const node = heap[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      const up = heap[p];
      if (!this.less(node, up)) break;
      heap[i] = up;
      pos[up] = i;
      i = p;
    }
    heap[i] = node;
    pos[node] = i;
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const pos = this.heapPos;
    const size = this.heapSize;
    const node = heap[i];
    for (;;) {
      const l = i * 2 + 1;
      if (l >= size) break;
      const r = l + 1;
      const c = r < size && this.less(heap[r], heap[l]) ? r : l;
      if (!this.less(heap[c], node)) break;
      heap[i] = heap[c];
      pos[heap[i]] = i;
      i = c;
    }
    heap[i] = node;
    pos[node] = i;
  }
}
