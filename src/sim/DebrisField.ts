import { CELL_COUNT, HEIGHT, TICK_DT, WIDTH } from './constants';
import { GasCell, type Vec2 } from './GasGrid';
import { MATERIAL_BIN, MATERIAL_MASS, MATERIAL_VALUE } from './materials';
import { MISSORT_FACTOR } from './materialSchema';
import type { Salvage } from './Salvage';
import { TileFlags } from './TileFlags';
import type { World } from './World';

export const MAX_BODIES = 64;
/** Tiles held by all bodies together. A component bigger than what is left stays in the grid. */
export const MAX_DEBRIS_TILES = 8192;
/** Linear speed cap, tiles/s: under half a tile per tick, so tile-centre contacts cannot tunnel. */
export const MAX_DEBRIS_SPEED = 8;
/** Cap on the speed of a body's outermost tile from spin alone, tiles/s. */
export const MAX_TIP_SPEED = 8;
export const RESTITUTION = 0.2;
export const FRICTION = 0.4;
/** Share of a contact's penetration removed per tick. */
export const POSITION_CORRECTION = 0.8;
/** Momentum per bar/tile of vent impulse on each lifted tile: escaping gas shoves a chunk as it tears off. */
export const VENT_KICK = 0.5;
/** Grapple spring, per unit mass: stiffness (1/s^2) and damping on the grab point's velocity (1/s). */
export const GRAPPLE_STIFFNESS = 4;
export const GRAPPLE_DAMPING = 4;
/** The grapple's force limit, mass * tiles/s^2. Heavy chunks accelerate slowly. */
export const GRAPPLE_MAX_FORCE = 150;

/** Slots per body in `DebrisField.body`. */
export const B_X = 0;
export const B_Y = 1;
export const B_ANGLE = 2;
export const B_VX = 3;
export const B_VY = 4;
export const B_SPIN = 5;
export const B_INV_MASS = 6;
export const B_INV_INERTIA = 7;
export const B_COS = 8;
export const B_SIN = 9;
export const B_MASS = 10;
/** Distance from the centre of mass to the farthest tile corner. */
export const B_RADIUS = 11;
export const BODY_STRIDE = 12;

const PRESENT = TileFlags.FLOOR | TileFlags.BULKHEAD | TileFlags.GIRDER;
const OPEN = GasCell.OPEN;
const W = WIDTH;
const H = HEIGHT;
/** Extra push past the cell boundary, so a corrected tile centre leaves the cell. */
const SLOP = 0.01;
/** Square tile of unit mass about its own centre: (1^2 + 1^2) / 12. */
const TILE_SELF_INERTIA = 1 / 6;

// Contact scratch slots (see `scratch`).
const C_PX = 0;
const C_PY = 1;
const C_NX = 2;
const C_NY = 3;
const C_PEN = 4;
const C_CORR_X = 5;
const C_CORR_Y = 6;
const C_CORR_N = 7;
const SCRATCH_SIZE = 8;

/**
 * Where each tile is sampled for contacts, in tile units from its centre: the centre, then
 * four points just inside its corners. Corner samples stop a tile at a wall's face rather
 * than with its centre half a tile in.
 */
const SAMPLE_X = [0, -0.45, 0.45, -0.45, 0.45];
const SAMPLE_Y = [0, -0.45, -0.45, 0.45, 0.45];
const SAMPLES = 5;

// Body-building sums (see `acc`).
const A_MASS = 0;
const A_MX = 1;
const A_MY = 2;
const A_INERTIA = 3;
const A_RADIUS = 4;
const A_GAS = 5;
const A_PX = 6;
const A_PY = 7;
const A_SPIN = 8;
const ACC_SIZE = 9;

