/**
 * The LLM translator — the bridge between a failed Tier 1 parse and the rest
 * of the ladder. Two jobs, always in this order:
 *
 *  1. **toCommand** — try to rewrite the input as one canonical command in
 *     the game's own grammar, then hand it straight back to the deterministic
 *     parser. The model's words are never trusted directly: only whether
 *     `parse()` accepts what came back, and after that the ordinary scope
 *     resolver decides what any noun actually refers to. This is what keeps
 *     rule 3 — never trust an id the model returns — true even though this
 *     module never sees a real object id at all.
 *  2. **classify** — when even that fails, classify the attempt into the
 *     Tier 2 enum `{ stat, band, target }`. Here the model *is* allowed to
 *     name a real id, because `legalAttempt` (tier2.ts) checks it against the
 *     exact scope list this module sent before anything is resolved.
 *
 * And a third, which replaces both while a conversation is open:
 *
 *  3. **converse** — one call that decides which of the two the line even is,
 *     or neither. Standing in front of someone, most typing is speech, and
 *     speech wants a voiced reply — but the latency budget is two calls a
 *     turn and it stays two (docs/narration-and-input.md), so paying for
 *     `toCommand` *and* `classify` before the voice call is not available.
 *     One router call answers "command, attempt, or just talking?" and leaves
 *     the second call for the narrator. Validation is unchanged: a command
 *     re-enters `parse()`, an attempt goes through `legalAttempt`, and
 *     anything else — including anything malformed — is speech.
 *
 * Runs only after the parser has already failed, and each job runs at most
 * once per turn. A cheap, fast model with a hard token cap — this is
 * translation, not creativity — and every failure edge degrades to
 * `undefined` (or, for the router, to speech) so a bad key or a flaky model
 * never blocks a turn.
 */

import type { ResolvedCampaign, VerbTable } from '../campaign/types';
import { attributeNames } from '../content/stats';
import { parse, type Command } from '../engine/parser';
import { ruleNumberMap } from '../engine/rules';
import type { ScopeEntry } from '../game/scope';
import { legalAttempt, type Tier2Attempt } from '../game/tier2';
import type { NpcRecord } from '../world/types';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

/** The latency contract: a tiny model, capped hard, never the narrator's budget. */
const TRANSLATOR_MAX_TOKENS = 100;

const SYSTEM_PROMPT =
  'You translate player text into a fixed game grammar or a small classification. ' +
  'You never invent an object, an exit, an NPC or an outcome. You output only what is asked, nothing else.';

/**
 * What one line said inside a conversation turned out to be. `speech` is the
 * default and the common case: the engine decided nothing, so the narrator
 * answers in the NPC's own voice.
 */
export type ConverseRoute =
  | { kind: 'command'; command: Command }
  | { kind: 'attempt'; attempt: Tier2Attempt }
  | { kind: 'speech' };

const SPEECH: ConverseRoute = { kind: 'speech' };

