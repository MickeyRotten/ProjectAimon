/**
 * The world: the Hub, the areas generated off it, and the queries every other
 * system asks of them.
 *
 * It holds the tables the data model describes — `areas`, `rooms`, `edges` —
 * and nothing else. In particular:
 *
 *  - A room never stores its exits. `exitsOf` is a query over `edges`.
 *  - A room never stores its contents. Objects and NPCs hold a `location`
 *    pointer and `contentsOf` is the query over it. There is no `contents`
 *    field on a room and there must never be one.
 *  - Distance is `hopsFrom`, counted along edges. Never coordinates.
 *
 * Generation happens in exactly one place — `enterGate` — because "walking
 * through an ungenerated gate generates the area" is literally "`roomB` is
 * null". Once filled in, the edge is an ordinary connection forever.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { hubNpc } from '../content/npcs';
import {
  inRoom,
  parseLocation,
  type LocationRef,
  type NpcRecord,
  type ObjectRecord,
} from '../content/records';
import { Rng } from '../engine/rng';
import { bandOf } from '../engine/rules';
import { generateArea, mintAreaId, reserveArea } from './area';
import { WorldLattice } from './lattice';
import {
  coordKey,
  isDirection,
  opposite,
  type AreaRecord,
  type Coord,
  type Direction,
  type EdgeRecord,
  type RoomRecord,
} from './types';

export const HUB_AREA_ID = 'hub';

export interface Exit {
  dir: Direction;
  edge: EdgeRecord;
  /** null when this is a gate: the area behind it has not been generated. */
  toRoomId: string | null;
  gateArchetype?: string;
}

export interface WorldOptions {
  campaign: ResolvedCampaign;
  /** Anything: the character's name plus a timestamp makes a fine world seed. */
  seed: number | string;
}

export class World {
  readonly campaign: ResolvedCampaign;
  readonly lattice: WorldLattice;
  readonly areas = new Map<string, AreaRecord>();
  readonly rooms = new Map<string, RoomRecord>();
  readonly edges = new Map<string, EdgeRecord>();
  readonly objects = new Map<string, ObjectRecord>();
  readonly npcs = new Map<string, NpcRecord>();
  /** Everything generation logged, oldest first. Shown on the boot screen. */
  readonly notes: string[] = [];

  private readonly rng: Rng;
  private readonly byCoord = new Map<string, string>();
  private readonly byRoom = new Map<string, EdgeRecord[]>();
  /** `location` -> the ids pointing at it. Rebuilt by `relocate`, never stale. */
  private readonly byLocation = new Map<string, Set<string>>();

  private constructor(options: WorldOptions) {
    this.campaign = options.campaign;
    this.rng = new Rng(options.seed);
    this.lattice = new WorldLattice(options.campaign.rules);
  }

  /** Build a new world: the hand-authored Hub, and a stub behind every hub gate. */
  static create(options: WorldOptions): World {
    const world = new World(options);
    world.buildHub();
    return world;
  }

  /** The RNG state, for the save. Restoring it resumes the same world stream. */
  rngState(): number {
    return this.rng.toState();
  }

  roomsOf(areaId: string): RoomRecord[] {
    return [...this.rooms.values()].filter((room) => room.areaId === areaId);
  }

  roomAt(coord: Coord): RoomRecord | undefined {
    const id = this.byCoord.get(coordKey(coord));
    return id ? this.rooms.get(id) : undefined;
  }

  /**
   * Everything whose `location` points at this one — objects and NPCs alike.
   * This is the only contents query there is, and it works the same for a
   * room, a chest, a shopkeeper's stock and the player's pockets.
   */
  contentsOf(location: LocationRef): { objects: ObjectRecord[]; npcs: NpcRecord[] } {
    const ids = location ? (this.byLocation.get(location) ?? new Set<string>()) : new Set<string>();
    const objects: ObjectRecord[] = [];
    const npcs: NpcRecord[] = [];
    for (const id of ids) {
      const object = this.objects.get(id);
      if (object) {
        objects.push(object);
        continue;
      }
      const npc = this.npcs.get(id);
      if (npc) npcs.push(npc);
    }
    return { objects, npcs };
  }