/**
 * Free-floating wreckage. When the structure loses its last path to a dock anchor, every
 * connected group of tiles that holds no grounded node is lifted out of the grid and
 * becomes a rigid body here: tile offsets from its centre of mass, plus position, angle,
 * velocity and spin. Bodies drift, collide with the grid and with each other (sampled at
 * tile centres, impulse-based with friction), can be towed by the grapple, and are
 * consumed by a salvage zone once every tile is inside it.
 *
 * Everything lives in fixed pools: body state in one `Float64Array` (`BODY_STRIDE` slots
 * per body), tiles in contiguous per-body ranges of a shared pool that is compacted when
 * a body leaves.
 *
 * Connectivity: two neighbouring tiles hold together unless both are girders and the
 * member between them has snapped. So a girder frame breaks where its members break, and
 * floor or bulkhead tiles move with whatever they are welded to. Detaching only runs in a
 * world with at least one grounded node; a map with no anchors at all is a sandbox.
 */
export class DebrisField {
  readonly alive = new Uint8Array(MAX_BODIES);
  /** Bumped when a slot is reused, so a stale reference (a rider, the grapple) can tell. */
  readonly generation = new Uint16Array(MAX_BODIES);
  readonly tileStart = new Int32Array(MAX_BODIES);
  readonly tileCount = new Int32Array(MAX_BODIES);
  readonly body = new Float64Array(MAX_BODIES * BODY_STRIDE);
  /** Gas that left the grid inside each body, in bar-cells. */
  readonly bodyGas = new Float32Array(MAX_BODIES);
  /** Tile-centre bounding box per body from the last step: minX, minY, maxX, maxY. */
  readonly bounds = new Float32Array(MAX_BODIES * 4);
  /**
   * Outside forces for the next step, per body: fx, fy and torque (mass * tiles/s^2). Crew
   * suit thrusters push here; `step` applies and clears them.
   */
  readonly force = new Float64Array(MAX_BODIES * 3);
  /** Grid cell under each body's centre, from the last step, or -1 off the map. For integer-only callers. */
  readonly centreCell = new Int32Array(MAX_BODIES).fill(-1);
  /** Salvage zone that pays most for each body, chosen when it tears free, or -1. */
  readonly bestZone = new Int8Array(MAX_BODIES).fill(-1);
  /** World tick before which crews leave a body alone (after a haul got stuck). */
  readonly haulBlockedUntil = new Int32Array(MAX_BODIES);
  /** Body mass in tenths, as an integer for integer-only callers. */
  readonly massTenths = new Int32Array(MAX_BODIES);
  count = 0;

  /** Grid cell under each tile's centre, from the last step, or -1 off the map. */
  readonly tileCell = new Int32Array(MAX_DEBRIS_TILES).fill(-1);
  /** Tile offsets from the owning body's centre of mass (x, y interleaved), unrotated. */
  readonly tileLocal = new Float32Array(MAX_DEBRIS_TILES * 2);
  readonly tileFlags = new Uint8Array(MAX_DEBRIS_TILES);
  readonly tileMaterial = new Uint8Array(MAX_DEBRIS_TILES);
  tilesUsed = 0;

  /** Body each grid cell was lifted into during this tick, or -1. Read by the crew to board. */
  readonly liftedBy = new Int16Array(CELL_COUNT).fill(-1);
  readonly liftedList = new Int32Array(CELL_COUNT);
  liftedCount = 0;

  /** Gas carried off in bodies, ever. `totalMass + vacuumAbsorbed + gasCarried` is conserved. */
  gasCarried = 0;
  detachedTotal = 0;
  contactsLastStep = 0;
  contactsTotal = 0;

  /** Grappled body, or -1; the grab point in body-local coordinates and the target in world tiles. */
  grabBody = -1;
  private grabGen = 0;
  readonly grab = new Float64Array(4);

  private readonly occupant = new Int16Array(CELL_COUNT);
  private readonly stampList = new Int32Array(MAX_DEBRIS_TILES);
  private stampCount = 0;
  private readonly visit = new Int32Array(CELL_COUNT);
  private visitStamp = 0;
  private readonly queue = new Int32Array(CELL_COUNT);
  private readonly scratch = new Float64Array(SCRATCH_SIZE);
  private readonly acc = new Float64Array(ACC_SIZE);
  private readonly impulse: Vec2 = { x: 0, y: 0 };

