/**
 * Area generation — one deterministic pass, no LLM, on first entry.
 *
 *  0. Depth is the source area's depth plus one. The cube was already
 *     reserved when the gate was created.
 *  1. Archetype comes from the gate.
 *  2. Roll a size and a graph shape.
 *  3. Build the room graph — connections first, then slots.
 *  4. Give every room a type, which gives it its tags.
 *
 *  5. Roll contents against `placement.json` — the placement roller, which
 *     lives in its own file and is handed a finished graph.
 *
 * Structure and contents are separate passes on purpose: the map exists
 * immediately and permanently, and only prose is lazy.
 *
 * Nothing in this file decides a number. Sizes, shapes, tier curve, gate
 * counts and fit rules are all read from the tables, because the tables are
 * the authoring surface and an engine constant is a knob nobody can turn.
 */

import type { JsonObject } from '../campaign/merge';
import type { AreaDef, ResolvedCampaign, RoomTypeDef } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleArray, ruleNumber, ruleObject, ruleRange, ruleWeightedPairs } from '../engine/rules';
import { matches } from '../engine/tags';
import { layoutArea, roomyEntry, weaveChords } from './layout';
import { placeContents } from './placement';
import {
  buildGraph,
  chordFraction,
  degrees,
  hopsFrom,
  isShape,
  type Graph,
  type Shape,
} from './shapes';
import type { WorldLattice } from './lattice';
import {
  ALL_DIRECTIONS,
  coordKey,
  cubeContains,
  directionBetween,
  FLAT_DIRECTIONS,
  opposite,
  sidesInside,
  step,
  type AreaRecord,
  type Coord,
  type Direction,
  type EdgeRecord,
  type NpcRecord,
  type ObjectRecord,
  type QuestRecord,
  type RoomRecord,
} from './types';

export interface GenerationResult {
  area: AreaRecord;
  rooms: RoomRecord[];
  /** Ordinary edges plus the gates out. A gate has `roomB: null`. */
  edges: EdgeRecord[];
  /** One stub per gate: cube reserved, nothing generated inside it yet. */
  stubs: AreaRecord[];
  /** Everything the placement roller put in the area, contents of containers included. */
  objects: ObjectRecord[];
  /** People and creatures alike — one table, `hostile` is a flag on the record. */
  npcs: NpcRecord[];
  /** Offered quests, one per quest-giving NPC the placement roller made. */
  quests: QuestRecord[];
  notes: string[];
}

export interface GenerateOptions {
  campaign: ResolvedCampaign;
  /** The area's own stream, so generating one area cannot shift another. */
  rng: Rng;
  lattice: WorldLattice;
  /** The stub made when the gate into this area was created. */
  stub: AreaRecord;
  /** World flags, which spawn upgrades and conditional stats read. */
  flags?: ReadonlySet<string> | undefined;
}

/**
 * Difficulty follows distance from the Hub, not archetype, with jitter so the
 * curve is not a straight line — and it is rolled once and stored, so walking
 * back through somewhere you cleared is always safe.
 */
export function rollTier(rules: JsonObject, areaDef: AreaDef, depth: number, rng: Rng): number {
  const stepSize = ruleNumber(rules, 'DEPTH_TIER.step');
  const base = ruleNumber(rules, 'DEPTH_TIER.base');
  const max = ruleNumber(rules, 'DEPTH_TIER.max');
  const spikeChance = ruleNumber(rules, 'DEPTH_TIER.spikeChance');
  const spikeBonus = ruleNumber(rules, 'DEPTH_TIER.spikeBonus');

  let tier = base + Math.floor(depth / stepSize);
  const jitter = rng.weighted(ruleWeightedPairs(rules, 'DEPTH_TIER.jitter'));
  tier += Number(jitter.value);
  if (rng.chance(spikeChance)) tier += spikeBonus;
  return Math.max(areaDef.tierFloor, Math.min(areaDef.tierCeil, Math.min(max, tier)));
}

/** A globally unique area id: the archetype plus a run tag. */
export function mintAreaId(rng: Rng, archetype: string): string {
  return `${archetype}_${rng.int(0, 0xfffff).toString(16).padStart(5, '0')}`;
}

