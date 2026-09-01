/**
 * The room narrator — the first and largest of the narrator's three jobs:
 * naming and describing a room the first time you enter it, and re-describing
 * it as its contents change.
 *
 * Two layers, exactly as the design lays them out:
 *
 *  - **baseDesc** — the room's architecture, light, wear and mood. Written once
 *    for a whole area in a single batch call the first time anyone walks into
 *    it, so the rooms read as one place rather than fifteen unrelated ones. It
 *    never names contents, so it stays true for the life of the area.
 *  - **the woven render** — baseDesc plus whatever is standing in the room right
 *    now, written as one paragraph. This is what the player reads. It is cached
 *    by a signature of the room's contents, so returning to an unchanged room is
 *    free and prints identical prose, and only a real change costs a call.
 *
 * The narrator owns prose and nothing else. It is handed the contents as data
 * and writes them up; it never decides what is there, and its output is read by
 * the player and by no other part of the system. When there is no API key, or a
 * call fails, every path falls back to a truthful render built from the records
 * themselves — the game is always playable without a narrator.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { seedFrom } from '../engine/rng';
import type { ObjectRecord, RoomRecord } from '../world/types';
import type { World } from '../world/world';
import { describeObject, sentenceList, titleOf, viewRoom } from '../game/describe';
import type { LlmClient } from './llm';
import type { NarratorSettings } from './settings';
import { clean, fill } from './text';

export interface RoomProse {
  name: string;
  /** The woven paragraph, ready to show. */
  prose: string;
}

/** A thing in the room the render must account for, with the words that name it. */
interface Notable {
  id: string;
  label: string;
  words: string[];
}

/** Cap on distinct cached renders per room, evicted least-recently-used. */
const RENDER_CAP = 8;

export class RoomNarrator {
  private readonly campaign: ResolvedCampaign;
  private readonly client: LlmClient;
  private readonly settings: NarratorSettings;

  /** signature -> woven prose. */
  private readonly cache = new Map<string, string>();
  /** roomId -> signatures held for it, oldest first, for per-room LRU eviction. */
  private readonly perRoom = new Map<string, string[]>();
  /** Areas whose baseDescs are being (or have been) generated, so we batch once. */
  private readonly baseDone = new Set<string>();

  constructor(deps: { campaign: ResolvedCampaign; client: LlmClient; settings: NarratorSettings }) {
    this.campaign = deps.campaign;
    this.client = deps.client;
    this.settings = deps.settings;
  }

  /**
   * The room as the player should see it now: a name and a woven paragraph.
   * Darkness is the engine's to describe, so a dark room returns nothing and the
   * placeholder stands. Everything here degrades to a truthful, code-built
   * render if the model is absent or misbehaves.
   */
  async describe(world: World, room: RoomRecord): Promise<RoomProse | undefined> {
    const view = viewRoom(world, room);
    if (view.dark) return undefined;

    await this.ensureBaseDescs(world, room);
    const base = room.baseDesc || view.desc;
    const name = room.name || titleOf(room);

    const notables = this.notablesOf(world, room);
    const signature = this.signatureOf(room, base, notables);

    const cached = this.cache.get(signature);
    if (cached !== undefined) return { name, prose: cached };

    const prose = await this.weave(base, notables);
    this.remember(room.id, signature, prose);
    return { name, prose };
  }

  // ── layer one: the permanent descriptions, batched per area ─────────