  clear(): void {
    this.alive.fill(0);
    this.count = 0;
    this.tilesUsed = 0;
    this.gasCarried = 0;
    this.detachedTotal = 0;
    this.grabBody = -1;
    this.clearLifted();
    for (let k = 0; k < this.stampCount; k++) this.occupant[this.stampList[k]] = 0;
    this.stampCount = 0;
  }

  /** Forgets last tick's lifted cells. */
  clearLifted(): void {
    for (let k = 0; k < this.liftedCount; k++) this.liftedBy[this.liftedList[k]] = -1;
    this.liftedCount = 0;
  }

  /**
   * Finds every tile component without a grounded node and lifts it out of the grid as a
   * body. Returns the number of bodies created.
   */
  detachFloating(world: World): number {
    const L = world.lattice;
    if (L.groundedCount === 0) return 0;
    const tiles = world.tiles;
    const active = L.nodeActive;
    const grounded = L.nodeGrounded;
    const adj = L.edgeAdjacency;
    const ea = L.edgeA;
    const eb = L.edgeB;
    const snapped = L.edgeSnapped;
    const visit = this.visit;
    const queue = this.queue;
    const stamp = ++this.visitStamp;

    let created = 0;
    for (let start = 0; start < CELL_COUNT; start++) {
      if (visit[start] === stamp || (tiles[start] & PRESENT) === 0) continue;
      let head = 0;
      let tail = 0;
      let anchored = false;
      visit[start] = stamp;
      queue[tail++] = start;
      while (head < tail) {
        const i = queue[head++];
        if (active[i] === 1 && grounded[i] === 1) anchored = true;
        for (let d = 0; d < 4; d++) {
          const e = adj[i * 4 + d];
          if (e < 0) continue;
          const j = ea[e] === i ? eb[e] : ea[e];
          if (visit[j] === stamp || (tiles[j] & PRESENT) === 0) continue;
          if (active[i] === 1 && active[j] === 1 && snapped[e] === 1) continue;
          visit[j] = stamp;
          queue[tail++] = j;
        }
      }
      if (!anchored && this.createBody(world, tail)) created++;
    }
    return created;
  }

  /**
   * Turns the `n` cells in `queue` into a body and clears them from the grid.
   *
   * This runs once per tear, far too rarely for V8 to optimise it, and interpreted double
   * arithmetic allocates a heap number per operation. So this function only loops over
   * integers; the per-tile float work lives in `addTileMass` and `addTile`, which run once
   * per tile (thousands of times per tear) and so do get optimised, and they accumulate
   * into `acc` rather than into locals.
   */
  private createBody(world: World, n: number): boolean {
    if (this.count >= MAX_BODIES || this.tilesUsed + n > MAX_DEBRIS_TILES) return false;
    const b = this.alive.indexOf(0);
    const queue = this.queue;
    const start = this.tilesUsed;
    this.acc.fill(0);
    for (let k = 0; k < n; k++) this.addTileMass(world, queue[k]);
    for (let k = 0; k < n; k++) this.addTile(world, queue[k], start + k);
    this.tilesUsed += n;
    this.writeBody(b);
    this.tileStart[b] = start;
    this.tileCount[b] = n;
    this.force.fill(0, b * 3, b * 3 + 3);
    this.haulBlockedUntil[b] = 0;
    for (let k = 0; k < n; k++) this.tileCell[start + k] = queue[k];
    this.centreCell[b] = Math.floor(this.body[b * BODY_STRIDE + B_Y]) * W + Math.floor(this.body[b * BODY_STRIDE + B_X]);
    this.bestZone[b] = this.payingZone(b, world.salvage);
    this.massTenths[b] = Math.round(this.body[b * BODY_STRIDE + B_MASS] * 10);
    this.generation[b]++;
    this.alive[b] = 1;
    this.count++;
    this.detachedTotal++;

    for (let k = 0; k < n; k++) {
      const i = queue[k];
      this.liftedBy[i] = b;
      this.liftedList[this.liftedCount++] = i;
      world.setTile(i % W, (i / W) | 0, TileFlags.VOID);
    }
    return true;
  }

