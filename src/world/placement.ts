/**
 * The placement roller — step 5 of area generation, and the last structural
 * pass before prose.
 *
 * Every content type in `placement.json` is rolled per room against a chance
 * and a tag filter, and then `guarantees` tops the result up. The top-up is
 * not a safety net: a ten-room area rolled barren on the reference generator's
 * first run — no hostiles, no people, one loot room — and small areas fall
 * below expectation often enough that this pass is load-bearing.
 *
 * Empty rooms are still wanted. Roughly a third of an area should hold nothing
 * mechanical, because that is where atmosphere lives, which is why the top-up
 * has a ceiling as well as a floor.
 *
 * Three rules shape the code:
 *
 *  - **A room never stores its contents.** Everything here writes a `location`
 *    pointer and nothing else. "What is in this room" stays a query.
 *  - **The tables decide what a thing is.** A rule carrying a `fixture` block
 *    builds an object from that block's own vocabulary, so a new kind of
 *    scenery is a table entry rather than a branch in this file. Only
 *    `hostile` and `npc` are named here, because those are systems.
 *  - **Locks are flavour.** A key is placed at a distance band for the walk,
 *    never to gate progression, and a lock that cannot be keyed is still fine.
 */

import type { Json, JsonObject } from '../campaign/merge';
import type { AreaDef, PlacementRule, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { generateItem, rollGold } from '../content/items';
import { rollEncounter } from '../content/monsters';
import { generateNpc } from '../content/npcs';
import { ruleAt, ruleNumber, ruleObject } from '../engine/rules';
import { matches } from '../engine/tags';
import {
  inObject,
  inRoom,
  type AreaRecord,
  type EdgeRecord,
  type Location,
  type NpcRecord,
  type ObjectFlags,
  type ObjectRecord,
  type RoomRecord,
} from './types';

export interface PlacementOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  area: AreaRecord;
  areaDef: AreaDef;
  rooms: readonly RoomRecord[];
  /** The area's own edges, for hop distance and for hanging a door on one. */
  edges: EdgeRecord[];
  /** World flags — spawn upgrades and conditional stats read them. */
  flags?: ReadonlySet<string> | undefined;
}

export interface PlacementResult {
  objects: ObjectRecord[];
  npcs: NpcRecord[];
  notes: string[];
}

/** A fixture block: the vocabulary an object that is not an item is built from. */
interface FixtureDef {
  kind: string;
  nouns: string[];
  adjectives: string[];
  tags?: string[];
  flags?: ObjectFlags;
  /** True on a spill of coin, which rolls its value from the loot tier. */
  gold?: boolean;
}

