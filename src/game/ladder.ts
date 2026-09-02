/**
 * Step 3 — the tier ladder. Which tier one line of input belongs to, and
 * nothing else: every branch here ends in a `Game` call that does the actual
 * work at the ordinary write points.
 *
 * Two ladders, depending on whether the player is mid-conversation.
 *
 * **Standing alone** — the original one. Tier 1 first, always: the parser is
 * free, deterministic and right about most of what gets typed. On a miss, ask
 * the translator to rewrite it as a canonical command; on a miss there, ask
 * the classifier for a Tier 2 attempt; failing both, Tier 3 flavour.
 *
 * **Talking to someone** — one router call replaces those two, and the
 * terminal changes. Free text in front of a person is usually *speech*, and
 * speech deserves an answer rather than Tier 3's bare echo — but the latency
 * budget is two LLM calls a turn and it stays two, so a turn cannot afford
 * `toCommand`, then `classify`, then the voice call. The router answers all
 * of "command, attempt, or just talking?" in one, leaving the second call for
 * the narrator to write the reply with.
 *
 * Tier 1 still runs first in both. The parser is what handles everything that
 * needs no prose — walking out, checking the map, drawing a weapon — and being
 * mid-conversation never takes those away.
 */

import type { VerbTable } from '../campaign/types';
import type { JsonObject } from '../campaign/merge';
import type { Translator } from '../narrator/translate';
import type { Game, TurnResult } from './game';
import { legalAttempt } from './tier2';

export interface LadderDeps {
  game: Game;
  /** Absent with no API key: the ladder then stops at Tier 1, as it always did. */
  translator: Translator | undefined;
  verbs: VerbTable;
  rules: JsonObject;
}

export async function stepThrough(deps: LadderDeps, raw: string): Promise<TurnResult> {
  const { game, translator } = deps;

  // `plan()` is called exactly once per input — it consumes a pending
  // disambiguation answer the moment it runs, so a second call would silently
  // drop that answer.
  const plan = game.plan(raw);
  if (plan.kind !== 'unparsed' || !translator) return game.respond(raw, plan);

  const ctx = game.context();
  const roomId = game.room.id;
  const partner = game.partner();

  if (partner) {
    const route = await translator.converse(raw, roomId, ctx.scope, deps.verbs, partner);
    if (route.kind === 'command') return game.run(raw, route.command);
    if (route.kind === 'attempt') return game.resolveTier2(raw, route.attempt);
    return game.speakTo(raw, partner.id);
  }

  const translated = await translator.toCommand(raw, roomId, ctx.scope, deps.verbs);
  if (translated) return game.run(raw, translated);

  const classified = await translator.classify(raw, roomId, ctx.scope);
  const attempt = classified ? legalAttempt(deps.rules, ctx.scope, classified) : undefined;
  if (attempt) return game.resolveTier2(raw, attempt);

  return game.tier3(raw);
}