  /** What lies in a room, which is `contentsOf` with the pointer spelled out. */
  inRoom(roomId: string): { objects: ObjectRecord[]; npcs: NpcRecord[] } {
    return this.contentsOf(inRoom(roomId));
  }

  /**
   * Move something. One field is written and the index follows, which is why
   * nothing outside this class should ever assign `location` directly.
   */
  relocate(id: string, location: LocationRef): void {
    const thing = this.objects.get(id) ?? this.npcs.get(id);
    if (!thing) throw new Error(`nothing with id "${id}" to move`);
    if (thing.location) this.byLocation.get(thing.location)?.delete(id);
    thing.location = location;
    this.indexLocation(id, location);
  }

  edgesOf(roomId: string): EdgeRecord[] {
    return this.byRoom.get(roomId) ?? [];
  }

  /** What leads out of this room, gates included. The only exits query. */
  exitsOf(roomId: string): Exit[] {
    return this.edgesOf(roomId).map((edge) => {
      const forward = edge.roomA === roomId;
      const dir = forward ? edge.dirFromA : opposite(edge.dirFromA);
      const toRoomId = forward ? edge.roomB : edge.roomA;
      const exit: Exit = { dir, edge, toRoomId };
      if (edge.gateArchetype !== undefined) exit.gateArchetype = edge.gateArchetype;
      return exit;
    });
  }

