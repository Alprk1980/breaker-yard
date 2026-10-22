/** Grid width in tiles. Index formula: `idx = y * WIDTH + x`. */
export const WIDTH = 128;
/** Grid height in tiles. */
export const HEIGHT = 128;
export const CELL_COUNT = WIDTH * HEIGHT;

/** Fixed simulation rate. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_DT = 1 / TICK_HZ;

/**
 * Column of open space between the docking berth (hulls end by x = 85) and the salvage bins
 * (from x = 92). Tows travel along it so a load never drags through the hull or a bin.
 */
export const HAUL_LANE_X = 88;

/** Pressure used by the debug injection tool, in bar. */
export const INJECT_PRESSURE_BAR = 10.0;
