import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { World } from '../src/world/world';
import { SHAPES } from '../src/world/shapes';
import { adjacent, coordKey, cubeContains, cubesOverlap, roomCoord, type Coord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

/** Walk through gates until `areas` areas exist, entry-first, deterministically. */
function explore(world: World, areas: number): void {
  while (world.areas.size < areas + 1) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

/** The generated areas, which never includes the hand-authored Hub. */
const generatedAreas = (world: World) =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');

describe('the hub', () => {
  it('is built from the manifest, with a stub behind every gate', () => {
    const world = World.create({ campaign, seed: 'hub-test' });
    const hub = world.areas.get('hub');
    expect(hub?.generated).toBe(true);
    expect(world.roomsOf('hub')).toHaveLength(campaign.manifest.hub.rooms.length);

    const gates = [...world.edges.values()].filter((edge) => edge.roomB === null);
    expect(gates).toHaveLength(campaign.manifest.hub.gates.length);
    for (const gate of gates) {
      const stub = world.areas.get(gate.gateAreaId as string);
      expect(stub?.generated).toBe(false);
      expect(stub?.depth).toBe(1);
      // The cube behind the gate is reserved before the area exists — the
      // whole reason a Distant quest can name a coordinate out there.
      expect(world.lattice.cubeOf(stub?.id as string)).toBeDefined();
    }
    expect(world.notes).toEqual([]);
  });

  it('reads exits off the edges, in both directions', () => {
    const world = World.create({ campaign, seed: 'exits' });
    const yard = world.exitsOf('hub_yard');
    expect(yard.map((exit) => exit.dir).sort()).toEqual(['e', 'n', 's', 'w']);
    // The hall's way back is the same edge, read the other way round.
    const back = world.exitsOf('hub_hall').find((exit) => exit.toRoomId === 'hub_yard');
    expect(back?.dir).toBe('s');
  });

  it('counts distance in hops, never in coordinates', () => {
    const world = World.create({ campaign, seed: 'hops' });
    const hops = world.hopsFrom('hub_hall');
    expect(hops.get('hub_yard')).toBe(1);
    expect(hops.get('hub_gate')).toBe(3);
    expect(world.bandOf(1)).toBe('near');
    expect(world.bandOf(4)).toBe('quiteNear');
    expect(world.bandOf(9)).toBe('far');
  });
});

describe('generating an area', () => {
  it('fills in the gate it was entered through', () => {
    const world = World.create({ campaign, seed: 'first-area' });
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    const area = world.enterGate(gate?.id as string);

    expect(area.generated).toBe(true);
    expect(gate?.roomB).toBe(area.entryRoomId);
    expect(area.entryRoomId).toBeTruthy();
    // The edge is now an ordinary connection, walkable from either side.
    const back = world.exitsOf(area.entryRoomId as string).find((exit) => exit.toRoomId === gate?.roomA);
    expect(back).toBeDefined();
  });

  it('rolls size, shape, tier and theme tokens from the tables', () => {
    for (const seed of ['a', 'b', 'c', 'd']) {
      const world = World.create({ campaign, seed });
      explore(world, 4);
      for (const area of generatedAreas(world)) {
        const def = campaign.areas.get(area.archetype);
        const rooms = world.roomsOf(area.id);
        expect(rooms.length).toBeGreaterThanOrEqual(def?.size[0] as number);
        expect(rooms.length).toBeLessThanOrEqual(def?.size[1] as number);
        expect(def?.shapes).toContain(area.shape);
        expect(SHAPES as readonly string[]).toContain(area.shape);
        expect(area.tier).toBeGreaterThanOrEqual(def?.tierFloor as number);
        expect(area.tier).toBeLessThanOrEqual(def?.tierCeil as number);
        expect(area.themeTokens).toHaveLength(2);
        expect(new Set(area.themeTokens).size).toBe(2);
      }
    }
  });

  it('gives every room a type from its archetype, and the area tags with it', () => {
    const world = World.create({ campaign, seed: 'types' });
    explore(world, 3);
    for (const area of generatedAreas(world)) {
      const def = campaign.areas.get(area.archetype);
      for (const room of world.roomsOf(area.id)) {
        expect(Object.keys(def?.roomTypes ?? {})).toContain(room.type);
        for (const tag of def?.areaTags ?? []) expect(room.tags).toContain(tag);
        expect(room.campaignId).toBe(campaign.id);
        expect(room.id.startsWith(`${area.id}:r`)).toBe(true);
      }
    }
  });

  it('honours a coordinate reserved before the area was generated', () => {
    const world = World.create({ campaign, seed: 'distant-quest' });
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    const stub = world.areas.get(gate?.gateAreaId as string);
    const cube = stub?.cube as NonNullable<typeof stub>['cube'];
    const promised: Coord = { x: cube.x1, y: cube.y1, z: cube.z1 };
    stub?.reservedCoords.push(promised);

    const area = world.enterGate(gate?.id as string);
    expect(world.roomAt(promised)?.areaId).toBe(area.id);
  });
});

describe('the invariants a generated world must hold', () => {
  const seeds = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];

  it('never draws a connection the map cannot show', () => {
    for (const seed of seeds) {
      const world = World.create({ campaign, seed });
      explore(world, 8);
      for (const edge of world.edges.values()) {
        if (!edge.roomB) continue;
        const a = world.rooms.get(edge.roomA);
        const b = world.rooms.get(edge.roomB);
        const sameArea = a?.areaId === b?.areaId;
        if (!sameArea) continue; // a crossing may span the gap between cubes
        expect(adjacent(roomCoord(a!), roomCoord(b!)), `${edge.id} in ${seed}`).toBe(true);
      }
      expect(world.notes.filter((note) => note.includes('cannot draw'))).toEqual([]);
    }
  });

  it('keeps ids and coordinates unique across the whole world', () => {
    for (const seed of seeds) {
      const world = World.create({ campaign, seed });
      explore(world, 8);
      const coords = new Set<string>();
      for (const room of world.rooms.values()) {
        const key = coordKey(room);
        expect(coords.has(key), `${room.id} collides at ${key} in ${seed}`).toBe(false);
        coords.add(key);
        const area = world.areas.get(room.areaId);
        expect(cubeContains(area?.cube as never, room)).toBe(true);
      }
      expect(new Set([...world.rooms.keys()]).size).toBe(world.rooms.size);
    }
  });

  it('never overlaps two areas in the lattice', () => {
    for (const seed of seeds) {
      const world = World.create({ campaign, seed });
      explore(world, 8);
      const cubes = world.lattice.entries();
      for (const [id, cube] of cubes) {
        for (const [otherId, other] of cubes) {
          if (id === otherId) continue;
          expect(cubesOverlap(cube, other), `${id} overlaps ${otherId} in ${seed}`).toBe(false);
        }
      }
    }
  });

  it('leaves every room reachable from the area entrance', () => {
    for (const seed of seeds) {
      const world = World.create({ campaign, seed });
      explore(world, 6);
      for (const area of generatedAreas(world)) {
        if (area.id === 'hub') continue;
        const reached = world.hopsFrom(area.entryRoomId as string);
        for (const room of world.roomsOf(area.id)) {
          expect(reached.has(room.id), `${room.id} is stranded in ${seed}`).toBe(true);
        }
      }
    }
  });

  it('rolls at least one way onward from most areas, and deepens as it goes', () => {
    const world = World.create({ campaign, seed: 'depth' });
    explore(world, 10);
    for (const area of generatedAreas(world)) {
      expect(area.depth).toBeGreaterThan(0);
    }
    const deepest = Math.max(...generatedAreas(world).map((area) => area.depth));
    expect(deepest).toBeGreaterThanOrEqual(2);
  });
});

describe('determinism', () => {
  it('builds the same world twice from the same seed', () => {
    const dump = (world: World) =>
      [...world.rooms.values()]
        .map((room) => `${room.id} ${room.type} ${coordKey(room)}`)
        .sort()
        .join('\n');

    const first = World.create({ campaign, seed: 'same-seed' });
    const second = World.create({ campaign, seed: 'same-seed' });
    explore(first, 5);
    explore(second, 5);
    expect(dump(second)).toBe(dump(first));

    const other = World.create({ campaign, seed: 'other-seed' });
    explore(other, 5);
    expect(dump(other)).not.toBe(dump(first));
  });
});
