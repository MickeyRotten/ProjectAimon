/**
 * Quests — templates, distance bands, objective placement, and the predicate
 * registry that says when an objective is done.
 *
 * The design keeps this deliberately small. There are no chains, no
 * prerequisites, no state machines beyond an enum, and no branching. An NPC
 * rolled into a room rolls a quest against the template table; on accept, a
 * band is rolled and one objective is placed into a graph that already exists,
 * so it is always genuinely reachable and nothing needs proving afterwards.
 *
 * This file holds only the parts that do not touch the world's tables:
 *
 *  - the closed vocabularies the loader validates against,
 *  - the band roll and hint prose, both pure,
 *  - the predicate registry, which reads a flat snapshot of the world rather
 *    than the `World` class, so this module never imports it and the two never
 *    form a cycle.
 *
 * `World.acceptQuest` and `World.completeQuest` do the writing, using these
 * helpers plus the item and creature generators.
 */

import type { JsonObject } from '../campaign/merge';
import type { QuestTemplate } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt } from '../engine/rules';
import { inRoom, type Coord, type NpcRecord, type ObjectiveRecord } from './types';

/** What an objective may place at its target. Engine-level, like `hostile`/`npc`. */
export const PLACE_KINDS = new Set(['item', 'hostile', 'parcel', 'none']);

/** The predicates an objective may be completed by. New quest types add here. */
export const PREDICATE_KINDS = new Set(['hasItem', 'npcDead', 'roomCleared', 'flagSet', 'atRoom']);

/** Reward kinds a template may grant. A roll over a table, never hardcoded. */
export const REWARD_KINDS = new Set(['gold', 'item']);

/** The one band that is not a hop range: it means another area entirely. */
export const DISTANT_BAND = 'distant';

/** The flag an `investigate` objective's SEARCH sets. */
export const investigateFlag = (questId: string): string => `quest:${questId}:investigated`;

/**
 * Roll a band from a template's weighted `bands`. Falls back to the first
 * positive-weight band if the roll table degenerates, which validation already
 * rules out but the engine should not trust.
 */
export function rollBand(rng: Rng, bands: Record<string, number>): string {
  const entries = Object.entries(bands ?? {})
    .filter(([name]) => !name.startsWith('_'))
    .map(([name, w]) => ({ name, w }));
  return rng.maybeWeighted(entries)?.name ?? entries[0]?.name ?? 'near';
}

/** The `[lo, hi]` hop range of a band, or undefined for `distant` / a typo. */
export function bandRange(rules: JsonObject, band: string): [number, number] | undefined {
  const range = ruleAt(rules, `DISTANCE_BANDS.${band}`);
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    return undefined;
  }
  return [range[0], range[1]];
}

/**
 * A general compass word from one coordinate to another — not adjacency, so it
 * reads over any distance and is what a hint points along. Depth wins when it
 * dominates, because "below" is more use to the player than "a little east and
 * far down".
 */
export function generalDirection(from: Coord, to: Coord): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  if (dx === 0 && dy === 0 && dz === 0) return 'here';
  if (Math.abs(dz) > Math.abs(dx) && Math.abs(dz) > Math.abs(dy)) return dz > 0 ? 'above' : 'below';
  const ns = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const ew = dx < 0 ? 'west' : dx > 0 ? 'east' : '';
  return [ns, ew].filter(Boolean).join('-') || (dz > 0 ? 'above' : 'below');
}

/** How far the band reads in prose. Always true, because the band chose it. */
const BAND_WALK: Record<string, string> = {
  near: 'close by',
  quiteNear: 'a fair walk',
  far: 'a long way',
  distant: 'in another place entirely',
};

/** Room-use tags to the noun a place is called by, most specific first. */
const PLACE_NOUN: [string, string][] = [
  ['grave', 'grave'],
  ['shrine', 'shrine'],
  ['market', 'market'],
  ['workspace', 'workshop'],
  ['storage', 'store-place'],
  ['dwelling', 'dwelling'],
  ['cell', 'cell'],
  ['ruin', 'ruin'],
  ['landmark', 'landmark'],
  ['vantage', 'high place'],
  ['water', 'waterside'],
  ['hearth', 'hearth'],
  ['underground', 'deep place'],
  ['indoor', 'room'],
  ['outdoor', 'open ground'],
];

