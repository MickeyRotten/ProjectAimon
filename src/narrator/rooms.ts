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

  /** Areas we will not attempt again: written, or given up on after MAX_TRIES. */
  private readonly settled = new Set<string>();
  /** Areas with a batch call in flight right now, so a second move can't double it. */
  private readonly inFlight = new Set<string>();
  /** How many times each area's batch has been attempted this session. */
  private readonly tries = new Map<string, number>();

  /** Batch attempts before an area is left to its placeholder for good. */
  private static readonly MAX_TRIES = 3;
  /**
   * The batch describes a whole area at once — ten or more rooms in one reply —
   * so it needs far longer than a single voice or outcome line. The default
   * client timeout is tuned for those small calls; this one gets its own.
   */
  private static readonly BATCH_TIMEOUT_MS = 30_000;

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * Ensure the room's whole area has been described: fill every empty
   * `baseDesc` in it, and its name, in one batch call. A persisted baseDesc
   * from an earlier visit — or the Hub's hand-authored one — is left alone, so
   * an area with nothing pending makes no call. The prose lands on the records
   * via `world.writeProse`; the screen reads it back from there, so this
   * returns nothing.
   *
   * A failed batch is **retried** on a later entry rather than left forever: a
   * single timeout on this large, slow call used to strand a whole area on its
   * developer placeholder for the rest of the session. Retries are capped at
   * `MAX_TRIES`, so a genuinely dead key still stops stalling every move.
   */
  async ensureArea(world: World, room: RoomRecord): Promise<void> {
    const areaId = room.areaId;
    if (this.settled.has(areaId) || this.inFlight.has(areaId)) return;

    const pending = world
      .roomsOf(areaId)
      .filter((entry) => entry.baseDesc.trim().length === 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (pending.length === 0) return this.settle(areaId); // authored, or already written

    const template = this.campaign.prompts['prompts/room-base.md'];
    if (!template) return this.settle(areaId); // no prompt, no batch — placeholders stand

    const attempt = (this.tries.get(areaId) ?? 0) + 1;
    this.tries.set(areaId, attempt);

    const area = world.areas.get(areaId);
    const roster = pending
      .map((entry, index) => `${index + 1}. ${entry.type} [${entry.tags.join(', ')}]`)
      .join('\n');
    const user = fill(template, {
      area: area?.name ?? areaId,
      theme: area?.themeTokens.join(', ') || '—',
      identity: describeIdentity(area?.identity),
      rooms: roster,
    });

    this.inFlight.add(areaId);
    try {
      const reply = await this.client.complete({
        model: this.settings.narratorModel,
        messages: [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: user },
        ],
        temperature: this.settings.temperature,
        maxTokens: Math.max(this.settings.maxTokens, pending.length * 120),
        timeoutMs: RoomNarrator.BATCH_TIMEOUT_MS,
      });
      const { areaName, rooms: parsed } = parseBaseLines(reply, pending.length);
      if (areaName) world.writeAreaName(areaId, areaName);
      pending.forEach((entry, index) => {
        const written = parsed[index];
        if (written) world.writeProse(entry.id, written);
      });
      this.settle(areaId); // written — never again
    } catch {
      // A failed batch leaves baseDesc empty and the structural placeholder
      // stands, which is still true. It stays retryable so the next entry into
      // the area can try again — unless we have burned through MAX_TRIES, at
      // which point a dead key or a stubborn model stops costing a call a move.
      if (attempt >= RoomNarrator.MAX_TRIES) this.settle(areaId);
    } finally {
      this.inFlight.delete(areaId);
    }
  }

  private settle(areaId: string): void {
    this.settled.add(areaId);
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