  /**
   * Hops from a room to everything reachable from it. This is the distance
   * metric — `DISTANCE_BANDS` reads it, and must never read coordinates.
   */
  hopsFrom(roomId: string): Map<string, number> {
    const seen = new Map<string, number>([[roomId, 0]]);
    const queue = [roomId];
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head] as string;
      const depth = seen.get(at) as number;
      for (const exit of this.exitsOf(at)) {
        if (!exit.toRoomId || seen.has(exit.toRoomId)) continue;
        seen.set(exit.toRoomId, depth + 1);
        queue.push(exit.toRoomId);
      }
    }
    return seen;
  }

  /** Which band a hop count falls in — `near`, `quiteNear`, `far`. */
  bandOf(hops: number): string | undefined {
    return bandOf(this.campaign.rules, hops);
  }

  /**
   * Walk through a gate. Generates the area behind it at `depth + 1`, links
   * the edge to the new entry room, and reserves a cube for every gate the new
   * area rolled. Called once per gate, ever.
   */
  enterGate(edgeId: string): AreaRecord {
    const edge = this.edges.get(edgeId);
    if (!edge) throw new Error(`no edge "${edgeId}"`);
    if (edge.roomB) {
      const room = this.rooms.get(edge.roomB);
      const area = room ? this.areas.get(room.areaId) : undefined;
      if (!area) throw new Error(`edge "${edgeId}" leads nowhere`);
      return area;
    }
    const stub = edge.gateAreaId ? this.areas.get(edge.gateAreaId) : undefined;
    if (!stub) throw new Error(`gate "${edgeId}" has no reserved area`);
    if (stub.generated) throw new Error(`area "${stub.id}" is already generated`);

    // Its own stream, keyed by the area id, so generating this area cannot
    // shift the rolls another area would have made.
    const result = generateArea({
      campaign: this.campaign,
      rng: this.rng.fork(stub.id),
      lattice: this.lattice,
      stub,
    });

    this.areas.set(result.area.id, result.area);
    for (const room of result.rooms) this.addRoom(room);
    for (const newEdge of result.edges) this.addEdge(newEdge);
    for (const object of result.objects) this.addObject(object);
    for (const npc of result.npcs) this.addNpc(npc);
    for (const newStub of result.stubs) this.areas.set(newStub.id, newStub);
    this.note(result.area.id, result.notes);

    edge.roomB = result.area.entryRoomId;
    this.indexEdge(edge);
    return result.area;
  }

  // ── the Hub ───────────────────────────────────────────────────────

  private buildHub(): void {
    const { hub } = this.campaign.manifest;
    this.lattice.reserve(HUB_AREA_ID, hub.cube);
    this.areas.set(HUB_AREA_ID, {
      campaignId: this.campaign.id,
      id: HUB_AREA_ID,
      archetype: HUB_AREA_ID,
      name: this.campaign.manifest.name,
      shape: 'authored',
      themeTokens: [],
      depth: 0,
      // Nothing is rolled in the Hub, so it has no tier to roll. Difficulty
      // starts one gate out.
      tier: 0,
      cube: hub.cube,
      generated: true,
      entryRoomId: hub.entryRoomId,
      entryCoord: null,
      reservedCoords: [],
    });

    for (const room of hub.rooms) {
      this.addRoom({
        campaignId: this.campaign.id,
        id: room.id,
        areaId: HUB_AREA_ID,
        x: room.x,
        y: room.y,
        z: room.z,
        type: HUB_AREA_ID,
        tags: [...room.tags],
        name: room.name,
        glyph: '',
        visited: false,
        baseDesc: room.baseDesc,
      });
    }

    for (const [from, dir, to] of hub.edges) {
      if (!isDirection(dir)) {
        this.notes.push(`hub: "${dir}" is not a direction, so ${from} does not reach ${to}`);
        continue;
      }
      this.addEdge({
        campaignId: this.campaign.id,
        id: `${from}>${to}`,
        roomA: from,
        roomB: to,
        dirFromA: dir,
        oneWay: false,
      });
    }

    // The Hub's people are hand-authored, but they are ordinary records with
    // ordinary numbers: the quartermaster you decide to rob has real stats.
    for (const def of hub.npcs ?? []) {
      const person = hubNpc(this.campaign, this.rng, def);
      if (!this.rooms.has(parseLocation(person.location)?.id ?? '')) {
        this.notes.push(`hub: ${person.id} points at "${person.location}", which is no room here`);
      }
      this.addNpc(person);
    }

    for (const gate of hub.gates) {
      const room = this.rooms.get(gate.fromRoom);
      if (!room || !isDirection(gate.dir)) {
        this.notes.push(`hub: gate from "${gate.fromRoom}" ${gate.dir} goes nowhere`);
        continue;
      }
      const { stub, longRoad } = reserveArea({
        campaign: this.campaign,
        rng: this.rng,
        lattice: this.lattice,
        archetype: gate.archetype,
        depth: 1,
        gateCoord: room,
        gateDir: gate.dir,
      });
      if (longRoad) this.notes.push(`hub: ${stub.id} took the long road`);
      this.areas.set(stub.id, stub);
      this.addEdge({
        campaignId: this.campaign.id,
        id: `${room.id}>gate:${stub.id}`,
        roomA: room.id,
        roomB: null,
        dirFromA: gate.dir,
        oneWay: false,
        gateArchetype: gate.archetype,
        gateAreaId: stub.id,
      });
    }
  }

  /** Mint an area id from the world stream. Used when a save needs a new one. */
  mintAreaId(archetype: string): string {
    return mintAreaId(this.rng, archetype);
  }

  // ── indexes ───────────────────────────────────────────────────────

  private addRoom(room: RoomRecord): void {
    const key = coordKey(room);
    const sitting = this.byCoord.get(key);
    if (sitting && sitting !== room.id) {
      this.notes.push(`${room.id} and ${sitting} both claim ${key}`);
    }
    this.rooms.set(room.id, room);
    this.byCoord.set(key, room.id);
  }

  private addObject(object: ObjectRecord): void {
    this.objects.set(object.id, object);
    this.indexLocation(object.id, object.location);
  }

  private addNpc(npc: NpcRecord): void {
    this.npcs.set(npc.id, npc);
    this.indexLocation(npc.id, npc.location);
  }

  private indexLocation(id: string, location: LocationRef): void {
    if (!location) return;
    const holding = this.byLocation.get(location) ?? new Set<string>();
    holding.add(id);
    this.byLocation.set(location, holding);
  }

  private addEdge(edge: EdgeRecord): void {
    this.edges.set(edge.id, edge);
    this.indexEdge(edge);
  }

  private indexEdge(edge: EdgeRecord): void {
    for (const roomId of [edge.roomA, edge.roomB]) {
      if (!roomId) continue;
      const list = this.byRoom.get(roomId) ?? [];
      if (!list.includes(edge)) list.push(edge);
      this.byRoom.set(roomId, list);
    }
  }

  private note(areaId: string, notes: readonly string[]): void {
    for (const line of notes) this.notes.push(`${areaId}: ${line}`);
  }
}
