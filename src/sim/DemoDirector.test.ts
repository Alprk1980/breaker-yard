import { describe, expect, it } from 'vitest';
import { DemoDirector } from './DemoDirector';
import { HazardKind } from './HazardLog';
import { MATERIAL_VALUE, Material } from './materials';
import { Simulation } from './Simulation';

describe('demo director', () => {
  it('plays a full salvage run and loops', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    const demo = new DemoDirector(sim);
    demo.restart();
    const S = sim.world.salvage;
    const seen = new Set<string>();
    let tore = false;
    let ridden = false;
    for (let t = 0; t < 20 * 180 && demo.loops === 0; t++) {
      demo.tick();
      sim.tick();
      seen.add(demo.label);
      if (demo.label.includes('tears free')) {
        tore ||= sim.world.debris.tilesUsed > 900;
        ridden ||= sim.hazards.countOf(HazardKind.CARRIED_OFF) > 0;
      }
    }
    expect(demo.loops).toBe(1);
    expect(seen.size).toBeGreaterThanOrEqual(10);
    // The engine went to the barge and the deck to the furnace, both whole and in the right bin.
    expect(demo.lastRunCredits).toBeGreaterThanOrEqual(13 * MATERIAL_VALUE[Material.ENGINE_PART] + 45 * MATERIAL_VALUE[Material.DECK_PLATE]);
    expect(tore).toBe(true);
    expect(ridden).toBe(true);
    // Restarted on a fresh hull.
    expect(S.credits).toBe(0);
    expect(sim.world.debris.count).toBe(0);
    expect(sim.pawns.count).toBe(3);
  });

  it('hands control back on stop', () => {
    const sim = new Simulation();
    const demo = new DemoDirector(sim);
    demo.restart();
    for (let t = 0; t < 10; t++) demo.tick();
    demo.stop();
    expect(demo.active).toBe(false);
    expect(demo.label).toBe('');
    expect(sim.world.debris.grabBody).toBe(-1);
  });
});
