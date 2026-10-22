import { describe, expect, it } from 'vitest';
import shipData from '../data/ships.json';
import { Contract, ContractState } from './Contract';
import demoBlueprint from './fixtures/demoBlueprint.json';
import { Material } from './materials';
import { DEMO } from './scenes';
import { type ShipBlueprint, buildShip, seedShipCrew, shipErrors, shipOrigin, shipValue } from './ships';
import { Simulation } from './Simulation';
import { TileFlags } from './TileFlags';
import { World } from './World';

const ships = shipData as ShipBlueprint[];
const base = (): ShipBlueprint => structuredClone(demoBlueprint);
const variant = (patch: (bp: ShipBlueprint) => void): ShipBlueprint => {
  const bp = base();
  patch(bp);
  return bp;
};

describe('ship blueprints', () => {
  it('accepts the demo hull as a blueprint, and builds it where the demo hull stands', () => {
    expect(shipErrors(base())).toEqual([]);
    const w = new World();
    buildShip(w, base());
    expect(shipOrigin(base())).toEqual({ x0: DEMO.hull.x0, y0: DEMO.hull.y0 });
    expect(w.getTile(DEMO.hull.x0, DEMO.hull.y0)).toBe(TileFlags.GIRDER | TileFlags.BULKHEAD);
    expect(w.material[w.index(DEMO.engine.x, DEMO.engine.y0)]).toBe(Material.ENGINE_PART);
    expect(w.lattice.isAnchor[w.index(DEMO.gantry.x, DEMO.gantry.y0)]).toBe(1);
    expect(w.gas.getPressure(66, 64)).toBeCloseTo(1, 5);
    expect(w.salvage.zoneCount).toBe(3);
  });

  it('sets compartment pressures from atmosphere points', () => {
    const bp = variant((s) => s.atmosphere.push([3, 5, 4]));
    expect(shipErrors(bp)).toEqual([]);
    const w = new World();
    buildShip(w, bp);
    const { x0, y0 } = shipOrigin(bp);
    expect(w.gas.getPressure(x0 + 3, y0 + 20)).toBeCloseTo(4, 5);
    expect(w.gas.getPressure(x0 + 20, y0 + 5)).toBeCloseTo(1, 5);
  });

  it('spawns the crew on their start tiles', () => {
    const sim = new Simulation();
    buildShip(sim.world, base());
    seedShipCrew(sim, base());
    expect(sim.pawns.count).toBe(3);
    expect(sim.pawns.pos[0]).toBeCloseTo(DEMO.hull.x0 + 14.5, 5);
  });

  it('rejects malformed shapes with the field named', () => {
    expect(shipErrors(variant((s) => (s.width = 50)))).toContainEqual(expect.stringContaining('width must be'));
    expect(shipErrors(variant((s) => (s.doors = [[1, 2, 3]])))).toContainEqual(expect.stringContaining('doors'));
    expect(shipErrors(variant((s) => (s.arms = [4])))).toContainEqual(expect.stringContaining('arms'));
    expect(shipErrors(variant((s) => (s.engine = [0, 8, 0, 20])))).toContainEqual(expect.stringContaining('not on the docked left side'));
    expect(shipErrors(variant((s) => (s.bulkheads = [[2, 2, 9, 9]])))).toContainEqual(expect.stringContaining('horizontal or vertical'));
    expect(shipErrors({ ...base(), cargo: 3 })).toContainEqual(expect.stringContaining('unknown field'));
  });

  it('rejects a door that is not on a bulkhead', () => {
    expect(shipErrors(variant((s) => s.doors.push([12, 12])))).toContainEqual(expect.stringContaining('door (12, 12)'));
  });

  it('rejects crew split across sealed compartments', () => {
    expect(shipErrors(variant((s) => (s.crew[2] = [3, 3])))).toContainEqual(expect.stringContaining('not in the same compartment'));
  });

  it('rejects a console the crew cannot reach', () => {
    // A console inside the sealed airlock.
    const errs = shipErrors(variant((s) => s.consoles.push([3, 10, 2, 2])));
    expect(errs).toContainEqual(expect.stringContaining('no deck tile next to it that the crew can reach'));
  });

  it('rejects a ship with no hazards, or too many', () => {
    expect(shipErrors(variant((s) => (s.leaks = [])))).toContainEqual(expect.stringContaining('0 hazard(s)'));
    const many = variant((s) => {
      s.leaks = [[20, 20], [21, 20], [22, 20]];
      s.atmosphere = [[3, 5, 0], [20, 10, 3]];
    });
    expect(shipErrors(many)).toContainEqual(expect.stringContaining('5 hazard(s)'));
  });

  it('rejects a frame that cannot carry its engine', () => {
    // Both arms bunched at the top, and the whole stern frame made of engine.
    const errs = shipErrors(variant((s) => {
      s.arms = [1, 5];
      s.engine = [36, 1, 36, 16];
      s.height = 29;
    }));
    expect(errs.some((e) => e.includes('snaps under its own weight') || e.includes('of breaking load'))).toBe(true);
  });

  it('rejects a quota outside the fair share of the ship', () => {
    const errs = shipErrors(variant((s) => (s.contract.quota = 6000)));
    expect(errs).toContainEqual(expect.stringMatching(/contract\.quota 6000 is \d+% of the ship's \d+ credits/));
  });

  it('prices the ship by its tiles', () => {
    const w = new World();
    buildShip(w, base());
    const v = shipValue(w, base());
    // 912 deck, 27 hull plate, 115 girder, 13 engine and 6 console tiles, plus the leak's deck tile.
    expect(v.total).toBe(6740);
    expect(v.perBin.reduce((a, b) => a + b, 0)).toBe(v.total);
  });
});

describe('shipped ships', () => {
  it('has a fleet', () => {
    expect(ships.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ships.map((s) => s.id)).size).toBe(ships.length);
  });

  for (const ship of ships) {
    it(`${ship.id} passes the blueprint check`, () => {
      expect(shipErrors(ship)).toEqual([]);
    });
  }
});

describe('contracts', () => {
  it('fails when the clock runs out short of quota, and grades a pass by margin', () => {
    const w = new World();
    buildShip(w, base());
    const c = new Contract();
    c.start(base());
    expect(c.state).toBe(ContractState.ACTIVE);
    expect(c.secondsLeft).toBe(600);
    for (let t = 0; t < 600 * 20; t++) c.tick(w);
    expect(c.state).toBe(ContractState.FAILED);
    expect(c.grade).toBe('F');

    c.start(base());
    w.salvage.credits = 3700;
    c.close(w);
    expect(c.state).toBe(ContractState.PASSED);
    expect(c.grade).toBe('B');
    expect(c.finalCredits).toBe(3700);
    // Closed contracts stop the clock.
    c.tick(w);
    expect(c.elapsedTicks).toBe(0);
  });
});
