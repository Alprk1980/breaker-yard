import { HAUL_LANE_X } from './constants';
import { B_X, B_Y, BODY_STRIDE, MAX_BODIES } from './DebrisField';
import { MATERIAL_VALUE, Material } from './materials';
import { PawnState } from './PawnManager';
import { HazardKind } from './HazardLog';
import { DEMO, addFuelTank, buildDemoHull, seedDemoCrew, setRoomPressure, strandedCrewman } from './scenes';
import { type ShipBlueprint, buildShip, seedShipCrew } from './ships';
import type { Simulation } from './Simulation';
import { ToolKind } from './WorkOrderQueue';

/** One beat of the demo. `tick` returns true when the beat is over. */
interface Beat {
  label: string;
  start(): void;
  tick(): boolean;
}

/** Ticks between torch cuts. */
const TORCH_INTERVAL = 6;
/** A tow moves on to its next waypoint once the load's centre is this close, in tiles. */
const WAYPOINT_RADIUS = 2.5;
/** Clear lane between the hull's right side and the salvage bins, where tows travel. */
const LANE_X = HAUL_LANE_X;

const { hull, gantry, engine, armRows, zones } = DEMO;
const lockX = hull.x0 + 7;
/** Deck section cut loose and sent to the furnace, inclusive. */
const DECK = { x0: 78, y0: 60, x1: 82, y1: 68 };

function centre(zone: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
  return [(zone.x0 + zone.x1) / 2, (zone.y0 + zone.y1) / 2];
}

/** A named, self-contained part of the demo. `setup` brings the world to its starting state. */
export interface DemoSection {
  readonly id: string;
  readonly title: string;
  /**
   * In the full run, carry on from the previous section's world instead of running `setup`.
   * Played on its own, a section always runs its setup.
   */
  readonly continues: boolean;
  setup(): void;
  readonly beats: readonly Beat[];
}

/**
 * Attract mode: plays a short scripted salvage run through the same controls a player has
 * (crew work orders, the torch, the grapple), in sections:
 *
 *   1. crew      The crew cuts through the airlock bulkhead.
 *   2. engine    The torch frees the engine block (hull breach) and it is towed to the barge.
 *   3. deck      A deck section is cut loose through the hole and towed to the furnace.
 *   4. tearoff   The gantry arms are cut; the hull tears away with the crew aboard.
 *   5. haul      On a fresh, vented hull the crew gets a salvage order on the engine block and
 *                does the rest alone: severs it free, tows it to the barge, flies home.
 *   6. rescue    A crewman blown out of the open stern drifts away unconscious; a rescuer
 *                walks to the edge, flies out on suit thrusters and brings them back aboard.
 *   7. fire      The torch hits a fuel tank: it blows, the blast sets off the tank beside it, fire
 *                spreads through the cabin and the crew runs; a cut to space vents the cabin and
 *                starves the fire out.
 *   8. contract  The next ship from the generated fleet docks, with its contract on the banner.
 *
 * `restart()` plays them all in order and loops. `playSection(i)` loops one section on its
 * own: each section's `setup` builds what it needs from scratch (the deck section starts
 * with the engine already gone), so any part can be watched without the rest. When a
 * feature lands, it gets a section here (or a beat in one) and a test that the section
 * reaches its outcome standalone.
 *
 * Beats and banner strings are built ahead of time, so `tick()` and drawing do not allocate.
 */
export class DemoDirector {
  active = false;
  /** Where the torch or grapple is pointing, in tiles; -1 when idle. */
  cursorX = -1;
  cursorY = -1;
  /** Completed runs (or section loops) since the last `restart()` or `playSection()`. */
  loops = 0;
  /** Credits earned by the last finished full run. */
  lastRunCredits = 0;
  /** Fleet index of the ship docked in the contract section, or -1. `N` takes its contract. */
  showcaseIndex = -1;
  /** Section being looped on its own, or -1 for the full run. */
  soloSection = -1;
  /** Banner caption for the beat in progress, and the controls line under it. */
  label = '';
  hint = '';

