/** World tile bitmask. One byte per tile in `World.tiles`. */
export const TileFlags = {
  VOID: 0x01,
  FLOOR: 0x02,
  BULKHEAD: 0x04,
  GIRDER: 0x08,
  HAZARD_LEAK: 0x10,
  /** A fuel tank (on a bulkhead tile): explodes when the torch cuts it or fire heats it. */
  FUEL: 0x20,
} as const;

export type TileFlag = (typeof TileFlags)[keyof typeof TileFlags];

const SOLID_MASK = TileFlags.BULKHEAD | TileFlags.GIRDER;

/** Bulkheads and girders both block gas. */
export function isSolid(flags: number): boolean {
  return (flags & SOLID_MASK) !== 0;
}

export function isLoadBearing(flags: number): boolean {
  return (flags & TileFlags.GIRDER) !== 0;
}

export function isVoid(flags: number): boolean {
  return (flags & TileFlags.VOID) !== 0 && !isSolid(flags);
}
