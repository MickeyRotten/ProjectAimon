/**
 * The world: the Hub, the areas generated off it, and the queries every other
 * system asks of them.
 *
 * It holds the tables the data model describes — `areas`, `rooms`, `edges` —
 * and nothing else. In particular:
 *
 *  - A room never stores its exits. `exitsOf` is a query over `edges`.
 *  - A room never stores its contents. Objects and people carry a `location`
 *    pointer and the room carries nothing, so "what is in here" is one query
 *    over one field — `contentsOf`. There is no `contents` array to drift.
 *  - Distance is `hopsFrom`, counted along edges. Never coordinates.
 *
 * Generation happens in exactly one place — `enterGate` — because "walking
 * through an ungenerated gate generates the area" is literally "`roomB` is
 * null". Once filled in, the edge is an ordinary connection forever.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { rollSex } from '../content/sex';
import { deriveHp, deriveResolve, floorAttributes, rollAttributes } from '../content/stats';
import { Rng } from '../engine/rng';
import { ruleObject } from '../engine/rules';
import { generateArea, mintAreaId, reserveArea } from './area';
import { WorldLattice } from './lattice';
import {
  coordKey,
  inRoom,
  isDirection,
  opposite,
  type AreaRecord,
  type Coord,
  type Direction,
  type EdgeRecord,
  type Cube,
  type Location,
  type NpcRecord,
  type ObjectRecord,
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

/**
 * Everything the world is, flat, ready to be written into a save.
 *
 * It is records only — no indexes, no derived values, no tables. Loading
 * rebuilds the indexes and **regenerates nothing**: the world lives in the
 * save, not in the tables, so a save made against an older campaign still
 * opens onto the same rooms.
 */
export interface WorldSnapshot {
  campaignId: string;
  seed: number | string;
  rngState: number;
  areas: AreaRecord[];
  rooms: RoomRecord[];
  edges: EdgeRecord[];
  objects: ObjectRecord[];
  npcs: NpcRecord[];
  flags: string[];
  /** The lattice reservations, which include cubes no area has filled yet. */
  cubes: [string, Cube][];
  notes: string[];
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
  /** Items, doors, scenery and containers alike. Behaviour is flags, not types. */
  readonly objects = new Map<string, ObjectRecord>();
  /** Everyone who is not the player. `hostile` separates a wolf from a smith. */
  readonly npcs = new Map<string, NpcRecord>();
  /** World flags. Spawn upgrades and conditional stats are the first readers. */
  readonly flags = new Set<string>();
  /** Everything generation logged, oldest first. Shown on the boot screen. */
  readonly notes: string[] = [];

  private readonly rng: Rng;
  private readonly seed: number | string;
  private readonly byCoord = new Map<string, string>();
  private readonly byRoom = new Map<string, EdgeRecord[]>();

  private constructor(options: WorldOptions) {
    this.campaign = options.campaign;
    this.seed = options.seed;
    this.rng = new Rng(options.seed);
    this.lattice = new WorldLattice(options.campaign.rules);
  }

  /** Build a new world: the hand-authored Hub, and a stub behind every hub gate. */
  static create(options: WorldOptions): World {
    const world = new World(options);
    world.buildHub();
    return world;
  }

  /**
   * Every record, for the save. Deep-copied on the way out, so a snapshot
   * taken mid-turn cannot be mutated by the turn that follows it.
   */
  snapshot(): WorldSnapshot {
    return structuredClone({
      campaignId: this.campaign.id,
      seed: this.seed,
      rngState: this.rng.toState(),
      areas: [...this.areas.values()],
      rooms: [...this.rooms.values()],
      edges: [...this.edges.values()],
      objects: [...this.objects.values()],
      npcs: [...this.npcs.values()],
      flags: [...this.flags],
      cubes: this.lattice.entries(),
      notes: [...this.notes],
    });
  }

  /**
   * Rebuild a world from a save. Records go back exactly as they were and the
   * indexes are rebuilt from them; nothing is rolled and nothing is
   * regenerated. An ungenerated gate stays a gate, with its cube still
   * reserved, and generates on the turn the player walks through it.
   */
  static restore(campaign: ResolvedCampaign, snapshot: WorldSnapshot): World {
    const world = new World({ campaign, seed: snapshot.seed });
    const copy = structuredClone(snapshot);
    world.rng.setState(copy.rngState);
    for (const [areaId, cube] of copy.cubes) world.lattice.reserve(areaId, cube);
    for (const area of copy.areas) world.areas.set(area.id, area);
    for (const room of copy.rooms) world.addRoom(room);
    for (const edge of copy.edges) world.addEdge(edge);
    for (const object of copy.objects) world.objects.set(object.id, object);
    for (const npc of copy.npcs) world.npcs.set(npc.id, npc);
    for (const flag of copy.flags) world.flags.add(flag);
    world.notes.push(...copy.notes);
    return world;
  }

