import { MATERIAL_BIN, MATERIAL_COUNT, MATERIAL_VALUE } from './materials';
import { MISSORT_FACTOR } from './materialSchema';

export const MAX_ZONES = 8;

/**
 * Salvage bins and the yard's ledger. A zone is an axis-aligned rectangle of open space
 * (tile units, `[x0, x1) x [y0, y1)`) that accepts one `Bin`. Debris whose every tile lies
 * inside a zone is consumed by it and paid out tile by tile: full value for tiles that
 * belong in that bin, `MISSORT_FACTOR` of it for the rest. Torch cuts destroy the value of
 * the tile they remove, which the ledger records separately.
 */
export class Salvage {
  readonly zoneBin = new Uint8Array(MAX_ZONES);
  readonly zoneRect = new Float32Array(MAX_ZONES * 4);
  zoneCount = 0;

  /**
   * Credits paid, credits lost to wrong-bin deliveries (value delivered minus value paid), and
   * value of tiles removed by the torch. Kept in a typed array behind accessors, not as plain
   * number fields: a field that starts as integer 0 and later holds fractions changes its
   * representation, which changes the object's shape and throws away optimised code built
   * against the old one.
   */
  private readonly ledger = new Float64Array(3);

  get credits(): number {
    return this.ledger[0];
  }

  set credits(value: number) {
    this.ledger[0] = value;
  }

  get missortLoss(): number {
    return this.ledger[1];
  }

  set missortLoss(value: number) {
    this.ledger[1] = value;
  }

  get destroyedValue(): number {
    return this.ledger[2];
  }

  set destroyedValue(value: number) {
    this.ledger[2] = value;
  }

  deliveredTiles = 0;
  missortedTiles = 0;
  /** Tiles delivered per material. */
  readonly deliveredByMaterial = new Uint32Array(MATERIAL_COUNT);

  addZone(bin: number, x0: number, y0: number, x1: number, y1: number): number {
    if (this.zoneCount >= MAX_ZONES) return -1;
    const z = this.zoneCount++;
    this.zoneBin[z] = bin;
    this.zoneRect[z * 4] = x0;
    this.zoneRect[z * 4 + 1] = y0;
    this.zoneRect[z * 4 + 2] = x1;
    this.zoneRect[z * 4 + 3] = y1;
    return z;
  }

  /**
   * Index of the zone that fully contains the box `[x0, x1] x [y0, y1]` read from
   * `box[at .. at + 4)`, grown by `margin` on every side, or -1. The box comes in as an
   * array and index rather than four numbers: a fractional number passed to a call V8 does
   * not inline is boxed on the heap, once per argument per call.
   */
  zoneContaining(box: Float32Array, at: number, margin: number): number {
    const r = this.zoneRect;
    for (let z = 0; z < this.zoneCount; z++) {
      if (
        box[at] - margin >= r[z * 4] &&
        box[at + 1] - margin >= r[z * 4 + 1] &&
        box[at + 2] + margin <= r[z * 4 + 2] &&
        box[at + 3] + margin <= r[z * 4 + 3]
      ) {
        return z;
      }
    }
    return -1;
  }

  /** Pays out one delivered tile. */
  deliverTile(zone: number, material: number): void {
    const value = MATERIAL_VALUE[material];
    const right = MATERIAL_BIN[material] === this.zoneBin[zone];
    const paid = right ? value : value * MISSORT_FACTOR;
    this.ledger[0] += paid;
    this.ledger[1] += value - paid;
    this.deliveredTiles++;
    this.deliveredByMaterial[material]++;
    if (!right) this.missortedTiles++;
  }

  /** Records a tile the torch removed. */
  destroyTile(material: number): void {
    this.ledger[2] += MATERIAL_VALUE[material];
  }

  /** Clears the ledger and the zones. */
  clear(): void {
    this.zoneCount = 0;
    this.resetLedger();
  }

  resetLedger(): void {
    this.ledger.fill(0);
    this.deliveredTiles = 0;
    this.missortedTiles = 0;
    this.deliveredByMaterial.fill(0);
  }
}
