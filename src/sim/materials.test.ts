import { describe, expect, it } from 'vitest';
import table from '../data/materials.json';
import { DEMO_TILE_COUNTS, MATERIAL_IDS, materialErrors, materialTableErrors } from './materialSchema';
import { MATERIAL_BIN, Material } from './materials';
import { DEMO, buildDemoHull } from './scenes';
import { World } from './World';

const good = () => structuredClone(table);

describe('material table', () => {
  it('ships valid', () => {
    expect(materialTableErrors(table)).toEqual([]);
  });

  it('prices the real demo hull', () => {
    const w = new World();
    buildDemoHull(w);
    const counts = new Array(MATERIAL_IDS.length).fill(0);
    const { x0, y0, x1, y1 } = DEMO.hull;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) counts[w.material[w.index(x, y)] - 1]++;
    }
    expect(counts).toEqual(DEMO_TILE_COUNTS);
  });

  it('loads bins by id', () => {
    expect(MATERIAL_BIN[Material.NONE]).toBe(0);
    for (let m = 1; m <= MATERIAL_IDS.length; m++) expect(MATERIAL_BIN[m]).toBeGreaterThan(0);
  });

  it('rejects malformed entries', () => {
    const e = good()[0];
    expect(materialErrors({ ...e, bin: 'airlock' })).toContainEqual(expect.stringContaining('bin'));
    expect(materialErrors({ ...e, value: 2.5 })).toContainEqual(expect.stringContaining('whole number'));
    expect(materialErrors({ ...e, color: '#FFF' })).toContainEqual(expect.stringContaining('color'));
    expect(materialErrors({ ...e, name: 'Deck \u{1F680}' })).toContainEqual(expect.stringContaining('emoji'));
    expect(materialErrors({ ...e, rarity: 3 })).toContainEqual(expect.stringContaining('unknown field'));
  });

  it('rejects a table that breaks the id set or the balance rules', () => {
    expect(materialTableErrors(good().slice(1))).toContainEqual(expect.stringContaining('exactly once'));
    const cheapEngine = good().map((e) => (e.id === 'engine-part' ? { ...e, value: 5 } : e));
    expect(materialTableErrors(cheapEngine)).toContainEqual(expect.stringContaining('at least 3x'));
    const oneBin = good().map((e) => ({ ...e, bin: 'furnace' }));
    expect(materialTableErrors(oneBin)).toContainEqual(expect.stringContaining('no material goes to the barge'));
    const rich = good().map((e) => ({ ...e, value: e.value * 3 }));
    expect(materialTableErrors(rich)).toContainEqual(expect.stringContaining('sorted demo hull pays'));
  });
});