  /**
   * The salvage zone that would pay most for body `b` as it is (right-bin tiles in full,
   * the rest at the missort rate), or -1 with no zones. Runs once, when the body forms.
   */
  private payingZone(b: number, salvage: Salvage): number {
    let best = -1;
    let bestPay = -1;
    const end = this.tileStart[b] + this.tileCount[b];
    for (let z = 0; z < salvage.zoneCount; z++) {
      const bin = salvage.zoneBin[z];
      let pay = 0;
      for (let t = this.tileStart[b]; t < end; t++) {
        const m = this.tileMaterial[t];
        pay += MATERIAL_BIN[m] === bin ? MATERIAL_VALUE[m] : MATERIAL_VALUE[m] * MISSORT_FACTOR;
      }
      if (pay > bestPay) {
        bestPay = pay;
        best = z;
      }
    }
    return best;
  }

  /** First pass over a new body's cells: total mass and its first moments. */
  private addTileMass(world: World, i: number): void {
    const acc = this.acc;
    const m = tileMass(world.material[i]);
    acc[A_MASS] += m;
    acc[A_MX] += m * ((i % W) + 0.5);
    acc[A_MY] += m * (((i / W) | 0) + 0.5);
  }

  /** Second pass: copies cell `i` into pool slot `t` relative to the centre of mass, and sums inertia, gas and vent push. */
  private addTile(world: World, i: number, t: number): void {
    const acc = this.acc;
    const gas = world.gas;
    const x = i % W;
    const y = (i / W) | 0;
    const lx = x + 0.5 - acc[A_MX] / acc[A_MASS];
    const ly = y + 0.5 - acc[A_MY] / acc[A_MASS];
    this.tileLocal[t * 2] = lx;
    this.tileLocal[t * 2 + 1] = ly;
    this.tileFlags[t] = world.tiles[i];
    this.tileMaterial[t] = world.material[i];
    acc[A_INERTIA] += tileMass(world.material[i]) * (lx * lx + ly * ly + TILE_SELF_INERTIA);
    const r = Math.sqrt(lx * lx + ly * ly);
    if (r > acc[A_RADIUS]) acc[A_RADIUS] = r;
    if (gas.cells[i] !== OPEN) return;
    acc[A_GAS] += gas.current[i];
    const imp = gas.getVentImpulse(x, y, this.impulse);
    acc[A_PX] += imp.x * VENT_KICK;
    acc[A_PY] += imp.y * VENT_KICK;
    acc[A_SPIN] += (lx * imp.y - ly * imp.x) * VENT_KICK;
  }

  /** Writes body `b`'s state from the sums in `acc`. */
  private writeBody(b: number): void {
    const acc = this.acc;
    const o = b * BODY_STRIDE;
    const s = this.body;
    const mass = acc[A_MASS];
    s[o + B_X] = acc[A_MX] / mass;
    s[o + B_Y] = acc[A_MY] / mass;
    s[o + B_ANGLE] = 0;
    s[o + B_VX] = acc[A_PX] / mass;
    s[o + B_VY] = acc[A_PY] / mass;
    s[o + B_SPIN] = acc[A_SPIN] / acc[A_INERTIA];
    s[o + B_INV_MASS] = 1 / mass;
    s[o + B_INV_INERTIA] = 1 / acc[A_INERTIA];
    s[o + B_COS] = 1;
    s[o + B_SIN] = 0;
    s[o + B_MASS] = mass;
    s[o + B_RADIUS] = acc[A_RADIUS] + Math.SQRT1_2;
    this.bodyGas[b] = acc[A_GAS];
    this.gasCarried += acc[A_GAS];
  }

