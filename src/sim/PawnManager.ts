import { HAUL_LANE_X, HEIGHT, WIDTH } from './constants';
import { B_COS, B_MASS, B_SIN, B_SPIN, B_VX, B_VY, B_X, B_Y, BODY_STRIDE, MAX_BODIES } from './DebrisField';
import { GasCell, type Vec2 } from './GasGrid';
import { HazardKind, type HazardLog } from './HazardLog';
import { BREATHABLE_BAR, BREATHABLE_TOXIN_BAR, COST_IMPASSABLE, type PathGrid } from './PathGrid';
import { TileFlags, isSolid } from './TileFlags';
import { OrderKind, ToolKind, type WorkOrderQueue } from './WorkOrderQueue';
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
  /** Walking to a deck tile next to a loose chunk, to climb aboard and tow it. */
  APPROACHING: 5,
  /** Aboard a chunk, pushing it to a bin with suit thrusters. */
  TUGGING: 6,
  /** Flying back to the ship after a tow. */
  RETURNING: 7,
  /** Out of health: helpless until healed, or rescued, or dead. */
  DOWN: 8,
  /** Heading for a downed or stranded pawn (walking, or to the deck edge to fly out). */
  RESCUE_GO: 9,
  /** Flying out on thrusters to grab a pawn adrift in space. */
  RESCUE_FLY: 10,
  /** Carrying a pawn to breathable air, or at least back aboard. */
  RESCUE_CARRY: 11,
} as const;

export const PAWN_STATE_NAMES: readonly string[] = [
  'IDLE',
  'NAVIGATING',
  'PRE_CUT',
  'DISASSEMBLING',
  'FLEEING',
  'APPROACHING',
  'TUGGING',
  'RETURNING',
  'DOWN',
  'RESCUE_GO',
  'RESCUE_FLY',
  'RESCUE_CARRY',
];

/** Kinds of work a pawn can be given a priority for. */
export const JobKind = {
  /** Work orders: cutting walls open and severing salvage. */
  CUT: 0,
  /** Towing loose chunks to the bin that pays most for them. */
  HAUL: 1,
  /** Fetching downed and stranded crew back to air. Tried before other jobs of the same priority. */
  RESCUE: 2,
} as const;
export const JOB_KINDS = 3;
export const JOB_NAMES: readonly string[] = ['cut', 'haul', 'rescue'];
/** Job priorities run 1 (done first) to 4 (done last); 0 means never. */
export const JOB_PRIORITY_LOWEST = 4;
/** New pawns rescue and cut first, and haul when there is nothing else. */
export const DEFAULT_JOB_PRIORITY: readonly number[] = [1, 2, 1];

/** Suit air, in seconds of breathing. */
export const SUIT_O2 = 180;
/** Air refilled per second in breathable air; drawn per second elsewhere, faster with a breached suit. */
export const O2_REFILL = 20;
export const O2_DRAIN = 1;
export const O2_DRAIN_BREACHED = 3;
/** Suit integrity (0-100) below which the suit is breached. */
export const SUIT_BREACH = 50;
/** Suit integrity lost per second per bar of toxin: the gas eats the seals. */
export const TOXIC_SUIT_DAMAGE = 3;
export const MAX_HEALTH = 100;
/** Health lost per second with no air, and regained per second while there is air. */
export const SUFFOCATION_DAMAGE = 8;
export const HEAL_RATE = 2;
/** A downed pawn gets up at this health; keeps losing health while down and dies at `DEATH_HEALTH`. */
export const WAKE_HEALTH = 30;
export const DEATH_HEALTH = -50;
/** Hitting a wall faster than this (tiles/s) hurts: `IMPACT_DAMAGE` health per tile/s over, half that to the suit. */
export const IMPACT_SPEED = 5;
export const IMPACT_DAMAGE = 8;
/** Adrift with no deck in reach for this many ticks: stranded, and someone should come. */
export const STRANDED_TICKS = 60;
/** Flying on thrusters: top speed (tiles/s), and the speed per tile of distance when braking in. */
export const MAX_FLY_SPEED = 4;
export const ARRIVE_GAIN = 1.5;
/** How hard thrusters correct toward the wanted velocity (1/s), capped at `THRUSTER_ACCEL`. */
export const STEER_GAIN = 3;
/** How far a rescuer looks for breathable deck, and for a deck edge to fly out from, in tiles. */
export const SAFE_SEARCH_TILES = 1200;
export const LAUNCH_SEARCH_RADIUS = 24;
/**
 * A downed pawn set down somewhere without breathable air (because none was in reach) is
 * left this long before anyone tries again, rather than being picked up over and over.
 */
export const RESCUE_RETRY_TICKS = 600;

/** A hauler's thruster force limit, mass * tiles/s^2 (the player's grapple has 150). */
export const TUG_FORCE = 60;
/** Tow spring per unit mass toward the next waypoint (1/s^2) and damping on the load's velocity (1/s). */
export const TUG_STIFFNESS = 2;
export const TUG_DAMPING = 3;
/** Chunks heavier than this (in girder tiles) are too much for one suit to tow. */
export const HAUL_MAX_MASS = 150;
/** How far from a chunk's nearest tile a hauler can climb aboard, in tiles. */
export const BOARD_RANGE = 2.5;
/**
 * How many tiles out from a chunk a hauler looks for deck to stand on, and the squared
 * tile offset allowed, which keeps the stand within `BOARD_RANGE` of the chunk (2-and-1
 * offsets are in, 2-and-2 corners are not).
 */