  readonly sections: readonly DemoSection[];
  private readonly fullRun: Beat[] = [];
  private readonly fullRunSection: number[] = [];
  private run: readonly Beat[] = [];
  private runSection: readonly number[] = [];
  private beat = 0;
  private readonly hintFull: string;
  private readonly hintSolo: string[];

  constructor(
    private readonly sim: Simulation,
    private readonly fleet: readonly ShipBlueprint[] = [],
  ) {
    const [bargeX, bargeY] = centre(zones[2]);
    const [furnaceX, furnaceY] = centre(zones[0]);
    const engineCuts: number[] = [];
    // Each end of the engine block twice: frame to floor (the breach), then floor to vacuum.
    for (const y of [engine.y0 - 1, engine.y1 + 1]) engineCuts.push(engine.x, y, engine.x, y);
    for (let y = engine.y0; y <= engine.y1; y++) engineCuts.push(engine.x - 1, y);
    const deckCuts: number[] = [];
    for (let x = DECK.x1; x >= DECK.x0; x--) deckCuts.push(x, DECK.y0 - 1);
    for (let y = DECK.y0 - 1; y <= DECK.y1 + 1; y++) deckCuts.push(DECK.x0 - 1, y);
    for (let x = DECK.x0; x <= DECK.x1; x++) deckCuts.push(x, DECK.y1 + 1);
    const engineY = (engine.y0 + engine.y1 + 1) / 2;
    const fresh = (): void => this.freshHull();

    this.sections = [
      {
        id: 'crew',
        title: 'Crew',
        continues: false,
        setup: fresh,
        beats: [
          this.wait('A derelict hull hangs off the docking gantry', 60),
          this.crewCuts('Crew cutting through the airlock bulkhead', lockX, 56, 62, 900),
        ],
      },
      {
        id: 'engine',
        title: 'Engine',
        continues: true,
        setup: fresh,
        beats: [
          this.torch('Torch cutting the engine block out of the frame (hull breach!)', engineCuts),
          this.tow('Grappling the engine block to the barge', engine.x + 0.5, engineY, [
            LANE_X, 64, LANE_X, bargeY - 2, bargeX, bargeY,
          ]),
        ],
      },
      {
        id: 'deck',
        title: 'Deck',
        continues: true,
        setup: () => {
          fresh();
          this.removeEngine(engineCuts, engineY);
        },
        beats: [
          this.torch('Cutting a deck section loose', deckCuts),
          this.tow('Grappling the deck plating to the furnace', (DECK.x0 + DECK.x1 + 1) / 2, (DECK.y0 + DECK.y1 + 1) / 2, [
            LANE_X, 64, LANE_X, furnaceY + 2, furnaceX, furnaceY,
          ]),
        ],
      },
      {
        id: 'tearoff',
        title: 'Tear-off',
        continues: true,
        setup: fresh,
        beats: [
          this.wait('Crew stands down', 40),
          // With the engine gone the hull is light enough to hang off one arm, so both are cut.
          this.torch('Cutting the gantry arms', [gantry.x + 3, armRows[0], gantry.x + 3, armRows[1]]),
          this.wait('The hull tears free, crew aboard', 40),
          this.haul('Hauling the stripped hull clear of the gantry', 64, 64, 64, 112, 300),
        ],
      },
      {
        id: 'haul',
        title: 'Crew haul',
        continues: false,
        setup: () => {
          fresh();
          setRoomPressure(this.sim.world, 0);
          this.sim.designateSalvage(engine.x, engine.y0, engine.x, engine.y1);
        },
        beats: [
          this.untilDebris('Salvage order on the engine block: the crew severs it free, no player input', 20 * 120),
          this.untilHauled('A hauler climbs aboard, tugs it to the barge and flies home', 13 * MATERIAL_VALUE[Material.ENGINE_PART], 20 * 90),
        ],
      },
      {
        id: 'rescue',
        title: 'Rescue',
        continues: false,
        setup: () => {
          this.cursorX = this.cursorY = -1;
          strandedCrewman(this.sim);
        },
        beats: [
          this.untilState('A crewman drifts out of the stern unconscious; a rescuer heads for the edge', PawnState.RESCUE_FLY, 20 * 40),
          this.untilRescued('The rescuer flies out on suit thrusters, grabs them and brings them back aboard', 20 * 90),
        ],
      },
      {
        id: 'fire',
        title: 'Fire',
        continues: false,
        setup: () => {
          fresh();
          addFuelTank(this.sim.world, 70, 57, 2, 2);
          addFuelTank(this.sim.world, 74, 57, 2, 2);
        },
        beats: [
          this.wait('Two fuel tanks in the cabin, a cutting crew nearby', 40),
          this.torch('The torch hits a fuel tank: it blows and sets off the one beside it', [70, 57]),
          this.wait('Fire spreads through the cabin, burning its air; the crew runs from the flames', 20 * 8),
          this.torch('Cutting the hull open to space', [hull.x1, 62, hull.x1, 64, hull.x1, 66]),
          this.untilFireOut('Venting the cabin starves the fire', 20 * 60),
        ],
      },
      {
        id: 'contract',
        title: 'Contract',
        continues: true,
        // The showcase docks its own ship.
        setup: () => {},
        beats: [this.showcase(160)],
      },
    ];
    this.sections.forEach((section, k) => {
      for (const b of section.beats) {
        this.fullRun.push(b);
        this.fullRunSection.push(k);
      }
    });
    const n = this.sections.length;
    this.hintFull = `DEMO  -  1-${n}: watch one section   click or M: take over`;
    this.hintSolo = this.sections.map(
      (s, k) => `SECTION ${k + 1}/${n} ${s.title.toUpperCase()} (looping)  -  0: full demo   1-${n}: sections   click or M: take over`,
    );
  }

