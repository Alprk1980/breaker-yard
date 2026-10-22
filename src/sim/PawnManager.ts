import { B_COS, B_SIN, B_SPIN, B_VX, B_VY, B_X, B_Y, BODY_STRIDE } from './DebrisField';
import { GasCell, type Vec2 } from './GasGrid';
import { HazardKind, type HazardLog } from './HazardLog';
import { COST_IMPASSABLE, type PathGrid } from './PathGrid';
import { isSolid } from './TileFlags';
import { ToolKind, type WorkOrderQueue } from './WorkOrderQueue';
import type { World } from './World';

export const MAX_PAWNS = 32;
/** Waypoints stored per pawn. Longer routes are treated as unreachable. */
export const MAX_PATH = 512;

export const PawnState = {
  IDLE: 0,
  NAVIGATING: 1,
  PRE_CUT: 2,
  DISASSEMBLING: 3,
  FLEEING: 4,
} as const;

export const PAWN_STATE_NAMES: readonly string[] = ['IDLE', 'NAVIGATING', 'PRE_CUT', 'DISASSEMBLING', 'FLEEING'];

/** Per-pawn warning bits, shown by the renderer. */
export const PawnWarning = {
  /** Sticky until the next claim: the last cut was refused for pressure. */
  PRESSURE: 0x01,
  /** Standing in a vent stream. */
  VENT: 0x02,
  TOXIC: 0x04,
  /** A member within one tile is above 80% utilisation. */
  STRESS: 0x08,
  /** Not on a floor tile. */
  ADRIFT: 0x10,
} as const;
export const PAWN_WARNING_BITS = 5;

/** Largest differential a pawn will cut through, in bar. */
export const MAX_CUT_DELTA_BAR = 2.0;
/** Ticks spent scanning the wall in PRE_CUT before the torch lights. */
export const PRE_CUT_TICKS = 10;
/** Progress per second, by tool. */
export const CUT_RATE = 25;
export const HEAVY_CUT_RATE = 12.5;
/** A member being cut loses up to this fraction of its capacity as it heats. */
export const HEAT_WEAKENING = 0.5;

/** Walking speeds in tiles per second. */
export const WALK_SPEED = 3;
export const FLEE_SPEED = 4.5;
export const REPATH_TICKS = 20;

/** Vent impulse (bar per tile) that sends a pawn running. */
export const FLEE_IMPULSE = 0.15;
/**
 * Ticks the stream must persist before a pawn runs. Opening any wall briefly pulls gas into
 * the new cell, and that one-tick gust is not a breach.
 */
export const FLEE_CONFIRM_TICKS = 3;
/** Vent impulse below which a clamped pawn counts the area as calm. */
export const CALM_IMPULSE = 0.05;
export const CALM_TICKS = 40;
/** Acceleration per bar/tile of vent impulse, tiles/s^2. */
export const DRAG_GAIN = 12;
/** Drag that engaged magboots absorb completely, tiles/s^2. Anything above slips through. */
export const MAGBOOT_GRIP = 6;
/** Velocity damping while booted to a floor, per second. */
export const BOOT_FRICTION = 8;
/**
 * Speed cap per axis, tiles/s. Keeps a pawn caught in a hard blowout under one tile per
 * tick, so `move` (which only tests the destination tile) cannot tunnel through a wall.
 */
export const MAX_DRIFT_SPEED = 15;
/** Suit thrusters used to reach a floor anchor when adrift, tiles/s^2. */
export const THRUSTER_ACCEL = 4;
export const REFUGE_RADIUS = 10;
export const ANCHOR_SEARCH_RADIUS = 8;
/** Toxic partial pressure that raises a warning, in bar. */
export const TOXIC_WARN_BAR = 0.2;

export const REFUSAL_SUSPEND_TICKS = 200;
export const UNREACHABLE_SUSPEND_TICKS = 100;
export const FLEE_SUSPEND_TICKS = 100;

/*
 * Enum values as plain module constants. `PawnState.FLEEING` is a property load with its own
 * type-feedback slot, and a slot in a branch that warm-up never reached deoptimises the
 * whole pawn tick the first time it runs. Module constants carry no feedback.
 */