  /** One fixed tick: grapple, integrate, collide, deliver. Allocation-free. */
  step(world: World, salvage: Salvage): void {
    if (this.count === 0) return;
    const dt = TICK_DT;
    const s = this.body;
    const alive = this.alive;

    const g = this.grabBody;
    if (g >= 0 && (alive[g] === 0 || this.generation[g] !== this.grabGen)) this.grabBody = -1;
    if (this.grabBody >= 0) this.applyGrapple(dt);
    const force = this.force;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      s[o + B_VX] += force[b * 3] * s[o + B_INV_MASS] * dt;
      s[o + B_VY] += force[b * 3 + 1] * s[o + B_INV_MASS] * dt;
      s[o + B_SPIN] += force[b * 3 + 2] * s[o + B_INV_INERTIA] * dt;
      force[b * 3] = 0;
      force[b * 3 + 1] = 0;
      force[b * 3 + 2] = 0;
    }

    for (let b = 0; b < MAX_BODIES; b++) {
      if (alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      const vx = s[o + B_VX];
      const vy = s[o + B_VY];
      const speed = Math.sqrt(vx * vx + vy * vy);
      const k = speed > MAX_DEBRIS_SPEED ? MAX_DEBRIS_SPEED / speed : 1;
      s[o + B_VX] = vx * k;
      s[o + B_VY] = vy * k;
      const maxSpin = MAX_TIP_SPEED / s[o + B_RADIUS];
      const spin = s[o + B_SPIN];
      s[o + B_SPIN] = spin > maxSpin ? maxSpin : spin < -maxSpin ? -maxSpin : spin;
      s[o + B_X] += s[o + B_VX] * dt;
      s[o + B_Y] += s[o + B_VY] * dt;
      s[o + B_ANGLE] += s[o + B_SPIN] * dt;
      s[o + B_COS] = Math.cos(s[o + B_ANGLE]);
      s[o + B_SIN] = Math.sin(s[o + B_ANGLE]);
    }

    // Stamp which body sits in each cell, for body-body contacts.
    const occupant = this.occupant;
    const local = this.tileLocal;
    for (let k = 0; k < this.stampCount; k++) occupant[this.stampList[k]] = 0;
    this.stampCount = 0;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      const x = s[o + B_X];
      const y = s[o + B_Y];
      const c = s[o + B_COS];
      const sn = s[o + B_SIN];
      const end = this.tileStart[b] + this.tileCount[b];
      for (let t = this.tileStart[b]; t < end; t++) {
        const lx = local[t * 2];
        const ly = local[t * 2 + 1];
        const cx = Math.floor(x + c * lx - sn * ly);
        const cy = Math.floor(y + sn * lx + c * ly);
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const ci = cy * W + cx;
        if (occupant[ci] === 0) {
          occupant[ci] = b + 1;
          this.stampList[this.stampCount++] = ci;
        }
      }
    }

