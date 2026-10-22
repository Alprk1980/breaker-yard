import { HEIGHT, WIDTH } from './constants';

/** Neighbour directions used to index `edgeAdjacency` (`node * 4 + dir`). */
export const Dir = {
  EAST: 0,
  WEST: 1,
  SOUTH: 2,
  NORTH: 3,
} as const;

/**
 * Structural load graph for load-bearing tiles.
 *
 * Nodes live one-per-tile (node index == tile index) and edges join 4-neighbours,
 * so every array is sized once at construction and never resized.
 *
 * Load model: every node's mass has to be carried back to an anchor along the
 * members. We solve for a load potential `phi` with anchors pinned at 0:
 *   deg(n) * phi[n] - sum_neighbours phi[m] = mass[n]
 * and the load carried by edge (a, b) is `phi[a] - phi[b]`. This is a discrete
 * Poisson problem, so the loads obey conservation at every node: an edge carries
 * exactly the mass hanging off beyond it, and parallel paths share it. A
 * cantilever therefore loads up toward its root, which is where it fails.
 *
 * The system is relaxed in place with Gauss-Seidel over-relaxation (SOR),
 * warm-started from the previous tick so a few dozen sweeps per tick suffice.
 * Nodes with no path to an anchor are "floating": they carry no load and are
 * skipped (their system would be singular).
 */
export class StressLattice {
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Number of horizontal edges; vertical edge ids start here. */
  readonly horizontalEdgeCount: number;

  readonly nodeMass: Float32Array;
  /** Peak utilisation (|load| / capacity) over a node's live edges. 1.0 = at breaking point. */
  readonly nodeStress: Float32Array;
  readonly nodePotential: Float32Array;
  readonly nodeActive: Uint8Array;
  readonly isAnchor: Uint8Array;
  /** 1 when the node has a live path to an anchor. */
  readonly nodeGrounded: Uint8Array;

  /** `node * 4 + Dir` -> edge id, or -1 at the grid edge. Fixed at construction. */
  readonly edgeAdjacency: Int32Array;
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  /** Signed load from A toward B. Positive means load flows from A to B. */
  readonly edgeLoad: Float32Array;
  readonly edgeCapacity: Float32Array;
  readonly edgeSnapped: Uint8Array;

  /** Default capacity applied to new or reset edges. */
  breakThreshold: number;
  /** SOR relaxation factor, 1 = plain Gauss-Seidel. Must stay in (0, 2). */
  omega = 1.9;
  iterationsPerTick = 128;
  /** Relative per-sweep change below which the solution counts as converged. */
  tolerance = 1e-6;

  converged = false;
  /** Iterations spent in the most recent `relax()` call. */
  lastIterations = 0;
  /** Largest relative change seen in the last sweep. */
  lastResidual = 0;
  /** Edges snapped during the most recent `step()`. */
  snappedLastStep = 0;
  totalSnapped = 0;
  groundedCount = 0;
  floatingCount = 0;
  /** Bumped by every `rebuildTopology()`, so callers can tell when grounding may have changed. */
  topologyVersion = 0;

  /** Grounded, non-anchor nodes: the only ones the solver touches. */
  private readonly solveList: Int32Array;
  private solveCount = 0;
  private readonly queue: Int32Array;
  private topologyDirty = true;

