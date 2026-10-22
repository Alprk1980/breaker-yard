import { describe, expect, it } from 'vitest';
import { DemoDirector } from './DemoDirector';
import demoBlueprint from './fixtures/demoBlueprint.json';
import { HazardKind } from './HazardLog';
import { MATERIAL_VALUE, Material } from './materials';
import { PawnState } from './PawnManager';
import { DEMO } from './scenes';
import type { ShipBlueprint } from './ships';
import { Simulation } from './Simulation';
import { TileFlags, isSolid } from './TileFlags';

describe('demo director', () => {
  it('plays a full salvage run and loops', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    const fleet = [{ ...(demoBlueprint as ShipBlueprint), id: 'showcased', name: 'Showcased Hull' }];
    const demo = new DemoDirector(sim, fleet);
    demo.restart();
    const S = sim.world.salvage;
    let showcased = false;
    let scriptedCredits = 0;
    const seen = new Set<string>();
    let tore = false;
    let ridden = false;
    for (let t = 0; t < 20 * 300 && demo.loops === 0; t++) {
      demo.tick();
      sim.tick();
      seen.add(demo.label);
      if (demo.label.includes('Tear-off')) scriptedCredits = Math.max(scriptedCredits, S.credits);
      if (demo.label.includes('Up next: Showcased Hull')) showcased ||= demo.showcaseIndex === 0 && sim.pawns.count === 3;
      if (demo.label.includes('tears free')) {
        tore ||= sim.world.debris.tilesUsed > 900;
        ridden ||= sim.hazards.countOf(HazardKind.CARRIED_OFF) > 0;
      }
    }
    expect(demo.loops).toBe(1);
    expect(seen.size).toBeGreaterThanOrEqual(10);
    // The engine went to the barge and the deck to the furnace, both whole and in the right bin.
    expect(scriptedCredits).toBeGreaterThanOrEqual(13 * MATERIAL_VALUE[Material.ENGINE_PART] + 45 * MATERIAL_VALUE[Material.DECK_PLATE]);
    expect(tore).toBe(true);
    expect(ridden).toBe(true);
    // The closing beat docked the fleet's first ship with its crew and advertised its contract.
    expect(showcased).toBe(true);
    expect(demo.showcaseIndex).toBe(-1);
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

describe('demo sections', () => {
  const fleet = [{ ...(demoBlueprint as ShipBlueprint), id: 'showcased', name: 'Showcased Hull' }];
  const lockX = DEMO.hull.x0 + 7;
  /** What each section must have achieved by the time it loops, when played on its own. */
  const outcomes: Record<string, (sim: Simulation, demo: DemoDirector) => boolean> = {
    crew: (sim) => {
      for (let y = 56; y <= 62; y++) if (isSolid(sim.world.getTile(lockX, y))) return false;
      return true;
    },
    engine: (sim) => sim.world.salvage.credits >= 13 * MATERIAL_VALUE[Material.ENGINE_PART],
    deck: (sim) => sim.world.salvage.credits >= 45 * MATERIAL_VALUE[Material.DECK_PLATE],
    tearoff: (sim) => sim.world.debris.tilesUsed > 900 && sim.hazards.countOf(HazardKind.CARRIED_OFF) === 3,
    rescue: (sim) => sim.hazards.countOf(HazardKind.RESCUED) > 0 && sim.pawns.count === 4,
    haul: (sim) =>
      sim.world.salvage.deliveredByMaterial[Material.ENGINE_PART] === 13 &&
      [0, 1, 2].every((p) => sim.pawns.state[p] !== PawnState.RETURNING),
    contract: (sim, demo) => demo.showcaseIndex === 0 && sim.pawns.count === 3,
  };

  it('has an outcome check for every section', () => {
    const demo = new DemoDirector(new Simulation(), fleet);
    expect(demo.sections.map((s) => s.id).sort()).toEqual(Object.keys(outcomes).sort());
  });

  for (const id of Object.keys(outcomes)) {
    it(`plays the ${id} section on its own, reaches its outcome, and loops it`, { timeout: 120_000 }, () => {
      const sim = new Simulation();
      const demo = new DemoDirector(sim, fleet);
      const i = demo.sectionIndex(id);
      demo.playSection(i);
      expect(demo.label).toContain(demo.sections[i].title);
      let reached = false;
      for (let t = 0; t < 20 * 200 && demo.loops === 0; t++) {
        demo.tick();
        sim.tick();
        reached ||= demo.loops === 0 && outcomes[id](sim, demo);
      }
      expect(reached).toBe(true);
      expect(demo.loops).toBe(1);
      expect(demo.soloSection).toBe(i);
      expect(demo.active).toBe(true);
    });
  }

  it('starts the deck section with the engine already gone', () => {
    const sim = new Simulation();
    const demo = new DemoDirector(sim, fleet);
    demo.playSection(demo.sectionIndex('deck'));
    expect(sim.world.getTile(DEMO.engine.x, 64)).toBe(TileFlags.VOID);
    expect(sim.world.debris.count).toBe(0);
    expect(sim.world.salvage.credits).toBe(0);
  });
});
