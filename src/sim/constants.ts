/** Grid width in tiles. Index formula: `idx = y * WIDTH + x`. */
export const WIDTH = 128;
/** Grid height in tiles. */
export const HEIGHT = 128;
export const CELL_COUNT = WIDTH * HEIGHT;

/** Fixed simulation rate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_DT = 1 / TICK_HZ;

/** Pressure used by the debug injection tool, in bar. */
export const INJECT_PRESSURE_BAR = 10.0;
