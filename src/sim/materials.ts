import table from '../data/materials.json';
import { BIN_IDS, MATERIAL_IDS, type MaterialEntry, materialTableErrors } from './materialSchema';
import { TileFlags } from './TileFlags';

/** Per-tile material, one byte per tile in `World.material`. Ids follow `MATERIAL_IDS`. */
export const Material = {
  NONE: 0,
  DECK_PLATE: 1,
  HULL_PLATE: 2,
  GIRDER_ALLOY: 3,
  ENGINE_PART: 4,
  ELECTRONICS: 5,
} as const;
export const MATERIAL_COUNT = MATERIAL_IDS.length + 1;

/** Salvage bin a zone accepts. Ids follow `BIN_IDS`. */
export const Bin = {
  NONE: 0,
  FURNACE: 1,
  PROCESSOR: 2,
  BARGE: 3,
} as const;
export const BIN_NAMES: readonly string[] = ['none', ...BIN_IDS];

const problems = materialTableErrors(table);
if (problems.length > 0) throw new Error(`src/data/materials.json is invalid:\n${problems.join('\n')}`);
const entries = table as MaterialEntry[];

function column<T extends Float32Array | Uint8Array>(out: T, read: (e: MaterialEntry) => number): T {
  MATERIAL_IDS.forEach((id, k) => {
    out[k + 1] = read(entries.find((e) => e.id === id) as MaterialEntry);
  });
  return out;
}

/** Credits per tile in the right bin, indexed by `Material`. */
export const MATERIAL_VALUE = column(new Float32Array(MATERIAL_COUNT), (e) => e.value);
/** Mass per tile, indexed by `Material`. */
export const MATERIAL_MASS = column(new Float32Array(MATERIAL_COUNT), (e) => e.mass);
/** `Bin` each material belongs in, indexed by `Material`. */
export const MATERIAL_BIN = column(new Uint8Array(MATERIAL_COUNT), (e) => BIN_IDS.indexOf(e.bin as (typeof BIN_IDS)[number]) + 1);
export const MATERIAL_NAMES: readonly string[] = ['none', ...MATERIAL_IDS.map((id) => (entries.find((e) => e.id === id) as MaterialEntry).name)];
export const MATERIAL_COLORS: readonly string[] = ['#000000', ...MATERIAL_IDS.map((id) => (entries.find((e) => e.id === id) as MaterialEntry).color)];

/** The material a freshly built tile gets from its flags. */
export function defaultMaterial(flags: number): number {
  if ((flags & TileFlags.GIRDER) !== 0) return Material.GIRDER_ALLOY;
  if ((flags & TileFlags.BULKHEAD) !== 0) return Material.HULL_PLATE;
  if ((flags & TileFlags.FLOOR) !== 0) return Material.DECK_PLATE;
  return Material.NONE;
}
