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
import { clean, fill, formatHistory } from './text';

export interface OutcomeInput {
  areaName: string;
  areaTone: string;
  history: readonly TranscriptEntry[];
  roomName: string;
  roomDesc: string;
  /** The engine's own sentences for what just happened — never contradicted. */
  facts: readonly string[];
  raw: string;
  /** Already decided by the engine; the fallback needs it when the model can't be reached. */
  outcome: 'success' | 'failure';
}

export class OutcomeNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * Prose for a Tier 2 outcome. Always degrades to a short, truthful line
   * built from the outcome the engine already decided — a Tier 2 attempt has
   * no other text of its own, so unlike the room and voice narrators this one
   * cannot leave the player with silence when the model can't be reached.
   */
  async narrate(input: OutcomeInput): Promise<string> {
    const template = this.campaign.prompts['prompts/outcome.md'];
    if (!template) return this.fallback(input);

    const user = fill(template, {
      standing: `${input.areaName} — ${input.areaTone}`.trim(),
      turn_context: '',
      history: formatHistory(input.history),
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
      return reply.length > 0 ? reply : this.fallback(input);
    } catch {
      return this.fallback(input);
    }
  }

  private fallback(input: OutcomeInput): string {
    return input.outcome === 'success'
      ? 'It goes over about as well as you hoped.'
      : "It doesn't land the way you hoped.";
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}
