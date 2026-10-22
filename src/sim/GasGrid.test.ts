import { describe, expect, it } from 'vitest';
import { GasCell, GasGrid, MAX_STABLE_FLOW_GAIN, MAX_STABLE_FLOW_KEEP } from './GasGrid';

/** Sealed box: walls around the border of a w x h grid, open inside. */
function sealedBox(w: number, h: number): GasGrid {
  const g = new GasGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      g.setCell(x, y, border ? GasCell.WALL : GasCell.OPEN);
    }
  }
  return g;
}

describe('GasGrid diffusion', () => {
  it('conserves mass in a sealed room', () => {
    const g = sealedBox(32, 32);
    g.setPressure(5, 5, 10);
    g.setPressure(20, 12, 4);
    g.setPressure(15, 25, 7.5);
    const before = g.totalMass();
    for (let t = 0; t < 2000; t++) g.step();
    expect(g.totalMass()).toBeCloseTo(before, 3);
    expect(g.vacuumAbsorbed).toBe(0);
  });

  it('equalises to a uniform pressure', () => {
    const g = sealedBox(16, 16);
    g.setPressure(1, 1, 196);
    for (let t = 0; t < 3000; t++) g.step();
    // 14 x 14 interior cells share 196 bar.
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) expect(g.getPressure(x, y)).toBeCloseTo(1, 3);
  });

  it('does not diffuse through walls', () => {
    const g = sealedBox(20, 10);
    for (let y = 0; y < 10; y++) g.setCell(10, y, GasCell.WALL);
    for (let y = 1; y < 9; y++) for (let x = 1; x < 10; x++) g.setPressure(x, y, 1);
    for (let t = 0; t < 500; t++) g.step();
    for (let y = 1; y < 9; y++) for (let x = 11; x < 19; x++) expect(g.getPressure(x, y)).toBe(0);
    expect(g.totalMass()).toBeCloseTo(72, 3);
  });

  it('accounts for every unit of gas drained into vacuum, and vacuum never holds gas', () => {
    const g = sealedBox(24, 24);
    g.setCell(0, 12, GasCell.VACUUM); // hull breach on the left wall
    for (let y = 1; y < 23; y++) for (let x = 1; x < 23; x++) g.setPressure(x, y, 1);
    const initial = g.totalMass();
    for (let t = 0; t < 400; t++) {
      g.step();
      expect(g.current[g.index(0, 12)]).toBe(0);
    }
    expect(g.totalMass()).toBeLessThan(initial);
    expect(g.totalMass() + g.vacuumAbsorbed).toBeCloseTo(initial, 2);
  });

  it('never produces negative pressure at the stability limit', () => {
    const g = sealedBox(12, 12);
    g.diffusion = 10; // clamped to 0.25
    expect(g.diffusion).toBe(0.25);
    g.setCell(0, 5, GasCell.VACUUM);
    g.setCell(5, 0, GasCell.VACUUM);
    g.setPressure(1, 5, 10);
    g.setPressure(5, 1, 10);
    for (let t = 0; t < 200; t++) {
      g.step();
      for (let i = 0; i < g.cellCount; i++) expect(g.current[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('GasGrid.getVentImpulse', () => {
  it('points out through a breach toward vacuum', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 5);
    g.setCell(15, 8, GasCell.VACUUM);
    expect(g.isBreach(14, 8)).toBe(true);
    const v = g.getVentImpulse(14, 8, { x: 0, y: 0 });
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeCloseTo(2.5, 5); // (p_left - p_vacuum) / 2
    expect(v.y).toBeCloseTo(0, 5);
  });

  it('is zero across intact walls and inside walls', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 5);
    const v = g.getVentImpulse(1, 1);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
    const w = g.getVentImpulse(0, 0);
    expect(w.x).toBe(0);
    expect(w.y).toBe(0);
  });

  it('reuses its scratch vector instead of allocating', () => {
    const g = sealedBox(8, 8);
    expect(g.getVentImpulse(2, 2)).toBe(g.getVentImpulse(3, 3));
  });
});

describe('GasGrid toxin', () => {
  it('diffuses with the gas, conserves mass, and vents with it', () => {
    const g = sealedBox(24, 24);
    g.setPressure(5, 5, 1);
    g.addToxicGas(g.index(5, 5), 3);
    expect(g.getPressure(5, 5)).toBe(4);
    expect(g.totalToxin()).toBe(3);
    for (let t = 0; t < 300; t++) g.step();
    expect(g.getToxin(10, 10)).toBeGreaterThan(0);
    expect(g.totalToxin()).toBeCloseTo(3, 3);
    for (let i = 0; i < g.cellCount; i++) expect(g.toxin[i]).toBeLessThanOrEqual(g.current[i] + 1e-6);

    g.setCell(0, 12, GasCell.VACUUM);
    for (let t = 0; t < 300; t++) g.step();
    expect(g.totalToxin()).toBeLessThan(3);
    expect(g.totalToxin() + g.toxinVented).toBeCloseTo(3, 3);
  });

  it('is discarded when a cell stops being open', () => {
    const g = sealedBox(8, 8);
    g.addToxicGas(g.index(3, 3), 2);
    g.setCell(3, 3, GasCell.WALL);
    expect(g.getToxin(3, 3)).toBe(0);
  });
});

describe('GasGrid.getPressureDelta', () => {
  it('reads the differential a wall holds back against vacuum', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 5);
    g.setCell(15, 8, GasCell.VACUUM);
    // The border wall at (15, 7) has 5 bar on its inner side and the new vacuum cell below it.
    expect(g.getPressureDelta(15, 7)).toBeCloseTo(5, 5);
  });

  it('is zero across a wall between equal pressures and inside a uniform room', () => {
    const g = sealedBox(16, 16);
    for (let y = 0; y < 16; y++) g.setCell(8, y, GasCell.WALL);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 2);
    expect(g.getPressureDelta(8, 8)).toBe(0);
    expect(g.getPressureDelta(4, 4)).toBe(0);
  });

  it('is zero for a wall with gas on one side only', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 3);
    // Interior side reads 3 bar; the grid edge beyond the border wall is not a sample.
    expect(g.getPressureDelta(0, 8)).toBe(0);
  });

  it('measures across an interior wall between two rooms', () => {
    const g = sealedBox(16, 16);
    for (let y = 0; y < 16; y++) g.setCell(8, y, GasCell.WALL);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 8; x++) g.setPressure(x, y, 4.5);
    for (let y = 1; y < 15; y++) for (let x = 9; x < 15; x++) g.setPressure(x, y, 1);
    expect(g.getPressureDelta(8, 8)).toBeCloseTo(3.5, 5);
  });
});

