import { describe, expect, it } from 'vitest';
import { WIDTH } from './constants';
import { PRIORITY_MAX, ToolKind, WorkOrderQueue } from './WorkOrderQueue';

describe('WorkOrderQueue', () => {
  it('adds, finds and cancels orders by tile', () => {
    const q = new WorkOrderQueue();
    const s = q.addOrder(10, 20, 4);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(q.cell[s]).toBe(20 * WIDTH + 10);
    expect(q.hasOrder(10, 20)).toBe(true);
    expect(q.count).toBe(1);
    expect(q.cancelOrder(10, 20)).toBe(true);
    expect(q.hasOrder(10, 20)).toBe(false);
    expect(q.cancelOrder(10, 20)).toBe(false);
    expect(q.count).toBe(0);
  });

  it('re-designating a tile updates it instead of duplicating', () => {
    const q = new WorkOrderQueue();
    const a = q.addOrder(1, 1, 1);
    const b = q.addOrder(1, 1, 99);
    expect(b).toBe(a);
    expect(q.count).toBe(1);
    expect(q.priority[a]).toBe(PRIORITY_MAX);
  });

  it('claims by priority, then distance, and never hands out a claimed order twice', () => {
    const q = new WorkOrderQueue();
    const far = q.addOrder(100, 100, 3);
    const near = q.addOrder(12, 10, 3);
    const urgent = q.addOrder(120, 5, 5);
    expect(q.claimNextOrder(10, 10, 0)).toBe(urgent);
    expect(q.claimNextOrder(10, 10, 1)).toBe(near);
    expect(q.claimNextOrder(10, 10, 2)).toBe(far);
    expect(q.claimNextOrder(10, 10, 3)).toBe(-1);
    expect(q.claimedBy[near]).toBe(1);
    expect(q.isHeldBy(near, q.cell[near], 1)).toBe(true);
    expect(q.isHeldBy(near, q.cell[near], 0)).toBe(false);
  });

  it('respects the tool mask', () => {
    const q = new WorkOrderQueue();
    const heavy = q.addOrder(5, 5, 5, ToolKind.HEAVY_CUTTER);
    const light = q.addOrder(50, 50, 1, ToolKind.CUTTER);
    expect(q.claimNextOrder(5, 5, 0, ToolKind.CUTTER)).toBe(light);
    expect(q.claimNextOrder(5, 5, 1, ToolKind.CUTTER | ToolKind.HEAVY_CUTTER)).toBe(heavy);
  });

  it('skips suspended orders until the suspension runs out', () => {
    const q = new WorkOrderQueue();
    const s = q.addOrder(3, 3, 3);
    expect(q.claimNextOrder(0, 0, 0)).toBe(s);
    q.release(s, 2);
    expect(q.claimNextOrder(0, 0, 1)).toBe(-1);
    q.tick();
    q.tick();
    expect(q.claimNextOrder(0, 0, 1)).toBe(s);
  });

  it('keeps progress across release and drops it on completion', () => {
    const q = new WorkOrderQueue();
    const s = q.addOrder(3, 3, 3);
    q.claimNextOrder(0, 0, 0);
    q.progress[s] = 40;
    q.release(s);
    expect(q.progress[s]).toBe(40);
    q.complete(s);
    expect(q.count).toBe(0);
    expect(q.hasOrder(3, 3)).toBe(false);
  });

  it('refuses orders when full or off the grid', () => {
    const q = new WorkOrderQueue(2);
    expect(q.addOrder(0, 0)).toBe(0);
    expect(q.addOrder(1, 0)).toBe(1);
    expect(q.addOrder(2, 0)).toBe(-1);
    expect(q.addOrder(-1, 0)).toBe(-1);
    expect(q.addOrder(0, 128)).toBe(-1);
  });
});