  /**
   * Fill every empty `baseDesc` in the room's area in one call. Done once per
   * area per session; a persisted baseDesc from an earlier visit is left alone.
   */
  private async ensureBaseDescs(world: World, room: RoomRecord): Promise<void> {
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
      const parsed = parseBaseLines(reply, pending.length);
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

  // ── layer two: the woven render ─────────────────────────────────────

  private async weave(base: string, notables: Notable[]): Promise<string> {
    const template = this.campaign.prompts['prompts/room-render.md'];
    if (!template) return this.fallback(base, notables);

    const contents =
      notables.length > 0 ? notables.map((entry) => `- ${entry.label}`).join('\n') : 'Nothing of note.';
    const messages = [
      { role: 'system' as const, content: this.systemPrompt() },
      { role: 'user' as const, content: fill(template, { base, contents }) },
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
      if (covers(reply, notables)) return reply;

      // One repair: hand back the model's own attempt and name what it dropped.
      const missing = notables.filter((entry) => !mentions(reply, entry.words));
      const repair = clean(
        await this.client.complete({
          model: this.settings.narratorModel,
          messages: [
            ...messages,
            { role: 'assistant', content: reply },
            {
              role: 'user',
              content: `Rewrite the paragraph. It must mention: ${missing
                .map((entry) => entry.label)
                .join('; ')}. Mention nothing that is not in the room.`,
            },
          ],
          temperature: this.settings.temperature,
          maxTokens: this.settings.maxTokens,
        }),
      );
      return covers(repair, notables) ? repair : this.fallback(base, notables);
    } catch {
      return this.fallback(base, notables);
    }
  }

  /** A render built from the records — always true, used whenever the model can't be. */
  private fallback(base: string, notables: Notable[]): string {
    if (notables.length === 0) return base;
    return `${base} Here: ${sentenceList(notables.map((entry) => entry.label))}.`;
  }

  // ── the content signature and the cache ─────────────────────────────

  /**
   * What must be listed, and the words that count as naming each thing. Doors on
   * the room's edges count too, since an open door reads differently from a shut
   * one; scenery does not, so the signature does not churn on flavour.
   */
  private notablesOf(world: World, room: RoomRecord): Notable[] {
    const notables: Notable[] = [];

    for (const object of world.objectsIn(room.id)) {
      if (object.flags.scenery) continue;
      notables.push({
        id: object.id,
        label: describeObject(world, object),
        words: wordsOf(object),
      });
    }
    for (const npc of world.npcsIn(room.id)) {
      notables.push({
        id: `npc:${npc.id}`,
        label: `${npc.name}${npc.hostile ? ' (hostile)' : ''}`,
        words: [...(npc.aliases ?? []), ...npc.name.toLowerCase().split(/\s+/)],
      });
    }
    for (const exit of world.exitsOf(room.id)) {
      const door = exit.edge.doorId ? world.objects.get(exit.edge.doorId) : undefined;
      if (!door) continue;
      const state = door.flags.locked ? 'locked' : door.flags.open ? 'open' : 'shut';
      notables.push({ id: `${door.id}:${state}`, label: `${state} ${door.name}`, words: wordsOf(door) });
    }

    return notables;
  }

  private signatureOf(room: RoomRecord, base: string, notables: Notable[]): string {
    const ids = notables.map((entry) => entry.id).sort();
    return `${room.id}|${seedFrom(base).toString(36)}|${ids.join(',')}`;
  }

  private remember(roomId: string, signature: string, prose: string): void {
    if (this.cache.has(signature)) return;
    this.cache.set(signature, prose);
    const held = this.perRoom.get(roomId) ?? [];
    held.push(signature);
    while (held.length > RENDER_CAP) {
      const evicted = held.shift();
      if (evicted) this.cache.delete(evicted);
    }
    this.perRoom.set(roomId, held);
  }

  private systemPrompt(): string {
    return this.campaign.prompts['prompts/narrator.md'] ?? '';
  }
}

// ── free functions ────────────────────────────────────────────────────

/** The parser's own vocabulary is the alias list, so validation stays in sync with it. */
function wordsOf(object: ObjectRecord): string[] {
  return [
    ...(object.nouns ?? []),
    ...(object.adjectives ?? []),
    ...object.name.toLowerCase().split(/\s+/),
  ].map((word) => word.toLowerCase());
}

/** Every notable is named in the render, matched against its aliases, not its display name. */
function covers(render: string, notables: Notable[]): boolean {
  if (render.trim().length === 0) return false;
  return notables.every((entry) => mentions(render, entry.words));
}

function mentions(render: string, words: string[]): boolean {
  const haystack = render.toLowerCase();
  return words.some((word) => word.length > 2 && haystack.includes(word));
}

/**
 * Read a batch reply into per-room `{ name, baseDesc }`. The emit shape is
 * `N. Name :: two sentences`, but weak models drop the number or the separator,
 * so this reads leniently: it accepts a bare `Name :: desc` line and, failing a
 * separator, takes the first sentence as the name.
 */
function parseBaseLines(reply: string, count: number): ({ name: string; baseDesc: string } | undefined)[] {
  const out: ({ name: string; baseDesc: string } | undefined)[] = new Array(count).fill(undefined);
  const lines = reply
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

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
  return out;
}
