import { describe, expect, it } from 'vitest';
import { GasCell, GasGrid } from './GasGrid';
import {
  COST_BASE,
  COST_IMPASSABLE,
  PATH_NONE,
  PATH_TOO_LONG,
  PRESSURE_PENALTY_PER_BAR,
  PathGrid,
  TOXIN_PENALTY_PER_BAR,
} from './PathGrid';
import { StressLattice } from './StressLattice';

const W = 32;
const H = 32;

/** Open 32x32 floor with no walls. */
function openFloor(): { gas: GasGrid; lattice: StressLattice; grid: PathGrid } {
  const gas = new GasGrid(W, H);
  const lattice = new StressLattice(W, H);
  const grid = new PathGrid(W, H);
  grid.updateCostGrid(gas, lattice);
  return { gas, lattice, grid };
}

const out = new Int32Array(1024);

describe('updateCostGrid', () => {
  it('marks walls and vacuum impassable and calm floor at the base cost', () => {
    const { gas, lattice, grid } = openFloor();
    gas.setCell(3, 3, GasCell.WALL);
    gas.setCell(5, 5, GasCell.VACUUM);
    grid.updateCostGrid(gas, lattice);
    expect(grid.getCost(3, 3)).toBe(COST_IMPASSABLE);
    expect(grid.getCost(5, 5)).toBe(COST_IMPASSABLE);
    expect(grid.getCost(10, 10)).toBe(COST_BASE);
  });

  it('penalises pressure differentials, including next to vacuum', () => {
    const { gas, lattice, grid } = openFloor();
    gas.setPressure(10, 10, 3);
    gas.setCell(20, 20, GasCell.VACUUM);
    gas.setPressure(21, 20, 2);
    grid.updateCostGrid(gas, lattice);
    expect(grid.getCost(10, 10)).toBe(COST_BASE + 3 * PRESSURE_PENALTY_PER_BAR);
    expect(grid.getCost(11, 10)).toBe(COST_BASE + 3 * PRESSURE_PENALTY_PER_BAR);
    expect(grid.getCost(21, 20)).toBe(COST_BASE + 2 * PRESSURE_PENALTY_PER_BAR);
    // A uniform pressurised room carries no penalty.
    for (let y = 0; y < H; y++) for (let x = 0; x < 8; x++) gas.setPressure(x, y, 1);
    grid.updateCostGrid(gas, lattice);
    expect(grid.getCost(3, 16)).toBe(COST_BASE);
  });

  it('penalises toxic gas', () => {
    const { gas, lattice, grid } = openFloor();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gas.setPressure(x, y, 1);
    gas.toxin[gas.index(8, 8)] = 0.5;
    grid.updateCostGrid(gas, lattice);
    expect(grid.getCost(8, 8)).toBe(COST_BASE + 0.5 * TOXIN_PENALTY_PER_BAR);
    expect(grid.getCost(9, 8)).toBe(COST_BASE);
  });

  it('penalises tiles around members above 80% stress', () => {
    const { gas, lattice, grid } = openFloor();
    gas.setCell(16, 16, GasCell.WALL);
    lattice.addNode(16, 16, 1);
    lattice.nodeStress[lattice.index(16, 16)] = 0.95;
    lattice.addNode(4, 4, 1);
    lattice.nodeStress[lattice.index(4, 4)] = 0.7;
    grid.updateCostGrid(gas, lattice);
    expect(grid.getCost(15, 16)).toBeGreaterThan(COST_BASE);
    expect(grid.getCost(17, 17)).toBeGreaterThan(COST_BASE);
    expect(grid.getCost(16, 16)).toBe(COST_IMPASSABLE);
    expect(grid.getCost(18, 16)).toBe(COST_BASE);
    expect(grid.getCost(5, 4)).toBe(COST_BASE); // 70% is under the line
  });
});