/**
 * A stub area: a cube in the lattice and nothing else. Made when a gate is
 * created, so a coordinate inside it can be named before anyone walks in.
 */
export function reserveArea(options: {
  campaign: ResolvedCampaign;
  rng: Rng;
  lattice: WorldLattice;
  archetype: string;
  depth: number;
  gateCoord: Coord;
  gateDir: Direction;
}): { stub: AreaRecord; longRoad: boolean } {
  const areaDef = requireArea(options.campaign, options.archetype);
  const id = mintAreaId(options.rng, options.archetype);
  const allocation = options.lattice.allocate({
    areaId: id,
    archetype: options.archetype,
    maxRooms: areaDef.size[1],
    gateCoord: options.gateCoord,
    gateDir: options.gateDir,
  });
  return {
    longRoad: allocation.longRoad,
    stub: {
      campaignId: options.campaign.id,
      id,
      archetype: options.archetype,
      name: areaDef.name,
      shape: '',
      themeTokens: [],
      depth: options.depth,
      tier: 0,
      cube: allocation.cube,
      generated: false,
      entryRoomId: null,
      entryCoord: allocation.entryCoord,
      reservedCoords: [],
    },
  };
}

/** Generate the area behind a gate. Called once, on first entry, forever. */
export function generateArea(options: GenerateOptions): GenerationResult {
  const { campaign, rng, lattice, stub } = options;
  const rules = campaign.rules;
  const areaDef = requireArea(campaign, stub.archetype);
  const notes: string[] = [];

  const roomCount = rng.int(areaDef.size[0], areaDef.size[1]);
  const shape = rollShape(rng, areaDef, notes);
  const tier = rollTier(rules, areaDef, stub.depth, rng);
  const themeTokens = rng.sample(areaDef.themeTokens, 2);

  // Four ways out of a slot in a flat area, six where the cube has depth —
  // and fewer than that for the entry room, which sits on the cube's face.
  const flat = stub.cube.z1 === stub.cube.z0;
  const maxDegree = flat ? 4 : 6;
  const entryCoord = roomyEntry(stub.cube, stub.entryCoord ?? centreOf(stub));
  const graph = buildGraph(rng, rules, shape, roomCount, {
    maxDegree,
    entryMaxDegree: Math.min(maxDegree, sidesInside(stub.cube, entryCoord)),
  });
  const layout = layoutArea({
    graph,
    rng,
    rules,
    cube: stub.cube,
    entryCoord,
    reservedCoords: stub.reservedCoords,
    growCube: (slack) => lattice.grow(stub.id, stub.archetype, areaDef.size[1], slack),
  });
  notes.push(...layout.notes);
  if (layout.unfilledReservations.length > 0) {
    notes.push(
      `${layout.unfilledReservations.length} reserved coordinate(s) got no room — a Distant objective there needs replacing`,
    );
  }

  // Density is woven on the lattice, between rooms that ended up side by side,
  // so every connection it adds is one the map can draw.
  const chords = weaveChords({
    placements: layout.placements,
    edges: layout.graph.edges,
    rng,
    wanted: Math.round(roomCount * chordFraction(rules, shape)),
    maxDegree,
  });
  const kept: Graph = { nodes: layout.graph.nodes, edges: [...layout.graph.edges, ...chords] };
  const nodeDegrees = degrees(kept);

  const area: AreaRecord = {
    ...stub,
    shape,
    tier,
    themeTokens,
    cube: lattice.cubeOf(stub.id) ?? stub.cube,
    generated: true,
    entryCoord,
  };

  const rooms: RoomRecord[] = [];
  for (let node = 0; node < kept.nodes; node++) {
    const at = layout.placements[node] as Coord;
    const type = rollRoomType(rng, rules, areaDef, nodeDegrees[node] ?? 0);
    rooms.push({
      campaignId: campaign.id,
      id: `${area.id}:r${String(node).padStart(2, '0')}`,
      areaId: area.id,
      x: at.x,
      y: at.y,
      z: at.z,
      type: type.id,
      // Area tags ride on every room, so a filter can ask about the place as
      // well as the room — `underground`, `cultivated`, `settled`.
      tags: [...new Set([...type.tags, ...areaDef.areaTags])],
      name: '',
      glyph: type.glyph ?? '',
      visited: false,
      baseDesc: '',
    });
  }
  area.entryRoomId = rooms[0]?.id ?? null;

  const edges: EdgeRecord[] = [];
  for (const [a, b] of kept.edges) {
    const roomA = rooms[a] as RoomRecord;
    const roomB = rooms[b] as RoomRecord;
    const dir = directionBetween(roomA, roomB);
    if (!dir) continue; // a loose edge the map cannot draw; already logged
    edges.push({
      campaignId: campaign.id,
      id: `${roomA.id}>${roomB.id}`,
      roomA: roomA.id,
      roomB: roomB.id,
      dirFromA: dir,
      oneWay: false,
    });
  }
  if (layout.looseEdges.length > 0) {
    notes.push(`${layout.looseEdges.length} connection(s) dropped as undrawable`);
  }

  const gates = rollGates({ campaign, rng, lattice, area, rooms, edges, graph: kept, areaDef });
  edges.push(...gates.edges);
  notes.push(...gates.notes);

  // Contents last, on a graph that is finished: the roller needs hop distance
  // for the tier bonus and for a key's distance band, and neither exists until
  // every edge is drawn. Its own stream, so tuning a placement chance cannot
  // shift the shape of the map that was already rolled.
  const contents = placeContents({
    campaign,
    rng: rng.fork(`${area.id}:contents`),
    area,
    areaDef,
    rooms,
    edges,
    ...(options.flags ? { flags: options.flags } : {}),
  });
  notes.push(...contents.notes);

  return {
    area,
    rooms,
    edges,
    stubs: gates.stubs,
    objects: contents.objects,
    npcs: contents.npcs,
    quests: contents.quests,
    notes,
  };
}

