/**
 * The NPC appearance narrator — a single EXAMINE description per NPC,
 * generated once and rechecked, never regenerated wholesale on every look:
 *
 *  - **First EXAMINE**: generated from the NPC's tags, persona, role, sex,
 *    current worn/wielded items, and its surrounding context (room tags and
 *    area theme), written permanently as `description`.
 *  - **Every later EXAMINE**: free, unless the game transcript has grown
 *    since `descriptionSeen` (the transcript length as of the last time this
 *    NPC's description was generated or confirmed unchanged). When it has,
 *    one call judges whether anything narrated since then would have changed
 *    the NPC's appearance and, if so, rewrites the description grounded in
 *    the old text plus what changed; either way `descriptionSeen` advances,
 *    so the same history is never rescanned.
 *
 * Turn number is deliberately not the clock here: EXAMINE itself costs a
 * turn (`free: false`), so `game.turn` advances on every single EXAMINE and
 * can never tell two back-to-back examines of the same NPC apart from a
 * real gap. `Game.transcript` grows by exactly one entry per submitted
 * command regardless, so its length is the clock that actually works.
 *
 * The narrator owns prose and nothing else — it is handed the NPC's worn and
 * carried items as data and writes them up; it never decides what those are.
 * With no API key, or on a failed call, this returns `undefined` (first
 * generation) or the last-known-good text (a failed recheck), and EXAMINE
 * stands on its persona line alone or its prior description, never blank.
 */

import type { ResolvedCampaign } from '../campaign/types';
import type { TranscriptEntry } from '../game/game';
import type { NpcRecord } from '../world/types';
import { heldBy, roomOfLocation } from '../world/types';
import type { World } from '../world/world';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill, formatHistory } from './text';

interface Judged {
  changed: boolean;
  description: string;
}

export class NpcNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * The EXAMINE description, or `undefined` if there is no narrator to ask
   * and nothing generated yet. `history` is the whole game transcript —
   * unscoped, exactly what NPC voicing already uses — and by the time this
   * runs it already includes the current EXAMINE's own just-pushed entry.
   */
  async describeAppearance(
    world: World,
    npc: NpcRecord,
    history: readonly TranscriptEntry[],
  ): Promise<string | undefined> {
    const priorLength = Math.max(0, history.length - 1);

    if (!npc.description && !npc.physiqueDesc) {
      const fresh = await this.generate(world, npc);
      if (!fresh) return undefined;
      world.writeNpcProse(npc.id, { description: fresh, descriptionSeen: history.length });
      return fresh;
    }

    if (!npc.description && npc.physiqueDesc) {
      // A save from before this scheme existed. Seed from the old permanent
      // physique line rather than discarding it — no call, no regeneration.
      const seeded = npc.physiqueDesc.trim();
      world.writeNpcProse(npc.id, { description: seeded, descriptionSeen: history.length });
      return seeded;
    }

    const seen = npc.descriptionSeen ?? 0;
    if (priorLength <= seen) {
      // Nothing has happened since the last check but more EXAMINEs of this
      // NPC — still advance the checkpoint, or the next repeat would look
      // stale again purely from EXAMINE's own turns piling up.
      world.writeNpcProse(npc.id, { descriptionSeen: history.length });
      return npc.description;
    }

    return this.recheck(world, npc, history.slice(seen, priorLength), history.length);
  }

  // ── fresh generation, once per NPC ───────────────────────────────────

  private async generate(world: World, npc: NpcRecord): Promise<string | undefined> {
    const template = this.campaign.prompts['prompts/npc-appearance.md'];
    if (!template) return undefined;

    const items = this.wornItemsOf(world, npc);
    const user = fill(template, {
      sex: npc.sex || 'someone',
      role: npc.role || npc.baseId,
      traits: npc.persona || npc.role || npc.baseId,
      tags: npc.tags.join(', ') || '—',
      items: items.length > 0 ? items.map((entry) => `- ${entry}`).join('\n') : 'Nothing notable.',
      context: this.contextOf(world, npc),
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

  // ── the recheck: judge, and rewrite only if warranted ────────────────

  private async recheck(
    world: World,
    npc: NpcRecord,
    window: readonly TranscriptEntry[],
    newSeen: number,
  ): Promise<string | undefined> {
    const current = npc.description ?? '';
    const template = this.campaign.prompts['prompts/npc-appearance-update.md'];
    if (!template) return current || undefined;

    const items = this.wornItemsOf(world, npc);
    const user = fill(template, {
      old: current,
      history: formatHistory(window, window.length),
      items: items.length > 0 ? items.map((entry) => `- ${entry}`).join('\n') : 'Nothing notable.',
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
      const judged = parseJudgeReply(reply, current);
      world.writeNpcProse(npc.id, {
        descriptionSeen: newSeen,
        ...(judged.changed ? { description: judged.description } : {}),
      });
      return judged.changed ? judged.description : current || undefined;
    } catch {
      // Leave descriptionSeen untouched: a transient failure is retried on
      // the next EXAMINE against the same (or larger) window, rather than
      // silently marking history it never actually looked at as seen.
      return current || undefined;
    }
  }

  // ── what the NPC is wearing or carrying, and where it's standing ─────

  /** Worn gear and any weapon, since a shopkeeper's whole stock is not "worn." */
  private wornItemsOf(world: World, npc: NpcRecord): string[] {
    return world
      .contentsOf(heldBy(npc.id))
      .objects.filter((object) => object.flags.worn || object.flags.weapon)
      .map((object) => object.name);
  }

  /** Room tags and area theme tokens — the same grounding a room's baseDesc gets. */
  private contextOf(world: World, npc: NpcRecord): string {
    const roomId = roomOfLocation(npc.location);
    const room = roomId ? world.rooms.get(roomId) : undefined;
    const area = room ? world.areas.get(room.areaId) : undefined;
    const bits = [...(room?.tags ?? []), ...(area?.themeTokens ?? [])];
    return bits.length > 0 ? bits.join(', ') : '—';
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}

/**
 * Read the judge+rewrite reply. The emit shape is `CHANGED: yes|no` then,
 * only when changed, a `DESCRIPTION:` line — but the safe default on any
 * malformed or ambiguous reply is always "nothing changed," never a blanked
 * record: `CHANGED: yes` with no description that follows is treated as
 * unchanged, and no `CHANGED:` marker at all is treated as unchanged too.
 */
function parseJudgeReply(reply: string, fallback: string): Judged {
  const match = /CHANGED\s*:\s*([^\n]*)/i.exec(reply);
  const verdict = match?.[1]?.trim().toLowerCase() ?? '';
  const changed = verdict.length > 0 && !/^(no|none|unchanged|no change)/.test(verdict);
  if (!changed) return { changed: false, description: fallback };

  const descMatch = /DESCRIPTION\s*:\s*([\s\S]*)/i.exec(reply);
  const description = descMatch?.[1] ? clean(descMatch[1]) : '';
  if (description.length === 0) return { changed: false, description: fallback };
  return { changed: true, description };
}
