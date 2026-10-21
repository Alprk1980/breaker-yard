import { describe, expect, it } from 'vitest';
import { DEMO, buildDemoHull } from './scenes';
import { TileFlags } from './TileFlags';
import { World } from './World';

describe('demo hull', () => {
  it('starts pressurised, anchored and under its break threshold', () => {
    const w = new World();
    buildDemoHull(w);
    expect(w.gas.getPressure(66, 64)).toBeCloseTo(DEMO.roomPressure, 5);
    expect(w.lattice.floatingCount).toBe(0);
    expect(w.lattice.isAnchor[w.index(DEMO.gantry.x, DEMO.gantry.y0)]).toBe(1);
    const mass = w.gas.totalMass();
    for (let t = 0; t < 200; t++) w.tick();
    expect(w.lattice.totalSnapped).toBe(0);
    expect(w.gas.totalMass()).toBeCloseTo(mass, 1);
    expect(w.gas.vacuumAbsorbed).toBe(0);
  });

  it('vents when the hull is cut open to space', () => {
    const w = new World();
    buildDemoHull(w);
    const mass = w.gas.totalMass();
    w.cutTile(DEMO.hull.x1, 64); // right frame tile: girder -> floor, now touching vacuum
    expect(w.getTile(DEMO.hull.x1, 64)).toBe(TileFlags.FLOOR);
    expect(w.lattice.hasNode(DEMO.hull.x1, 64)).toBe(false);
    for (let t = 0; t < 100; t++) w.tick();
    expect(w.gas.totalMass()).toBeLessThan(mass * 0.97);
    expect(w.gas.totalMass() + w.gas.vacuumAbsorbed).toBeCloseTo(mass, 0);
    expect(w.gas.getVentImpulse(DEMO.hull.x1, 64).x).toBeGreaterThan(0);
  });

  it('tears free when one gantry arm is cut', () => {
    const w = new World();
    buildDemoHull(w);
    w.cutTile(DEMO.gantry.x + 3, DEMO.armRows[0]);
    for (let t = 0; t < 200; t++) w.tick();
    expect(w.lattice.totalSnapped).toBeGreaterThan(0);
    expect(w.lattice.nodeGrounded[w.index(DEMO.engine.x, DEMO.engine.y0)]).toBe(0);
  });

  it('cutting a floor tile leaves vacuum', () => {
    const w = new World();
    buildDemoHull(w);
    w.cutTile(66, 64);
    expect(w.getTile(66, 64)).toBe(TileFlags.VOID);
    expect(w.gas.getPressure(66, 64)).toBe(0);
  });
});
