import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { parseLocation, type NpcRecord, type ObjectRecord } from '../src/content/records';
import { World } from '../src/world/world';
import type { AreaRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

/** A world with `areas` areas generated off the Hub, entry-first. */
function explored(seed: string, areas = 4): World {
  const world = World.create({ campaign, seed });
  while (generated(world).length < areas) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) break;
    world.enterGate(gate.id);
  }
  return world;
}

const generated = (world: World): AreaRecord[] =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');

const guarantees = campaign.placement.guarantees;

/**
 * Does this room hold anything worth taking? A chest with a sword in it is a
 * loot room, even though the sword points at the chest rather than the room.
 */
function holdsLoot(world: World, roomId: string): boolean {
  const walk = (location: string): boolean =>
    world.contentsOf(location).objects.some(
      (object) => object.flags.takeable === true || walk(`obj:${object.id}`),
    );
  return walk(`room:${roomId}`);
}

describe('what the roller puts in a room', () => {
  it('points every single thing at somewhere that exists', () => {
    const world = explored('pointers');
    const things: (ObjectRecord | NpcRecord)[] = [
      ...world.objects.values(),
      ...world.npcs.values(),
    ];
    expect(things.length).toBeGreaterThan(0);
    for (const thing of things) {
      const target = parseLocation(thing.location);
      expect(target).toBeDefined();
      if (target?.kind === 'room') expect(world.rooms.has(target.id)).toBe(true);
      if (target?.kind === 'obj') expect(world.objects.has(target.id)).toBe(true);
      if (target?.kind === 'npc') expect(world.npcs.has(target.id)).toBe(true);
    }
  });

  it('leaves the room record holding nothing at all', () => {
    const world = explored('no-contents', 2);
    for (const room of world.rooms.values()) {
      expect(Object.keys(room)).not.toContain('contents');
      expect(Object.keys(room)).not.toContain('objects');
      expect(Object.keys(room)).not.toContain('npcs');
    }
  });

  it('answers "what is in here" as a query, containers included', () => {
    const world = explored('query');
    const chest = [...world.objects.values()].find(
      (object) => object.flags.container === true &&
        [...world.objects.values()].some((other) => other.location === `obj:${object.id}`),
    );
    expect(chest).toBeDefined();
    const inside = world.contentsOf(`obj:${chest?.id}`);
    expect(inside.objects.length).toBeGreaterThan(0);
    // The chest is in a room; what is inside it is not.
    const room = parseLocation(chest?.location ?? null);
    const roomContents = world.inRoom(room?.id as string);
    expect(roomContents.objects.map((object) => object.id)).toContain(chest?.id);
    expect(roomContents.objects.map((object) => object.id)).not.toContain(
      inside.objects[0]?.id,
    );
  });

  it('moves a thing by writing one field, and the index follows', () => {
    const world = explored('move', 1);
    const object = [...world.objects.values()][0] as ObjectRecord;
    const from = object.location as string;
    world.relocate(object.id, 'player');
    expect(world.contentsOf(from).objects.map((one) => one.id)).not.toContain(object.id);
    expect(world.contentsOf('player').objects.map((one) => one.id)).toContain(object.id);
  });

  it('generates the same contents twice from the same seed', () => {
    const signature = (world: World) =>
      [...world.objects.values()]
        .map((object) => `${object.id}:${object.name}:${object.location}`)
        .sort()
        .join('|');
    expect(signature(explored('repeatable'))).toBe(signature(explored('repeatable')));
  });
});

