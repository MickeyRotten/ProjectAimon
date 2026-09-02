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

import type { Location, ObjectFlags, NpcRecord } from '../world/types';

/** The flags that are true-or-false. `lockedById` is a pointer, not a switch. */
export type BooleanFlag = Exclude<keyof ObjectFlags, 'lockedById'>;

/**
 * A change to the volatile combat session. It is bookkeeping — primers,
 * stances, recharge counters, the round — so it is grouped under one effect
 * rather than spreading a dozen kinds across the union. `who` is `player` or an
 * npc id. Applied at a write point like everything else.
 */
export type CombatOp =
  | { t: 'begin' }
  | { t: 'end' }
  | { t: 'round' }
  | { t: 'tickRecharge' }
  | { t: 'primer'; who: string; value: string }
  | { t: 'stance'; who: string; value: string }
  | { t: 'recharge'; who: string; ability: string; rounds: number }
  | { t: 'useEncounter'; who: string; ability: string }
  | { t: 'threat'; who: string; delta: number }
  | { t: 'sense'; id: string };

/**
 * A change to the open conversation. Like `CombatOp` this is bookkeeping — who
 * the player is talking to, and whether anyone is — so it is grouped under one
 * effect rather than spreading kinds across the union. Opening is what makes
 * the "turns to hear you out" line fire once rather than every turn, and what
 * routes later free text to that person instead of into Tier 3's echo.
 */
export type ConverseOp = { t: 'open'; npcId: string } | { t: 'close' };

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
  /** A Tier 2 outcome against a non-hostile NPC. Never chosen by the model —
   * the engine picks this from Tier 2's closed effect vocabulary. */
  | { kind: 'npcDisposition'; id: string; delta: number }
  /** Extra turns the world half must burn — the cost of a forced retreat. */
  | { kind: 'extraTurns'; turns: number }
  /** Take on an offered quest. Rolls the band and places the objective on apply. */
  | { kind: 'acceptQuest'; questId: string }
  /** Mark a quest complete and grant its rewards, gold into the purse. */
  | { kind: 'completeQuest'; questId: string }
  /** Fail a quest whose giver has died. */
  | { kind: 'failQuest'; questId: string }
  // ── combat ──────────────────────────────────────────────────────────
  | { kind: 'npcHp'; id: string; delta: number }
  | { kind: 'npcResolve'; id: string; delta: number }
  /** A killing blow: the creature becomes a corpse and drops its purse. */
  | { kind: 'npcDead'; id: string }
  /** A Presence break — flee, surrender or join — read from friendliness. */
  | { kind: 'npcBreak'; id: string; outcome: string }
  /** A creature summoned mid-fight by `call_help` or a leader's escort. */
  | { kind: 'spawnCreature'; record: NpcRecord }
  /** Skill growth on a landed hit or absorbed damage. Player only. */
  | { kind: 'growSkill'; axis: 'weapon' | 'approach' | 'armour'; id: string; delta: number }
  /** The player is beaten — the corpse run. `victorId` keeps their goods. */
  | { kind: 'defeatPlayer'; victorId: string; by: string }
  /** A change to the volatile combat session. */
  | { kind: 'combat'; op: CombatOp }
  /** A change to the open conversation — who is being talked to, or nobody. */
  | { kind: 'converse'; op: ConverseOp };
