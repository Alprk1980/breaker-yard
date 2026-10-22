/**
 * Schema and balance check for the salvage material table (`src/data/materials.json`).
 *
 * Self-contained (no imports) so the content generator in `tools/qwen-gen.mjs` can load it
 * with Node's type stripping as well as the game and the tests.
 */

/** Material ids, in `Material` order (`Material.DECK_PLATE` is index 0 + 1). */
export const MATERIAL_IDS = ['deck-plate', 'hull-plate', 'girder-alloy', 'engine-part', 'electronics'] as const;
/** Salvage bins, in `Bin` order (`Bin.FURNACE` is index 0 + 1). */
export const BIN_IDS = ['furnace', 'processor', 'barge'] as const;

/** Share of a tile's value paid when it lands in the wrong bin. */
export const MISSORT_FACTOR = 0.25;

/**
 * Tiles of each material inside the demo hull's frame, in `MATERIAL_IDS` order. A test
 * rebuilds the hull and checks these, so the balance check always prices the real ship.
 */
export const DEMO_TILE_COUNTS: readonly number[] = [915, 24, 115, 13, 6];
/** Credits a perfectly sorted demo hull must pay. */
export const DEMO_VALUE_MIN = 6000;
export const DEMO_VALUE_MAX = 20000;
/** No single bin may hold more than this share of the sorted demo hull's value. */
export const MAX_BIN_SHARE = 0.6;

export interface MaterialEntry {
  id: string;
  name: string;
  description: string;
  /** Credits per tile delivered to the right bin. */
  value: number;
  /** Mass per tile, in girder-tile units (the stress lattice's default node mass is 1). */
  mass: number;
  bin: string;
  /** `#rrggbb`, used to draw debris. */
  color: string;
}

const HEX = /^#[0-9a-f]{6}$/;
// Pictographs, dingbats and variation selectors: house style is plain text.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/** Problems with one entry; empty when it is usable. */
export function materialErrors(e: unknown): string[] {
  const out: string[] = [];
  if (typeof e !== 'object' || e === null) return ['entry: must be an object'];
  const m = e as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : '?';
  if (!(MATERIAL_IDS as readonly unknown[]).includes(m.id)) out.push(`${id}: id must be one of ${MATERIAL_IDS.join(', ')}`);
  if (typeof m.name !== 'string' || m.name.length < 3 || m.name.length > 24) out.push(`${id}: name 3-24 characters`);
  if (typeof m.description !== 'string' || m.description.length < 20 || m.description.length > 120) {
    out.push(`${id}: description 20-120 characters`);
  }
  for (const key of ['name', 'description'] as const) {
    if (typeof m[key] === 'string' && EMOJI.test(m[key] as string)) out.push(`${id}: no emoji in ${key}`);
  }
  if (typeof m.value !== 'number' || !Number.isInteger(m.value) || m.value < 1 || m.value > 500) {
    out.push(`${id}: value must be a whole number of credits, 1-500`);
  }
  if (typeof m.mass !== 'number' || !Number.isFinite(m.mass) || m.mass < 0.2 || m.mass > 10) out.push(`${id}: mass 0.2-10`);
  if (!(BIN_IDS as readonly unknown[]).includes(m.bin)) out.push(`${id}: bin must be one of ${BIN_IDS.join(', ')}`);
  if (typeof m.color !== 'string' || !HEX.test(m.color)) out.push(`${id}: color must be lowercase #rrggbb`);
  const extra = Object.keys(m).filter((k) => !['id', 'name', 'description', 'value', 'mass', 'bin', 'color'].includes(k));
  if (extra.length > 0) out.push(`${id}: unknown field(s) ${extra.join(', ')}`);
  return out;
}

/** Problems with the whole table: per-entry errors, the id set, and the demo-hull balance. */
export function materialTableErrors(table: unknown): string[] {
  if (!Array.isArray(table)) return ['table: must be a JSON array'];
  const out = table.flatMap((e) => materialErrors(e));
  const ids = table.map((e) => (e as { id?: unknown })?.id);
  for (const id of MATERIAL_IDS) {
    const n = ids.filter((x) => x === id).length;
    if (n !== 1) out.push(`table: ${id} must appear exactly once (found ${n})`);
  }
  if (table.length !== MATERIAL_IDS.length) out.push(`table: exactly ${MATERIAL_IDS.length} entries`);
  if (out.length > 0) return out;

  const byId = new Map((table as MaterialEntry[]).map((e) => [e.id, e]));
  const get = (id: (typeof MATERIAL_IDS)[number]): MaterialEntry => byId.get(id) as MaterialEntry;

  for (const bin of BIN_IDS) {
    if (!table.some((e: MaterialEntry) => e.bin === bin)) out.push(`table: no material goes to the ${bin}`);
  }
  const colors = new Set(table.map((e: MaterialEntry) => e.color));
  if (colors.size !== table.length) out.push('table: every color must be different');

  const deck = get('deck-plate');
  const hull = get('hull-plate');
  const girder = get('girder-alloy');
  const engine = get('engine-part');
  const elec = get('electronics');
  if (!(deck.mass <= hull.mass && hull.mass <= girder.mass)) {
    out.push(`table: mass must rise deck-plate <= hull-plate <= girder-alloy (got ${deck.mass}, ${hull.mass}, ${girder.mass})`);
  }
  if (table.some((e: MaterialEntry) => e.mass > engine.mass)) out.push('table: engine-part must be the heaviest material');
  for (const prize of [engine, elec]) {
    for (const plate of [deck, hull, girder]) {
      if (prize.value < plate.value * 3) {
        out.push(`table: ${prize.id} (${prize.value}) must be worth at least 3x ${plate.id} (${plate.value}) per tile`);
      }
    }
  }

  // Price the demo hull, sorted perfectly and dumped whole into one bin.
  let sorted = 0;
  const perBin = new Map<string, number>();
  MATERIAL_IDS.forEach((id, k) => {
    const v = get(id).value * DEMO_TILE_COUNTS[k];
    sorted += v;
    perBin.set(get(id).bin, (perBin.get(get(id).bin) ?? 0) + v);
  });
  if (sorted < DEMO_VALUE_MIN || sorted > DEMO_VALUE_MAX) {
    out.push(
      `balance: the sorted demo hull pays ${sorted} credits, band ${DEMO_VALUE_MIN}-${DEMO_VALUE_MAX} ` +
        `(tiles: ${MATERIAL_IDS.map((id, k) => `${DEMO_TILE_COUNTS[k]} ${id}`).join(', ')})`,
    );
  }
  for (const [bin, v] of perBin) {
    if (v > sorted * MAX_BIN_SHARE) {
      out.push(
        `balance: the ${bin} takes ${Math.round((100 * v) / sorted)}% of the demo hull's value, max ${MAX_BIN_SHARE * 100}%: ` +
          'sorting must matter, so spread value across bins',
      );
    }
  }
  return out;
}
