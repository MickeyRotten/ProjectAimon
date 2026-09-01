/**
 * State changes, described but not applied.
 *
 * Rule one of the project: game state is written in exactly two places — step
 * 7 of the turn loop for the player half, step 12 for the world half. A
 * command handler cannot write state; it returns effects, and the turn loop
 * applies them at the one point it is allowed to. Writing state from inside a
 * handler is the bug that ate the predecessor project, so the type system is
 * put in the way of it.
 */

import type { Location, ObjectFlags } from '../world/types';

/** The flags that are true-or-false. `lockedById` is a pointer, not a switch. */
export type BooleanFlag = Exclude<keyof ObjectFlags, 'lockedById'>;

export type Effect =
  | { kind: 'movePlayer'; roomId: string }
  /** Walk through an ungenerated gate. Generation happens on apply, once. */
  | { kind: 'enterGate'; edgeId: string }
  | { kind: 'moveObject'; id: string; location: Location }
  | { kind: 'setObjectFlag'; id: string; flag: BooleanFlag; value: boolean }
  | { kind: 'setBurn'; id: string; turns: number }
  | { kind: 'wield'; id: string }
  | { kind: 'wear'; id: string }
  | { kind: 'purse'; delta: number }
  | { kind: 'hp'; delta: number }
  | { kind: 'resolve'; delta: number }
  | { kind: 'libido'; delta: number }
  | { kind: 'visit'; roomId: string }
  | { kind: 'brief'; value: boolean }
  | { kind: 'pronoun'; ref: string; id: string }
  | { kind: 'worldFlag'; id: string; value: boolean }
  /** Extra turns the world half must burn — the cost of a forced retreat. */
  | { kind: 'extraTurns'; turns: number };