// ── the pieces ──────────────────────────────────────────────────────

function requireArea(campaign: ResolvedCampaign, archetype: string): AreaDef {
  const areaDef = campaign.areas.get(archetype);
  if (!areaDef) throw new Error(`no area archetype "${archetype}" in campaign "${campaign.id}"`);
  return areaDef;
}

function rollShape(rng: Rng, areaDef: AreaDef, notes: string[]): Shape {
  const allowed = areaDef.shapes.filter(isShape);
  if (allowed.length !== areaDef.shapes.length) {
    notes.push(`areas/${areaDef.id}.json names a shape the generator does not build`);
  }
  return allowed.length > 0 ? rng.pick(allowed) : 'sprawl';
}

/** A room type with a glyph, since the table may or may not supply one. */
type RoomTypeRoll = RoomTypeDef & { id: string; glyph?: string };

/**
 * Roll a room type, respecting `WORLD.roomTypeFit`: a `dead-end` type only
 * fits a leaf, a `junction` type only fits where three ways meet. When the
 * filter leaves nothing, the table rolls unfiltered — a room always gets a
 * type, because a room without one has no tags and nothing can be placed in it.
 */
function rollRoomType(rng: Rng, rules: JsonObject, areaDef: AreaDef, degree: number): RoomTypeRoll {
  const fit = ruleObject(rules, 'WORLD.roomTypeFit');
  const entries = Object.entries(areaDef.roomTypes)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, def]) => ({ ...(def as RoomTypeRoll), id }));

  const fits = entries.filter((entry) =>
    entry.tags.every((tag) => {
      const constraint = fit[tag];
      if (!constraint || typeof constraint !== 'object' || Array.isArray(constraint)) return true;
      const min = (constraint as JsonObject)['minDegree'];
      const max = (constraint as JsonObject)['maxDegree'];
      if (typeof min === 'number' && degree < min) return false;
      if (typeof max === 'number' && degree > max) return false;
      return true;
    }),
  );
  return rng.weighted(fits.length > 0 ? fits : entries);
}

/**
 * Roll the ways out. Each gate reserves the cube behind it immediately — that
 * reservation is the whole reason coordinates came back, and it is what makes
 * a `Distant` quest objective placeable before the area exists.
 */
