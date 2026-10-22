/** What a pawn ran into. */
export const HazardKind = {
  NONE: 0,
  /** Pre-cut scan found the wall holding back more than the safe differential. */
  CUT_REFUSED_PRESSURE: 1,
  /** The differential rose past the limit while the cut was under way. */
  CUT_ABORTED_PRESSURE: 2,
  /** Caught in a vent stream; the pawn dropped its work and fled. */
  DECOMPRESSION: 3,
  /** Knocked off the floor into open space. */
  ADRIFT: 4,
  /** No route to the order's tile. */
  UNREACHABLE: 5,
  /** The deck tore free of the anchors with the pawn aboard. */
  CARRIED_OFF: 6,
} as const;

export const HAZARD_NAMES: readonly string[] = [
  'none',
  'cut refused: pressure',
  'cut aborted: pressure',
  'decompression',
  'adrift',
  'unreachable',
  'carried off on debris',
];

/**
 * Fixed-size ring buffer of hazard events, written from the tick loop without
 * allocating. Index 0 of `at()` is the oldest retained event.
 */
export class HazardLog {
  readonly capacity: number;
  readonly kind: Uint8Array;
  readonly pawn: Int8Array;
  readonly x: Int16Array;
  readonly y: Int16Array;
  readonly tick: Uint32Array;
  /** Event magnitude, e.g. the pressure differential in bar. */
  readonly value: Float32Array;
  /** Events retained, up to `capacity`. */
  count = 0;
  /** Events ever logged. */
  total = 0;
  private head = 0;

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.kind = new Uint8Array(capacity);
    this.pawn = new Int8Array(capacity);
    this.x = new Int16Array(capacity);
    this.y = new Int16Array(capacity);
    this.tick = new Uint32Array(capacity);
    this.value = new Float32Array(capacity);
  }

  log(kind: number, pawn: number, x: number, y: number, tick: number, value: number): void {
    const i = this.head;
    this.kind[i] = kind;
    this.pawn[i] = pawn;
    this.x[i] = x;
    this.y[i] = y;
    this.tick[i] = tick;
    this.value[i] = value;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
  }

  /** Ring slot of the n-th retained event, oldest first. */
  at(n: number): number {
    return (this.head - this.count + n + this.capacity) % this.capacity;
  }

  /** Number of retained events of `kind`. */
  countOf(kind: number): number {
    let c = 0;
    for (let n = 0; n < this.count; n++) if (this.kind[this.at(n)] === kind) c++;
    return c;
  }

  clear(): void {
    this.count = 0;
    this.total = 0;
    this.head = 0;
  }
}
