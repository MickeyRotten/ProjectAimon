import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { matches } from '../src/engine/tags';
import { World } from '../src/world/world';
import { inObject, inRoom, type NpcRecord, type ObjectRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const guarantees = campaign.placement.guarantees;

/** Walk gates entry-first until `areas` generated areas exist. */
function explore(world: World, areas: number): void {
  while (world.areas.size < areas + 1) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

const worlds = (count: number, areas = 4): World[] =>
  Array.from({ length: count }, (_, i) => {
    const world = World.create({ campaign, seed: `placement-${i}` });
    explore(world, areas);
    return world;
  });

const generated = (world: World) =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');

const sample = worlds(6);

describe('the placement roller', () => {
  it('puts something in the world at all', () => {
    for (const world of sample) {
      expect(world.objects.size).toBeGreaterThan(0);
      expect([...world.npcs.values()].some((npc) => npc.hostile)).toBe(true);
    }
  });

  it('is deterministic: the same seed places the same things', () => {
    const build = () => {
      const world = World.create({ campaign, seed: 'repeat' });
      explore(world, 3);
      return world;
    };
    const a = build();
    const b = build();
    expect([...a.objects.values()]).toEqual([...b.objects.values()]);
    expect([...a.npcs.values()]).toEqual([...b.npcs.values()]);
  });

  it('never writes contents onto a room', () => {
    for (const world of sample) {
      for (const room of world.rooms.values()) {
        expect(room).not.toHaveProperty('contents');
        expect(room).not.toHaveProperty('objects');
        expect(room).not.toHaveProperty('npcs');
      }
    }
  });

  it('points every record at a location that exists', () => {
    for (const world of sample) {
      for (const record of [...world.objects.values(), ...world.npcs.values()] as (
        | ObjectRecord
        | NpcRecord
      )[]) {
        const location = record.location as string;
        if (location.startsWith('room:')) {
          expect(world.rooms.has(location.slice(5))).toBe(true);
        } else if (location.startsWith('obj:')) {
          expect(world.objects.has(location.slice(4))).toBe(true);
        } else {
          expect(['player']).toContain(location);
        }
      }
    }
  });

  it('respects every rule’s tag filter', () => {
    for (const world of sample) {
      const hostileRule = campaign.placement['hostile'] as { requires?: string[] };
      const npcRule = campaign.placement['npc'] as { requires?: string[] };
      for (const npc of world.npcs.values()) {
        const roomId = (npc.location as string).slice(5);
        const room = world.rooms.get(roomId);
        if (!room || room.areaId === 'hub') continue;
        const rule = npc.hostile ? hostileRule : npcRule;
        expect(matches(room.tags, rule.requires), `${npc.name} in ${room.type}`).toBe(true);
      }
    }
  });

  it('tops an area up to the guaranteed minimums where its tags allow', () => {
    for (const world of sample) {
      for (const area of generated(world)) {
        const rooms = world.roomsOf(area.id);
        const hostileRooms = rooms.filter((room) =>
          world.npcsIn(room.id).some((npc) => npc.hostile),
        );
        const npcRooms = rooms.filter((room) => world.npcsIn(room.id).some((npc) => !npc.hostile));

        const canHoldHostile = rooms.filter((room) =>
          matches(room.tags, (campaign.placement['hostile'] as { requires?: string[] }).requires),
        );
        const canHoldNpc = rooms.filter((room) =>
          matches(room.tags, (campaign.placement['npc'] as { requires?: string[] }).requires),
        );

        expect(hostileRooms.length).toBeGreaterThanOrEqual(
          Math.min(guarantees.minHostiles, canHoldHostile.length),
        );
        expect(npcRooms.length).toBeGreaterThanOrEqual(
          Math.min(guarantees.minNpcs, canHoldNpc.length),
        );
      }
    }
  });

  it('leaves rooms bare, because that is where atmosphere lives', () => {
    for (const world of sample) {
      for (const area of generated(world)) {
        const rooms = world.roomsOf(area.id);
        const bare = rooms.filter(
          (room) => world.objectsIn(room.id).length === 0 && world.npcsIn(room.id).length === 0,
        );
        expect(bare.length, `${area.id} has nothing empty in it`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps hostiles off more than the allowed share of an area', () => {
    const fraction = ((guarantees as unknown as Record<string, number>)[
      'maxHostileRoomFraction'
    ] ?? 1) as number;
    for (const world of sample) {
      for (const area of generated(world)) {
        const rooms = world.roomsOf(area.id);
        const hostileRooms = rooms.filter((room) =>
          world.npcsIn(room.id).some((npc) => npc.hostile),
        );
        expect(hostileRooms.length).toBeLessThanOrEqual(Math.max(1, Math.ceil(rooms.length * fraction)));
      }
    }
  });

  it('fills a container through the pointer, never through a list', () => {
    const containers = sample.flatMap((world) =>
      [...world.objects.values()]
        .filter((object) => object.flags.container)
        .map((object) => ({ world, object })),
    );
    expect(containers.length).toBeGreaterThan(0);
    for (const { world, object } of containers) {
      expect(object).not.toHaveProperty('contents');
      for (const held of world.contentsOfObject(object.id)) {
        expect(held.location).toBe(inObject(object.id));
        expect(held.flags.takeable).toBe(true);
      }
    }
  });

  it('hangs a locked door on an edge and keys it', () => {
    const doors = sample.flatMap((world) =>
      [...world.objects.values()]
        .filter((object) => object.flags.locked)
        .map((object) => ({ world, object })),
    );
    expect(doors.length).toBeGreaterThan(0);
    for (const { world, object } of doors) {
      const edge = [...world.edges.values()].find((candidate) => candidate.doorId === object.id);
      expect(edge, `${object.name} hangs on nothing`).toBeDefined();
      // A key is flavour, not structure: it may be missing, but if it exists it
      // must be a real object somewhere in the world.
      if (object.flags.lockedById) expect(world.objects.has(object.flags.lockedById)).toBe(true);
    }
  });

  it('puts a key inside its band, counted in hops', () => {
    const near = campaign.rules['DISTANCE_BANDS'] as Record<string, [number, number]>;
    const [lo, hi] = near['near'] as [number, number];
    for (const world of sample) {
      for (const door of [...world.objects.values()].filter((object) => object.flags.lockedById)) {
        const key = world.objects.get(door.flags.lockedById as string) as ObjectRecord;
        const doorRoom = (door.location as string).slice(5);
        const keyRoom = (key.location as string).slice(5);
        if (doorRoom === keyRoom) continue; // no room in band: the lock stands as flavour
        const hops = world.hopsFrom(doorRoom).get(keyRoom);
        expect(hops).toBeGreaterThanOrEqual(lo);
        expect(hops).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('reads back through one query and one field', () => {
    const world = sample[0] as World;
    const room = [...world.rooms.values()].find(
      (candidate) => world.objectsIn(candidate.id).length > 0,
    );
    const object = world.objectsIn(room?.id as string)[0] as ObjectRecord;
    world.moveTo(object.id, 'player');
    expect(world.objectsIn(room?.id as string)).not.toContain(object);
    expect(world.contentsOf('player').objects).toContain(object);
    world.moveTo(object.id, inRoom(room?.id as string));
    expect(world.objectsIn(room?.id as string)).toContain(object);
  });

  it('gives the hub its authored people and nothing rolled', () => {
    const world = World.create({ campaign, seed: 'hub-people' });
    for (const authored of campaign.manifest.hub.npcs) {
      const npc = world.npcs.get(authored.id) as NpcRecord;
      expect(npc.location).toBe(authored.location);
      expect(npc.hostile).toBe(false);
      expect(npc.maxHp).toBeGreaterThan(0);
    }
    // Nothing is generated in the Hub, so nothing hostile can be standing in it.
    expect([...world.npcs.values()].every((npc) => !npc.hostile)).toBe(true);
    expect(world.objects.size).toBe(0);
  });
});
