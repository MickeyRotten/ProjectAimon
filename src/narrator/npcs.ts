/**
 * The NPC appearance narrator — a physique/outfit line for EXAMINE, on the
 * same two-layer scheme the room narrator already uses:
 *
 *  - **physiqueDesc** — build, bearing, face. Written once on the first
 *    EXAMINE of this NPC, never regenerated. It never names clothing or gear.
 *  - **the woven render** — physiqueDesc plus whatever the NPC is currently
 *    wearing or wielding, written as one short paragraph. Cached by a
 *    signature of the NPC's worn/carried items, so re-examining an unchanged
 *    NPC is free and reads identically, and only a real gear change costs a
 *    call.
 *
 * Unlike room baseDesc, this is not batched: most NPCs are never examined, so
 * generating physique for every NPC in an area up front would spend calls on
 * NPCs the player never looks at. It generates lazily, on first EXAMINE.
 *
 * The narrator owns prose and nothing else — it is handed the NPC's worn and
 * carried items as data and writes them up; it never decides what those are.
 * With no API key, or on a failed call, this returns `undefined` and EXAMINE
 * stands on its persona line alone.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { seedFrom } from '../engine/rng';
import type { NpcRecord } from '../world/types';
import { heldBy } from '../world/types';
import type { World } from '../world/world';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

/** Cap on distinct cached renders per NPC, evicted least-recently-used. */
const RENDER_CAP = 8;

export class NpcNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  /** signature -> woven prose. */
  private readonly cache = new Map<string, string>();
  /** npcId -> signatures held for it, oldest first, for per-NPC LRU eviction. */
  private readonly perNpc = new Map<string, string[]>();

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * The physique/outfit line for EXAMINE, or `undefined` if there is no
   * narrator to ask. Everything here degrades silently — the caller already
   * has the persona line to fall back on.
   */
  async describeAppearance(world: World, npc: NpcRecord): Promise<string | undefined> {
    const physique = await this.ensurePhysique(world, npc);
    if (!physique) return undefined;

    const items = this.wornItemsOf(world, npc);
    const signature = this.signatureOf(npc, physique, items);

    const cached = this.cache.get(signature);
    if (cached !== undefined) return cached;

    const prose = await this.weave(physique, items);
    if (prose) this.remember(npc.id, signature, prose);
    return prose;
  }

  // ── layer one: the permanent physique, generated once per NPC ───────

  private async ensurePhysique(world: World, npc: NpcRecord): Promise<string | undefined> {
    if (npc.physiqueDesc && npc.physiqueDesc.trim().length > 0) return npc.physiqueDesc;

    const template = this.campaign.prompts['prompts/npc-physique.md'];
    if (!template) return undefined;

    const user = fill(template, {
      sex: npc.sex || 'someone',
      role: npc.role || npc.baseId,
      traits: npc.persona || npc.role || npc.baseId,
      tags: npc.tags.join(', ') || '—',
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
      if (reply.length === 0) return undefined;
      world.writeNpcProse(npc.id, { physiqueDesc: reply });
      return reply;
    } catch {
      return undefined;
    }
  }

  // ── layer two: the woven render ──────────────────────────────────────

  private async weave(physique: string, items: string[]): Promise<string | undefined> {
    const template = this.campaign.prompts['prompts/npc-appearance.md'];
    if (!template) return undefined;

    const list = items.length > 0 ? items.map((entry) => `- ${entry}`).join('\n') : 'Nothing notable.';
    const messages = [
      { role: 'system' as const, content: this.systemPrompt() },
      { role: 'user' as const, content: fill(template, { physique, items: list }) },
    ];

    try {
      const reply = clean(
        await this.client.complete({
          model: this.settings.narratorModel,
          messages,
          temperature: this.settings.temperature,
          maxTokens: this.settings.maxTokens,
        }),
      );
      return reply.length > 0 ? reply : undefined;
    } catch {
      return undefined;
    }
  }

  // ── what the NPC is wearing or carrying ──────────────────────────────

  /** Worn gear and any weapon, since a shopkeeper's whole stock is not "worn." */
  private wornItemsOf(world: World, npc: NpcRecord): string[] {
    return world
      .contentsOf(heldBy(npc.id))
      .objects.filter((object) => object.flags.worn || object.flags.weapon)
      .map((object) => object.name);
  }

  private signatureOf(npc: NpcRecord, physique: string, items: string[]): string {
    return `${npc.id}|${seedFrom(physique).toString(36)}|${[...items].sort().join(',')}`;
  }

  private remember(npcId: string, signature: string, prose: string): void {
    if (this.cache.has(signature)) return;
    this.cache.set(signature, prose);
    const held = this.perNpc.get(npcId) ?? [];
    held.push(signature);
    while (held.length > RENDER_CAP) {
      const evicted = held.shift();
      if (evicted) this.cache.delete(evicted);
    }
    this.perNpc.set(npcId, held);
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}