function rollGates(options: {
  campaign: ResolvedCampaign;
  rng: Rng;
  lattice: WorldLattice;
  area: AreaRecord;
  rooms: RoomRecord[];
  edges: EdgeRecord[];
  graph: Graph;
  areaDef: AreaDef;
}): { edges: EdgeRecord[]; stubs: AreaRecord[]; notes: string[] } {
  const { campaign, rng, lattice, area, rooms, edges, graph, areaDef } = options;
  const rules = campaign.rules;
  const notes: string[] = [];
  const gateEdges: EdgeRecord[] = [];
  const stubs: AreaRecord[] = [];

  const targets = Object.entries(areaDef.gates ?? {})
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, w]) => ({ id, w }));
  if (targets.length === 0) return { edges: gateEdges, stubs, notes };

  const [minGates, maxGates] = ruleRange(rules, 'WORLD.gates.perArea');
  const minHops = ruleNumber(rules, 'WORLD.gates.minHopsFromEntry');
  const maxPerRoom = ruleNumber(rules, 'WORLD.gates.maxPerRoom');
  const requires = ruleArray(rules, 'WORLD.gates.roomRequires', []).filter(
    (term): term is string => typeof term === 'string',
  );

  const hops = hopsFrom(graph, 0);
  const occupied = new Set(rooms.map((room) => coordKey(room)));
  const usedDirs = new Map<string, Set<Direction>>();
  for (const edge of edges) {
    dirsOf(usedDirs, edge.roomA).add(edge.dirFromA);
    if (edge.roomB) dirsOf(usedDirs, edge.roomB).add(opposite(edge.dirFromA));
  }
  const gatesPerRoom = new Map<string, number>();

  const wanted = rng.int(minGates, maxGates);
  const flat = area.cube.z1 === area.cube.z0;
  const compass = flat ? FLAT_DIRECTIONS : ALL_DIRECTIONS;

  // `rooms[i]` is graph node `i` — they are built in node order — so the hop
  // count from the entry is a lookup rather than a second walk.
  const candidates = rng.shuffle(
    rooms.filter((room, node) => (hops.get(node) ?? 0) >= minHops && matches(room.tags, requires)),
  );

  for (const room of candidates) {
    if (gateEdges.length >= wanted) break;
    if ((gatesPerRoom.get(room.id) ?? 0) >= maxPerRoom) continue;

    // A gate needs a side of the room with nothing on it, pointing at a slot
    // no room of this area occupies — otherwise the crossing would be drawn
    // straight into a neighbour.
    const free = compass.filter(
      (dir) => !dirsOf(usedDirs, room.id).has(dir) && !occupied.has(coordKey(step(room, dir))),
    );
    const outward = free.filter((dir) => !cubeContains(area.cube, step(room, dir)));
    const dir = rng.maybePick(outward.length > 0 ? outward : free);
    if (!dir) continue;

    const archetype = rng.weighted(targets).id;
    if (!campaign.areas.has(archetype)) {
      notes.push(`gate table names "${archetype}", which no area defines`);
      continue;
    }
    const { stub, longRoad } = reserveArea({
      campaign,
      rng,
      lattice,
      archetype,
      depth: area.depth + 1,
      gateCoord: room,
      gateDir: dir,
    });
    if (longRoad) notes.push(`${stub.id} could not sit next door — long road from ${room.id}`);

    stubs.push(stub);
    dirsOf(usedDirs, room.id).add(dir);
    gatesPerRoom.set(room.id, (gatesPerRoom.get(room.id) ?? 0) + 1);
    gateEdges.push({
      campaignId: campaign.id,
      id: `${room.id}>gate:${stub.id}`,
      roomA: room.id,
      roomB: null,
      dirFromA: dir,
      oneWay: false,
      gateArchetype: archetype,
      gateAreaId: stub.id,
    });
  }

  if (gateEdges.length === 0) notes.push('no room could carry a gate, so this area is a dead end');
  return { edges: gateEdges, stubs, notes };
}

const dirsOf = (map: Map<string, Set<Direction>>, roomId: string): Set<Direction> => {
  const existing = map.get(roomId);
  if (existing) return existing;
  const made = new Set<Direction>();
  map.set(roomId, made);
  return made;
};

const centreOf = (stub: AreaRecord): Coord => ({
  x: Math.floor((stub.cube.x0 + stub.cube.x1) / 2),
  y: Math.floor((stub.cube.y0 + stub.cube.y1) / 2),
  z: Math.floor((stub.cube.z0 + stub.cube.z1) / 2),
});