const IDLE = PawnState.IDLE;
const NAVIGATING = PawnState.NAVIGATING;
const PRE_CUT = PawnState.PRE_CUT;
const DISASSEMBLING = PawnState.DISASSEMBLING;
const FLEEING = PawnState.FLEEING;
const W_PRESSURE = PawnWarning.PRESSURE;
const W_VENT = PawnWarning.VENT;
const W_TOXIC = PawnWarning.TOXIC;
const W_STRESS = PawnWarning.STRESS;
const W_ADRIFT = PawnWarning.ADRIFT;
const H_CUT_REFUSED = HazardKind.CUT_REFUSED_PRESSURE;
const H_CUT_ABORTED = HazardKind.CUT_ABORTED_PRESSURE;
const H_DECOMPRESSION = HazardKind.DECOMPRESSION;
const H_ADRIFT = HazardKind.ADRIFT;
const H_UNREACHABLE = HazardKind.UNREACHABLE;
const H_CARRIED_OFF = HazardKind.CARRIED_OFF;
const OPEN = GasCell.OPEN;
const WALL = GasCell.WALL;
const HEAVY_CUTTER = ToolKind.HEAVY_CUTTER;

/*
 * Slots in `PawnManager.scalars`. Doubles crossing a call that V8 did not inline get boxed
 * (one heap allocation each), so the tick passes them through this buffer instead of as
 * arguments or return values.
 */
const S_DT = 0;
const S_IMPULSE = 1;
const S_MOVE_X = 2;
const S_MOVE_Y = 3;

/** `timer` value that asks a fleeing pawn to pick a refuge on its next tick. */
const PLAN_NOW = 0xffff;

/**
 * Fixed pool of up to 32 pawns, stored as a struct of typed arrays. Pairs are
 * interleaved: `pos[p * 2]` is x and `pos[p * 2 + 1]` is y, in tile units with tile
 * (x, y) spanning [x, x + 1).
 *
 * Pawns own no grid cells. Each tick they read the gas, stress and cost layers through
 * the tile index of their position, and act on the world only through `World.setTile`,
 * the lattice API and the work-order queue.
 */
export class PawnManager {
  readonly capacity = MAX_PAWNS;
  readonly alive = new Uint8Array(MAX_PAWNS);
  readonly pos = new Float32Array(MAX_PAWNS * 2);
  /** Velocity from decompression drag, tiles/s. Walking is applied separately. */
  readonly vel = new Float32Array(MAX_PAWNS * 2);
  /** Unit facing vector, for the renderer. */
  readonly heading = new Float32Array(MAX_PAWNS * 2);
  readonly state = new Uint8Array(MAX_PAWNS);
  readonly target = new Int16Array(MAX_PAWNS * 2);
  /** Work progress on the current order, 0..100. */
  readonly progress = new Float32Array(MAX_PAWNS);
  /** 1 while the pawn's boots are clamped to a floor, resisting drag. */
  readonly magBoot = new Uint8Array(MAX_PAWNS);
  readonly orderSlot = new Int16Array(MAX_PAWNS).fill(-1);
  readonly toolMask = new Uint8Array(MAX_PAWNS);
  readonly warnings = new Uint8Array(MAX_PAWNS);
  /** Floor tile a drifting pawn is thrusting toward, or -1. */
  readonly anchor = new Int32Array(MAX_PAWNS).fill(-1);
  /** 1 while braced at a refuge: velocity is pinned to zero. */
  readonly clamp = new Uint8Array(MAX_PAWNS);
  /** Consecutive ticks spent in a vent stream above `FLEE_IMPULSE`. */
  readonly ventTicks = new Uint8Array(MAX_PAWNS);
  /** State-specific countdown or counter (repath, pre-cut scan, calm time). */
  readonly timer = new Uint16Array(MAX_PAWNS);
  /** Waypoint tile indices, MAX_PATH per pawn. */
  readonly path = new Int32Array(MAX_PAWNS * MAX_PATH);
  readonly pathLen = new Int16Array(MAX_PAWNS);
  readonly pathStep = new Int16Array(MAX_PAWNS);
  /** Debris body the pawn is riding, or -1; with that body's generation and the pawn's body-local position. */
  readonly ride = new Int16Array(MAX_PAWNS).fill(-1);
  readonly rideGen = new Uint16Array(MAX_PAWNS);
  readonly rideLocal = new Float32Array(MAX_PAWNS * 2);
  count = 0;

  private readonly scalars = new Float64Array(4);
  private readonly impulse: Vec2 = { x: 0, y: 0 };
  private readonly probe: Vec2 = { x: 0, y: 0 };