export class Translator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  /** `roomId|raw` → the canonical text the model proposed, or null. */
  private readonly commandCache = new Map<string, string | null>();
  /** `roomId|raw` → the classifier's salvaged object, or null. */
  private readonly classifyCache = new Map<string, Record<string, unknown> | null>();
  /**
   * `roomId|partnerId|raw` → the router's salvaged object, or null. Keyed on
   * the partner as well as the room, because the same sentence said to two
   * different people is two different questions.
   */
  private readonly converseCache = new Map<string, Record<string, unknown> | null>();

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * One attempt at a canonical Tier 1 command, re-entering `parse()` exactly
   * once. Returns `undefined` on anything short of a clean re-parse — no
   * key, no prompt, a network failure, a "null" reply, or a reply the
   * grammar still refuses.
   */
  async toCommand(raw: string, roomId: string, scope: readonly ScopeEntry[], verbs: VerbTable): Promise<Command | undefined> {
    const key = `${roomId}|${raw}`;
    let text = this.commandCache.get(key);
    if (text === undefined) {
      text = await this.requestCommand(raw, scope, verbs);
      this.commandCache.set(key, text);
    }
    if (!text) return undefined;
    const reparsed = parse(text, verbs);
    return reparsed.ok ? reparsed.command : undefined;
  }

  /**
   * Classify the attempt into `{ stat, band, target }`, or `undefined`.
   * The caller (tier2.ts's `legalAttempt`) is what actually validates the
   * fields — this only salvages a shape out of whatever text came back.
   */
  async classify(raw: string, roomId: string, scope: readonly ScopeEntry[]): Promise<Record<string, unknown> | undefined> {
    const key = `${roomId}|${raw}`;
    if (this.classifyCache.has(key)) return this.classifyCache.get(key) ?? undefined;
    const result = await this.requestClassify(raw, scope);
    this.classifyCache.set(key, result ?? null);
    return result;
  }

  /**
   * The one call a conversation turn is allowed. Returns what the line was;
   * every validation is the engine's, exactly as it is for the other two
   * jobs, and every failure edge lands on `speech` rather than on an error —
   * being unable to classify what someone said is not a reason to refuse to
   * answer them.
   */
  async converse(
    raw: string,
    roomId: string,
    scope: readonly ScopeEntry[],
    verbs: VerbTable,
    partner: NpcRecord,
  ): Promise<ConverseRoute> {
    const key = `${roomId}|${partner.id}|${raw}`;
    let salvaged = this.converseCache.get(key);
    if (salvaged === undefined) {
      salvaged = (await this.requestConverse(raw, scope, verbs, partner)) ?? null;
      this.converseCache.set(key, salvaged);
    }
    if (!salvaged) return SPEECH;

    const kind = typeof salvaged.kind === 'string' ? salvaged.kind.toLowerCase() : '';
    if (kind === 'command') {
      // Same contract as `toCommand`: the model's words are never trusted,
      // only whether the deterministic parser accepts them.
      const text = typeof salvaged.command === 'string' ? salvaged.command.trim() : '';
      if (!text) return SPEECH;
      const reparsed = parse(text, verbs);
      return reparsed.ok ? { kind: 'command', command: reparsed.command } : SPEECH;
    }
    if (kind === 'attempt') {
      // Rule 3 again: `legalAttempt` checks the target against the exact
      // scope list this module sent, and rejects anything else.
      const attempt = legalAttempt(this.campaign.rules, scope, salvaged);
      return attempt ? { kind: 'attempt', attempt } : SPEECH;
    }
    return SPEECH;
  }

  private async requestConverse(
    raw: string,
    scope: readonly ScopeEntry[],
    verbs: VerbTable,
    partner: NpcRecord,
  ): Promise<Record<string, unknown> | undefined> {
    const template = this.campaign.prompts['prompts/converse.md'];
    if (!template) return undefined;

    const user = fill(template, {
      partner: partner.name,
      partner_note: partner.isVendor ? ', who sells things' : '',
      stats: attributeNames(this.campaign.rules).join(', '),
      bands: Object.keys(ruleNumberMap(this.campaign.rules, 'DIFFICULTY_BASE')).join(', '),
      verbs: verbs.verbs.map((verb) => verb.words[0] as string).join(', '),
      scope: scope.map((entry) => `- ${entry.id}: ${entry.name}`).join('\n'),
      input: raw,
    });
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: user },
    ];

    try {
      const reply = await this.client.complete({
        model: this.settings.translatorModel,
        messages,
        temperature: 0,
        maxTokens: TRANSLATOR_MAX_TOKENS,
      });
      const salvaged = salvageRoute(reply);
      if (salvaged) return salvaged;

      // One repair call, fired only after salvage fails — same as classify.
      const repair = await this.client.complete({
        model: this.settings.translatorModel,
        messages: [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: 'Emit only the JSON object, with a "kind" of command, attempt or speech.' },
        ],
        temperature: 0,
        maxTokens: TRANSLATOR_MAX_TOKENS,
      });
      return salvageRoute(repair);
    } catch {
      return undefined;
    }
  }

  private async requestCommand(raw: string, scope: readonly ScopeEntry[], verbs: VerbTable): Promise<string | null> {
    const template = this.campaign.prompts['prompts/translate.md'];
    if (!template) return null;

    const user = fill(template, {
      verbs: verbs.verbs.map((verb) => verb.words[0] as string).join(', '),
      scope: scope.map((entry) => `- ${sayableName(entry)}`).join('\n'),
      input: raw,
    });

    try {
      const reply = clean(
        await this.client.complete({
          model: this.settings.translatorModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: user },
          ],
          temperature: 0,
          maxTokens: TRANSLATOR_MAX_TOKENS,
        }),
      );
      if (!reply || reply.toLowerCase() === 'null') return null;
      return reply;
    } catch {
      return null;
    }
  }

  private async requestClassify(raw: string, scope: readonly ScopeEntry[]): Promise<Record<string, unknown> | undefined> {
    const template = this.campaign.prompts['prompts/classify.md'];
    if (!template) return undefined;

    const user = fill(template, {
      stats: attributeNames(this.campaign.rules).join(', '),
      bands: Object.keys(ruleNumberMap(this.campaign.rules, 'DIFFICULTY_BASE')).join(', '),
      scope: scope.map((entry) => `- ${entry.id}: ${entry.name}`).join('\n'),
      input: raw,
    });
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: user },
    ];

    try {
      const reply = await this.client.complete({
        model: this.settings.translatorModel,
        messages,
        temperature: 0,
        maxTokens: TRANSLATOR_MAX_TOKENS,
      });
      const salvaged = salvageClassify(reply);
      if (salvaged) return salvaged;

      // One repair call, fired only after salvage fails.
      const repair = await this.client.complete({
        model: this.settings.translatorModel,
        messages: [
          ...messages,
          { role: 'assistant', content: reply },
          { role: 'user', content: 'Emit only the JSON object: { "stat": ..., "band": ..., "target": ... }' },
        ],
        temperature: 0,
        maxTokens: TRANSLATOR_MAX_TOKENS,
      });
      return salvageClassify(repair);
    } catch {
      return undefined;
    }
  }
}

