import { CELL_COUNT, WIDTH } from './constants';

/** Tool bitmask. A pawn can take an order when its kit covers the order's tool. */
export const ToolKind = {
  NONE: 0,
  /** Plasma cutter: bulkheads and plating. */
  CUTTER: 0x01,
  /** Heavy cutter: load-bearing girders. */
  HEAVY_CUTTER: 0x02,
} as const;

export const MAX_ORDERS = 256;
export const PRIORITY_MIN = 1;
export const PRIORITY_MAX = 5;
export const PRIORITY_DEFAULT = 3;

/**
 * Fixed pool of player-designated salvage orders, one per tile at most.
 *
 * Orders are not consumed by `claimNextOrder`: a claimed order stays in the pool, marked
 * with its pawn, until that pawn completes or releases it. Work progress lives on the
 * order, so a pawn that flees mid-cut leaves the partial cut for whoever claims it next.
 * An order that was refused or unreachable is suspended for a while and skipped by claims.
 */
export class WorkOrderQueue {
  readonly capacity: number;
  readonly width: number;
  /** Tile index per slot, or -1 for a free slot. */
  readonly cell: Int32Array;
  readonly priority: Uint8Array;
  readonly tool: Uint8Array;
  /** Pawn holding the order, or -1. */
  readonly claimedBy: Int8Array;
  /** Disassembly progress, 0..100. */
  readonly progress: Float32Array;
  /** Ticks left before a suspended order can be claimed again. */
  readonly suspended: Uint16Array;
  /** Tile index -> slot, or -1. */
  readonly slotAt: Int16Array;
  count = 0;

  constructor(capacity = MAX_ORDERS, width = WIDTH, cellCount = CELL_COUNT) {
    this.capacity = capacity;
    this.width = width;
    this.cell = new Int32Array(capacity).fill(-1);
    this.priority = new Uint8Array(capacity);
    this.tool = new Uint8Array(capacity);
    this.claimedBy = new Int8Array(capacity).fill(-1);
    this.progress = new Float32Array(capacity);
    this.suspended = new Uint16Array(capacity);
    this.slotAt = new Int16Array(cellCount).fill(-1);
  }

  /**
   * Designates the tile at (x, y). Re-designating an existing order updates its priority
   * and tool. Returns the slot, or -1 when the pool is full or (x, y) is off the grid.
   */
  addOrder(x: number, y: number, priority: number = PRIORITY_DEFAULT, tool: number = ToolKind.CUTTER): number {
    if (x < 0 || y < 0 || x >= this.width || y * this.width + x >= this.slotAt.length) return -1;
    const idx = y * this.width + x;
    const p = priority < PRIORITY_MIN ? PRIORITY_MIN : priority > PRIORITY_MAX ? PRIORITY_MAX : priority | 0;
    let slot = this.slotAt[idx];
    if (slot >= 0) {
      this.priority[slot] = p;
      this.tool[slot] = tool;
      return slot;
    }
    slot = this.cell.indexOf(-1);
    if (slot < 0) return -1;
    this.cell[slot] = idx;
    this.priority[slot] = p;
    this.tool[slot] = tool;
    this.claimedBy[slot] = -1;
    this.progress[slot] = 0;
    this.suspended[slot] = 0;
    this.slotAt[idx] = slot;
    this.count++;
    return slot;
  }

  /** Removes the order on (x, y). A pawn holding it notices on its next tick. */
  cancelOrder(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y * this.width + x >= this.slotAt.length) return false;
    const slot = this.slotAt[y * this.width + x];
    if (slot < 0) return false;
    this.free(slot);
    return true;
  }

  hasOrder(x: number, y: number): boolean {
    return this.orderAt(x, y) >= 0;
  }

  orderAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y * this.width + x >= this.slotAt.length) return -1;
    return this.slotAt[y * this.width + x];
  }

  /**
   * Claims the best open order for a pawn at (pawnX, pawnY): highest priority first, then
   * nearest (Chebyshev). Skips claimed and suspended orders and tools outside `toolMask`.
   * Returns the slot, or -1 when nothing is available.
   */
  claimNextOrder(pawnX: number, pawnY: number, pawn = 0, toolMask = 0xff): number {
    let best = -1;
    let bestPriority = -1;
    let bestDist = 0;
    const w = this.width;
    for (let s = 0; s < this.capacity; s++) {
      const idx = this.cell[s];
      if (idx < 0 || this.claimedBy[s] >= 0 || this.suspended[s] > 0) continue;
      if ((this.tool[s] & toolMask) !== this.tool[s]) continue;
      const dx = Math.abs((idx % w) - pawnX);
      const dy = Math.abs(((idx / w) | 0) - pawnY);
      const dist = dx > dy ? dx : dy;
      const pr = this.priority[s];
      if (pr > bestPriority || (pr === bestPriority && dist < bestDist)) {
        best = s;
        bestPriority = pr;
        bestDist = dist;
      }
    }
    if (best >= 0) this.claimedBy[best] = pawn;
    return best;
  }

  /** True while `slot` still holds the order on tile `idx` claimed by `pawn`. */
  isHeldBy(slot: number, idx: number, pawn: number): boolean {
    return slot >= 0 && slot < this.capacity && this.cell[slot] === idx && this.claimedBy[slot] === pawn;
  }

  /** Hands an order back to the pool, optionally suspended for `suspendTicks`. */
  release(slot: number, suspendTicks = 0): void {
    if (slot < 0 || slot >= this.capacity || this.cell[slot] < 0) return;
    this.claimedBy[slot] = -1;
    this.suspended[slot] = suspendTicks;
  }

  /** Marks the order done and frees its slot. */
  complete(slot: number): void {
    if (slot < 0 || slot >= this.capacity || this.cell[slot] < 0) return;
    this.free(slot);
  }

  clear(): void {
    this.cell.fill(-1);
    this.claimedBy.fill(-1);
    this.progress.fill(0);
    this.suspended.fill(0);
    this.slotAt.fill(-1);
    this.count = 0;
  }

  /** Counts down suspensions. Allocation-free. */
  tick(): void {
    const sus = this.suspended;
    for (let s = 0; s < this.capacity; s++) if (sus[s] > 0) sus[s]--;
  }

  private free(slot: number): void {
    this.slotAt[this.cell[slot]] = -1;
    this.cell[slot] = -1;
    this.claimedBy[slot] = -1;
    this.progress[slot] = 0;
    this.suspended[slot] = 0;
    this.count--;
  }
}