  constructor(
    private readonly world: World,
    private readonly paths: PathGrid,
    private readonly orders: WorkOrderQueue,
    private readonly hazards: HazardLog,
  ) {}

  /** Spawns a pawn at the centre of a floor tile. Returns its id, or -1. */
  spawn(x: number, y: number, toolMask: number = ToolKind.CUTTER | ToolKind.HEAVY_CUTTER): number {
    if (this.world.gas.getCell(x, y) !== OPEN) return -1;
    const p = this.alive.indexOf(0);
    if (p < 0) return -1;
    this.alive[p] = 1;
    this.pos[p * 2] = x + 0.5;
    this.pos[p * 2 + 1] = y + 0.5;
    this.vel[p * 2] = 0;
    this.vel[p * 2 + 1] = 0;
    this.heading[p * 2] = 1;
    this.heading[p * 2 + 1] = 0;
    this.state[p] = IDLE;
    this.target[p * 2] = -1;
    this.target[p * 2 + 1] = -1;
    this.progress[p] = 0;
    this.magBoot[p] = 1;
    this.orderSlot[p] = -1;
    this.toolMask[p] = toolMask;
    this.warnings[p] = 0;
    this.ventTicks[p] = 0;
    this.anchor[p] = -1;
    this.clamp[p] = 0;
    this.timer[p] = 0;
    this.pathLen[p] = 0;
    this.pathStep[p] = 0;
    this.ride[p] = -1;
    this.count++;
    return p;
  }

  despawn(p: number): void {
    if (this.alive[p] === 0) return;
    this.dropOrder(p, 0);
    this.alive[p] = 0;
    this.count--;
  }

  clear(): void {
    this.alive.fill(0);
    this.orderSlot.fill(-1);
    this.count = 0;
  }