    // Contacts, sampled at each tile's centre and inset corners, against the grid, the map
    // edge and other bodies.
    const tiles = world.tiles;
    const sc = this.scratch;
    const bounds = this.bounds;
    let contacts = 0;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      sc[C_CORR_X] = 0;
      sc[C_CORR_Y] = 0;
      sc[C_CORR_N] = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const end = this.tileStart[b] + this.tileCount[b];
      for (let t = this.tileStart[b]; t < end; t++) {
        for (let k = 0; k < SAMPLES; k++) {
          const lx = local[t * 2] + SAMPLE_X[k];
          const ly = local[t * 2 + 1] + SAMPLE_Y[k];
          const c = s[o + B_COS];
          const sn = s[o + B_SIN];
          const px = s[o + B_X] + c * lx - sn * ly;
          const py = s[o + B_Y] + sn * lx + c * ly;
          const cx = Math.floor(px);
          const cy = Math.floor(py);
          if (k === 0) {
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            this.tileCell[t] = cx < 0 || cy < 0 || cx >= W || cy >= H ? -1 : cy * W + cx;
          }
          let other = -2;
          if (cx < 0 || cy < 0 || cx >= W || cy >= H || (tiles[cy * W + cx] & PRESENT) !== 0) other = -1;
          else if (occupant[cy * W + cx] !== 0 && occupant[cy * W + cx] !== b + 1) other = occupant[cy * W + cx] - 1;
          if (other === -2) continue;

          // Normal: out of the cell across its nearer face, unless that face is blocked too.
          const dx = px - (cx + 0.5);
          const dy = py - (cy + 0.5);
          const sx = dx >= 0 ? 1 : -1;
          const sy = dy >= 0 ? 1 : -1;
          const adx = dx >= 0 ? dx : -dx;
          const ady = dy >= 0 ? dy : -dy;
          const xFree = !this.blocked(tiles, cx + sx, cy, other);
          const yFree = !this.blocked(tiles, cx, cy + sy, other);
          if (xFree && (adx >= ady || !yFree)) {
            sc[C_NX] = sx;
            sc[C_NY] = 0;
            sc[C_PEN] = 0.5 - adx + SLOP;
          } else if (yFree) {
            sc[C_NX] = 0;
            sc[C_NY] = sy;
            sc[C_PEN] = 0.5 - ady + SLOP;
          } else {
            // Buried in a corner: back out toward the body's own centre.
            const bx = s[o + B_X] - (cx + 0.5);
            const by = s[o + B_Y] - (cy + 0.5);
            const bl = Math.sqrt(bx * bx + by * by) + 1e-9;
            sc[C_NX] = bx / bl;
            sc[C_NY] = by / bl;
            sc[C_PEN] = 0.5;
          }
          sc[C_PX] = px;
          sc[C_PY] = py;
          this.resolveContact(b, other);
          contacts++;
        }
      }
      const cxw = Math.floor(s[o + B_X]);
      const cyw = Math.floor(s[o + B_Y]);
      this.centreCell[b] = cxw < 0 || cyw < 0 || cxw >= W || cyw >= H ? -1 : cyw * W + cxw;
      bounds[b * 4] = minX;
      bounds[b * 4 + 1] = minY;
      bounds[b * 4 + 2] = maxX;
      bounds[b * 4 + 3] = maxY;
      const nc = sc[C_CORR_N];
      if (nc > 0) {
        s[o + B_X] += (sc[C_CORR_X] / nc) * POSITION_CORRECTION;
        s[o + B_Y] += (sc[C_CORR_Y] / nc) * POSITION_CORRECTION;
      }
    }
    this.contactsLastStep = contacts;
    this.contactsTotal += contacts;

    // A body with every tile inside a zone goes into that bin.
    for (let b = 0; b < MAX_BODIES; b++) {
      if (alive[b] === 0) continue;
      // Bounds are tile centres; half a tile out is the tiles' edges.
      const z = salvage.zoneContaining(bounds, b * 4, 0.5);
      if (z >= 0) this.deliver(b, z, salvage);
    }
  }

  /** Whether cell (x, y) counts as solid for a contact against `other` (-1: the grid). */
  private blocked(tiles: Uint8Array, x: number, y: number, other: number): boolean {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const i = y * W + x;
    return other < 0 ? (tiles[i] & PRESENT) !== 0 : this.occupant[i] === other + 1;
  }

  /**
   * Impulse at the contact in `scratch` between body `b` and `other` (a body, or -1 for the
   * immovable grid), with Coulomb friction. Penetration is queued on `b` and pushed straight
   * onto `other`, split by inverse mass.
   */
  private resolveContact(b: number, other: number): void {
    const s = this.body;
    const sc = this.scratch;
    const oa = b * BODY_STRIDE;
    const nx = sc[C_NX];
    const ny = sc[C_NY];
    const rax = sc[C_PX] - s[oa + B_X];
    const ray = sc[C_PY] - s[oa + B_Y];
    const invMa = s[oa + B_INV_MASS];
    const invIa = s[oa + B_INV_INERTIA];
    let vrx = s[oa + B_VX] - s[oa + B_SPIN] * ray;
    let vry = s[oa + B_VY] + s[oa + B_SPIN] * rax;
    const ob = other >= 0 ? other * BODY_STRIDE : 0;
    const invMb = other >= 0 ? s[ob + B_INV_MASS] : 0;
    const invIb = other >= 0 ? s[ob + B_INV_INERTIA] : 0;
    const rbx = other >= 0 ? sc[C_PX] - s[ob + B_X] : 0;
    const rby = other >= 0 ? sc[C_PY] - s[ob + B_Y] : 0;
    if (other >= 0) {
      vrx -= s[ob + B_VX] - s[ob + B_SPIN] * rby;
      vry -= s[ob + B_VY] + s[ob + B_SPIN] * rbx;
    }

    const share = invMa / (invMa + invMb);
    sc[C_CORR_X] += nx * sc[C_PEN] * share;
    sc[C_CORR_Y] += ny * sc[C_PEN] * share;
    sc[C_CORR_N] += 1;
    if (other >= 0) {
      s[ob + B_X] -= nx * sc[C_PEN] * (1 - share) * POSITION_CORRECTION;
      s[ob + B_Y] -= ny * sc[C_PEN] * (1 - share) * POSITION_CORRECTION;
    }

    const vn = vrx * nx + vry * ny;
    if (vn >= 0) return;
    const rna = rax * ny - ray * nx;
    const rnb = rbx * ny - rby * nx;
    const j = (-(1 + RESTITUTION) * vn) / (invMa + invMb + rna * rna * invIa + rnb * rnb * invIb);
    // Friction along the tangent (-ny, nx), capped by the normal impulse.
    const tx = -ny;
    const ty = nx;
    const vt = vrx * tx + vry * ty;
    const rta = rax * ty - ray * tx;
    const rtb = rbx * ty - rby * tx;
    const jtRaw = -vt / (invMa + invMb + rta * rta * invIa + rtb * rtb * invIb);
    const jtMax = FRICTION * j;
    const jt = jtRaw > jtMax ? jtMax : jtRaw < -jtMax ? -jtMax : jtRaw;
    const ix = nx * j + tx * jt;
    const iy = ny * j + ty * jt;
    s[oa + B_VX] += ix * invMa;
    s[oa + B_VY] += iy * invMa;
    s[oa + B_SPIN] += (rax * iy - ray * ix) * invIa;
    if (other >= 0) {
      s[ob + B_VX] -= ix * invMb;
      s[ob + B_VY] -= iy * invMb;
      s[ob + B_SPIN] -= (rbx * iy - rby * ix) * invIb;
    }
  }

  /** Spring-damper from the grab point to the grapple target, force-limited, applied at the grab point. */
  private applyGrapple(dt: number): void {
    const s = this.body;
    const gr = this.grab;
    const o = this.grabBody * BODY_STRIDE;
    const c = s[o + B_COS];
    const sn = s[o + B_SIN];
    const rx = c * gr[0] - sn * gr[1];
    const ry = sn * gr[0] + c * gr[1];
    const vpx = s[o + B_VX] - s[o + B_SPIN] * ry;
    const vpy = s[o + B_VY] + s[o + B_SPIN] * rx;
    const m = s[o + B_MASS];
    let fx = m * (GRAPPLE_STIFFNESS * (gr[2] - s[o + B_X] - rx) - GRAPPLE_DAMPING * vpx);
    let fy = m * (GRAPPLE_STIFFNESS * (gr[3] - s[o + B_Y] - ry) - GRAPPLE_DAMPING * vpy);
    const f = Math.sqrt(fx * fx + fy * fy);
    if (f > GRAPPLE_MAX_FORCE) {
      fx *= GRAPPLE_MAX_FORCE / f;
      fy *= GRAPPLE_MAX_FORCE / f;
    }
    s[o + B_VX] += fx * s[o + B_INV_MASS] * dt;
    s[o + B_VY] += fy * s[o + B_INV_MASS] * dt;
    s[o + B_SPIN] += (rx * fy - ry * fx) * s[o + B_INV_INERTIA] * dt;
  }

  /** Pays out every tile of body `b` into zone `z` and removes the body. */
  private deliver(b: number, z: number, salvage: Salvage): void {
    const end = this.tileStart[b] + this.tileCount[b];
    for (let t = this.tileStart[b]; t < end; t++) salvage.deliverTile(z, this.tileMaterial[t]);
    this.removeBody(b);
  }

  /** Frees a body's slot and closes the gap its tiles leave in the pool. */
  removeBody(b: number): void {
    if (this.alive[b] === 0) return;
    const start = this.tileStart[b];
    const n = this.tileCount[b];
    const end = start + n;
    this.tileLocal.copyWithin(start * 2, end * 2, this.tilesUsed * 2);
    this.tileFlags.copyWithin(start, end, this.tilesUsed);
    this.tileMaterial.copyWithin(start, end, this.tilesUsed);
    this.tileCell.copyWithin(start, end, this.tilesUsed);
    this.tilesUsed -= n;
    for (let k = 0; k < MAX_BODIES; k++) {
      if (this.alive[k] === 1 && this.tileStart[k] > start) this.tileStart[k] -= n;
    }
    this.alive[b] = 0;
    this.tileCount[b] = 0;
    this.count--;
    if (this.grabBody === b) this.grabBody = -1;
  }

  /** Body with a tile under world point (x, y), or -1. */
  bodyAt(x: number, y: number): number {
    const s = this.body;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (this.alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      const dx = x - s[o + B_X];
      const dy = y - s[o + B_Y];
      if (dx * dx + dy * dy > s[o + B_RADIUS] * s[o + B_RADIUS]) continue;
      // Into the body frame: rotate by -angle.
      const lx = s[o + B_COS] * dx + s[o + B_SIN] * dy;
      const ly = -s[o + B_SIN] * dx + s[o + B_COS] * dy;
      const end = this.tileStart[b] + this.tileCount[b];
      for (let t = this.tileStart[b]; t < end; t++) {
        if (Math.abs(this.tileLocal[t * 2] - lx) <= 0.5 && Math.abs(this.tileLocal[t * 2 + 1] - ly) <= 0.5) return b;
      }
    }
    return -1;
  }

  /** Hooks the grapple onto body `b` at world point (x, y). */
  grabAt(b: number, x: number, y: number): void {
    if (b < 0 || this.alive[b] === 0) return;
    const s = this.body;
    const o = b * BODY_STRIDE;
    const dx = x - s[o + B_X];
    const dy = y - s[o + B_Y];
    this.grab[0] = s[o + B_COS] * dx + s[o + B_SIN] * dy;
    this.grab[1] = -s[o + B_SIN] * dx + s[o + B_COS] * dy;
    this.grab[2] = x;
    this.grab[3] = y;
    this.grabBody = b;
    this.grabGen = this.generation[b];
  }

  setGrappleTarget(x: number, y: number): void {
    this.grab[2] = x;
    this.grab[3] = y;
  }

  releaseGrapple(): void {
    this.grabBody = -1;
  }

  /** Linear momentum of all bodies, written to `out` as (x, y). For tests. */
  momentum(out: Vec2): Vec2 {
    out.x = 0;
    out.y = 0;
    for (let b = 0; b < MAX_BODIES; b++) {
      if (this.alive[b] === 0) continue;
      const o = b * BODY_STRIDE;
      out.x += this.body[o + B_VX] * this.body[o + B_MASS];
      out.y += this.body[o + B_VY] * this.body[o + B_MASS];
    }
    return out;
  }

  /** Spawns a body directly from a list of grid cells, as if they had torn free. For tests and scenes. */
  liftCells(world: World, cells: ArrayLike<number>): number {
    for (let k = 0; k < cells.length; k++) this.queue[k] = cells[k];
    if (!this.createBody(world, cells.length)) return -1;
    return this.liftedBy[cells[0]];
  }
}

/** Mass of one tile; tiles without a material weigh one girder. */
function tileMass(material: number): number {
  const m = MATERIAL_MASS[material];
  return m > 0 ? m : 1;
}
