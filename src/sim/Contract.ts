import { TICK_HZ } from './constants';
import type { ShipBlueprint } from './ships';
import type { World } from './World';

export const ContractState = {
  /** No ship under contract. */
  NONE: 0,
  ACTIVE: 1,
  PASSED: 2,
  FAILED: 3,
} as const;

export const CONTRACT_STATE_NAMES: readonly string[] = ['none', 'active', 'passed', 'failed'];

/** Delivered credits over quota needed for each grade, best first. Below quota is an F. */
const GRADES: readonly [number, string][] = [
  [1.5, 'A'],
  [1.2, 'B'],
  [1.0, 'C'],
];

/**
 * A salvage contract on one ship: deliver `quota` credits to the bins before the clock
 * runs out. It closes when time is up or when the player calls it, and is graded on
 * credits delivered against quota. Credits come from the world's salvage ledger, which
 * `buildShip` resets, so the ledger at close is the contract's take.
 */
export class Contract {
  state: number = ContractState.NONE;
  shipId = '';
  shipName = '';
  client = '';
  brief = '';
  quota = 0;
  limitTicks = 0;
  elapsedTicks = 0;
  /** Credits delivered when the contract closed. */
  finalCredits = 0;
  grade = '';

  /** No contract: back to the sandbox or the demo. */
  reset(): void {
    this.state = ContractState.NONE;
  }

  /** Opens a contract on a ship that has just been built with `buildShip`. */
  start(bp: ShipBlueprint): void {
    this.state = ContractState.ACTIVE;
    this.shipId = bp.id;
    this.shipName = bp.name;
    this.client = bp.contract.client;
    this.brief = bp.contract.brief;
    this.quota = bp.contract.quota;
    this.limitTicks = bp.contract.timeLimit * TICK_HZ;
    this.elapsedTicks = 0;
    this.finalCredits = 0;
    this.grade = '';
  }

  /** One fixed tick: runs the clock and closes the contract when it reaches the limit. */
  tick(world: World): void {
    if (this.state !== ContractState.ACTIVE) return;
    this.elapsedTicks++;
    if (this.elapsedTicks >= this.limitTicks) this.close(world);
  }

  /** Ends the contract now and grades it. */
  close(world: World): void {
    if (this.state !== ContractState.ACTIVE) return;
    const credits = world.salvage.credits;
    this.finalCredits = credits;
    const ratio = this.quota > 0 ? credits / this.quota : 0;
    this.grade = 'F';
    for (const [min, g] of GRADES) {
      if (ratio >= min) {
        this.grade = g;
        break;
      }
    }
    this.state = ratio >= 1 ? ContractState.PASSED : ContractState.FAILED;
  }

  get secondsLeft(): number {
    return Math.max(0, Math.ceil((this.limitTicks - this.elapsedTicks) / TICK_HZ));
  }
}