const STAND_REACH = 2;
const STAND_REACH_SQ = 5;
/** A tow moves on to its next waypoint within this distance, in tiles. */
export const HAUL_WAYPOINT_RADIUS = 2.5;
/** A tow that has not gained half a tile on its waypoint in this many checks is stuck. */
export const STUCK_CHECK_TICKS = 40;
export const STUCK_LIMIT = 4;
/** After a stuck tow, crews leave that chunk alone this long. */
export const HAUL_BLOCK_TICKS = 600;

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
const APPROACHING = PawnState.APPROACHING;
const TUGGING = PawnState.TUGGING;
const RETURNING = PawnState.RETURNING;
const DOWN = PawnState.DOWN;
const RESCUE_GO = PawnState.RESCUE_GO;
const RESCUE_FLY = PawnState.RESCUE_FLY;
const RESCUE_CARRY = PawnState.RESCUE_CARRY;
const JOB_RESCUE = JobKind.RESCUE;
const JOB_CUT = JobKind.CUT;
const JOB_HAUL = JobKind.HAUL;
const SEVER = OrderKind.SEVER;
const PRESENT = TileFlags.FLOOR | TileFlags.BULKHEAD | TileFlags.GIRDER;
/** `rideRole` values. */
const ROLE_PASSENGER = 0;
const ROLE_TUG = 1;
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
const H_HAUL_ABANDONED = HazardKind.HAUL_ABANDONED;
const H_KNOCKED_OUT = HazardKind.KNOCKED_OUT;
const H_DIED = HazardKind.DIED;
const H_RESCUED = HazardKind.RESCUED;
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
  /** Passenger (carried off) or tug (hauling the chunk it rides). */
  readonly rideRole = new Uint8Array(MAX_PAWNS);
  /** Job priority per pawn and `JobKind` (`p * JOB_KINDS + kind`): 1 first .. 4 last, 0 never. */
  readonly jobPriority = new Uint8Array(MAX_PAWNS * JOB_KINDS);
  /** Chunk the pawn is hauling (approaching or towing), or -1, with that body's generation. */
  readonly haulBody = new Int16Array(MAX_PAWNS).fill(-1);
  readonly haulGen = new Uint16Array(MAX_PAWNS);
  /** Tow route: three waypoints (x, y), the last inside the bin; and the leg being flown. */
  readonly route = new Float32Array(MAX_PAWNS * 6);
  readonly routeLeg = new Uint8Array(MAX_PAWNS);
  /** Deck tile a hauler left from, to fly back to; and whether it has reached the lane yet. */
  readonly home = new Int32Array(MAX_PAWNS).fill(-1);
  readonly returnLeg = new Uint8Array(MAX_PAWNS);
  /** Stuck detection for tows: closest approach to the waypoint, ticks since, failed checks. */
  readonly stuckBest = new Float32Array(MAX_PAWNS);
  readonly stuckTicks = new Uint8Array(MAX_PAWNS);
  readonly stuckCount = new Uint8Array(MAX_PAWNS);
  /** Pawn hauling each debris body, or -1. */
  readonly bodyHauler = new Int8Array(MAX_BODIES).fill(-1);
  /** Seconds of suit air, suit integrity (0-100) and health (`MAX_HEALTH` down to `DEATH_HEALTH`). */
  readonly oxygen = new Float32Array(MAX_PAWNS);
  readonly suit = new Float32Array(MAX_PAWNS);
  readonly health = new Float32Array(MAX_PAWNS);
  /** Tile index the pawn is on, refreshed every tick, for integer-only callers. */
  readonly cellOf = new Int32Array(MAX_PAWNS);
  /** Ticks adrift with no deck to thrust for. */
  readonly strandedTicks = new Uint16Array(MAX_PAWNS);
  /** 1 while the pawn is stranded, or down out of breathable air, and nobody is carrying it. */
  readonly needy = new Uint8Array(MAX_PAWNS);
  /** Ticks before a downed pawn set down without air counts as needing rescue again. */
  readonly rescueWait = new Uint16Array(MAX_PAWNS);
  /** The pawn carrying this one, or -1. */
  readonly carriedBy = new Int8Array(MAX_PAWNS).fill(-1);
  /** The pawn coming to rescue this one, or -1. */
  readonly rescuer = new Int8Array(MAX_PAWNS).fill(-1);
  /** The pawn this one is rescuing, or -1; whether it has to fly out for them; whether the carry route is set. */
  readonly rescueTarget = new Int8Array(MAX_PAWNS).fill(-1);
  readonly rescueFly = new Uint8Array(MAX_PAWNS);
  readonly carryPlanned = new Uint8Array(MAX_PAWNS);
  /** Breadth-first search scratch for finding breathable deck. */
  private readonly bfsQueue = new Int32Array(SAFE_SEARCH_TILES);
  private readonly bfsSeen = new Uint32Array(WIDTH * HEIGHT);
  private bfsStamp = 0;
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
    this.rideRole[p] = ROLE_PASSENGER;
    this.haulBody[p] = -1;
    this.home[p] = -1;
    this.oxygen[p] = SUIT_O2;
    this.suit[p] = 100;
    this.health[p] = MAX_HEALTH;
    this.cellOf[p] = y * this.world.width + x;
    this.strandedTicks[p] = 0;
    this.needy[p] = 0;
    this.rescueWait[p] = 0;
    this.carriedBy[p] = -1;
    this.rescuer[p] = -1;
    this.rescueTarget[p] = -1;
    for (let k = 0; k < JOB_KINDS; k++) this.jobPriority[p * JOB_KINDS + k] = DEFAULT_JOB_PRIORITY[k];
    this.count++;
    return p;
  }

  despawn(p: number): void {
    if (this.alive[p] === 0) return;
    this.dropOrder(p, 0);
    this.releaseHaul(p);
    this.endRescue(p);
    // Anyone this pawn was carrying, or was coming for, is let go.
    for (let q = 0; q < MAX_PAWNS; q++) {
      if (this.carriedBy[q] === p) this.carriedBy[q] = -1;
      if (this.rescuer[q] === p) this.rescuer[q] = -1;
    }
    if (this.rescuer[p] >= 0) this.rescueTarget[this.rescuer[p]] = -1;
    this.rescuer[p] = -1;
    this.carriedBy[p] = -1;
    this.ride[p] = -1;
    this.alive[p] = 0;
    this.count--;
  }

  clear(): void {
    this.alive.fill(0);
    this.orderSlot.fill(-1);
    this.bodyHauler.fill(-1);
    this.carriedBy.fill(-1);
    this.rescuer.fill(-1);
    this.rescueTarget.fill(-1);
    this.needy.fill(0);
    this.count = 0;
  }

  /** Sets a pawn's priority for a kind of job: 1 first .. 4 last, 0 never. */
  setJobPriority(p: number, kind: number, priority: number): void {
    this.jobPriority[p * JOB_KINDS + kind] = priority < 0 ? 0 : priority > JOB_PRIORITY_LOWEST ? JOB_PRIORITY_LOWEST : priority;
  }

  /** Steps a pawn's priority for a job through 1, 2, 3, 4, off. Returns the new value. */
  cycleJobPriority(p: number, kind: number): number {
    const next = (this.jobPriority[p * JOB_KINDS + kind] + 1) % (JOB_PRIORITY_LOWEST + 1);
    this.jobPriority[p * JOB_KINDS + kind] = next;
    return next;
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

    // --- Needs: suit air, suit integrity, health ---
    const nw = world.width;
    const ni = Math.floor(pos[p * 2 + 1]) * nw + Math.floor(pos[p * 2]);
    const open = gas.cells[ni] === OPEN;
    const press = open ? gas.current[ni] : 0;
    const toxBar = open ? gas.toxin[ni] : 0;
    const breathable = press >= BREATHABLE_BAR && toxBar < BREATHABLE_TOXIN_BAR;
    const o2Rate = breathable ? O2_REFILL : this.suit[p] < SUIT_BREACH ? -O2_DRAIN_BREACHED : -O2_DRAIN;
    const o2Raw = this.oxygen[p] + o2Rate * dt;
    const o2 = o2Raw > SUIT_O2 ? SUIT_O2 : o2Raw < 0 ? 0 : o2Raw;
    this.oxygen[p] = o2;
    const suitRaw = this.suit[p] - toxBar * TOXIC_SUIT_DAMAGE * dt;
    this.suit[p] = suitRaw < 0 ? 0 : suitRaw;
    const hpRaw = this.health[p] + (o2 <= 0 ? -SUFFOCATION_DAMAGE : HEAL_RATE) * dt;
    const hp = hpRaw > MAX_HEALTH ? MAX_HEALTH : hpRaw;
    this.health[p] = hp;
    this.cellOf[p] = ni;
    if (hp <= DEATH_HEALTH) {
      this.die(p);
      return;
    }
    if (hp <= 0 && this.state[p] !== DOWN) this.knockOut(p);

    // --- Being carried by a rescuer: held at their side ---
    const carrier = this.carriedBy[p];
    if (carrier >= 0) {
      if (this.alive[carrier] === 1 && this.state[carrier] === RESCUE_CARRY) {
        pos[p * 2] = pos[carrier * 2];
        pos[p * 2 + 1] = pos[carrier * 2 + 1];
        vel[p * 2] = vel[carrier * 2];
        vel[p * 2 + 1] = vel[carrier * 2 + 1];
        this.magBoot[p] = 0;
        this.needy[p] = 0;
        this.strandedTicks[p] = 0;
        return;
      }
      this.carriedBy[p] = -1;
    }

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
        if (this.rideRole[p] === ROLE_TUG) {
          // Suit thrusters: a force-limited spring toward the next waypoint, damped on the load's speed.
          const leg = this.routeLeg[p];
          const dx = this.route[p * 6 + leg * 2] - s[o + B_X];
          const dy = this.route[p * 6 + leg * 2 + 1] - s[o + B_Y];
          const d = Math.sqrt(dx * dx + dy * dy);
          const m = s[o + B_MASS];
          const fx = m * (TUG_STIFFNESS * dx - TUG_DAMPING * s[o + B_VX]);
          const fy = m * (TUG_STIFFNESS * dy - TUG_DAMPING * s[o + B_VY]);
          const f = Math.sqrt(fx * fx + fy * fy);
          const k = f > TUG_FORCE ? TUG_FORCE / f : 1;
          debris.force[ride * 3] += fx * k;
          debris.force[ride * 3 + 1] += fy * k;
          this.heading[p * 2] = d > 1e-4 ? dx / d : this.heading[p * 2];
          this.heading[p * 2 + 1] = d > 1e-4 ? dy / d : this.heading[p * 2 + 1];
          const next = d < HAUL_WAYPOINT_RADIUS && leg < 2;
          this.routeLeg[p] = next ? leg + 1 : leg;
          // Stuck: no half-tile gain on the waypoint for STUCK_LIMIT checks in a row.
          const gained = d < this.stuckBest[p] - 0.5;
          this.stuckBest[p] = next ? 1e9 : gained ? d : this.stuckBest[p];
          const due = !gained && !next && this.stuckTicks[p] + 1 >= STUCK_CHECK_TICKS;
          this.stuckTicks[p] = gained || next || due ? 0 : this.stuckTicks[p] + 1;
          this.stuckCount[p] = gained || next ? 0 : due ? this.stuckCount[p] + 1 : this.stuckCount[p];
          if (this.stuckCount[p] >= STUCK_LIMIT) this.abandonHaul(p);
        }
        return;
      }
      // The wreck went into a bin: float free at the speed it was carrying us.
      this.ride[p] = -1;
      if (this.rideRole[p] === ROLE_TUG) this.endTow(p);
    }

    // --- Physics: decompression drag against magboots, suit thrusters, clamping ---
    const heading = this.heading;
    const w = world.width;
    let tx = Math.floor(pos[p * 2]);
    let ty = Math.floor(pos[p * 2 + 1]);
    const onFloor = gas.cells[ty * w + tx] === OPEN;
    // A rescuer launching off the deck lets go of it on purpose.
    const booted = onFloor && this.state[p] !== RESCUE_FLY;
    const imp = gas.getVentImpulse(tx, ty, this.impulse);
    const impMag = Math.sqrt(imp.x * imp.x + imp.y * imp.y);
    const f = impMag * DRAG_GAIN;
    // Booted pawns only feel the drag their grip cannot absorb, and friction bleeds off speed.
    const slip = booted ? (f > MAGBOOT_GRIP ? 1 - MAGBOOT_GRIP / f : 0) : 1;
    const friction = 1 - BOOT_FRICTION * dt;
    const damp = booted ? (friction > 0 ? friction : 0) : 1;
    // Off the deck with somewhere to go (a deck in reach, home, a pawn to fetch): thrusters
    // steer toward the speed wanted there, which falls off on the way in so the pawn arrives
    // rather than slams in. A downed pawn has no one at the controls.
    const anchor = booted || this.state[p] === DOWN ? -1 : this.anchor[p];
    const adx = anchor >= 0 ? (anchor % w) + 0.5 - pos[p * 2] : 0;
    const ady = anchor >= 0 ? ((anchor / w) | 0) + 0.5 - pos[p * 2 + 1] : 0;
    const ad = Math.sqrt(adx * adx + ady * ady);
    const want = ad * ARRIVE_GAIN < MAX_FLY_SPEED ? ad * ARRIVE_GAIN : MAX_FLY_SPEED;
    const wk = ad > 1e-4 ? want / ad : 0;
    const dvx = adx * wk - vel[p * 2];
    const dvy = ady * wk - vel[p * 2 + 1];
    const dvm = Math.sqrt(dvx * dvx + dvy * dvy);
    const steer = anchor < 0 || dvm < 1e-4 ? 0 : dvm * STEER_GAIN < THRUSTER_ACCEL ? STEER_GAIN : THRUSTER_ACCEL / dvm;
    const thrust = anchor >= 0 && ad > 1e-4 ? 1 : 0;
    const ax = imp.x * DRAG_GAIN * slip + dvx * steer;
    const ay = imp.y * DRAG_GAIN * slip + dvy * steer;
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
    this.magBoot[p] = booted ? 1 : 0;
    sc[S_MOVE_X] = vx * dt;
    sc[S_MOVE_Y] = vy * dt;
    this.move(p);
    // Impact: `move` stops a pawn dead at a wall. Hitting one fast hurts, and dents the suit.
    const hitX = vx !== 0 && vel[p * 2] === 0 ? (vx < 0 ? -vx : vx) : 0;
    const hitY = vy !== 0 && vel[p * 2 + 1] === 0 ? (vy < 0 ? -vy : vy) : 0;
    const hit = hitX > hitY ? hitX : hitY;
    const blow = hit > IMPACT_SPEED ? (hit - IMPACT_SPEED) * IMPACT_DAMAGE : 0;
    this.health[p] -= blow;
    this.suit[p] = this.suit[p] - blow * 0.5 > 0 ? this.suit[p] - blow * 0.5 : 0;

    tx = Math.floor(pos[p * 2]);
    ty = Math.floor(pos[p * 2 + 1]);

    // --- Live warnings ---
    const live =
      (impMag > FLEE_IMPULSE ? W_VENT : 0) |
      (gas.toxin[ty * w + tx] > TOXIC_WARN_BAR ? W_TOXIC : 0) |
      (onFloor ? 0 : W_ADRIFT) |
      (this.stressNear(tx, ty) ? W_STRESS : 0);
    this.warnings[p] = (this.warnings[p] & W_PRESSURE) | live;

    // Stranded: adrift with nothing to thrust for. Needy: down or stranded, and loose.
    const st = this.state[p];
    const adrift = !onFloor && this.anchor[p] < 0 && st !== RESCUE_FLY && st !== RESCUE_CARRY && st !== RETURNING;
    const sTicks = adrift ? this.strandedTicks[p] + 1 : 0;
    this.strandedTicks[p] = sTicks > 0xffff ? 0xffff : sTicks;
    const wait = this.rescueWait[p];
    this.rescueWait[p] = wait > 0 ? wait - 1 : 0;
    this.needy[p] = sTicks >= STRANDED_TICKS || (st === DOWN && !breathable && wait === 0) ? 1 : 0;
    this.cellOf[p] = ty * w + tx;
    if (st === DOWN) {
      if (this.health[p] >= WAKE_HEALTH) this.wake(p);
      return;
    }

    const vt = impMag > FLEE_IMPULSE ? this.ventTicks[p] + 1 : 0;
    this.ventTicks[p] = vt > 255 ? 255 : vt;
    const flying = st === RETURNING || st === RESCUE_FLY || st === RESCUE_CARRY;
    if (st !== FLEEING && !flying && (vt >= FLEE_CONFIRM_TICKS || !onFloor)) {
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
      case APPROACHING:
        this.tickApproaching(p);
        break;
      case RETURNING:
        this.tickReturning(p, tx, ty);
        break;
      case RESCUE_GO:
        this.tickRescueGo(p, tx, ty);
        break;
      case RESCUE_FLY:
        this.tickRescueFly(p);
        break;
      case RESCUE_CARRY:
        this.tickRescueCarry(p, tx, ty);
        break;
    }

    // --- Motion and work for the state just decided ---
    const state = this.state[p];
    const walking =
      state === NAVIGATING || state === FLEEING || state === APPROACHING || state === RESCUE_GO || (state === RESCUE_CARRY && onFloor);
    if (walking && this.clamp[p] === 0) {
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

  /** Tries each job kind in priority order (1 first; rescue before the rest) and takes the first that has work. */
  private tickIdle(p: number, tx: number, ty: number): void {
    const base = p * JOB_KINDS;
    for (let level = 1; level <= JOB_PRIORITY_LOWEST; level++) {
      if (this.jobPriority[base + JOB_RESCUE] === level && this.tryRescue(p, tx, ty)) return;
      if (this.jobPriority[base + JOB_CUT] === level && this.tryCut(p, tx, ty)) return;
      if (this.jobPriority[base + JOB_HAUL] === level && this.tryHaul(p, tx, ty)) return;
    }
  }

  // --- Survival -------------------------------------------------------------------------

  /** Health ran out: drop everything and go down where you are. */
  private knockOut(p: number): void {
    this.hazards.log(H_KNOCKED_OUT, p, this.cellOf[p] % this.world.width, (this.cellOf[p] / this.world.width) | 0, this.world.tickCount, 0);
    this.dropOrder(p, 0);
    this.releaseHaul(p);
    this.endRescue(p);
    // A tug that blacks out stays aboard as a passenger.
    this.rideRole[p] = ROLE_PASSENGER;
    this.state[p] = DOWN;
    this.clamp[p] = 0;
    this.anchor[p] = -1;
    this.pathLen[p] = 0;
  }

  private wake(p: number): void {
    this.state[p] = IDLE;
    this.pathLen[p] = 0;
    this.needy[p] = 0;
  }

  private die(p: number): void {
    const w = this.world.width;
    this.hazards.log(H_DIED, p, this.cellOf[p] % w, (this.cellOf[p] / w) | 0, this.world.tickCount, 0);
    this.despawn(p);
  }

  /** Lets go of any rescue this pawn is doing: the victim stays where it is, unclaimed. */
  private endRescue(p: number): void {
    const v = this.rescueTarget[p];
    if (v >= 0) {
      if (this.rescuer[v] === p) this.rescuer[v] = -1;
      if (this.carriedBy[v] === p) this.carriedBy[v] = -1;
    }
    this.rescueTarget[p] = -1;
  }

  /** The rescue is off (victim gone, dead, or taken): stand down, flying home if out in space. */
  private abortRescue(p: number, tx: number, ty: number): void {
    this.endRescue(p);
    this.pathLen[p] = 0;
    const onDeck = this.world.gas.cells[ty * this.world.width + tx] === OPEN;
    this.state[p] = onDeck ? IDLE : RETURNING;
    this.returnLeg[p] = 1;
  }

  /** True while victim `v` is still this pawn's to rescue. */
  private holdsRescue(p: number, v: number): boolean {
    return v >= 0 && this.alive[v] === 1 && this.rescuer[v] === p;
  }

  /**
   * Looks for the nearest pawn that is down or stranded and that nobody is fetching. A victim
   * on the deck is walked to; one out in space is flown to from the deck tile nearest them.
   * Integer-only: it reads `needy` and `cellOf`, which the hot tick keeps current.
   */
  private tryRescue(p: number, tx: number, ty: number): boolean {
    const w = this.world.width;
    let best = -1;
    let bestD = 0x7fffffff;
    for (let v = 0; v < MAX_PAWNS; v++) {
      if (v === p || this.alive[v] === 0 || this.needy[v] === 0 || this.rescuer[v] >= 0 || this.carriedBy[v] >= 0) continue;
      const c = this.cellOf[v];
      const vx = c % w;
      const vy = (c / w) | 0;
      const d = (vx > tx ? vx - tx : tx - vx) + (vy > ty ? vy - ty : ty - vy);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best < 0) return false;
    const c = this.cellOf[best];
    const onDeck = this.world.gas.cells[c] === OPEN && this.paths.cost[c] !== COST_IMPASSABLE;
    const goal = onDeck ? c : this.launchTile(c);
    if (goal < 0 || !this.planPath(p, tx, ty, goal % w, (goal / w) | 0, false)) return false;
    this.rescuer[best] = p;
    this.rescueTarget[p] = best;
    this.rescueFly[p] = onDeck ? 0 : 1;
    this.target[p * 2] = goal % w;
    this.target[p * 2 + 1] = (goal / w) | 0;
    this.state[p] = RESCUE_GO;
    this.timer[p] = REPATH_TICKS;
    return true;
  }

  /** Walking to the victim, or to the deck tile to fly out from. */
  private tickRescueGo(p: number, tx: number, ty: number): void {
    const v = this.rescueTarget[p];
    if (!this.holdsRescue(p, v) || this.carriedBy[v] >= 0) {
      this.abortRescue(p, tx, ty);
      return;
    }
    const w = this.world.width;
    const c = this.cellOf[v];
    const vx = c % w;
    const vy = (c / w) | 0;
    if (this.reachable(tx, ty, vx, vy)) {
      this.grab(p, v);
      return;
    }
    if (this.pathStep[p] < this.pathLen[p]) return;
    if (this.rescueFly[p] === 1) {
      // At the deck edge: launch.
      this.home[p] = ty * w + tx;
      this.anchor[p] = c;
      this.clamp[p] = 0;
      this.state[p] = RESCUE_FLY;
      return;
    }
    // The victim moved: go again.
    if (!this.planPath(p, tx, ty, vx, vy, false)) this.abortRescue(p, tx, ty);
  }

  /** Flying out to the victim; thrusters aim at them every tick. */
  private tickRescueFly(p: number): void {
    const v = this.rescueTarget[p];
    const w = this.world.width;
    const here = this.cellOf[p];
    if (!this.holdsRescue(p, v) || this.carriedBy[v] >= 0) {
      this.abortRescue(p, here % w, (here / w) | 0);
      return;
    }
    const c = this.cellOf[v];
    this.anchor[p] = c;
    if (this.reachable(here % w, (here / w) | 0, c % w, (c / w) | 0)) this.grab(p, v);
  }

  /** Within arm's reach: the same tile or a neighbour. */
  private reachable(x: number, y: number, vx: number, vy: number): boolean {
    return (x > vx ? x - vx : vx - x) <= 1 && (y > vy ? y - vy : vy - y) <= 1;
  }

  private grab(p: number, v: number): void {
    this.carriedBy[v] = p;
    this.needy[v] = 0;
    this.state[p] = RESCUE_CARRY;
    this.carryPlanned[p] = 0;
    this.pathLen[p] = 0;
    this.pathStep[p] = 0;
    this.anchor[p] = this.home[p];
  }

  /**
   * Carrying: out in space, thrusters take both home to the deck edge; aboard, walk to the
   * nearest breathable deck (or stay put if there is none in reach) and set the victim down.
   */
  private tickRescueCarry(p: number, tx: number, ty: number): void {
    const v = this.rescueTarget[p];
    if (!this.holdsRescue(p, v)) {
      this.abortRescue(p, tx, ty);
      return;
    }
    const w = this.world.width;
    if (this.world.gas.cells[ty * w + tx] !== OPEN) {
      this.anchor[p] = this.home[p] >= 0 ? this.home[p] : this.nearestFloor(tx, ty, ANCHOR_SEARCH_RADIUS);
      return;
    }
    this.anchor[p] = -1;
    if (this.carryPlanned[p] === 0) {
      this.carryPlanned[p] = 1;
      const safe = this.safeTile(tx, ty);
      if (safe >= 0 && safe !== ty * w + tx && this.planPath(p, tx, ty, safe % w, (safe / w) | 0, false)) return;
      this.pathLen[p] = 0;
    }
    if (this.pathStep[p] >= this.pathLen[p]) this.setDown(p, v);
  }

  /** Puts the victim down beside the rescuer and ends the rescue. */
  private setDown(p: number, v: number): void {
    const w = this.world.width;
    this.carriedBy[v] = -1;
    this.rescuer[v] = -1;
    this.strandedTicks[v] = 0;
    this.needy[v] = 0;
    this.rescueWait[v] = this.paths.breathable[this.cellOf[p]] === 1 ? 0 : RESCUE_RETRY_TICKS;
    this.pos[v * 2] = this.pos[p * 2];
    this.pos[v * 2 + 1] = this.pos[p * 2 + 1];
    this.vel[v * 2] = 0;
    this.vel[v * 2 + 1] = 0;
    this.anchor[v] = -1;
    if (this.state[v] !== DOWN) this.state[v] = IDLE;
    this.rescueTarget[p] = -1;
    this.state[p] = IDLE;
    this.pathLen[p] = 0;
    this.hazards.log(H_RESCUED, v, this.cellOf[p] % w, (this.cellOf[p] / w) | 0, this.world.tickCount, 0);
  }

  /**
   * Nearest breathable deck tile walkable from (x, y), by breadth-first search over passable
   * tiles (at most `SAFE_SEARCH_TILES`), or the start tile if none is found.
   */
  private safeTile(x: number, y: number): number {
    const w = this.world.width;
    const h = this.world.height;
    const cost = this.paths.cost;
    const air = this.paths.breathable;
    const queue = this.bfsQueue;
    const seen = this.bfsSeen;
    const stamp = ++this.bfsStamp;
    const start = y * w + x;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = stamp;
    while (head < tail) {
      const i = queue[head++];
      if (air[i] === 1) return i;
      const cx = i % w;
      const cy = (i / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = d === 0 ? cx - 1 : d === 1 ? cx + 1 : cx;
        const ny = d === 2 ? cy - 1 : d === 3 ? cy + 1 : cy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] === stamp || cost[j] === COST_IMPASSABLE || tail >= queue.length) continue;
        seen[j] = stamp;
        queue[tail++] = j;
      }
    }
    return start;
  }

  /** The walkable deck tile nearest cell `c` (out in space), searching rings out to `LAUNCH_SEARCH_RADIUS`, or -1. */
  private launchTile(c: number): number {
    const w = this.world.width;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let r = 1; r <= LAUNCH_SEARCH_RADIUS; r++) {
      let best = -1;
      let bestD = 0x7fffffff;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx !== -r && dx !== r && dy !== -r && dy !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (this.paths.getCost(x, y) === COST_IMPASSABLE) continue;
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

  /** True when an order's tile still has work left: a wall to open, or anything left to sever. */
  private orderLive(slot: number, idx: number): boolean {
    const flags = this.world.tiles[idx];
    return this.orders.kind[slot] === SEVER ? (flags & PRESENT) !== 0 : isSolid(flags);
  }

  /** Claims the best work order and heads for it. Returns false when there is none. */
  private tryCut(p: number, tx: number, ty: number): boolean {
    const orders = this.orders;
    const slot = orders.claimNextOrder(tx, ty, p, this.toolMask[p]);
    if (slot < 0) return false;
    const w = this.world.width;
    const idx = orders.cell[slot];
    const ox = idx % w;
    const oy = (idx / w) | 0;
    if (!this.orderLive(slot, idx)) {
      // Already cut by hand; nothing left to do.
      orders.complete(slot);
      return true;
    }
    this.orderSlot[p] = slot;
    this.target[p * 2] = ox;
    this.target[p * 2 + 1] = oy;
    this.progress[p] = orders.progress[slot];
    this.warnings[p] &= ~W_PRESSURE;
    if (!this.planPath(p, tx, ty, ox, oy, true, this.orders.kind[this.orderSlot[p]] === SEVER)) {
      this.hazards.log(H_UNREACHABLE, p, ox, oy, this.world.tickCount, 0);
      this.dropOrder(p, UNREACHABLE_SUSPEND_TICKS);
      return true;
    }
    this.state[p] = NAVIGATING;
    this.timer[p] = REPATH_TICKS;
    return true;
  }

  /**
   * Looks for a loose chunk to tow: free (no other hauler, not on the player's grapple, not
   * blocked after a stuck tow), light enough, with a bin to go to, and with a walkable deck
   * tile next to one of its tiles. Takes the one whose standing tile is nearest and heads
   * there. Integer-only, and heavy chunks are skipped before their tiles are scanned, so it
   * is cheap enough to run every tick an idle pawn has hauling as its next job.
   */
  private tryHaul(p: number, tx: number, ty: number): boolean {
    const world = this.world;
    const debris = world.debris;
    if (debris.count === 0) return false;
    const w = world.width;
    const h = world.height;
    const cells = world.gas.cells;
    const tick = world.tickCount;
    let bestBody = -1;
    let bestStand = -1;
    let bestD = 0x7fffffff;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (debris.alive[b] === 0 || this.bodyHauler[b] >= 0 || debris.grabBody === b) continue;
      if (debris.bestZone[b] < 0 || debris.haulBlockedUntil[b] > tick || debris.massTenths[b] > HAUL_MAX_MASS * 10) continue;
      const end = debris.tileStart[b] + debris.tileCount[b];
      for (let t = debris.tileStart[b]; t < end; t++) {
        const cell = debris.tileCell[t];
        if (cell < 0) continue;
        const cx = cell % w;
        const cy = (cell / w) | 0;
        // Two tiles out: severing leaves a one-tile gap of vacuum around the chunk.
        for (let dy = -STAND_REACH; dy <= STAND_REACH; dy++) {
          for (let dx = -STAND_REACH; dx <= STAND_REACH; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (dx * dx + dy * dy > STAND_REACH_SQ) continue;
            if (x < 0 || y < 0 || x >= w || y >= h || cells[y * w + x] !== OPEN) continue;
            if (this.paths.getCost(x, y) === COST_IMPASSABLE) continue;
            const d = (x > tx ? x - tx : tx - x) + (y > ty ? y - ty : ty - y);
            if (d < bestD) {
              bestD = d;
              bestBody = b;
              bestStand = y * w + x;
            }
          }
        }
      }
    }
    if (bestBody < 0) return false;
    const sx = bestStand % w;
    const sy = (bestStand / w) | 0;
    if (!this.planPath(p, tx, ty, sx, sy, false)) {
      debris.haulBlockedUntil[bestBody] = tick + UNREACHABLE_SUSPEND_TICKS;
      return false;
    }
    this.bodyHauler[bestBody] = p;
    this.haulBody[p] = bestBody;
    this.haulGen[p] = debris.generation[bestBody];
    this.target[p * 2] = sx;
    this.target[p * 2 + 1] = sy;
    this.state[p] = APPROACHING;
    return true;
  }

  /** Walking to the chunk: give up if it is gone; climb aboard on arrival. */
  private tickApproaching(p: number): void {
    const b = this.haulBody[p];
    const debris = this.world.debris;
    if (b < 0 || debris.alive[b] === 0 || debris.generation[b] !== this.haulGen[p]) {
      this.releaseHaul(p);
      this.state[p] = IDLE;
      this.pathLen[p] = 0;
      return;
    }
    if (this.pathStep[p] >= this.pathLen[p]) this.board(p);
  }

  /**
   * Climbs aboard the hauled chunk at its tile nearest the pawn and sets the tow route: out
   * to the haul lane, along it to the bin's row, into the bin. Gives up if the chunk has
   * drifted out of reach. Runs once per tow.
   */
  private board(p: number): void {
    const world = this.world;
    const debris = world.debris;
    const b = this.haulBody[p];
    const s = debris.body;
    const o = b * BODY_STRIDE;
    const px = this.pos[p * 2];
    const py = this.pos[p * 2 + 1];
    let best = -1;
    let bestD2 = BOARD_RANGE * BOARD_RANGE;
    const end = debris.tileStart[b] + debris.tileCount[b];
    for (let t = debris.tileStart[b]; t < end; t++) {
      const lx = debris.tileLocal[t * 2];
      const ly = debris.tileLocal[t * 2 + 1];
      const dx = s[o + B_X] + s[o + B_COS] * lx - s[o + B_SIN] * ly - px;
      const dy = s[o + B_Y] + s[o + B_SIN] * lx + s[o + B_COS] * ly - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = t;
      }
    }
    if (best < 0) {
      this.releaseHaul(p);
      debris.haulBlockedUntil[b] = world.tickCount + UNREACHABLE_SUSPEND_TICKS;
      this.state[p] = IDLE;
      return;
    }
    this.home[p] = Math.floor(py) * world.width + Math.floor(px);
    this.returnLeg[p] = 0;
    this.ride[p] = b;
    this.rideGen[p] = debris.generation[b];
    this.rideRole[p] = ROLE_TUG;
    this.rideLocal[p * 2] = debris.tileLocal[best * 2];
    this.rideLocal[p * 2 + 1] = debris.tileLocal[best * 2 + 1];
    const zone = debris.bestZone[b];
    const rect = world.salvage.zoneRect;
    const zx = (rect[zone * 4] + rect[zone * 4 + 2]) * 0.5;
    const zy = (rect[zone * 4 + 1] + rect[zone * 4 + 3]) * 0.5;
    const by = s[o + B_Y];
    const r = p * 6;
    this.route[r] = HAUL_LANE_X;
    this.route[r + 1] = by;
    this.route[r + 2] = HAUL_LANE_X;
    this.route[r + 3] = zy > by ? zy - 2 : zy + 2;
    this.route[r + 4] = zx;
    this.route[r + 5] = zy;
    this.routeLeg[p] = 0;
    this.stuckBest[p] = 1e9;
    this.stuckTicks[p] = 0;
    this.stuckCount[p] = 0;
    this.pathLen[p] = 0;
    this.state[p] = TUGGING;
  }

  /** The towed chunk is gone (delivered, or taken away): let go and head home. */
  private endTow(p: number): void {
    this.releaseHaul(p);
    this.rideRole[p] = ROLE_PASSENGER;
    this.state[p] = RETURNING;
    this.returnLeg[p] = 0;
    this.clamp[p] = 0;
  }

  /** The tow is stuck: let go, leave the chunk alone for a while, and head home. */
  private abandonHaul(p: number): void {
    const b = this.ride[p];
    const world = this.world;
    if (b >= 0) world.debris.haulBlockedUntil[b] = world.tickCount + HAUL_BLOCK_TICKS;
    this.hazards.log(H_HAUL_ABANDONED, p, Math.floor(this.pos[p * 2]), Math.floor(this.pos[p * 2 + 1]), world.tickCount, 0);
    this.ride[p] = -1;
    this.endTow(p);
  }

  /** Drops any claim on a chunk. */
  private releaseHaul(p: number): void {
    const b = this.haulBody[p];
    if (b >= 0 && this.bodyHauler[b] === p) this.bodyHauler[b] = -1;
    this.haulBody[p] = -1;
  }

  /**
   * Flying home after a tow: thrusters aim at the haul lane level with the home tile, then at
   * the home tile itself, so the pawn comes back in through open space rather than across
   * the hull. Lands (back to IDLE) on the first deck tile it reaches.
   */
  private tickReturning(p: number, tx: number, ty: number): void {
    const w = this.world.width;
    if (this.world.gas.cells[ty * w + tx] === OPEN) {
      this.state[p] = IDLE;
      this.anchor[p] = -1;
      this.home[p] = -1;
      return;
    }
    const home = this.home[p];
    if (home < 0) {
      this.anchor[p] = this.nearestFloor(tx, ty, ANCHOR_SEARCH_RADIUS);
      return;
    }
    const hy = (home / w) | 0;
    const dx = tx > HAUL_LANE_X ? tx - HAUL_LANE_X : HAUL_LANE_X - tx;
    const dy = ty > hy ? ty - hy : hy - ty;
    if (this.returnLeg[p] === 0 && dx <= 1 && dy <= 1) {
      // At the lane: aim for a deck tile near home that can be flown to in a straight line,
      // since the tile left from may sit behind the hull's frame.
      this.returnLeg[p] = 1;
      this.home[p] = this.landingTile(ty * w + tx, home);
    }
    this.anchor[p] = this.returnLeg[p] === 0 ? hy * w + HAUL_LANE_X : this.home[p];
  }

  /** Radius around home searched for a deck tile in clear line of sight. */
  private static readonly LANDING_RADIUS = 6;

  /**
   * The walkable deck tile nearest `home` (within `LANDING_RADIUS`) with a clear straight
   * line from `from`: no wall on any cell the line crosses. Falls back to `home`. Integer-only.
   */
  private landingTile(from: number, home: number): number {
    const w = this.world.width;
    const hx = home % w;
    const hy = (home / w) | 0;
    const r = PawnManager.LANDING_RADIUS;
    let best = home;
    let bestD = 0x7fffffff;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dy * dy;
        if (d >= bestD) continue;
        const x = hx + dx;
        const y = hy + dy;
        if (this.paths.getCost(x, y) === COST_IMPASSABLE) continue;
        if (!this.clearLine(from % w, (from / w) | 0, x, y)) continue;
        bestD = d;
        best = y * w + x;
      }
    }
    return best;
  }

  /** Bresenham walk from (x0, y0) to (x1, y1): true when no cell on it is a wall. */
  private clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    const cells = this.world.gas.cells;
    const w = this.world.width;
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    const dx = x1 > x0 ? x1 - x0 : x0 - x1;
    const dy = y1 > y0 ? y0 - y1 : y1 - y0;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      if (cells[y * w + x] === WALL) return false;
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
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
    if (!this.planPath(p, tx, ty, ox, oy, true, this.orders.kind[this.orderSlot[p]] === SEVER)) {
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
    if (!this.inReach(p, tx, ty, ox, oy)) {
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
    if (!this.inReach(p, tx, ty, ox, oy)) {
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
    const slot = this.orderSlot[p];
    if (this.orders.kind[slot] === SEVER && (this.world.tiles[oy * this.world.width + ox] & PRESENT) !== 0) {
      // Severing: the wall is deck now; scan again and keep cutting until it is gone.
      this.progress[p] = 0;
      this.orders.progress[slot] = 0;
      this.state[p] = PRE_CUT;
      this.timer[p] = PRE_CUT_TICKS;
      return;
    }
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
    this.releaseHaul(p);
    this.endRescue(p);
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

  private planPath(p: number, sx: number, sy: number, gx: number, gy: number, adjacent: boolean, diagonal = false): boolean {
    const len = this.paths.findPath(sx, sy, gx, gy, adjacent, this.path, p * MAX_PATH, MAX_PATH, diagonal);
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
    if (!this.orderLive(slot, idx)) {
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

  /**
   * Whether a pawn on (x, y) can work the tile (ox, oy): 4-adjacent for walls, and across a
   * corner too when severing, since severed tiles can end up with no 4-neighbour left to
   * stand on.
   */
  private inReach(p: number, x: number, y: number, ox: number, oy: number): boolean {
    const dx = x > ox ? x - ox : ox - x;
    const dy = y > oy ? y - oy : oy - y;
    if (this.orders.kind[this.orderSlot[p]] === SEVER) return dx <= 1 && dy <= 1 && dx + dy > 0;
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