/** Highest |face flux| anywhere on the grid. */
function maxFlux(g: GasGrid): number {
  let m = 0;
  for (let i = 0; i < g.cellCount; i++) m = Math.max(m, Math.abs(g.flowX[i]), Math.abs(g.flowY[i]));
  return m;
}

describe('GasGrid flow', () => {
  it('conserves mass in a sealed room after a blast, then settles to rest', () => {
    const g = sealedBox(32, 32);
    g.setPressure(5, 5, 50);
    g.setPressure(20, 12, 4);
    g.setPressure(15, 25, 7.5);
    const before = g.totalMass();
    let peak = 0;
    for (let t = 0; t < 3000; t++) {
      g.step();
      if (t < 50) peak = Math.max(peak, maxFlux(g));
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(g.totalMass()).toBeCloseTo(before, 3);
    expect(g.vacuumAbsorbed).toBe(0);
    // No mode rings up from rounding: the flux dies away and the room is uniform.
    expect(maxFlux(g)).toBeLessThan(1e-5);
    const mean = before / (30 * 30);
    for (let y = 1; y < 31; y++) for (let x = 1; x < 31; x++) expect(g.getPressure(x, y)).toBeCloseTo(mean, 3);
  });

  it('conserves mass with diffusion off, flow alone', () => {
    const g = sealedBox(24, 24);
    g.substeps = 0;
    for (let y = 1; y < 23; y++) for (let x = 1; x < 8; x++) g.setPressure(x, y, 3);
    const before = g.totalMass();
    for (let t = 0; t < 500; t++) {
      g.step();
      expect(g.totalMass()).toBeCloseTo(before, 3);
    }
    expect(g.getPressure(20, 12)).toBeGreaterThan(0.5);
  });

  it('does not overshoot when two rooms equalise through a doorway', () => {
    const g = sealedBox(30, 12);
    for (let y = 0; y < 12; y++) if (y !== 6) g.setCell(15, y, GasCell.WALL);
    for (let y = 1; y < 11; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 2);
    for (let t = 0; t < 600; t++) {
      g.step();
      for (let i = 0; i < g.cellCount; i++) {
        expect(g.current[i]).toBeGreaterThanOrEqual(0);
        expect(g.current[i]).toBeLessThanOrEqual(2 + 1e-5);
      }
    }
    expect(g.getPressure(28, 6)).toBeGreaterThan(0.5);
  });

  it('accounts for every unit vented, and blows out far faster than diffusion alone', () => {
    const run = (flowSubsteps: number): number => {
      const g = sealedBox(24, 24);
      g.flowSubsteps = flowSubsteps;
      g.setCell(0, 12, GasCell.VACUUM);
      for (let y = 1; y < 23; y++) for (let x = 1; x < 23; x++) g.setPressure(x, y, 1);
      const initial = g.totalMass();
      for (let t = 0; t < 100; t++) {
        g.step();
        expect(g.current[g.index(0, 12)]).toBe(0);
        expect(g.totalMass() + g.vacuumAbsorbed).toBeCloseTo(initial, 2);
      }
      return g.vacuumAbsorbed / initial;
    };
    const diffusionOnly = run(0);
    const withFlow = run(8);
    expect(withFlow).toBeGreaterThan(diffusionOnly * 3);
    expect(withFlow).toBeGreaterThan(0.5);
  });

  it('never produces negative pressure, even with 10 bar against vacuum on several sides', () => {
    const g = sealedBox(12, 12);
    g.setCell(0, 5, GasCell.VACUUM);
    g.setCell(5, 0, GasCell.VACUUM);
    g.setCell(11, 5, GasCell.VACUUM);
    g.setPressure(1, 5, 10);
    g.setPressure(5, 1, 10);
    g.setPressure(10, 5, 10);
    for (let t = 0; t < 200; t++) {
      g.step();
      for (let i = 0; i < g.cellCount; i++) {
        expect(g.current[i]).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(g.current[i])).toBe(true);
      }
    }
  });

  it('clamps gain and damping to their stable limits', () => {
    const g = new GasGrid(8, 8);
    g.flowGain = 3;
    g.flowKeep = 2;
    expect(g.flowGain).toBe(MAX_STABLE_FLOW_GAIN);
    expect(g.flowKeep).toBe(MAX_STABLE_FLOW_KEEP);
    g.flowGain = -1;
    expect(g.flowGain).toBe(0);
  });

  it('restarts the flux on the faces of a cell whose type changes', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 1);
    g.setCell(15, 8, GasCell.VACUUM);
    for (let t = 0; t < 10; t++) g.step();
    expect(g.flowX[g.index(14, 8)]).toBeGreaterThan(0);
    g.setCell(15, 8, GasCell.WALL);
    expect(g.flowX[g.index(14, 8)]).toBe(0);
    const mass = g.totalMass();
    for (let t = 0; t < 200; t++) g.step();
    expect(g.totalMass()).toBeCloseTo(mass, 3);
  });
});