  /** The RNG state, for the save. Restoring it resumes the same world stream. */
  rngState(): number {
    return this.rng.toState();
  }

  /**
   * Everything whose `location` points here. One query, one field — and the
   * only way anything ever asks what is in a room, a chest or a pocket.
   */
  contentsOf(location: Location): { objects: ObjectRecord[]; npcs: NpcRecord[] } {
    return {
      objects: [...this.objects.values()].filter((object) => object.location === location),
      npcs: [...this.npcs.values()].filter((npc) => npc.location === location),
    };
  }

  objectsIn(roomId: string): ObjectRecord[] {
    return this.contentsOf(inRoom(roomId)).objects;
  }

  npcsIn(roomId: string): NpcRecord[] {
    return this.contentsOf(inRoom(roomId)).npcs;
  }

  /** What is inside a container, which is the same query one pointer deeper. */
  contentsOfObject(objectId: string): ObjectRecord[] {
    return [...this.objects.values()].filter((object) => object.location === `obj:${objectId}`);
  }

  /**
   * Move anything, anywhere: a room, a container, an NPC's hands, the player,
   * or out of play with `null`. One field is written, so there is no second
   * place to forget.
   */
  moveTo(id: string, location: Location): void {
    const object = this.objects.get(id);
    if (object) {
      object.location = location;
      return;
    }
    const npc = this.npcs.get(id);
    if (npc) npc.location = location;
  }

  roomsOf(areaId: string): RoomRecord[] {
    return [...this.rooms.values()].filter((room) => room.areaId === areaId);
  }

  roomAt(coord: Coord): RoomRecord | undefined {
    const id = this.byCoord.get(coordKey(coord));
    return id ? this.rooms.get(id) : undefined;
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
    const bands = ruleObject(this.campaign.rules, 'DISTANCE_BANDS');
    for (const [name, range] of Object.entries(bands)) {
      if (name.startsWith('_') || !Array.isArray(range)) continue;
      const [lo, hi] = range as number[];
      if (typeof lo === 'number' && typeof hi === 'number' && hops >= lo && hops <= hi) return name;
    }
    return undefined;
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
      flags: this.flags,
    });

    this.areas.set(result.area.id, result.area);
    for (const room of result.rooms) this.addRoom(room);
    for (const newEdge of result.edges) this.addEdge(newEdge);
    for (const newStub of result.stubs) this.areas.set(newStub.id, newStub);
    for (const object of result.objects) this.objects.set(object.id, object);
    for (const npc of result.npcs) this.npcs.set(npc.id, npc);
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

    // The Hub's people are hand-authored rather than rolled, but they are the
    // same records with the same `location` pointer — nothing downstream may
    // need to know which of the two made them.
    for (const npc of hub.npcs) {
      // Hand-authored people still roll a body: the shop and the bank read the
      // same fields off the same record as anyone met out in the world.
      const stats = floorAttributes(rollAttributes(this.rng, this.campaign.rules));
      const maxHp = deriveHp(this.campaign.rules, stats.toughness);
      const maxResolve = deriveResolve(this.campaign.rules, stats.willpower);
      this.npcs.set(npc.id, {
        campaignId: this.campaign.id,
        id: npc.id,
        name: npc.name,
        aliases: [],
        location: npc.location,
        persona: npc.persona,
        tags: [...npc.tags],
        sex: rollSex({
          rng: this.rng,
          own: npc.sex,
          fallback: this.campaign.npcs.sexDefault,
        }),
        stats,
        hp: maxHp,
        maxHp,
        resolve: maxResolve,
        maxResolve,
        armourReduction: 0,
        penetration: 0,
        weaponDamage: '',
        damageBonus: 0,
        attacksPerRound: 1,
        threat: 0,
        friendliness: 0,
        bribeThreshold: 0,
        disposition: 0,
        standing: 0,
        sensed: false,
        isVendor: npc.isVendor === true,
        priceModifier: 1,
        hostile: false,
        baseId: npc.id,
        role: (npc.services ?? [])[0] ?? '',
        gambits: '',
        abilities: [],
        presenceImmune: false,
      });
    }

    for (const gate of hub.gates) {
      const room = this.rooms.get(gate.fromRoom);
      if (!room || !isDirection(gate.dir)) {
        this.notes.push(`hub: gate from "${gate.fromRoom}" ${gate.dir} goes nowhere`);
        continue;
      }
      // Two ways out of one room in one direction means one of them can never
      // be walked. Validation calls it an error; the engine refuses to build
      // the unreachable one rather than shipping a gate nobody can use.
      if (this.exitsOf(room.id).some((exit) => exit.dir === gate.dir)) {
        this.notes.push(`hub: ${room.id} already has a way out going ${gate.dir}, so the ${gate.archetype} gate was dropped`);
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
