/**
 * Outcome narration — the narrator's third job. By the time this runs the
 * engine has already decided everything: the roll, the effect, the state
 * change. This module only writes it up, from the packet
 * docs/narration-and-input.md orders — standing context, turn context,
 * history, state of play, this turn's facts, then the player's own input —
 * with **every fact stated exactly once** and the state of play placed
 * before the facts, so the transcript never contradicts what just happened.
 *
 * Used today for Tier 2 outcomes. The engine's own mechanical lines (the
 * roll, the numbers) stay on screen regardless of whether this call
 * succeeds — this only adds prose alongside them, never in place of the
 * truth.
 */

import type { ResolvedCampaign } from '../campaign/types';
import type { TranscriptEntry } from '../game/game';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

export interface OutcomeInput {
  areaName: string;
  areaTone: string;
  history: readonly TranscriptEntry[];
  roomName: string;
  roomDesc: string;
  /** The engine's own sentences for what just happened — never contradicted. */
  facts: readonly string[];
  raw: string;
}

/** How many recent turns of transcript the packet's history tier carries. */
const HISTORY_WINDOW = 6;

export class OutcomeNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  async narrate(input: OutcomeInput): Promise<string | undefined> {
    const template = this.campaign.prompts['prompts/outcome.md'];
    if (!template) return undefined;

    const history = input.history
      .slice(-HISTORY_WINDOW)
      .map((entry) => `> ${entry.input}\n${entry.output}`)
      .join('\n\n');

    const user = fill(template, {
      standing: `${input.areaName} — ${input.areaTone}`.trim(),
      turn_context: '',
      history: history || '(nothing yet)',
      state: `${input.roomName}\n${input.roomDesc}`,
      facts: input.facts.join(' '),
      input: input.raw,
    });

    try {
      const reply = clean(
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
      return reply.length > 0 ? reply : undefined;
    } catch {
      return undefined;
    }
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}