describe('GasGrid flow carries toxin', () => {
  it('conserves toxin while flow moves it across a sealed room', () => {
    const g = sealedBox(24, 24);
    g.substeps = 0; // flow alone
    for (let y = 1; y < 23; y++) for (let x = 1; x < 6; x++) g.addToxicGas(g.index(x, y), 2);
    for (let y = 1; y < 23; y++) for (let x = 6; x < 23; x++) g.setPressure(x, y, 0.5);
    const before = g.totalToxin();
    for (let t = 0; t < 300; t++) {
      g.step();
      for (let i = 0; i < g.cellCount; i++) expect(g.toxin[i]).toBeLessThanOrEqual(g.current[i] + 1e-6);
    }
    expect(g.totalToxin()).toBeCloseTo(before, 3);
    // Without diffusion the toxic gas only travels as far as it expands: from 5 columns at
    // 2 bar to roughly 12 columns at the 0.84 bar the room settles at.
    expect(g.getToxin(10, 12)).toBeGreaterThan(0.1);
    expect(g.getToxin(20, 12)).toBeLessThan(0.05);
  });

  it('keeps a uniform toxic share as the gas vents, and tallies the toxin lost', () => {
    const g = sealedBox(24, 24);
    g.substeps = 0;
    for (let y = 1; y < 23; y++) {
      for (let x = 1; x < 23; x++) {
        g.setPressure(x, y, 0.6);
        g.addToxicGas(g.index(x, y), 0.4);
      }
    }
    const toxin = g.totalToxin();
    g.setCell(23, 12, GasCell.VACUUM);
    for (let t = 0; t < 100; t++) g.step();
    expect(g.totalToxin()).toBeLessThan(toxin * 0.7);
    expect(g.totalToxin() + g.toxinVented).toBeCloseTo(toxin, 2);
    // Upwind transport moves gas and toxin in the same proportion: the mix is unchanged.
    expect(g.toxinVented / g.vacuumAbsorbed).toBeCloseTo(0.4, 3);
    for (let y = 1; y < 23; y++) {
      for (let x = 1; x < 23; x++) expect(g.getToxin(x, y) / g.getPressure(x, y)).toBeCloseTo(0.4, 3);
    }
  });
});

describe('GasGrid.getVentImpulse with flow', () => {
  it('adds the gas stream, and reads the jet just outside the hole', () => {
    const g = sealedBox(16, 16);
    for (let y = 1; y < 15; y++) for (let x = 1; x < 15; x++) g.setPressure(x, y, 1);
    g.setCell(15, 8, GasCell.VACUUM);
    for (let t = 0; t < 10; t++) g.step();
    const hole = g.getVentImpulse(14, 8, { x: 0, y: 0 });
    // The pressure gradient alone would read at most 0.5 at 1 bar.
    expect(hole.x).toBeGreaterThan(1);
    expect(Math.abs(hole.y)).toBeLessThan(0.05);
    const jet = g.getVentImpulse(15, 8, { x: 0, y: 0 });
    expect(jet.x).toBeGreaterThan(0.5);
    expect(g.getVentImpulse(15, 2, { x: 0, y: 0 }).x).toBe(0); // vacuum cell beside an intact wall
  });
});