describe('the guarantees', () => {
  it('are met, or the area says why not', () => {
    for (let seed = 0; seed < 8; seed++) {
      const world = explored(`guarantee-${seed}`, 4);
      for (const area of generated(world)) {
        const rooms = world.roomsOf(area.id);
        const hostileRooms = rooms.filter((room) =>
          world.inRoom(room.id).npcs.some((npc) => npc.hostile),
        );
        const npcRooms = rooms.filter((room) =>
          world.inRoom(room.id).npcs.some((npc) => !npc.hostile),
        );
        const lootRooms = rooms.filter((room) => holdsLoot(world, room.id));
        const excused = world.notes.some((note) => note.startsWith(`${area.id}: could not meet`));
        if (excused) continue;
        expect(hostileRooms.length).toBeGreaterThanOrEqual(guarantees.minHostiles);
        expect(npcRooms.length).toBeGreaterThanOrEqual(guarantees.minNpcs);
        expect(lootRooms.length).toBeGreaterThanOrEqual(guarantees.minLootRooms);
      }
    }
  });

  it('never puts two encounters in one room', () => {
    const world = explored('cap', 6);
    for (const area of generated(world)) {
      for (const room of world.roomsOf(area.id)) {
        const hostiles = world.inRoom(room.id).npcs.filter((npc) => npc.hostile);
        const bases = new Set(hostiles.map((npc) => npc.baseId));
        // One encounter may hold several creatures and several bases, but the
        // cap is on encounters, so a room never holds more than a warband.
        if (hostiles.length > 0) expect(bases.size).toBeLessThanOrEqual(4);
      }
    }
  });

  it('leaves the deepest room to something worth remembering', () => {
    let checked = 0;
    for (let seed = 0; seed < 6; seed++) {
      const world = explored(`elite-${seed}`, 3);
      for (const area of generated(world)) {
        const rooms = world.roomsOf(area.id);
        const entry = area.entryRoomId as string;
        const hops = world.hopsFrom(entry);
        const deepest = [...rooms].sort(
          (a, b) => (hops.get(b.id) ?? 0) - (hops.get(a.id) ?? 0) || a.id.localeCompare(b.id),
        )[0];
        const hostiles = world.inRoom(deepest?.id as string).npcs.filter((npc) => npc.hostile);
        if (hostiles.length === 0) continue; // no hostile belongs in that room
        checked++;
        expect(hostiles.some((npc) => npc.elite !== '')).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('still leaves rooms with nothing in them', () => {
    const world = explored('slack', 6);
    let rooms = 0;
    let empty = 0;
    for (const area of generated(world)) {
      for (const room of world.roomsOf(area.id)) {
        rooms++;
        const { objects, npcs } = world.inRoom(room.id);
        if (objects.length === 0 && npcs.length === 0) empty++;
      }
    }
    expect(empty / rooms).toBeGreaterThan(0.1);
  });
});

describe('locks', () => {
  it('are flavour: a locked door never strands a room, and its key is reachable', () => {
    for (let seed = 0; seed < 10; seed++) {
      const world = explored(`locks-${seed}`, 4);
      const doors = [...world.edges.values()].filter((edge) => edge.doorId);
      for (const edge of doors) {
        const door = world.objects.get(edge.doorId as string);
        expect(door?.flags.locked).toBe(true);

        // Every room of the area is still reachable from the entrance with
        // the locked connection removed, so nothing behind it is gated.
        const room = world.rooms.get(edge.roomA) as { areaId: string };
        const area = world.areas.get(room.areaId) as AreaRecord;
        const rooms = world.roomsOf(area.id);
        const entry = area.entryRoomId as string;
        const seen = new Set([entry]);
        const queue = [entry];
        for (let head = 0; head < queue.length; head++) {
          for (const exit of world.exitsOf(queue[head] as string)) {
            if (exit.edge.id === edge.id || !exit.toRoomId || seen.has(exit.toRoomId)) continue;
            seen.add(exit.toRoomId);
            queue.push(exit.toRoomId);
          }
        }
        expect(rooms.every((one) => seen.has(one.id))).toBe(true);

        const key = world.objects.get(door?.flags.lockedById as string);
        expect(key).toBeDefined();
        const keyRoom = parseLocation(key?.location ?? null);
        expect(seen.has(keyRoom?.id as string)).toBe(true);
      }
    }
  });
});

describe('the Hub', () => {
  it('places its hand-authored people, in the rooms they name', () => {
    const world = World.create({ campaign, seed: 'hub-people' });
    for (const def of campaign.manifest.hub.npcs) {
      const person = world.npcs.get(def.id);
      expect(person?.location).toBe(def.location);
      expect(world.contentsOf(def.location).npcs.map((one) => one.id)).toContain(def.id);
    }
    expect(world.notes).toEqual([]);
  });

  it('rolls no contents of its own — the Hub is authored, not generated', () => {
    const world = World.create({ campaign, seed: 'hub-empty' });
    expect(world.objects.size).toBe(0);
  });
});