export function placeContents(options: PlacementOptions): PlacementResult {
  const { campaign, rng, area, rooms } = options;
  const objects: ObjectRecord[] = [];
  const npcs: NpcRecord[] = [];
  const notes: string[] = [];

  if (rooms.length === 0) return { objects, npcs, notes };

  let objectSeq = 0;
  let npcSeq = 0;
  const nextObjectId = (): string => `${area.id}:o${String(objectSeq++).padStart(2, '0')}`;
  const nextNpcId = (): string => `${area.id}:n${String(npcSeq++).padStart(2, '0')}`;

  const hops = hopsWithin(options);
  const guarantees = (campaign.placement.guarantees ?? {}) as unknown as JsonObject;
  const maxHostileRooms = Math.max(
    1,
    Math.floor(rooms.length * numberAt(guarantees, 'maxHostileRoomFraction', 1)),
  );
  const maxPerRoom = numberAt(guarantees, 'maxHostilesPerRoom', 1);

  const hostileRooms = new Set<string>();
  const hostileCounts = new Map<string, number>();
  const npcRooms = new Set<string>();
  const lootRooms = new Set<string>();
  const doorsOnEdge = new Set<string>();

  const context: RollContext = {
    ...options,
    objects,
    npcs,
    notes,
    nextObjectId,
    nextNpcId,
    hops,
    hostileRooms,
    hostileCounts,
    npcRooms,
    lootRooms,
    doorsOnEdge,
    maxPerRoom,
  };

  // ── the roll ──────────────────────────────────────────────────────

  for (const room of rooms) {
    for (const [key, rule] of placementRules(campaign)) {
      if (!matches(room.tags, rule.requires)) continue;
      if (!rng.chance(rule.chance)) continue;
      if (key === 'hostile' && hostileRooms.size >= maxHostileRooms) continue;
      place(context, key, rule, room);
    }
  }

  // ── the top-up, which is the part that is not optional ────────────

  const wantHostiles = numberAt(guarantees, 'minHostiles', 0);
  const hostileRule = ruleFor(campaign, 'hostile');
  for (const room of eligible(context, hostileRule, (candidate) => !hostileRooms.has(candidate.id))) {
    if (hostileRooms.size >= Math.min(wantHostiles, maxHostileRooms)) break;
    place(context, 'hostile', hostileRule, room);
  }
  if (hostileRooms.size < wantHostiles) {
    notes.push(
      `only ${hostileRooms.size} of ${wantHostiles} hostile rooms — no other room's tags allow one`,
    );
  }

  const wantLoot = numberAt(guarantees, 'minLootRooms', 0);
  const lootRule = ruleFor(campaign, 'loot');
  for (const room of eligible(context, lootRule, (candidate) => !lootRooms.has(candidate.id))) {
    if (lootRooms.size >= wantLoot) break;
    place(context, 'loot', lootRule, room);
  }

  const wantNpcs = numberAt(guarantees, 'minNpcs', 0);
  const npcRule = ruleFor(campaign, 'npc');
  for (const room of eligible(context, npcRule, (candidate) => !npcRooms.has(candidate.id))) {
    if (npcRooms.size >= wantNpcs) break;
    place(context, 'npc', npcRule, room);
  }
  if (npcRooms.size < wantNpcs) {
    notes.push(`no room in this area can hold an NPC, so it has ${npcRooms.size}`);
  }

  // Off in the base tables: a dark area is a supply problem the player solves
  // before walking in, not one the generator solves for them.
  if (
    guarantees['lightSourceIfDarkArea'] === true &&
    rooms.some((room) => room.tags.includes('dark')) &&
    !objects.some((object) => object.flags.lightSource)
  ) {
    const lightRule = ruleFor(campaign, 'lightSource');
    const room = rng.maybePick(eligible(context, lightRule, () => true));
    if (room) place(context, 'lightSource', lightRule, room);
  }

  // The deepest room is guaranteed an elite. It is the one promise the tier
  // curve makes inside an area rather than between areas.
  const deepest = deepestRoom(rooms, hops);
  if (deepest) {
    const standing = npcs.filter(
      (creature) => creature.hostile && creature.location === inRoom(deepest.id),
    );
    if (standing.length > 0) {
      // Re-roll rather than lift stats on a creature already built: an elite is
      // a title, a tag and a stat lift together, not a number bumped afterwards.
      const dropped = new Set(standing.map((creature) => creature.id));
      const kept = npcs.filter((creature) => !dropped.has(creature.id));
      npcs.length = 0;
      npcs.push(...kept);
      hostileRooms.delete(deepest.id);
      hostileCounts.delete(deepest.id);
    }
    if (standing.length > 0 || matches(deepest.tags, ruleFor(campaign, 'hostile').requires)) {
      place(context, 'hostile', ruleFor(campaign, 'hostile'), deepest, { forceElite: true });
    }
  }

  // Only shortfalls are logged. `notes` is a problem list the boot screen shows
  // in warning colour, so a routine summary in it would train the eye to skip
  // the line that matters.
  return { objects, npcs, notes };
}

// ── one placement ───────────────────────────────────────────────────

interface RollContext extends PlacementOptions {
  objects: ObjectRecord[];
  npcs: NpcRecord[];
  notes: string[];
  nextObjectId: () => string;
  nextNpcId: () => string;
  hops: Map<string, number>;
  hostileRooms: Set<string>;
  /** How many encounters each room carries, capped by `maxHostilesPerRoom`. */
  hostileCounts: Map<string, number>;
  npcRooms: Set<string>;
  lootRooms: Set<string>;
  doorsOnEdge: Set<string>;
  maxPerRoom: number;
}

