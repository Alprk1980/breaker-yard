import { describe, expect, it } from 'vitest';
import { StressLattice } from './StressLattice';

/** Horizontal beam from (0, y) to (len - 1, y); node 0 is the anchor. */
function cantilever(len: number, threshold = 1000, mass = 1): StressLattice {
  const L = new StressLattice(16, 8, threshold);
  for (let x = 0; x < len; x++) L.addNode(x, 2, mass, x === 0);
  return L;
}

function edgeBetween(L: StressLattice, ax: number, ay: number, bx: number, by: number): number {
  const a = L.index(ax, ay);
  const b = L.index(bx, by);
  for (let d = 0; d < 4; d++) {
    const e = L.edgeAdjacency[a * 4 + d];
    if (e >= 0 && (L.edgeB[e] === b || L.edgeA[e] === b)) return e;
  }
  throw new Error('not adjacent');
}

describe('StressLattice relaxation', () => {
  it('builds a consistent fixed adjacency table', () => {
    const L = new StressLattice(4, 3);
    expect(L.edgeCount).toBe(3 * 3 + 4 * 2);
    for (let n = 0; n < L.nodeCount; n++) {
      for (let d = 0; d < 4; d++) {
        const e = L.edgeAdjacency[n * 4 + d];
        if (e >= 0) expect(L.edgeA[e] === n || L.edgeB[e] === n).toBe(true);
      }
    }
    expect(L.edgeAdjacency[0 * 4 + 1]).toBe(-1); // no west edge at x = 0
  });

  it('carries each cantilever segment the mass hanging beyond it', () => {
    const L = cantilever(6);
    L.solve();
    expect(L.converged).toBe(true);
    // Edge from node k to k+1 carries the mass of nodes k+1..5.
    for (let k = 0; k < 5; k++) {
      const e = edgeBetween(L, k, 2, k + 1, 2);
      expect(Math.abs(L.edgeLoad[e])).toBeCloseTo(5 - k, 2);
    }
  });

  it('delivers all grounded mass to the anchors', () => {
    const L = new StressLattice(16, 16, 1000);
    for (let y = 2; y < 10; y++) for (let x = 2; x < 12; x++) L.addNode(x, y, 1 + ((x * 7 + y * 3) % 4));
    L.setAnchor(2, 2, true);
    L.setAnchor(11, 9, true);
    L.solve();
    expect(L.anchorReaction()).toBeCloseTo(L.groundedMass(), 1);
  });

  it('splits load between two anchors on a symmetric beam', () => {
    const L = new StressLattice(16, 4, 1000);
    for (let x = 0; x < 9; x++) L.addNode(x, 1, 1, x === 0 || x === 8);
    L.solve();
    const left = Math.abs(L.edgeLoad[edgeBetween(L, 0, 1, 1, 1)]);
    const right = Math.abs(L.edgeLoad[edgeBetween(L, 7, 1, 8, 1)]);
    expect(left).toBeCloseTo(3.5, 2);
    expect(right).toBeCloseTo(3.5, 2);
  });

  it('marks nodes with no path to an anchor as floating and loads them with nothing', () => {
    const L = cantilever(4);
    L.addNode(8, 2, 5); // detached island
    L.addNode(9, 2, 5);
    L.solve();
    expect(L.floatingCount).toBe(2);
    expect(L.nodeGrounded[L.index(8, 2)]).toBe(0);
    expect(L.edgeLoad[edgeBetween(L, 8, 2, 9, 2)]).toBe(0);
    expect(Number.isFinite(L.nodePotential[L.index(8, 2)])).toBe(true);
  });

  it('reports node stress as peak utilisation of incident edges', () => {
    const L = cantilever(5, 8);
    L.solve();
    // Root edge carries 4 of 8 capacity.
    expect(L.nodeStress[L.index(0, 2)]).toBeCloseTo(0.5, 2);
    expect(L.nodeStress[L.index(4, 2)]).toBeCloseTo(1 / 8, 2);
  });
});

describe('StressLattice snapping', () => {
  it('snaps edges over breakThreshold and releases the severed section', () => {
    const L = cantilever(8, 4.5);
    for (let t = 0; t < 200; t++) L.step();
    // Loads 7, 6, 5 exceed 4.5 on the first converged pass; everything beyond the root floats.
    expect(L.edgeSnapped[edgeBetween(L, 0, 2, 1, 2)]).toBe(1);
    expect(L.edgeSnapped[edgeBetween(L, 1, 2, 2, 2)]).toBe(1);
    expect(L.edgeSnapped[edgeBetween(L, 2, 2, 3, 2)]).toBe(1);
    expect(L.edgeSnapped[edgeBetween(L, 3, 2, 4, 2)]).toBe(0);
    expect(L.floatingCount).toBe(7);
    expect(L.totalSnapped).toBe(3);
  });

  it('leaves a beam under its threshold intact', () => {
    const L = cantilever(8, 7.5);
    for (let t = 0; t < 200; t++) L.step();
    expect(L.totalSnapped).toBe(0);
    expect(L.floatingCount).toBe(0);
  });

  it('redistributes load when a parallel member is removed', () => {
    // Two-rail ladder anchored at the left, rails joined by rungs.
    const L = new StressLattice(16, 6, 1000);
    for (let x = 0; x < 10; x++) {
      L.addNode(x, 1, 1, x === 0);
      L.addNode(x, 3, 1, x === 0);
      L.addNode(x, 2, 1);
    }
    L.solve();
    const before = Math.abs(L.edgeLoad[edgeBetween(L, 5, 3, 6, 3)]);
    L.removeNode(5, 1);
    L.solve();
    const after = Math.abs(L.edgeLoad[edgeBetween(L, 5, 3, 6, 3)]);
    expect(after).toBeGreaterThan(before);
    expect(L.anchorReaction()).toBeCloseTo(L.groundedMass(), 1);
  });

  it('only checks thresholds on a converged solution', () => {
    const L = cantilever(12, 1000);
    L.iterationsPerTick = 1;
    L.step();
    expect(L.converged).toBe(false);
    expect(L.snappedLastStep).toBe(0);
  });
});