  /** Index of the section with this id, or -1. */
  sectionIndex(id: string): number {
    return this.sections.findIndex((s) => s.id === id);
  }

  /** Starts the full demo from the top, on a fresh demo hull. */
  restart(): void {
    this.soloSection = -1;
    this.begin(this.fullRun, this.fullRunSection);
  }

  /** Loops one section on its own, from its own setup. */
  playSection(i: number): void {
    if (i < 0 || i >= this.sections.length) return;
    this.soloSection = i;
    this.begin(this.sections[i].beats, this.sections[i].beats.map(() => i));
  }

  /** Hands control back to the player, leaving the world as it is. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.showcaseIndex = -1;
    this.label = '';
    this.sim.world.debris.releaseGrapple();
    this.cursorX = this.cursorY = -1;
  }

  /** Advances the script by one simulation tick. Call before `Simulation.tick()`. */
  tick(): void {
    if (!this.active || !this.run[this.beat].tick()) return;
    this.beat++;
    if (this.beat < this.run.length) {
      this.startBeat();
      return;
    }
    const loops = this.loops + 1;
    if (this.soloSection >= 0) {
      this.playSection(this.soloSection);
    } else {
      // The showcase rebuilds the world, so with a fleet the run's credits were taken there.
      if (this.fleet.length === 0) this.lastRunCredits = this.sim.world.salvage.credits;
      this.restart();
    }
    this.loops = loops;
  }

  private begin(run: readonly Beat[], sections: readonly number[]): void {
    this.run = run;
    this.runSection = sections;
    this.active = true;
    this.beat = 0;
    this.loops = 0;
    this.showcaseIndex = -1;
    this.startBeat();
  }

  private startBeat(): void {
    const beat = this.run[this.beat];
    const k = this.runSection[this.beat];
    // A section's first beat sets its world up: always when played alone, and in the full run
    // unless it carries on from the section before.
    const first = this.beat === 0 || this.runSection[this.beat - 1] !== k;
    if (first && (this.soloSection >= 0 || this.beat === 0 || !this.sections[k].continues)) this.sections[k].setup();
    beat.start();
    this.label = `${k + 1}/${this.sections.length}  ${this.sections[k].title}: ${beat.label}`;
    this.hint = this.soloSection >= 0 ? this.hintSolo[this.soloSection] : this.hintFull;
  }

  /** The demo hull with its crew, as built at the start of the demo. */
  private freshHull(): void {
    const sim = this.sim;
    buildDemoHull(sim.world);
    sim.resetCrew();
    seedDemoCrew(sim);
    this.showcaseIndex = -1;
    this.cursorX = this.cursorY = -1;
  }