function place(
  context: RollContext,
  key: string,
  rule: PlacementRule,
  room: RoomRecord,
  options: { forceElite?: boolean } = {},
): void {
  const { campaign, rng } = context;
  const tier = tierIn(context, room);
  const here = inRoom(room.id);

  if (key === 'hostile') {
    // One *encounter* per room by default. A composition is already a group,
    // so the cap counts fights, not creatures.
    if ((context.hostileCounts.get(room.id) ?? 0) >= context.maxPerRoom) return;
    const encounter = rollEncounter({
      campaign,
      rng,
      areaDef: context.areaDef,
      archetype: context.area.archetype,
      tier,
      roomTags: room.tags,
      location: here,
      nextId: context.nextNpcId,
      flags: context.flags,
      forceElite: options.forceElite === true,
    });
    if (!encounter) return;
    context.npcs.push(...encounter.creatures);
    context.hostileRooms.add(room.id);
    context.hostileCounts.set(room.id, (context.hostileCounts.get(room.id) ?? 0) + 1);
    return;
  }

  if (key === 'npc') {
    const person = generateNpc({
      campaign,
      rng,
      areaDef: context.areaDef,
      roomTags: room.tags,
      location: here,
      id: context.nextNpcId(),
    });
    if (!person) return;
    context.npcs.push(person.record);
    context.npcRooms.add(room.id);
    return;
  }

  const fixture = (rule as { fixture?: FixtureDef }).fixture;
  if (!fixture) {
    // No fixture block means the rule places an item: `loot` places anything,
    // `lightSource` asks for a kind.
    const item = generateItem({
      campaign,
      rng,
      tier,
      kind: (rule as { itemKind?: string }).itemKind,
      id: context.nextObjectId(),
      location: here,
    });
    if (!item) return;
    context.objects.push(item);
    if (item.flags.takeable) context.lootRooms.add(room.id);
    return;
  }

  const object = buildFixture(context, fixture, here, tier);
  context.objects.push(object);

  // Whatever the fixture holds goes inside it, pointing at the fixture rather
  // than at the room, which is what makes a chest's contents a query.
  const rolls = rule.lootRolls;
  if (rolls) {
    const count = rng.int(rolls[0], rolls[1]);
    for (let i = 0; i < count; i++) {
      const item = generateItem({
        campaign,
        rng,
        tier,
        id: context.nextObjectId(),
        location: inObject(object.id),
      });
      if (!item) continue;
      context.objects.push(item);
      context.lootRooms.add(room.id);
    }
  }
  if (object.flags.takeable) context.lootRooms.add(room.id);

  if (key === 'lockedDoor') hangDoor(context, rule, room, object);
}

/** Build an object from a fixture block. The block owns every word of it. */
function buildFixture(
  context: RollContext,
  fixture: FixtureDef,
  location: Location,
  tier: number,
): ObjectRecord {
  const { rng } = context;
  const noun = rng.pick(fixture.nouns);
  const adjective = rng.maybePick(fixture.adjectives);
  const object: ObjectRecord = {
    campaignId: context.campaign.id,
    id: context.nextObjectId(),
    name: [adjective, noun].filter(Boolean).join(' '),
    nouns: [...fixture.nouns],
    adjectives: [...fixture.adjectives],
    location,
    desc: '',
    tags: [...new Set([fixture.kind, ...(fixture.tags ?? [])])],
    baseId: fixture.kind,
    quality: 'plain',
    affixes: [],
    flags: { ...(fixture.flags ?? {}) },
    condition: 100,
    burnRemaining: 0,
  };
  if (fixture.gold) object.gold = rollGold(context.campaign, rng, tier);
  return object;
}

/**
 * Hang a door on one of the room's edges and put its key somewhere at the
 * band's distance. A door with no edge to sit on is dropped rather than left
 * floating; a key with nowhere to go is simply never made, and the lock stands
 * as flavour. Nothing here is load-bearing, so nothing here needs to succeed.
 */
function hangDoor(
  context: RollContext,
  rule: PlacementRule,
  room: RoomRecord,
  door: ObjectRecord,
): void {
  const edge = context.edges.find(
    (candidate) =>
      (candidate.roomA === room.id || candidate.roomB === room.id) &&
      candidate.roomB !== null &&
      !context.doorsOnEdge.has(candidate.id),
  );
  if (!edge) {
    // Nothing to hang it on. A door floating in a room is worse than no door,
    // and nothing downstream depends on this one existing.
    const at = context.objects.indexOf(door);
    if (at >= 0) context.objects.splice(at, 1);
    return;
  }
  edge.doorId = door.id;
  context.doorsOnEdge.add(edge.id);

  const band = rule.keyBand;
  const key = generateItem({
    campaign: context.campaign,
    rng: context.rng,
    tier: tierIn(context, room),
    kind: 'key',
    id: context.nextObjectId(),
    location: inRoom(room.id),
  });
  if (!key) return;
  door.flags.lockedById = key.id;

  const target = band ? roomInBand(context, room, band) : undefined;
  key.location = inRoom((target ?? room).id);
  context.objects.push(key);
  context.lootRooms.add((target ?? room).id);
}

