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

  credits = 0;
  /** Credits lost to wrong-bin deliveries (value delivered minus value paid). */
  missortLoss = 0;
  /** Value of tiles removed by the torch. */
  destroyedValue = 0;
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

  /** Index of the zone that fully contains the box `[x0, x1] x [y0, y1]`, or -1. */
  zoneContaining(x0: number, y0: number, x1: number, y1: number): number {
    const r = this.zoneRect;
    for (let z = 0; z < this.zoneCount; z++) {
      if (x0 >= r[z * 4] && y0 >= r[z * 4 + 1] && x1 <= r[z * 4 + 2] && y1 <= r[z * 4 + 3]) return z;
    }
    return -1;
  }

  /** Pays out one delivered tile. */
  deliverTile(zone: number, material: number): void {
    const value = MATERIAL_VALUE[material];
    const right = MATERIAL_BIN[material] === this.zoneBin[zone];
    const paid = right ? value : value * MISSORT_FACTOR;
    this.credits += paid;
    this.missortLoss += value - paid;
    this.deliveredTiles++;
    this.deliveredByMaterial[material]++;
    if (!right) this.missortedTiles++;
  }

  /** Records a tile the torch removed. */
  destroyTile(material: number): void {
    this.destroyedValue += MATERIAL_VALUE[material];
  }

  /** Clears the ledger and the zones. */
  clear(): void {
    this.zoneCount = 0;
    this.resetLedger();
  }

  resetLedger(): void {
    this.credits = 0;
    this.missortLoss = 0;
    this.destroyedValue = 0;
    this.deliveredTiles = 0;
    this.missortedTiles = 0;
    this.deliveredByMaterial.fill(0);
  }
}