  /** Cuts the engine block free at once and takes it away, as if the engine section had run. */
  private removeEngine(cuts: readonly number[], engineY: number): void {
    const world = this.sim.world;
    for (let k = 0; k < cuts.length; k += 2) world.cutTile(cuts[k], cuts[k + 1]);
    for (let t = 0; t < 5 && world.debris.count === 0; t++) this.sim.tick();
    const b = this.nearestBody(engine.x + 0.5, engineY);
    if (b >= 0) world.debris.removeBody(b);
  }

  private wait(label: string, ticks: number): Beat {
    let t = 0;
    return {
      label,
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
      },
      tick: () => ++t >= ticks,
    };
  }

  /**
   * Docks the next generated ship (one per loop, in turn) with its crew, and advertises its
   * contract for `ticks`. Skipped when there is no fleet.
   */
  private showcase(ticks: number): Beat {
    let t = 0;
    const beat: Beat = {
      label: '',
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
        if (this.fleet.length === 0) return;
        this.lastRunCredits = this.sim.world.salvage.credits;
        const i = this.loops % this.fleet.length;
        const bp = this.fleet[i];
        const c = bp.contract;
        this.showcaseIndex = i;
        buildShip(this.sim.world, bp);
        this.sim.resetCrew();
        seedShipCrew(this.sim, bp);
        const time = `${Math.floor(c.timeLimit / 60)}:${String(c.timeLimit % 60).padStart(2, '0')}`;
        beat.label = `Up next: ${bp.name} for ${c.client}, ${c.quota} cr in ${time}. Press N to take this contract`;
      },
      tick: () => this.fleet.length === 0 || ++t >= ticks,
    };
    return beat;
  }

  /** Waits, hands off, until something tears loose (or `timeout` ticks pass). */
  private untilDebris(label: string, timeout: number): Beat {
    let t = 0;
    return {
      label,
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
      },
      tick: () => this.sim.world.debris.count > 0 || ++t >= timeout,
    };
  }

  /** Waits, hands off, until nothing is burning (or `timeout` ticks pass). */
  private untilFireOut(label: string, timeout: number): Beat {
    let t = 0;
    const gas = this.sim.world.gas;
    return {
      label,
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
      },
      tick: () => gas.burningCount === 0 || ++t >= timeout,
    };
  }

  /** Waits, hands off, until some pawn is in `state` (or `timeout` ticks pass). */
  private untilState(label: string, state: number, timeout: number): Beat {
    let t = 0;
    const pawns = this.sim.pawns;
    return {
      label,
      start: () => {
        t = 0;
      },
      tick: () => {
        if (++t >= timeout) return true;
        for (let p = 0; p < pawns.capacity; p++) if (pawns.alive[p] === 1 && pawns.state[p] === state) return true;
        return false;
      },
    };
  }

  /** Waits, hands off, until someone has been rescued and no rescuer is still out flying. */
  private untilRescued(label: string, timeout: number): Beat {
    let t = 0;
    const sim = this.sim;
    return {
      label,
      start: () => {
        t = 0;
      },
      tick: () => {
        if (++t >= timeout) return true;
        if (sim.hazards.countOf(HazardKind.RESCUED) === 0) return false;
        for (let p = 0; p < sim.pawns.capacity; p++) {
          const st = sim.pawns.state[p];
          if (sim.pawns.alive[p] === 1 && (st === PawnState.RESCUE_FLY || st === PawnState.RESCUE_CARRY)) return false;
        }
        return true;
      },
    };
  }

  /** Waits, hands off, until `credits` are delivered and no one is still flying home. */
  private untilHauled(label: string, credits: number, timeout: number): Beat {
    let t = 0;
    const sim = this.sim;
    return {
      label,
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
      },
      tick: () => {
        if (++t >= timeout) return true;
        if (sim.world.salvage.credits < credits) return false;
        for (let p = 0; p < sim.pawns.capacity; p++) {
          if (sim.pawns.alive[p] === 1 && sim.pawns.state[p] === PawnState.RETURNING) return false;
        }
        return true;
      },
    };
  }

  /** Work orders on a wall column; over when the crew has cleared them all, or on timeout. */
  private crewCuts(label: string, x: number, y0: number, y1: number, timeout: number): Beat {
    let t = 0;
    const orders = this.sim.orders;
    return {
      label,
      start: () => {
        t = 0;
        this.cursorX = this.cursorY = -1;
        for (let y = y0; y <= y1; y++) orders.addOrder(x, y, 4, ToolKind.CUTTER);
      },
      tick: () => {
        let left = 0;
        for (let y = y0; y <= y1; y++) if (orders.hasOrder(x, y)) left++;
        if (left > 0 && ++t < timeout) return false;
        for (let y = y0; y <= y1; y++) orders.cancelOrder(x, y);
        return true;
      },
    };
  }

  /** The player's torch, one tile every `TORCH_INTERVAL` ticks along `cells` (x, y pairs). */
  private torch(label: string, cells: readonly number[]): Beat {
    let t = 0;
    let next = 0;
    return {
      label,
      start: () => {
        t = 0;
        next = 0;
        this.cursorX = cells[0] + 0.5;
        this.cursorY = cells[1] + 0.5;
      },
      tick: () => {
        if (++t < TORCH_INTERVAL) return false;
        t = 0;
        if (next >= cells.length) return true;
        this.cursorX = cells[next] + 0.5;
        this.cursorY = cells[next + 1] + 0.5;
        this.sim.world.cutTile(cells[next], cells[next + 1]);
        next += 2;
        return false;
      },
    };
  }

  /**
   * Grapples the debris nearest (x, y) by its centre and tows it along `route` (x, y pairs),
   * the last point inside a bin. Over once the bin takes it, or after 40 s.
   */
  private tow(label: string, x: number, y: number, route: readonly number[]): Beat {
    let t = 0;
    let leg = 0;
    let body = -1;
    let gen = 0;
    const debris = this.sim.world.debris;
    return {
      label,
      start: () => {
        t = 0;
        leg = 0;
        body = this.nearestBody(x, y);
        if (body < 0) return;
        gen = debris.generation[body];
        const o = body * BODY_STRIDE;
        debris.grabAt(body, debris.body[o + B_X], debris.body[o + B_Y]);
        debris.setGrappleTarget(route[0], route[1]);
      },
      tick: () => {
        if (body < 0 || debris.alive[body] === 0 || debris.generation[body] !== gen || ++t > 800) {
          debris.releaseGrapple();
          return true;
        }
        const o = body * BODY_STRIDE;
        const dx = debris.body[o + B_X] - route[leg];
        const dy = debris.body[o + B_Y] - route[leg + 1];
        if (leg + 2 < route.length && dx * dx + dy * dy < WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
          leg += 2;
          debris.setGrappleTarget(route[leg], route[leg + 1]);
        }
        this.cursorX = debris.grab[2];
        this.cursorY = debris.grab[3];
        return false;
      },
    };
  }

  /** Grapples the debris nearest (x, y) toward (tx, ty) for `ticks`, then lets go. */
  private haul(label: string, x: number, y: number, tx: number, ty: number, ticks: number): Beat {
    let t = 0;
    const debris = this.sim.world.debris;
    return {
      label,
      start: () => {
        t = 0;
        const body = this.nearestBody(x, y);
        if (body < 0) return;
        const o = body * BODY_STRIDE;
        debris.grabAt(body, debris.body[o + B_X], debris.body[o + B_Y]);
        debris.setGrappleTarget(tx, ty);
        this.cursorX = tx;
        this.cursorY = ty;
      },
      tick: () => {
        if (++t < ticks) return false;
        debris.releaseGrapple();
        return true;
      },
    };
  }

  /** Debris body whose centre is nearest (x, y) within 6 tiles, or -1. */
  private nearestBody(x: number, y: number): number {
    const debris = this.sim.world.debris;
    let best = -1;
    let bestD = 36;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (debris.alive[b] === 0) continue;
      const dx = debris.body[b * BODY_STRIDE + B_X] - x;
      const dy = debris.body[b * BODY_STRIDE + B_Y] - y;
      if (dx * dx + dy * dy < bestD) {
        best = b;
        bestD = dx * dx + dy * dy;
      }
    }
    return best;
  }
}
