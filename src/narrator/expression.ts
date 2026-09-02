/**
 * Expression narration — the ephemeral half of the narrator's work. A flavour
 * verb (smell, listen, grope, …) or a Tier 3 line the player just spoke into
 * the air has no mechanical outcome at all: nothing rolled, nothing changed.
 * So unlike room descriptions and NPC appearance, this is **never cached** —
 * freshness is the whole point, and a repeated `smell` should read differently
 * each time.
 *
 * Like every narrator it only ever writes; it resolves nothing. The caller
 * carries a canned fallback line for when there is no key, and this returns an
 * empty string (never throws to the caller) when it cannot produce prose, so
 * the fallback stands.
 */

import type { ResolvedCampaign } from '../campaign/types';
import type { TranscriptEntry } from '../game/game';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill, formatHistory } from './text';

export interface ExpressionInput {
  areaName: string;
  areaTone: string;
  history: readonly TranscriptEntry[];
  roomName: string;
  roomDesc: string;
  /** What the player typed, verbatim. */
  raw: string;
  /** The flavour verb, when there is one; absent for pure Tier 3 expression. */
  verb?: string | undefined;
  /** What the verb was aimed at, when it named something in scope. */
  target?: string | undefined;
}

export class ExpressionNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /** A short, fresh, in-world reaction. Returns '' when it cannot produce one. */
  async narrate(input: ExpressionInput): Promise<string> {
    const template = this.campaign.prompts['prompts/expression.md'];
    if (!template) return '';

    const action = input.verb
      ? `${input.verb}${input.target ? ` the ${input.target}` : ''}`
      : '(speaking or thinking aloud, not aimed at anyone)';

    const user = fill(template, {
      standing: `${input.areaName} — ${input.areaTone}`.trim(),
      history: formatHistory(input.history),
      state: `${input.roomName}\n${input.roomDesc}`,
      action,
      input: input.raw,
    });

    try {
      return clean(
        await this.client.complete({
          model: this.settings.narratorModel,
          messages: [
            { role: 'system', content: this.systemPrompt() },
            { role: 'user', content: user },
          ],
          temperature: this.settings.temperature,
          maxTokens: this.settings.maxTokens,
        }),
      );
    } catch {
      return '';
    }
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}