/**
 * The router's object, read as leniently as the classifier's: alias keys are
 * normalised so an attempt still validates, and a reply with no usable `kind`
 * at all is dropped so the caller falls to speech.
 */
function salvageRoute(text: string): Record<string, unknown> | undefined {
  const candidates = extractCandidateObjects(text);
  if (candidates.length === 0) return undefined;
  let merged: Record<string, unknown> = {};
  for (const candidate of candidates) merged = { ...merged, ...normaliseKeys(candidate) };
  for (const value of Object.values(merged)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged = { ...merged, ...normaliseKeys(value as Record<string, unknown>) };
    }
  }
  return typeof merged.kind === 'string' ? merged : undefined;
}

/** What the model should say to name a scope entry in a plain-text command. */
function sayableName(entry: ScopeEntry): string {
  const words = [...entry.nouns, ...entry.adjectives].filter((word) => word.length > 0);
  return words.length > 0 ? `${entry.name} — say "${words[0]}"` : entry.name;
}

const STAT_ALIASES = ['stat', 'attribute', 'attr'];
const BAND_ALIASES = ['band', 'difficulty', 'tier'];
const TARGET_ALIASES = ['target', 'npc', 'id', 'who'];

/** Map the alias keys a model actually reaches for onto the contract's own names. */
function normaliseKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (STAT_ALIASES.includes(lower)) out.stat = value;
    else if (BAND_ALIASES.includes(lower)) out.band = value;
    else if (TARGET_ALIASES.includes(lower)) out.target = value;
    else out[key] = value;
  }
  return out;
}

/** The last balanced `{...}` block in the text — the no-marker fallback. */
function lastBraceBalancedObject(text: string): string | undefined {
  for (let end = text.length - 1; end >= 0; end--) {
    if (text[end] !== '}') continue;
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      if (text[start] === '}') depth++;
      else if (text[start] === '{') {
        depth--;
        if (depth === 0) return text.slice(start, end + 1);
      }
    }
  }
  return undefined;
}

function extractCandidateObjects(text: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [parsed as Record<string, unknown>];
  } catch {
    // fall through to the brace scan below
  }
  const block = lastBraceBalancedObject(text);
  if (!block) return [];
  try {
    const parsed = JSON.parse(block);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
  } catch {
    return [];
  }
}

/**
 * Emit canonical, read lenient: accept alias keys, accept the fields nested
 * one level down (under a wrapper key such as `attempt`) *and* at the top
 * level, merged with the nested answer winning, and fall back to the last
 * brace-balanced object when there is no clean marker at all.
 */
function salvageClassify(text: string): Record<string, unknown> | undefined {
  const candidates = extractCandidateObjects(text);
  if (candidates.length === 0) return undefined;

  let merged: Record<string, unknown> = {};
  for (const candidate of candidates) merged = { ...merged, ...normaliseKeys(candidate) };
  for (const value of Object.values(merged)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged = { ...merged, ...normaliseKeys(value as Record<string, unknown>) };
    }
  }

  if (merged.stat === undefined && merged.band === undefined && merged.target === undefined) return undefined;
  return merged;
}