/** Mood/light tags that read as an adjective in front of the place noun. */
const PLACE_ADJECTIVE = ['dark', 'dim', 'grim', 'holy', 'lush', 'austere', 'corrupt', 'opulent', 'quiet', 'wild'];

/**
 * A hint from the target room's own data, so it is always true and never
 * authored: tags `indoor, dark, storage`, four hops east, band `quiteNear`
 * becomes *"a dark store-place, a fair walk east."*
 *
 * For a `Distant` objective the room does not exist yet, so the tags are
 * unknown and the hint leans on band and direction alone.
 */
export function buildHint(options: {
  template: QuestTemplate;
  fromCoord: Coord;
  targetCoord: Coord | null;
  targetTags: readonly string[] | null;
  band: string;
}): string {
  const from = options.template.hintFrom ?? [];
  const parts: string[] = [];

  if (from.includes('tags') && options.targetTags) {
    const adjective = PLACE_ADJECTIVE.find((tag) => options.targetTags?.includes(tag));
    const noun = PLACE_NOUN.find(([tag]) => options.targetTags?.includes(tag))?.[1] ?? 'place';
    parts.push(`a ${[adjective, noun].filter(Boolean).join(' ')}`);
  }

  const tail: string[] = [];
  if (from.includes('band')) tail.push(BAND_WALK[options.band] ?? 'somewhere');
  if (from.includes('direction') && options.targetCoord) {
    const dir = generalDirection(options.fromCoord, options.targetCoord);
    if (dir !== 'here') tail.push(dir);
  }

  const lead = parts.join(', ');
  const rest = tail.join(' ');
  if (lead && rest) return `${lead}, ${rest}.`;
  return `${lead || rest || 'not far'}.`;
}

// ── the predicate registry ──────────────────────────────────────────

/**
 * A flat read of everything a predicate might ask about, assembled by the turn
 * loop so this module never depends on `World`. `carriedIds` is the transitive
 * carry — pockets and the containers in them alike.
 */
export interface QuestCheckContext {
  playerRoomId: string;
  carriedIds: ReadonlySet<string>;
  npcs: ReadonlyMap<string, NpcRecord>;
  flags: ReadonlySet<string>;
}

type Predicate = (ctx: QuestCheckContext, objective: ObjectiveRecord) => boolean;

const PREDICATES: Record<string, Predicate> = {
  hasItem: (ctx, objective) => objective.targetId !== '' && ctx.carriedIds.has(objective.targetId),

  // Gone from the table or moved out of play. Combat, at step 6, is what will
  // actually make this true; until then a kill objective simply stays open.
  npcDead: (ctx, objective) => {
    if (objective.targetId === '') return false;
    const npc = ctx.npcs.get(objective.targetId);
    return !npc || npc.location === null;
  },

  // No hostile stands in the room. Also a step-6 outcome, and false while the
  // room is unknown (a Distant objective before its area generates).
  roomCleared: (ctx, objective) => {
    if (objective.targetRoomId === '') return false;
    const here = inRoom(objective.targetRoomId);
    for (const npc of ctx.npcs.values()) {
      if (npc.hostile && npc.location === here) return false;
    }
    return true;
  },

  flagSet: (ctx, objective) => objective.completedByArg !== '' && ctx.flags.has(objective.completedByArg),

  atRoom: (ctx, objective) =>
    objective.targetRoomId !== '' && ctx.playerRoomId === objective.targetRoomId,
};

/** Is this objective satisfied right now? Unknown predicates never fire. */
export function objectiveComplete(ctx: QuestCheckContext, objective: ObjectiveRecord): boolean {
  if (objective.done) return true;
  const predicate = PREDICATES[objective.completedBy];
  return predicate ? predicate(ctx, objective) : false;
}
