/** Pressure at which the gas ramp saturates to red. */
export const RAMP_MAX_BAR = 10;
export const RAMP_SIZE = 512;

/** [bar, r, g, b, a] stops: transparent -> cyan -> yellow -> red. */
const GAS_STOPS: readonly (readonly [number, number, number, number, number])[] = [
  [0.0, 0, 255, 255, 0],
  [1.0, 0, 230, 255, 120],
  [4.0, 255, 235, 0, 175],
  [10.0, 255, 32, 0, 220],
];

/** Packs RGBA into a little-endian ImageData word. */
export function packRGBA(r: number, g: number, b: number, a: number): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Builds the gas pressure lookup table once at init. Index = bar / RAMP_MAX_BAR * (RAMP_SIZE - 1). */
export function buildGasRamp(): Uint32Array {
  const lut = new Uint32Array(RAMP_SIZE);
  for (let i = 0; i < RAMP_SIZE; i++) {
    const bar = (i / (RAMP_SIZE - 1)) * RAMP_MAX_BAR;
    let s = 0;
    while (s < GAS_STOPS.length - 2 && bar > GAS_STOPS[s + 1][0]) s++;
    const a = GAS_STOPS[s];
    const b = GAS_STOPS[s + 1];
    const t = Math.min(Math.max((bar - a[0]) / (b[0] - a[0]), 0), 1);
    lut[i] = packRGBA(
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
      Math.round(a[3] + (b[3] - a[3]) * t),
      Math.round(a[4] + (b[4] - a[4]) * t),
    );
  }
  return lut;
}

/** Stress colour strings, green (0) to red (1.0 utilisation), built once at init. */
export function buildStressPalette(buckets: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < buckets; i++) {
    const hue = Math.round(120 * (1 - i / (buckets - 1)));
    out.push(`hsl(${hue}, 90%, 52%)`);
  }
  return out;
}