  /** Nearest live pawn within `radius` tiles of (x, y), or -1. */
  pawnNear(x: number, y: number, radius: number): number {
    let best = -1;
    let bestD = radius * radius;
    for (let p = 0; p < MAX_PAWNS; p++) {
      if (this.alive[p] === 0) continue;
      const dx = this.pos[p * 2] - x;
      const dy = this.pos[p * 2 + 1] - y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * Puts every pawn standing on a cell that was lifted into debris this tick aboard that
   * body. A rider drops its work and moves with the wreck until the wreck is delivered,
   * then floats free with the wreck's velocity.
   */
  boardDebris(): void {
    const debris = this.world.debris;
    if (debris.liftedCount === 0) return;
    const w = this.world.width;
    for (let p = 0; p < MAX_PAWNS; p++) {
      if (this.alive[p] === 0) continue;
      const tx = Math.floor(this.pos[p * 2]);
      const ty = Math.floor(this.pos[p * 2 + 1]);
      const b = debris.liftedBy[ty * w + tx];
      if (b < 0) continue;
      this.dropOrder(p, 0);
      this.clamp[p] = 0;
      this.anchor[p] = -1;
      this.ride[p] = b;
      this.rideGen[p] = debris.generation[b];
      // Bodies are born unrotated, so local = world - centre of mass.
      const o = b * BODY_STRIDE;
      this.rideLocal[p * 2] = this.pos[p * 2] - debris.body[o + B_X];
      this.rideLocal[p * 2 + 1] = this.pos[p * 2 + 1] - debris.body[o + B_Y];
      this.hazards.log(H_CARRIED_OFF, p, tx, ty, this.world.tickCount, 0);
    }
  }

  /** One fixed tick. Allocation-free. */
  tick(dt: number): void {
    this.scalars[S_DT] = dt;
    for (let p = 0; p < MAX_PAWNS; p++) {
      if (this.alive[p] === 1) this.tickPawn(p);
    }
  }

  /**
   * One pawn, one tick. Layout matters for the zero-allocation rule: every bit of
   * floating-point work (physics, walking, facing, cut progress) lives here, in the one
   * function that runs for every pawn every tick and so is always optimised. The per-state
   * functions it calls are integer-only decision logic; they are cold, may well be running
   * in V8's interpreter, and interpreted double arithmetic allocates a heap number per op.
   */
  private tickPawn(p: number): void {
    const world = this.world;
    const gas = world.gas;
    const sc = this.scalars;
    const dt = sc[S_DT];
    const pos = this.pos;
    const vel = this.vel;

    // --- Riding a wreck: carried rigidly with it, doing nothing else ---
    const ride = this.ride[p];
    if (ride >= 0) {
      const debris = world.debris;
      if (debris.alive[ride] === 1 && debris.generation[ride] === this.rideGen[p]) {
        const s = debris.body;
        const o = ride * BODY_STRIDE;
        const lx = this.rideLocal[p * 2];
        const ly = this.rideLocal[p * 2 + 1];
        const rx = s[o + B_COS] * lx - s[o + B_SIN] * ly;
        const ry = s[o + B_SIN] * lx + s[o + B_COS] * ly;
        pos[p * 2] = s[o + B_X] + rx;
        pos[p * 2 + 1] = s[o + B_Y] + ry;
        vel[p * 2] = s[o + B_VX] - s[o + B_SPIN] * ry;
        vel[p * 2 + 1] = s[o + B_VY] + s[o + B_SPIN] * rx;
        this.magBoot[p] = 1;
        this.warnings[p] = 0;
        return;
      }
      // The wreck went into a bin: float free at the speed it was carrying us.
      this.ride[p] = -1;
    }

    // --- Physics: decompression drag against magboots, suit thrusters, clamping ---
    const heading = this.heading;
    const w = world.width;
    let tx = Math.floor(pos[p * 2]);
    let ty = Math.floor(pos[p * 2 + 1]);
    const onFloor = gas.cells[ty * w + tx] === OPEN;
    const imp = gas.getVentImpulse(tx, ty, this.impulse);
    const impMag = Math.sqrt(imp.x * imp.x + imp.y * imp.y);
    const f = impMag * DRAG_GAIN;
    // Booted pawns only feel the drag their grip cannot absorb, and friction bleeds off speed.
    const slip = onFloor ? (f > MAGBOOT_GRIP ? 1 - MAGBOOT_GRIP / f : 0) : 1;
    const friction = 1 - BOOT_FRICTION * dt;
    const damp = onFloor ? (friction > 0 ? friction : 0) : 1;
    // Adrift with a floor in reach: thrusters push toward it.
    const anchor = onFloor ? -1 : this.anchor[p];
    const adx = anchor >= 0 ? (anchor % w) + 0.5 - pos[p * 2] : 0;
    const ady = anchor >= 0 ? ((anchor / w) | 0) + 0.5 - pos[p * 2 + 1] : 0;
    const ad = Math.sqrt(adx * adx + ady * ady);
    const thrust = ad > 1e-4 ? THRUSTER_ACCEL / ad : 0;
    const ax = imp.x * DRAG_GAIN * slip + adx * thrust;
    const ay = imp.y * DRAG_GAIN * slip + ady * thrust;
    // A pawn clamped to its anchor sits at the tile centre and holds still whatever the stream does.
    const clamped = this.clamp[p] === 1;
    const rawVx = vel[p * 2] * damp + ax * dt;
    const rawVy = vel[p * 2 + 1] * damp + ay * dt;
    const capVx = rawVx > MAX_DRIFT_SPEED ? MAX_DRIFT_SPEED : rawVx < -MAX_DRIFT_SPEED ? -MAX_DRIFT_SPEED : rawVx;
    const capVy = rawVy > MAX_DRIFT_SPEED ? MAX_DRIFT_SPEED : rawVy < -MAX_DRIFT_SPEED ? -MAX_DRIFT_SPEED : rawVy;
    const vx = clamped ? 0 : capVx;
    const vy = clamped ? 0 : capVy;
    vel[p * 2] = vx;
    vel[p * 2 + 1] = vy;
    pos[p * 2] = clamped ? tx + 0.5 : pos[p * 2];
    pos[p * 2 + 1] = clamped ? ty + 0.5 : pos[p * 2 + 1];
    heading[p * 2] = thrust > 0 ? adx / ad : heading[p * 2];
    heading[p * 2 + 1] = thrust > 0 ? ady / ad : heading[p * 2 + 1];
    this.magBoot[p] = onFloor ? 1 : 0;
    sc[S_MOVE_X] = vx * dt;
    sc[S_MOVE_Y] = vy * dt;
    this.move(p);

    tx = Math.floor(pos[p * 2]);
    ty = Math.floor(pos[p * 2 + 1]);

    // --- Live warnings ---
    const live =
      (impMag > FLEE_IMPULSE ? W_VENT : 0) |
      (gas.toxin[ty * w + tx] > TOXIC_WARN_BAR ? W_TOXIC : 0) |
      (onFloor ? 0 : W_ADRIFT) |
      (this.stressNear(tx, ty) ? W_STRESS : 0);
    this.warnings[p] = (this.warnings[p] & W_PRESSURE) | live;

    const vt = impMag > FLEE_IMPULSE ? this.ventTicks[p] + 1 : 0;
    this.ventTicks[p] = vt > 255 ? 255 : vt;
    if (this.state[p] !== FLEEING && (vt >= FLEE_CONFIRM_TICKS || !onFloor)) {
      sc[S_IMPULSE] = impMag;
      this.startFleeing(p, onFloor ? H_DECOMPRESSION : H_ADRIFT, tx, ty);
    }

    // --- Decisions (integer-only) ---
    switch (this.state[p]) {
      case IDLE:
        this.tickIdle(p, tx, ty);
        break;
      case NAVIGATING:
        this.tickNavigating(p, tx, ty);
        break;
      case PRE_CUT:
        this.tickPreCut(p, tx, ty);
        break;
      case DISASSEMBLING:
        this.tickDisassembling(p, tx, ty);
        break;
      case FLEEING:
        this.tickFleeing(p, tx, ty, impMag > FLEE_IMPULSE, impMag < CALM_IMPULSE);
        break;
    }

    // --- Motion and work for the state just decided ---
    const state = this.state[p];
    if ((state === NAVIGATING || state === FLEEING) && this.clamp[p] === 0) {
      // Walk along the path; several waypoints can be passed in one tick.
      let budget = (state === FLEEING ? FLEE_SPEED : WALK_SPEED) * dt;
      const base = p * MAX_PATH;
      while (budget > 0 && this.pathStep[p] < this.pathLen[p]) {
        const node = this.path[base + this.pathStep[p]];
        const dx = (node % w) + 0.5 - pos[p * 2];
        const dy = ((node / w) | 0) + 0.5 - pos[p * 2 + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const near = d <= budget;
        const k = d > 1e-4 ? 1 / d : 0;
        heading[p * 2] = d > 1e-4 ? dx * k : heading[p * 2];
        heading[p * 2 + 1] = d > 1e-4 ? dy * k : heading[p * 2 + 1];
        const step = near ? d : budget;
        sc[S_MOVE_X] = dx * k * step;
        sc[S_MOVE_Y] = dy * k * step;
        this.move(p);
        budget = near ? budget - d : 0;
        this.pathStep[p] += near ? 1 : 0;
      }
    } else if (state === PRE_CUT || state === DISASSEMBLING) {
      const ox = this.target[p * 2];
      const oy = this.target[p * 2 + 1];
      const dx = ox + 0.5 - pos[p * 2];
      const dy = oy + 0.5 - pos[p * 2 + 1];
      const k = 1 / Math.sqrt(dx * dx + dy * dy + 1e-9);
      heading[p * 2] = dx * k;
      heading[p * 2 + 1] = dy * k;
      if (state === DISASSEMBLING) {
        const slot = this.orderSlot[p];
        const rate = this.orders.tool[slot] === HEAVY_CUTTER ? HEAVY_CUT_RATE : CUT_RATE;
        const raw = this.progress[p] + rate * dt;
        const progress = raw > 100 ? 100 : raw;
        this.progress[p] = progress;
        this.orders.progress[slot] = progress;
        // Torch heat softens the member: its edges lose capacity as the cut deepens, which
        // shows up as rising utilisation (and can snap a member that was already loaded).
        // Written straight into the edge arrays: passing `cap` to a setter would box it.
        const lattice = world.lattice;
        const n = oy * lattice.width + ox;
        const cap = lattice.breakThreshold * (1 - (HEAT_WEAKENING * progress) / 100);
        for (let d = 0; d < 4; d++) {
          const e = lattice.edgeAdjacency[n * 4 + d];
          if (e >= 0 && lattice.nodeActive[n] === 1) lattice.edgeCapacity[e] = cap;
        }
        if (progress >= 100) this.finishCut(p, ox, oy);
      }
    }
  }

  private tickIdle(p: number, tx: number, ty: number): void {
    const orders = this.orders;
    const slot = orders.claimNextOrder(tx, ty, p, this.toolMask[p]);
    if (slot < 0) return;
    const w = this.world.width;
    const idx = orders.cell[slot];
    const ox = idx % w;
    const oy = (idx / w) | 0;
    if (!isSolid(this.world.tiles[idx])) {
      // Already cut by hand; nothing left to do.
      orders.complete(slot);
      return;
    }
    this.orderSlot[p] = slot;
    this.target[p * 2] = ox;
    this.target[p * 2 + 1] = oy;
    this.progress[p] = orders.progress[slot];
    this.warnings[p] &= ~W_PRESSURE;
    if (!this.planPath(p, tx, ty, ox, oy, true)) {
      this.hazards.log(H_UNREACHABLE, p, ox, oy, this.world.tickCount, 0);
      this.dropOrder(p, UNREACHABLE_SUSPEND_TICKS);
      return;
    }
    this.state[p] = NAVIGATING;
    this.timer[p] = REPATH_TICKS;
  }

  private tickNavigating(p: number, tx: number, ty: number): void {
    if (!this.holdsLiveOrder(p)) return;
    if (this.pathStep[p] >= this.pathLen[p]) {
      // Standing next to the wall.
      this.state[p] = PRE_CUT;
      this.timer[p] = PRE_CUT_TICKS;
      return;
    }
    if (this.timer[p] > 0) {
      this.timer[p]--;
      return;
    }
    // Costs move with the gas, so routes are refreshed on a fixed cadence.
    const ox = this.target[p * 2];
    const oy = this.target[p * 2 + 1];
    if (!this.planPath(p, tx, ty, ox, oy, true)) {
      this.hazards.log(H_UNREACHABLE, p, ox, oy, this.world.tickCount, 0);
      this.dropOrder(p, UNREACHABLE_SUSPEND_TICKS);
      return;
    }
    this.timer[p] = REPATH_TICKS;
  }

  /** Scans the wall: refuses the cut if it is holding back more than `MAX_CUT_DELTA_BAR`. */
  private tickPreCut(p: number, tx: number, ty: number): void {
    if (!this.holdsLiveOrder(p)) return;
    const ox = this.target[p * 2];
    const oy = this.target[p * 2 + 1];
    if (!this.adjacentTo(tx, ty, ox, oy)) {
      this.resumeNavigation(p);
      return;
    }
    const gas = this.world.gas;
    if (gas.exceedsPressureDelta(ox, oy, MAX_CUT_DELTA_BAR)) {
      this.hazards.log(H_CUT_REFUSED, p, ox, oy, this.world.tickCount, gas.getPressureDelta(ox, oy));
      this.warnings[p] |= W_PRESSURE;
      this.dropOrder(p, REFUSAL_SUSPEND_TICKS);
      return;
    }
    if (this.timer[p] > 0) {
      this.timer[p]--;
      return;
    }
    this.state[p] = DISASSEMBLING;
    this.progress[p] = this.orders.progress[this.orderSlot[p]];
  }

  /** Safety checks while cutting; the torch work itself is applied in `tickPawn`. */
  private tickDisassembling(p: number, tx: number, ty: number): void {
    if (!this.holdsLiveOrder(p)) return;
    const world = this.world;
    const ox = this.target[p * 2];
    const oy = this.target[p * 2 + 1];
    if (!this.adjacentTo(tx, ty, ox, oy)) {
      this.resumeNavigation(p);
      return;
    }
    // Keep scanning while cutting: a breach elsewhere can load this wall up mid-cut.
    if (world.gas.exceedsPressureDelta(ox, oy, MAX_CUT_DELTA_BAR)) {
      this.hazards.log(H_CUT_ABORTED, p, ox, oy, world.tickCount, world.gas.getPressureDelta(ox, oy));
      this.warnings[p] |= W_PRESSURE;
      this.dropOrder(p, REFUSAL_SUSPEND_TICKS);
    }
  }

  /** The wall is through: remove the tile and its structural node, and close the order. */
  private finishCut(p: number, ox: number, oy: number): void {
    this.world.cutTile(ox, oy);
    this.orders.complete(this.orderSlot[p]);
    this.orderSlot[p] = -1;
    this.progress[p] = 0;
    this.state[p] = IDLE;
  }

  private tickFleeing(p: number, tx: number, ty: number, inStream: boolean, calm: boolean): void {
    if (this.world.gas.cells[ty * this.world.width + tx] !== OPEN) {
      // Adrift: aim the thrusters (applied by the physics step) at the nearest floor.
      this.anchor[p] = this.nearestFloor(tx, ty, ANCHOR_SEARCH_RADIUS);
      this.clamp[p] = 0;
      this.pathLen[p] = 0;
      this.pathStep[p] = 0;
      this.timer[p] = PLAN_NOW;
      return;
    }
    this.anchor[p] = -1;

    // Plan on entry or landing, then re-plan every 10 ticks while still in the stream.
    if (this.timer[p] === PLAN_NOW || (inStream && (this.world.tickCount + p) % 10 === 0)) {
      this.chooseRefuge(p, tx, ty);
      this.timer[p] = 0;
    }
    if (this.pathStep[p] < this.pathLen[p]) {
      // Still running; `tickPawn` walks the route.
      this.clamp[p] = 0;
      this.timer[p] = 0;
      return;
    }

    // At the refuge: clamp to the anchor tile and wait for the stream to die down.
    this.clamp[p] = 1;
    if (!calm) {
      this.timer[p] = 0;
      return;
    }
    if (++this.timer[p] >= CALM_TICKS) {
      this.state[p] = IDLE;
      this.clamp[p] = 0;
      this.pathLen[p] = 0;
      this.timer[p] = 0;
    }
  }

  /** Drops work and runs. Logs the vent impulse left in `scalars[S_IMPULSE]`. */
  private startFleeing(p: number, kind: number, tx: number, ty: number): void {
    this.hazards.log(kind, p, tx, ty, this.world.tickCount, this.scalars[S_IMPULSE]);
    this.dropOrder(p, FLEE_SUSPEND_TICKS);
    this.state[p] = FLEEING;
    this.clamp[p] = 0;
    this.anchor[p] = -1;
    this.pathLen[p] = 0;
    this.pathStep[p] = 0;
    this.timer[p] = PLAN_NOW;
  }

  /**
   * Picks the best floor anchor within `REFUGE_RADIUS`: a passable tile braced against a
   * solid neighbour, cheap on the cost grid (which already prices the vent stream), and as
   * far as possible along the direction opposite to the vent impulse at the pawn. Then
   * plans a route to it.
   *
   * The scan loop is integer-only. It runs a few times a second at most, so V8 may still be
   * interpreting it, and interpreted double arithmetic allocates.
   */
  private chooseRefuge(p: number, tx: number, ty: number): void {
    const paths = this.paths;
    const w = this.world.width;
    const imp = this.world.gas.getVentImpulse(tx, ty, this.probe);
    const im = Math.sqrt(imp.x * imp.x + imp.y * imp.y);
    // Flee direction, quantised to 1/16ths.
    const fx = im > 1e-6 ? Math.round((-imp.x * 16) / im) | 0 : 0;
    const fy = im > 1e-6 ? Math.round((-imp.y * 16) / im) | 0 : 0;

    let best = -1;
    let bestScore = 0x7fffffff;
    for (let dy = -REFUGE_RADIUS; dy <= REFUGE_RADIUS; dy++) {
      const y = ty + dy;
      const ady = dy < 0 ? -dy : dy;
      for (let dx = -REFUGE_RADIUS; dx <= REFUGE_RADIUS; dx++) {
        const x = tx + dx;
        const c = paths.getCost(x, y);
        if (c === COST_IMPASSABLE || !this.braced(x, y)) continue;
        const adx = dx < 0 ? -dx : dx;
        // Octile distance in tenths of a tile.
        const octile = adx > ady ? adx * 10 + ady * 4 : ady * 10 + adx * 4;
        const along = dx * fx + dy * fy;
        const score = c * 4 + (octile >> 1) - along * 2;
        if (score < bestScore) {
          bestScore = score;
          best = y * w + x;
        }
      }
    }
    this.pathStep[p] = 0;
    this.pathLen[p] = 0;
    if (best < 0) return;
    const bx = best % w;
    const by = (best / w) | 0;
    this.target[p * 2] = bx;
    this.target[p * 2 + 1] = by;
    const len = paths.findPath(tx, ty, bx, by, false, this.path, p * MAX_PATH, MAX_PATH);
    if (len > 0) this.pathLen[p] = len;
  }

  /** A floor tile with a solid 4-neighbour to brace against. */
  private braced(x: number, y: number): boolean {
    const gas = this.world.gas;
    return (
      gas.getCell(x - 1, y) === WALL ||
      gas.getCell(x + 1, y) === WALL ||
      gas.getCell(x, y - 1) === WALL ||
      gas.getCell(x, y + 1) === WALL
    );
  }

  /** Nearest OPEN tile by expanding square rings, or -1. */
  private nearestFloor(cx: number, cy: number, radius: number): number {
    const gas = this.world.gas;
    const w = this.world.width;
    for (let r = 1; r <= radius; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx !== -r && dx !== r && dy !== -r && dy !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (gas.getCell(x, y) !== OPEN) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = y * w + x;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private planPath(p: number, sx: number, sy: number, gx: number, gy: number, adjacent: boolean): boolean {
    const len = this.paths.findPath(sx, sy, gx, gy, adjacent, this.path, p * MAX_PATH, MAX_PATH);
    this.pathStep[p] = 0;
    if (len < 0) {
      this.pathLen[p] = 0;
      return false;
    }
    this.pathLen[p] = len;
    return true;
  }

  /**
   * Moves by `scalars[S_MOVE_X/Y]`, one axis at a time, stopping (and killing velocity) at walls and the
   * grid edge. Written branch-light on purpose: a rarely taken branch with its own property
   * accesses deoptimises the hot pawn tick the first time a pawn bumps into something.
   */
  private move(p: number): void {
    const dx = this.scalars[S_MOVE_X];
    const dy = this.scalars[S_MOVE_Y];
    const cells = this.world.gas.cells;
    const w = this.world.width;
    const pos = this.pos;
    const vel = this.vel;
    const maxX = w - 0.001;
    const maxY = this.world.height - 0.001;
    const x = pos[p * 2];
    const y = pos[p * 2 + 1];

    let nx = x + dx;
    let hitX = nx < 0 || nx > maxX;
    nx = nx < 0 ? 0 : nx > maxX ? maxX : nx;
    const blockedX = cells[Math.floor(y) * w + Math.floor(nx)] === WALL;
    nx = blockedX ? x : nx;
    hitX = hitX || blockedX;

    let ny = y + dy;
    let hitY = ny < 0 || ny > maxY;
    ny = ny < 0 ? 0 : ny > maxY ? maxY : ny;
    const blockedY = cells[Math.floor(ny) * w + Math.floor(nx)] === WALL;
    ny = blockedY ? y : ny;
    hitY = hitY || blockedY;

    pos[p * 2] = nx;
    pos[p * 2 + 1] = ny;
    vel[p * 2] = hitX ? 0 : vel[p * 2];
    vel[p * 2 + 1] = hitY ? 0 : vel[p * 2 + 1];
  }

  /** True while the pawn's order is still its own and still has a wall to cut; otherwise drops to IDLE. */
  private holdsLiveOrder(p: number): boolean {
    const slot = this.orderSlot[p];
    const w = this.world.width;
    const idx = this.target[p * 2 + 1] * w + this.target[p * 2];
    if (!this.orders.isHeldBy(slot, idx, p)) {
      // Cancelled by the player.
      this.orderSlot[p] = -1;
      this.state[p] = IDLE;
      this.pathLen[p] = 0;
      return false;
    }
    if (!isSolid(this.world.tiles[idx])) {
      this.orders.complete(slot);
      this.orderSlot[p] = -1;
      this.state[p] = IDLE;
      this.pathLen[p] = 0;
      return false;
    }
    return true;
  }

  private resumeNavigation(p: number): void {
    this.state[p] = NAVIGATING;
    this.timer[p] = 0;
  }

  private dropOrder(p: number, suspendTicks: number): void {
    const slot = this.orderSlot[p];
    if (slot >= 0) {
      const w = this.world.width;
      const idx = this.target[p * 2 + 1] * w + this.target[p * 2];
      if (this.orders.isHeldBy(slot, idx, p)) this.orders.release(slot, suspendTicks);
    }
    this.orderSlot[p] = -1;
    this.state[p] = IDLE;
    this.pathLen[p] = 0;
    this.pathStep[p] = 0;
  }

  private adjacentTo(x: number, y: number, ox: number, oy: number): boolean {
    const dx = x > ox ? x - ox : ox - x;
    const dy = y > oy ? y - oy : oy - y;
    return dx + dy === 1;
  }

  /** Any live structural node in the 3x3 block around (x, y) above the danger line. */
  private stressNear(x: number, y: number): boolean {
    const L = this.world.lattice;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!L.inBounds(nx, ny)) continue;
        const n = ny * L.width + nx;
        if (L.nodeActive[n] === 1 && L.nodeStress[n] > 0.8) return true;
      }
    }
    return false;
  }
}
