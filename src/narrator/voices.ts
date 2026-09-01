/**
 * NPC voicing — the narrator's second job. `talk`, `ask`, `tell` and `say`
 * already decided everything mechanical (which NPC, what quest state, the
 * pronoun update); this module only writes up what that NPC says back.
 *
 * The engine can never be told to add, promote or remove anything from
 * here — a reply is prose, read by the player and by nobody else. Runs after
 * the mechanical turn has resolved and saved, same discipline the room
 * narrator's `narrateHere` already follows in main.ts.
 */

import type { ResolvedCampaign } from '../campaign/types';
import type { NpcRecord } from '../world/types';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

export class VoiceNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * What the NPC says back to `raw`, about `topic` if there was one. Always
   * degrades to a short, truthful, in-character line rather than throwing or
   * leaving the player without a reply.
   */
  async speak(npc: NpcRecord, raw: string, topic: string): Promise<string> {
    const template = this.campaign.prompts['prompts/npc-voice.md'];
    if (!template) return this.fallback(npc);

    const user = fill(template, {
      name: npc.name,
      persona: npc.persona || `${npc.role || 'someone'} out of ${npc.baseId}.`,
      disposition: describeDisposition(npc.disposition),
      input: raw,
      topic_line: topic ? `The topic: ${topic}` : '',
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
      return reply.length > 0 ? reply : this.fallback(npc);
    } catch {
      return this.fallback(npc);
    }
  }

  private fallback(npc: NpcRecord): string {
    return `${npc.name} has nothing to say about that right now.`;
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}

function describeDisposition(disposition: number): string {
  if (disposition >= 20) return 'warm toward the player';
  if (disposition >= 5) return 'favourably inclined';
  if (disposition <= -20) return 'hostile in manner, if not in combat';
  if (disposition <= -5) return 'cold toward the player';
  return 'neutral toward the player';
}
