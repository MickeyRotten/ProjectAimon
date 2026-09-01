/**
 * Scope — the single most important robustness rule in the parser.
 *
 * A noun matches only what the player could actually reach or see: what they
 * carry, what is in the room, what is inside an open container that is itself
 * in scope, the doors on the room's edges, and themselves. `take sword` never
 * matches a sword two rooms away, and that one rule removes most parser
 * weirdness without a single special case.
 *
 * Darkness narrows it rather than special-casing it: with no light in a dark
 * room, the room is not in scope at all. You can still rummage through your own
 * pack, and nothing else.
 */

import type { NpcRecord, ObjectRecord, RoomRecord } from '../world/types';
import { IN_PLAYER, inObject, inRoom } from '../world/types';
import type { World } from '../world/world';
import type { Phrase } from '../engine/parser';

export type ScopeKind = 'self' | 'object' | 'npc' | 'door';

export interface ScopeEntry {
  id: string;
  kind: ScopeKind;
  name: string;
  nouns: string[];
  adjectives: string[];
  /** Where it was found. Preconditions read this — you cannot drop a chest. */
  where: 'self' | 'carried' | 'worn' | 'room' | 'container' | 'door';
  object?: ObjectRecord | undefined;
  npc?: NpcRecord | undefined;
}

export interface ScopeView {
  world: World;
  room: RoomRecord;
  /** True when the room is dark and nothing in it is lit. */
  dark: boolean;
  playerName: string;
}

/** Everything the player may name this turn. */
export function scopeOf(view: ScopeView): ScopeEntry[] {
  const { world, room } = view;
  const entries: ScopeEntry[] = [
    {
      id: 'self',
      kind: 'self',
      name: view.playerName,
      nouns: ['me', 'myself', 'self'],
      adjectives: [],
      where: 'self',
    },
  ];

  const carried = world.contentsOf(IN_PLAYER).objects;
  for (const object of carried) {
    entries.push(objectEntry(object, object.flags.worn ? 'worn' : 'carried'));
    entries.push(...openContents(world, object));
  }

  if (view.dark) return entries;

  for (const object of world.objectsIn(room.id)) {
    entries.push(objectEntry(object, 'room'));
    entries.push(...openContents(world, object));
  }
  for (const npc of world.npcsIn(room.id)) {
    entries.push({
      id: npc.id,
      kind: 'npc',
      name: npc.name,
      // Aliases carry every former name, so a matcher never reads `name` alone.
      nouns: [...nameWords(npc.name), ...npc.aliases.flatMap(nameWords)],
      adjectives: [],
      where: 'room',
      npc,
    });
  }

  // Doors live on edges, and an edge is shared: the door the player is looking
  // at may be recorded as standing in the room on the other side.
  for (const edge of world.edgesOf(room.id)) {
    if (!edge.doorId) continue;
    const door = world.objects.get(edge.doorId);
    if (!door || door.location === inRoom(room.id)) continue;
    entries.push({ ...objectEntry(door, 'door'), kind: 'door' });
  }
  return entries;
}

const objectEntry = (object: ObjectRecord, where: ScopeEntry['where']): ScopeEntry => ({
  id: object.id,
  kind: 'object',
  name: object.name,
  nouns: [...object.nouns, ...nameWords(object.name)],
  adjectives: [...object.adjectives, ...nameWords(object.name)],
  where,
  object,
});

/** One pointer deeper: what is inside an open container that is itself in scope. */
function openContents(world: World, container: ObjectRecord): ScopeEntry[] {
  if (!container.flags.container || !container.flags.open) return [];
  return world
    .contentsOf(inObject(container.id))
    .objects.map((object) => objectEntry(object, 'container'));
}

const nameWords = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((word) => word.length > 0);

/**
 * Match a typed phrase against the scope. The last word is the noun and the
 * rest are adjectives, so "rusty blade" and "iron sword" both resolve without
 * a synonym table per object.
 */
export function matchPhrase(entries: readonly ScopeEntry[], phrase: Phrase): ScopeEntry[] {
  if (phrase.all) {
    return entries.filter(
      (entry) =>
        entry.kind === 'object' &&
        entry.object?.flags.takeable === true &&
        !phrase.except.some((word) => wordsOf(entry).includes(word)),
    );
  }
  const words = phrase.words.map((word) => word.toLowerCase());
  if (words.length === 0) return [];
  const noun = words[words.length - 1] as string;
  const adjectives = words.slice(0, -1);

  return entries.filter((entry) => {
    const nouns = entry.nouns.map((word) => word.toLowerCase());
    if (!nouns.includes(noun)) return false;
    const describers = [...entry.adjectives, ...entry.nouns].map((word) => word.toLowerCase());
    return adjectives.every((word) => describers.includes(word));
  });
}

const wordsOf = (entry: ScopeEntry): string[] =>
  [...entry.nouns, ...entry.adjectives].map((word) => word.toLowerCase());

/** Does anything here, carried or in the room, give light? */
export function anyLight(world: World, roomId: string): ObjectRecord | undefined {
  const lit = (object: ObjectRecord) =>
    object.flags.lightSource === true && object.flags.lit === true && object.burnRemaining > 0;
  return world.contentsOf(IN_PLAYER).objects.find(lit) ?? world.objectsIn(roomId).find(lit);
}

/** A dark room with nothing lit in it. The one place darkness is decided. */
export function isDark(world: World, room: RoomRecord): boolean {
  return room.tags.includes('dark') && anyLight(world, room.id) === undefined;
}