/** A room the right number of hops away, by `DISTANCE_BANDS`. Never euclidean. */
function roomInBand(context: RollContext, from: RoomRecord, band: string): RoomRecord | undefined {
  const range = ruleAt(context.campaign.rules, `DISTANCE_BANDS.${band}`);
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') {
    return undefined;
  }
  const [lo, hi] = [range[0], range[1]];
  const distances = hopsFromRoom(context, from.id);
  const inBand = context.rooms.filter((room) => {
    const hops = distances.get(room.id);
    return hops !== undefined && hops >= lo && hops <= hi;
  });
  return context.rng.maybePick(inBand);
}

// ── the pieces ──────────────────────────────────────────────────────

/** Every rule in the table, notes and the guarantees block skipped. */
function placementRules(campaign: ResolvedCampaign): [string, PlacementRule][] {
  return Object.entries(campaign.placement)
    .filter(([key]) => !key.startsWith('_') && key !== 'guarantees')
    .filter(([, rule]) => typeof (rule as PlacementRule)?.chance === 'number')
    .map(([key, rule]) => [key, rule as PlacementRule]);
}

function ruleFor(campaign: ResolvedCampaign, key: string): PlacementRule {
  const rule = campaign.placement[key] as PlacementRule | undefined;
  return rule ?? { chance: 0 };
}

/** Rooms a rule may still be applied to, shuffled so a top-up is not front-loaded. */
function eligible(
  context: RollContext,
  rule: PlacementRule,
  extra: (room: RoomRecord) => boolean,
): RoomRecord[] {
  return context.rng.shuffle(
    context.rooms.filter((room) => matches(room.tags, rule.requires) && extra(room)),
  );
}

/**
 * The tier a room fights at: the area's, plus `DEPTH_TIER.roomDepthBonus` for
 * how far into the area it sits. The band is the same one quests use — hops
 * along edges, never coordinates.
 */
function tierIn(context: RollContext, room: RoomRecord): number {
  const rules = context.campaign.rules;
  const hops = context.hops.get(room.id) ?? 0;
  const bands = ruleObject(rules, 'DISTANCE_BANDS');
  const bonuses = ruleObject(rules, 'DEPTH_TIER.roomDepthBonus', {});
  let bonus = 0;
  for (const [name, range] of Object.entries(bands)) {
    if (name.startsWith('_') || !Array.isArray(range)) continue;
    const [lo, hi] = range as number[];
    if (typeof lo !== 'number' || typeof hi !== 'number') continue;
    if (hops >= lo && hops <= hi) bonus = numberAt(bonuses, name, 0);
  }
  const max = ruleNumber(rules, 'DEPTH_TIER.max');
  return Math.max(1, Math.min(max, context.area.tier + bonus));
}

const deepestRoom = (
  rooms: readonly RoomRecord[],
  hops: Map<string, number>,
): RoomRecord | undefined =>
  [...rooms].sort((a, b) => (hops.get(b.id) ?? 0) - (hops.get(a.id) ?? 0))[0];

/** Hops from the area's entry room to every other, along this area's edges. */
function hopsWithin(options: PlacementOptions): Map<string, number> {
  const entry = options.area.entryRoomId ?? options.rooms[0]?.id;
  if (!entry) return new Map();
  return walk(options.edges, entry);
}

function hopsFromRoom(context: RollContext, roomId: string): Map<string, number> {
  return walk(context.edges, roomId);
}

function walk(edges: readonly EdgeRecord[], from: string): Map<string, number> {
  const neighbours = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = neighbours.get(from) ?? [];
    list.push(to);
    neighbours.set(from, list);
  };
  for (const edge of edges) {
    if (!edge.roomB) continue; // a gate: the area behind it does not exist yet
    link(edge.roomA, edge.roomB);
    link(edge.roomB, edge.roomA);
  }
  const seen = new Map<string, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as string;
    const depth = seen.get(at) as number;
    for (const next of neighbours.get(at) ?? []) {
      if (seen.has(next)) continue;
      seen.set(next, depth + 1);
      queue.push(next);
    }
  }
  return seen;
}

const numberAt = (table: JsonObject | Record<string, Json>, key: string, fallback: number): number =>
  typeof table[key] === 'number' ? (table[key] as number) : fallback;
