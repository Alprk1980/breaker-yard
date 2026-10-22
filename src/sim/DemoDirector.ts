import { B_X, B_Y, BODY_STRIDE, MAX_BODIES } from './DebrisField';
import { DEMO, buildDemoHull, seedDemoCrew } from './scenes';
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
const LANE_X = 88;

const { hull, gantry, engine, armRows, zones } = DEMO;
const lockX = hull.x0 + 7;
/** Deck section cut loose and sent to the furnace, inclusive. */
const DECK = { x0: 78, y0: 60, x1: 82, y1: 68 };

function centre(zone: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
  return [(zone.x0 + zone.x1) / 2, (zone.y0 + zone.y1) / 2];
}

/**
 * Attract mode: plays a short scripted salvage run on the demo hull through the same
 * controls a player has (crew work orders, the torch, the grapple), then loops.
 *
 *   1. The crew cuts through the airlock bulkhead.
 *   2. The torch frees the engine block: the hull breaches and the crew runs for cover.
 *      The engine is towed to the barge.
 *   3. A deck section is cut loose through the hole and towed to the furnace.
 *   4. The gantry arms are cut, and the hull tears away with the crew aboard.
 *   5. The next ship from the generated fleet docks, with its contract on the banner.
 *
 * Beats are built once, so `tick()` does not allocate.
 */
export class DemoDirector {
  active = false;
  /** Where the torch or grapple is pointing, in tiles; -1 when idle. */
  cursorX = -1;
  cursorY = -1;
  /** Completed runs since `restart()`. */
  loops = 0;
  /** Credits earned by the last finished run. */
  lastRunCredits = 0;
  /** Fleet index of the ship docked in the closing beat, or -1. `N` takes its contract. */
  showcaseIndex = -1;

  private readonly beats: Beat[];
  private beat = 0;

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

    this.beats = [
      this.wait('Breaker-Yard: a derelict hull hangs off the docking gantry', 60),
      this.crewCuts('1/4  Crew cutting through the airlock bulkhead', lockX, 56, 62, 900),
      this.torch('2/4  Torch cutting the engine block out of the frame (hull breach!)', engineCuts),
      this.tow('2/4  Grappling the engine block to the barge', engine.x + 0.5, (engine.y0 + engine.y1 + 1) / 2, [
        LANE_X, 64, LANE_X, bargeY - 2, bargeX, bargeY,
      ]),
      this.torch('3/4  Cutting a deck section loose', deckCuts),
      this.tow('3/4  Grappling the deck plating to the furnace', (DECK.x0 + DECK.x1 + 1) / 2, (DECK.y0 + DECK.y1 + 1) / 2, [
        LANE_X, 64, LANE_X, furnaceY + 2, furnaceX, furnaceY,
      ]),
      this.wait('4/4  Crew stands down', 40),
      // With the engine gone the hull is light enough to hang off one arm, so both are cut.
      this.torch('4/4  Cutting the gantry arms', [gantry.x + 3, armRows[0], gantry.x + 3, armRows[1]]),
      this.wait('4/4  The hull tears free, crew aboard', 40),
      this.haul('4/4  Hauling the stripped hull clear of the gantry', 64, 64, 64, 112, 300),
      this.showcase(160),
    ];
  }

  /** Label of the beat in progress, for the HUD. */
  get label(): string {
    return this.active ? this.beats[this.beat].label : '';
  }

  /** Rebuilds the demo hull and crew and starts the script from the top. */
  restart(): void {
    const sim = this.sim;
    buildDemoHull(sim.world);
    sim.resetCrew();
    seedDemoCrew(sim);
    this.active = true;
    this.beat = 0;
    this.showcaseIndex = -1;
    this.beats[0].start();
  }

  /** Hands control back to the player, leaving the world as it is. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.showcaseIndex = -1;
    this.sim.world.debris.releaseGrapple();
    this.cursorX = this.cursorY = -1;
  }

  /** Advances the script by one simulation tick. Call before `Simulation.tick()`. */
  tick(): void {
    if (!this.active || !this.beats[this.beat].tick()) return;
    this.beat++;
    if (this.beat === this.beats.length) {
      this.loops++;
      // The showcase rebuilds the world, so with a fleet the run's credits were taken there.
      if (this.fleet.length === 0) this.lastRunCredits = this.sim.world.salvage.credits;
      this.restart();
      return;
    }
    this.beats[this.beat].start();
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