describe('PathGrid.findPath', () => {
  it('finds a straight route and writes it start-exclusive, goal-inclusive', () => {
    const { grid } = openFloor();
    const len = grid.findPath(2, 5, 8, 5, false, out, 0, out.length);
    expect(len).toBe(6);
    expect(out[0]).toBe(5 * W + 3);
    expect(out[len - 1]).toBe(5 * W + 8);
    expect(grid.findPath(4, 4, 4, 4, false, out, 0, out.length)).toBe(0);
  });

  it('takes diagonals across open floor', () => {
    const { grid } = openFloor();
    expect(grid.findPath(0, 0, 10, 10, false, out, 0, out.length)).toBe(10);
  });

  it('detours around a wall and never cuts its corners', () => {
    const { gas, lattice, grid } = openFloor();
    for (let y = 0; y < 20; y++) gas.setCell(10, y, GasCell.WALL);
    grid.updateCostGrid(gas, lattice);
    const len = grid.findPath(5, 5, 15, 5, false, out, 0, out.length);
    expect(len).toBeGreaterThan(10);
    let prev = 5 * W + 5;
    for (let k = 0; k < len; k++) {
      const n = out[k];
      const x = n % W;
      const y = (n / W) | 0;
      expect(grid.isPassable(x, y)).toBe(true);
      const px = prev % W;
      const py = (prev / W) | 0;
      expect(Math.max(Math.abs(x - px), Math.abs(y - py))).toBe(1);
      if (x !== px && y !== py) {
        expect(grid.isPassable(x, py)).toBe(true);
        expect(grid.isPassable(px, y)).toBe(true);
      }
      prev = n;
    }
    expect(out[len - 1]).toBe(5 * W + 15);
  });

  it('reports unreachable goals and routes that overflow the buffer', () => {
    const { gas, lattice, grid } = openFloor();
    for (let y = 0; y < H; y++) gas.setCell(10, y, GasCell.WALL);
    grid.updateCostGrid(gas, lattice);
    expect(grid.findPath(5, 5, 15, 5, false, out, 0, out.length)).toBe(PATH_NONE);
    expect(grid.findPath(0, 0, 9, 31, false, out, 0, 5)).toBe(PATH_TOO_LONG);
  });

  it('can stop on any tile 4-adjacent to a wall target', () => {
    const { gas, lattice, grid } = openFloor();
    gas.setCell(20, 10, GasCell.WALL);
    grid.updateCostGrid(gas, lattice);
    expect(grid.findPath(5, 10, 20, 10, false, out, 0, out.length)).toBe(PATH_NONE);
    const len = grid.findPath(5, 10, 20, 10, true, out, 0, out.length);
    expect(len).toBe(14);
    expect(out[len - 1]).toBe(10 * W + 19);
  });

  it('pays to walk around a hazard when the detour is cheaper', () => {
    const { gas, lattice, grid } = openFloor();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gas.setPressure(x, y, 1);
    // A toxic band across the direct route, with a gap at the top.
    for (let y = 3; y < H; y++) for (let x = 14; x < 18; x++) gas.toxin[gas.index(x, y)] = 1;
    grid.updateCostGrid(gas, lattice);
    const len = grid.findPath(5, 20, 26, 20, false, out, 0, out.length);
    expect(len).toBeGreaterThan(21);
    for (let k = 0; k < len; k++) expect(gas.toxin[out[k]]).toBe(0);
  });

  it('gives the same answer on repeated searches (generation stamps reset nothing)', () => {
    const { gas, lattice, grid } = openFloor();
    for (let y = 4; y < 28; y++) gas.setCell(12, y, GasCell.WALL);
    grid.updateCostGrid(gas, lattice);
    const first = grid.findPath(2, 16, 25, 16, false, out, 0, out.length);
    const copy = out.slice(0, first);
    for (let i = 0; i < 50; i++) grid.findPath(i % W, 0, 31, 31, false, out, 512, 512);
    expect(grid.findPath(2, 16, 25, 16, false, out, 0, out.length)).toBe(first);
    expect(Array.from(out.subarray(0, first))).toEqual(Array.from(copy));
  });
});