  constructor(width = WIDTH, height = HEIGHT, breakThreshold = 40) {
    this.width = width;
    this.height = height;
    this.nodeCount = width * height;
    this.horizontalEdgeCount = (width - 1) * height;
    this.edgeCount = this.horizontalEdgeCount + width * (height - 1);
    this.breakThreshold = breakThreshold;

    const n = this.nodeCount;
    const e = this.edgeCount;
    this.nodeMass = new Float32Array(n);
    this.nodeStress = new Float32Array(n);
    this.nodePotential = new Float32Array(n);
    this.nodeActive = new Uint8Array(n);
    this.isAnchor = new Uint8Array(n);
    this.nodeGrounded = new Uint8Array(n);
    this.edgeAdjacency = new Int32Array(n * 4).fill(-1);
    this.edgeA = new Int32Array(e);
    this.edgeB = new Int32Array(e);
    this.edgeLoad = new Float32Array(e);
    this.edgeCapacity = new Float32Array(e).fill(breakThreshold);
    this.edgeSnapped = new Uint8Array(e);
    this.solveList = new Int32Array(n);
    this.queue = new Int32Array(n);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width - 1; x++) {
        const id = y * (width - 1) + x;
        const a = y * width + x;
        this.edgeA[id] = a;
        this.edgeB[id] = a + 1;
        this.edgeAdjacency[a * 4 + Dir.EAST] = id;
        this.edgeAdjacency[(a + 1) * 4 + Dir.WEST] = id;
      }
    }
    for (let y = 0; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        const id = this.horizontalEdgeCount + y * width + x;
        const a = y * width + x;
        this.edgeA[id] = a;
        this.edgeB[id] = a + width;
        this.edgeAdjacency[a * 4 + Dir.SOUTH] = id;
        this.edgeAdjacency[(a + width) * 4 + Dir.NORTH] = id;
      }
    }
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Adds (or re-adds) a structural node. Its edges start intact at `breakThreshold`. */
  addNode(x: number, y: number, mass = 1, anchor = false): void {
    if (!this.inBounds(x, y)) return;
    const n = y * this.width + x;
    this.nodeActive[n] = 1;
    this.nodeMass[n] = mass;
    this.isAnchor[n] = anchor ? 1 : 0;
    this.nodePotential[n] = 0;
    const base = n * 4;
    for (let d = 0; d < 4; d++) {
      const e = this.edgeAdjacency[base + d];
      if (e < 0) continue;
      this.edgeSnapped[e] = 0;
      this.edgeCapacity[e] = this.breakThreshold;
      this.edgeLoad[e] = 0;
    }
    this.topologyDirty = true;
  }

  removeNode(x: number, y: number): void {
    if (!this.inBounds(x, y)) return;
    const n = y * this.width + x;
    if (this.nodeActive[n] === 0) return;
    this.nodeActive[n] = 0;
    this.isAnchor[n] = 0;
    this.nodeMass[n] = 0;
    this.nodePotential[n] = 0;
    this.nodeStress[n] = 0;
    const base = n * 4;
    for (let d = 0; d < 4; d++) {
      const e = this.edgeAdjacency[base + d];
      if (e >= 0) this.edgeLoad[e] = 0;
    }
    this.topologyDirty = true;
  }

  hasNode(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.nodeActive[y * this.width + x] === 1;
  }

  setMass(x: number, y: number, mass: number): void {
    if (!this.hasNode(x, y)) return;
    this.nodeMass[y * this.width + x] = mass;
    this.converged = false;
  }

  setAnchor(x: number, y: number, anchor: boolean): void {
    if (!this.hasNode(x, y)) return;
    const n = y * this.width + x;
    this.isAnchor[n] = anchor ? 1 : 0;
    this.nodePotential[n] = 0;
    this.topologyDirty = true;
  }

  /** Returns the new anchor state, or false when there is no node at (x, y). */
  toggleAnchor(x: number, y: number): boolean {
    if (!this.hasNode(x, y)) return false;
    const next = this.isAnchor[y * this.width + x] === 0;
    this.setAnchor(x, y, next);
    return next;
  }

  /** Sets capacity of the edge leaving (x, y) in direction `dir`. */
  setEdgeCapacity(x: number, y: number, dir: number, capacity: number): void {
    if (!this.inBounds(x, y)) return;
    const e = this.edgeAdjacency[(y * this.width + x) * 4 + dir];
    if (e >= 0) this.edgeCapacity[e] = capacity;
  }

  isEdgeLive(e: number): boolean {
    return this.edgeSnapped[e] === 0 && this.nodeActive[this.edgeA[e]] === 1 && this.nodeActive[this.edgeB[e]] === 1;
  }

  clear(): void {
    this.nodeActive.fill(0);
    this.isAnchor.fill(0);
    this.nodeMass.fill(0);
    this.nodePotential.fill(0);
    this.nodeStress.fill(0);
    this.nodeGrounded.fill(0);
    this.edgeLoad.fill(0);
    this.edgeSnapped.fill(0);
    this.edgeCapacity.fill(this.breakThreshold);
    this.totalSnapped = 0;
    this.snappedLastStep = 0;
    this.topologyDirty = true;
  }

  /** One fixed tick: rebuild topology if needed, relax, compute loads, snap overloaded edges. */
  step(): void {
    if (this.topologyDirty) this.rebuildTopology();
    this.relax(this.iterationsPerTick);
    this.computeLoads();
    this.snappedLastStep = this.converged ? this.snapOverloaded() : 0;
  }

  /** Runs relaxation until converged; returns iterations used. Intended for setup and tests. */
  solve(maxIterations = 20000): number {
    if (this.topologyDirty) this.rebuildTopology();
    let used = 0;
    while (used < maxIterations) {
      used += this.relax(Math.min(256, maxIterations - used));
      if (this.converged) break;
    }
    this.computeLoads();
    return used;
  }

  /**
   * Flood-fills from every anchor through live edges to find grounded nodes and
   * build the solve list. Floating nodes are zeroed.
   */
  rebuildTopology(): void {
    const n = this.nodeCount;
    const active = this.nodeActive;
    const anchor = this.isAnchor;
    const grounded = this.nodeGrounded;
    const queue = this.queue;
    const adj = this.edgeAdjacency;
    const ea = this.edgeA;
    const eb = this.edgeB;
    const snapped = this.edgeSnapped;

    grounded.fill(0);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < n; i++) {
      if (active[i] === 1 && anchor[i] === 1) {
        grounded[i] = 1;
        queue[tail++] = i;
      }
    }
    while (head < tail) {
      const node = queue[head++];
      const base = node * 4;
      for (let d = 0; d < 4; d++) {
        const e = adj[base + d];
        if (e < 0 || snapped[e] === 1) continue;
        const other = ea[e] === node ? eb[e] : ea[e];
        if (active[other] === 0 || grounded[other] === 1) continue;
        grounded[other] = 1;
        queue[tail++] = other;
      }
    }

    let solveCount = 0;
    let groundedCount = 0;
    let floatingCount = 0;
    for (let i = 0; i < n; i++) {
      if (active[i] === 0) continue;
      if (grounded[i] === 1) {
        groundedCount++;
        if (anchor[i] === 0) this.solveList[solveCount++] = i;
      } else {
        floatingCount++;
        this.nodePotential[i] = 0;
        this.nodeStress[i] = 0;
      }
    }
    this.solveCount = solveCount;
    this.groundedCount = groundedCount;
    this.floatingCount = floatingCount;
    this.topologyDirty = false;
    this.converged = false;
    this.topologyVersion++;
  }

  /** Performs up to `iterations` SOR sweeps; returns how many ran. */
  relax(iterations: number): number {
    const list = this.solveList;
    const count = this.solveCount;
    const phi = this.nodePotential;
    const mass = this.nodeMass;
    const adj = this.edgeAdjacency;
    const ea = this.edgeA;
    const eb = this.edgeB;
    const snapped = this.edgeSnapped;
    const active = this.nodeActive;
    const omega = this.omega;
    const tol = this.tolerance;

    let it = 0;
    let residual = 0;
    this.converged = count === 0;
    while (it < iterations && !this.converged) {
      residual = 0;
      for (let k = 0; k < count; k++) {
        const node = list[k];
        const base = node * 4;
        let sum = 0;
        let deg = 0;
        for (let d = 0; d < 4; d++) {
          const e = adj[base + d];
          if (e < 0 || snapped[e] === 1) continue;
          const other = ea[e] === node ? eb[e] : ea[e];
          if (active[other] === 0) continue;
          sum += phi[other];
          deg++;
        }
        const old = phi[node];
        const gs = (mass[node] + sum) / deg;
        const updated = old + omega * (gs - old);
        phi[node] = updated;
        const change = Math.abs(updated - old) / (Math.abs(updated) > 1 ? Math.abs(updated) : 1);
        if (change > residual) residual = change;
      }
      it++;
      if (residual < tol) this.converged = true;
    }
    this.lastIterations = it;
    this.lastResidual = residual;
    return it;
  }

  /** Writes `edgeLoad` and `nodeStress` from the current potentials. */
  computeLoads(): void {
    const phi = this.nodePotential;
    const ea = this.edgeA;
    const eb = this.edgeB;
    const grounded = this.nodeGrounded;
    const load = this.edgeLoad;
    const cap = this.edgeCapacity;
    const stress = this.nodeStress;

    stress.fill(0);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = ea[e];
      const b = eb[e];
      if (!this.isEdgeLive(e) || grounded[a] === 0 || grounded[b] === 0) {
        load[e] = 0;
        continue;
      }
      const l = phi[a] - phi[b];
      load[e] = l;
      const u = Math.abs(l) / cap[e];
      if (u > stress[a]) stress[a] = u;
      if (u > stress[b]) stress[b] = u;
    }
  }

  /** Utilisation of an edge: |load| / capacity. */
  edgeUtilisation(e: number): number {
    return Math.abs(this.edgeLoad[e]) / this.edgeCapacity[e];
  }

  /** Snaps edge `e` outright (a blast tearing a member), if it is live. */
  snapEdge(e: number): void {
    if (e < 0 || this.edgeSnapped[e] === 1 || !this.isEdgeLive(e)) return;
    this.edgeSnapped[e] = 1;
    this.edgeLoad[e] = 0;
    this.totalSnapped++;
    this.topologyDirty = true;
  }

  /** Marks every live edge whose load exceeds its capacity as snapped. Returns the count. */
  snapOverloaded(): number {
    let count = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      if (this.edgeSnapped[e] === 1) continue;
      if (Math.abs(this.edgeLoad[e]) > this.edgeCapacity[e]) {
        this.edgeSnapped[e] = 1;
        this.edgeLoad[e] = 0;
        count++;
      }
    }
    if (count > 0) {
      this.totalSnapped += count;
      this.topologyDirty = true;
    }
    return count;
  }

  /** Total load arriving at anchors. Equals total grounded mass once converged. */
  anchorReaction(): number {
    let sum = 0;
    for (let n = 0; n < this.nodeCount; n++) {
      if (this.isAnchor[n] === 0 || this.nodeActive[n] === 0) continue;
      const base = n * 4;
      for (let d = 0; d < 4; d++) {
        const e = this.edgeAdjacency[base + d];
        if (e < 0) continue;
        // Load flowing into the anchor node.
        sum += this.edgeB[e] === n ? this.edgeLoad[e] : -this.edgeLoad[e];
      }
    }
    return sum;
  }

  /** Total mass on grounded, non-anchor nodes. */
  groundedMass(): number {
    let sum = 0;
    for (let k = 0; k < this.solveCount; k++) sum += this.nodeMass[this.solveList[k]];
    return sum;
  }
}
