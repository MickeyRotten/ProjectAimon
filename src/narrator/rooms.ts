/**
 * The room narrator — the first and largest of the narrator's three jobs:
 * naming and describing a room the first time its area is entered.
 *
 * **One layer, one call per area.** The first time anyone walks into an area,
 * a single batch call writes a permanent `baseDesc` (and name) for every room
 * in it that does not already have one, plus the area's own name. Rooms read
 * as one place because they were written together, and because it is written
 * once and stored on the record, returning to a room — or walking deeper into
 * the area — costs nothing and never pops in.
 *
 * The Hub ships hand-authored `baseDesc` and names in `campaign.json`, so its
 * rooms are never pending and the batch makes no call there at all.
 *
 * Current contents (an NPC, a dropped sword) are not woven into this prose:
 * they change turn to turn, so the screen lists them mechanically in a
 * `Here: …` line beside the description rather than paying an LLM call to fold
 * them in. The narrator owns the permanent description and nothing else; its
 * output is read by the player and by no other part of the system. When there
 * is no API key, or the call fails, `baseDesc` stays empty and the structural
 * placeholder stands — the game is always playable without a narrator.
 */

import type { ResolvedCampaign } from '../campaign/types';
import type { RoomRecord } from '../world/types';
import type { World } from '../world/world';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

export class RoomNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  /** Areas whose baseDescs are being (or have been) generated, so we batch once. */
  private readonly baseDone = new Set<string>();

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * Ensure the room's whole area has been described: fill every empty
   * `baseDesc` in it, and its name, in one batch call. Done once per area per
   * session; a persisted baseDesc from an earlier visit — or the Hub's
   * hand-authored one — is left alone, so an area with nothing pending makes no
   * call. The prose lands on the records via `world.writeProse`; the screen
   * reads it back from there, so this returns nothing.
   */
  async ensureArea(world: World, room: RoomRecord): Promise<void> {
    if (this.baseDone.has(room.areaId)) return;
    this.baseDone.add(room.areaId);

    const rooms = world.roomsOf(room.areaId).sort((a, b) => a.id.localeCompare(b.id));
    const pending = rooms.filter((entry) => entry.baseDesc.trim().length === 0);
    if (pending.length === 0) return;

    const template = this.campaign.prompts['prompts/room-base.md'];
    if (!template) return; // no prompt, no batch — placeholders stand

    const area = world.areas.get(room.areaId);
    const roster = pending
      .map((entry, index) => `${index + 1}. ${entry.type} [${entry.tags.join(', ')}]`)
      .join('\n');
    const user = fill(template, {
      area: area?.name ?? room.areaId,
      theme: area?.themeTokens.join(', ') || '—',
      identity: describeIdentity(area?.identity),
      rooms: roster,
    });

    try {
      const reply = await this.client.complete({
        model: this.settings.narratorModel,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: user },
        ],
        temperature: this.settings.temperature,
        maxTokens: Math.max(this.settings.maxTokens, pending.length * 80),
      });
      const { areaName, rooms: parsed } = parseBaseLines(reply, pending.length);
      if (areaName) world.writeAreaName(room.areaId, areaName);
      pending.forEach((entry, index) => {
        const written = parsed[index];
        if (written) world.writeProse(entry.id, written);
      });
    } catch {
      // A failed batch leaves baseDesc empty; the render falls back to the
      // structural placeholder, which is still true. We do not retry per turn —
      // the area is marked done so a dead key does not stall every move.
    }
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}

// ── free functions ────────────────────────────────────────────────────

/**
 * The area's identity as a few plain lines for the prompt. No identity is not
 * an absence to paper over — it is the answer, and the prompt is told so.
 */
function describeIdentity(identity: Record<string, string> | null | undefined): string {
  if (!identity) return 'Nothing of note. This is an ordinary place that no story is about.';
  const rows = Object.entries(identity).filter(([key]) => !key.startsWith('_'));
  if (rows.length === 0) return 'Nothing of note. This is an ordinary place that no story is about.';
  return rows.map(([trait, value]) => `- ${trait}: ${value}`).join('\n');
}

/**
 * Read a batch reply into per-room `{ name, baseDesc }`. The emit shape is
 * `N. Name :: two sentences`, but weak models drop the number or the separator,
 * so this reads leniently: it accepts a bare `Name :: desc` line and, failing a
 * separator, takes the first sentence as the name.
 */
function parseBaseLines(
  reply: string,
  count: number,
): { areaName: string; rooms: ({ name: string; baseDesc: string } | undefined)[] } {
  const out: ({ name: string; baseDesc: string } | undefined)[] = new Array(count).fill(undefined);
  const lines = reply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // The area's own name comes first, on its own marked line. It is optional:
  // a model that skips it leaves the archetype's working name standing, which
  // is exactly what happened before this line existed.
  let areaName = '';
  const head = lines[0]?.match(/^AREA\s*(?:::|[—-])\s*(.+)$/i);
  if (head?.[1]) {
    areaName = clean(head[1]);
    lines.shift();
  }

  let index = 0;
  for (const line of lines) {
    if (index >= count) break;
    const body = line.replace(/^\s*\d+[.)]\s*/, '');
    const split = body.split(/\s*::\s*|\s+—\s+|\s+-\s+/);
    if (split.length >= 2 && split[0]) {
      out[index] = { name: clean(split[0]), baseDesc: clean(split.slice(1).join(' — ')) };
    } else if (body.length > 0) {
      const sentences = body.split(/(?<=[.!?])\s+/);
      out[index] = { name: clean(sentences[0] ?? body), baseDesc: clean(body) };
    }
    index += 1;
  }
  return { areaName, rooms: out };
}
