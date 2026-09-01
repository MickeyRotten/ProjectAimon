/**
 * Tier 2 — free actions with stakes.
 *
 * *"I tell the innkeeper about my brother and ask if he knew him."* No
 * canonical command covers this, so the Translator classifies the attempt
 * into a small engine-owned enum — `{ stat, band, target }` — and this module
 * is what validates and resolves it.
 *
 * **The model never picks the effect.** It says what kind of attempt this was
 * and against whom; the engine looks up whether the target has a valid
 * handler, rolls, and decides the state change from a closed vocabulary:
 * disposition, HP, gold, time, a condition, a flag. Never a new object, exit,
 * NPC or goal — and never chosen by the classifier. See
 * docs/narration-and-input.md, "Tier 2 — free actions with stakes".
 *
 * The check itself is the one `docs/gameplay-rules.md` names for anything
 * outside combat: `chance = 3 × attribute + base`, clamped the same way a
 * combat roll is — `clampChance` is imported rather than restated.
 */

import { attributeNames } from '../content/stats';
import type { Rng } from '../engine/rng';
import { ruleNumberMap } from '../engine/rules';
import { clampChance } from './combat';
import { line, type CommandContext, type Line } from './commands';
import type { Effect } from './effects';
import type { ScopeEntry } from './scope';

/** The only shape the Translator's classifier is ever allowed to hand back. */
export interface Tier2Attempt {
  stat: string;
  band: string;
  target: string | null;
}

export interface Tier2Reply {
  lines: Line[];
  effects: Effect[];
  outcome: 'success' | 'failure';
}

/**
 * Validate a classifier's raw guess into a legal attempt, or reject it
 * outright. Rule 3: never trust an id the model returns — `target` must be
 * one of the ids in the scope list that was actually sent. Anything illegal
 * here is not an attempt at all; the caller falls through to Tier 3.
 */
export function legalAttempt(
  rules: import('../campaign/merge').JsonObject,
  scope: readonly ScopeEntry[],
  candidate: unknown,
): Tier2Attempt | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const value = candidate as Record<string, unknown>;

  const stat = value.stat;
  if (typeof stat !== 'string' || !attributeNames(rules).includes(stat)) return undefined;

  const band = value.band;
  const bands = Object.keys(ruleNumberMap(rules, 'DIFFICULTY_BASE'));
  if (typeof band !== 'string' || !bands.includes(band)) return undefined;

  const rawTarget = value.target;
  let target: string | null;
  if (rawTarget === null || rawTarget === undefined) {
    target = null;
  } else if (typeof rawTarget === 'string' && scope.some((entry) => entry.id === rawTarget)) {
    target = rawTarget;
  } else {
    return undefined; // an id outside the sent scope — discard, do not resolve
  }

  return { stat, band, target };
}

/**
 * Roll the attempt and pick the state change. The engine chooses the effect
 * by what the target actually is, never by anything the model said:
 *
 * - a non-hostile NPC: disposition moves, up on success, down on failure
 * - a hostile NPC: disposition never moves; failure costs Resolve instead
 * - no target (self, or an expression with nobody to aim at): failure costs
 *   Resolve; success changes nothing mechanical
 * - an object or door: nothing mechanical either way — the turn is the cost
 */
export function resolveAttempt(ctx: CommandContext, attempt: Tier2Attempt, rng: Rng): Tier2Reply {
  const rules = ctx.campaign.rules;
  const attributeValue = attributeValueOf(ctx, attempt.stat);
  const base = ruleNumberMap(rules, 'DIFFICULTY_BASE')[attempt.band] ?? 0;
  const chance = clampChance(rules, 3 * attributeValue + base);
  const roll = rng.int(1, 100);
  const success = roll <= chance;

  const lines: Line[] = [
    line(
      `(${attempt.stat}, ${attempt.band}: ${chance}% — rolled ${roll}, ${success ? 'a success' : 'a failure'})`,
      'roll',
    ),
  ];
  const effects: Effect[] = [];

  const target = attempt.target ? ctx.scope.find((entry) => entry.id === attempt.target) : undefined;
  if (target?.npc) {
    if (target.npc.hostile) {
      if (!success) effects.push({ kind: 'resolve', delta: -1 });
    } else {
      effects.push({ kind: 'npcDisposition', id: target.npc.id, delta: success ? 2 : -2 });
    }
  } else if (!target && !success) {
    effects.push({ kind: 'resolve', delta: -1 });
  }

  return { lines, effects, outcome: success ? 'success' : 'failure' };
}

/** The player's raw score for a Tier 2 stat, read the same way the game names it. */
function attributeValueOf(ctx: CommandContext, stat: string): number {
  const stats = ctx.player.stats as unknown as Record<string, number>;
  return stats[stat] ?? 0;
}
