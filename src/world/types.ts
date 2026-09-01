/**
 * The records the world is made of, and the lattice they sit in.
 *
 * Three rules from the data model shape all of it:
 *
 *  - **Rooms never store their connections.** "What does this room connect to"
 *    is a query over `edges`. The absence of an edge is the wall, and nothing
 *    stores "not connected".
 *  - **Rooms never store their contents.** There is no `contents` field here
 *    and there must never be one; contents are a query over `location`.
 *  - **Coordinates are identity, hops are distance.** A coordinate is a slot
 *    and a name. Distance is hop count along edges, never euclidean.
 */

/** A slot in the world lattice. Z is depth: negative underground. */
export interface Coord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A reserved block of the lattice, inclusive at both ends. Allocated when a
 * gate is created — before the area behind it exists.
 */
export interface Cube {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/**
 * The six ways out of a slot. `u` and `d` are the vertical pair, which is how
 * a stair in a ruin reaches the warren allocated beneath it.
 *
 * North is -y. That comes from the hand-authored hub in `campaign.json`, where
 * the yard at (1,1) goes north to the hall at (1,0): screen coordinates, y
 * growing southward. The generator must agree with the authored data.
 */
export const DIRECTIONS = {
  n: { x: 0, y: -1, z: 0 },
  s: { x: 0, y: 1, z: 0 },
  e: { x: 1, y: 0, z: 0 },
  w: { x: -1, y: 0, z: 0 },
  u: { x: 0, y: 0, z: 1 },
  d: { x: 0, y: 0, z: -1 },
} as const;

export type Direction = keyof typeof DIRECTIONS;

export const ALL_DIRECTIONS = Object.keys(DIRECTIONS) as Direction[];

/** The four compass directions, for areas one level deep. */
export const FLAT_DIRECTIONS: Direction[] = ['n', 's', 'e', 'w'];

const OPPOSITES: Record<Direction, Direction> = {
  n: 's',
  s: 'n',
  e: 'w',
  w: 'e',
  u: 'd',
  d: 'u',
};

export const opposite = (dir: Direction): Direction => OPPOSITES[dir];

export const isDirection = (value: string): value is Direction => value in DIRECTIONS;

export const step = (from: Coord, dir: Direction, distance = 1): Coord => {
  const v = DIRECTIONS[dir];
  return { x: from.x + v.x * distance, y: from.y + v.y * distance, z: from.z + v.z * distance };
};

/** The direction from `a` to `b`, or undefined when they are not neighbours. */
export function directionBetween(a: Coord, b: Coord): Direction | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return ALL_DIRECTIONS.find((dir) => {
    const v = DIRECTIONS[dir];
    return v.x === dx && v.y === dy && v.z === dz;
  });
}

export const adjacent = (a: Coord, b: Coord): boolean => directionBetween(a, b) !== undefined;

/** The map key for a coordinate. Internal; `roomCode` is the readable one. */
export const coordKey = (c: Coord): string => `${c.x},${c.y},${c.z}`;

/** `12.7.-3` — readable, unique, and usable as a debug and quest handle. */
export const roomCode = (c: Coord): string => `${c.x}.${c.y}.${c.z}`;

export function parseCoordKey(key: string): Coord {
  const [x, y, z] = key.split(',').map(Number);
  return { x: x as number, y: y as number, z: z as number };
}

export const cubeContains = (cube: Cube, c: Coord): boolean =>
  c.x >= cube.x0 && c.x <= cube.x1 && c.y >= cube.y0 && c.y <= cube.y1 && c.z >= cube.z0 && c.z <= cube.z1;

export const cubeSlots = (cube: Cube): number =>
  (cube.x1 - cube.x0 + 1) * (cube.y1 - cube.y0 + 1) * (cube.z1 - cube.z0 + 1);

/**
 * How many of a slot's six sides stay inside the cube. A room on a face has
 * fewer ways out than one in the middle, which is what caps the entry room's
 * connections.
 */
export function sidesInside(cube: Cube, at: Coord): number {
  return ALL_DIRECTIONS.filter((dir) => cubeContains(cube, step(at, dir))).length;
}

/** Every slot in a cube, in a stable order. */
export function cubeCoords(cube: Cube): Coord[] {
  const out: Coord[] = [];
  for (let z = cube.z0; z <= cube.z1; z++) {
    for (let y = cube.y0; y <= cube.y1; y++) {
      for (let x = cube.x0; x <= cube.x1; x++) out.push({ x, y, z });
    }
  }
  return out;
}

/** Do two cubes overlap, once each is grown by `gap` slots on every side? */
export function cubesOverlap(a: Cube, b: Cube, gap = 0): boolean {
  return (
    a.x0 - gap <= b.x1 &&
    b.x0 - gap <= a.x1 &&
    a.y0 - gap <= b.y1 &&
    b.y0 - gap <= a.y1 &&
    a.z0 - gap <= b.z1 &&
    b.z0 - gap <= a.z1
  );
}

// ── the tables the world is stored in ───────────────────────────────

export interface AreaRecord {
  campaignId: string;
  /** Globally unique, e.g. `warren_3f2a1`. Room ids are minted from it. */
  id: string;
  /** The archetype table it was rolled from: `farmland`, `warren`, ... */
  archetype: string;
  name: string;
  /** Empty until the area is generated. */
  shape: string;
  themeTokens: string[];
  /** Gate crossings from the Hub. */
  depth: number;
  /** Rolled once at generation and never changed, so backtracking is safe. */
  tier: number;
  cube: Cube;
  generated: boolean;
  entryRoomId: string | null;
  /**
   * The slot the entry room must take, fixed when the gate was created so the
   * crossing costs one lattice step rather than half an area.
   */
  entryCoord: Coord | null;
  /**
   * Coordinates promised to something before this area existed — a `Distant`
   * quest objective. A room is guaranteed to land on each one.
   */
  reservedCoords: Coord[];
}

export interface RoomRecord {
  campaignId: string;
  /** `<areaId>:r<n>`, globally unique. Never `r0` per area. */
  id: string;
  areaId: string;
  x: number;
  y: number;
  z: number;
  type: string;
  tags: string[];
  /** Written by the narrator on first entry. Empty until then. */
  name: string;
  /** From the room type's table entry, when it declares one. */
  glyph: string;
  visited: boolean;
  /** Written once when the area is generated. Empty until the narrator runs. */
  baseDesc: string;
}

export interface EdgeRecord {
  campaignId: string;
  id: string;
  roomA: string;
  /** `null` makes this a gate: the area behind it does not exist yet. */
  roomB: string | null;
  dirFromA: Direction;
  doorId?: string;
  oneWay: boolean;
  /** The archetype waiting behind a gate. Set only when `roomB` is null. */
  gateArchetype?: string;
  /** The area whose cube was reserved for this gate, before it generated. */
  gateAreaId?: string;
}

export const roomCoord = (room: RoomRecord): Coord => ({ x: room.x, y: room.y, z: room.z });

// ── quests ──────────────────────────────────────────────────────────

/**
 * A quest's life, as an enum rather than a boolean, so chains and failure and
 * abandonment are a state rather than a schema change later. v1 only ever moves
 * `offered -> active -> complete`, with `failed` reached when a giver dies.
 */
export type QuestState = 'offered' | 'active' | 'complete' | 'failed' | 'abandoned';

/**
 * One generated quest, campaign-scoped like everything else. It holds a list of
 * objective ids, never the objectives themselves — v1 always makes exactly one,
 * but the seam for more costs nothing now and a lot to retrofit.
 */
export interface QuestRecord {
  campaignId: string;
  id: string;
  type: string;
  giverNpcId: string;
  state: QuestState;
  objectiveIds: string[];
  /** Always empty in v1. A chain later is a populated array, not a new schema. */
  prerequisiteQuestIds: string[];
  /** Reward kinds rolled from the template, granted once on completion. */
  rewardRoll: string[];
  /** The giver's area tier, so a reward and a spawned target scale to it. */
  tier: number;
}

/**
 * An objective is its own record, never a field on the quest. `targetCoord` is
 * what makes a `Distant` objective work: a coordinate is reserved inside an area
 * that does not exist yet, and once that area generates `targetRoomId` is filled
 * in from it. Everything downstream reads the id.
 */
export interface ObjectiveRecord {
  campaignId: string;
  id: string;
  questId: string;
  kind: string;
  /** The object or npc the predicate watches, when it needs one. Empty otherwise. */
  targetId: string;
  /** Empty until the target room is known — which, for `Distant`, is at area-gen. */
  targetRoomId: string;
  /** Set only for a `Distant` objective, before its room exists. */
  targetCoord: Coord | null;
  band: string;
  /** The predicate that satisfies it, from the closed registry. */
  completedBy: string;
  /** A payload the predicate needs, e.g. the flag name for `flagSet`. */
  completedByArg: string;
  /** What the objective places at the target once its area exists, if anything. */
  place: string;
  itemKind: string;
  hint: string;
  done: boolean;
}

// ── the things that sit in the world ────────────────────────────────

/**
 * Where something is. One field, one source of truth:
 *
 *   `room:<roomId>`   lying in a room
 *   `player`          carried
 *   `obj:<objectId>`  inside a container
 *   `npc:<npcId>`     held by someone — which is also vendor stock
 *   `null`            out of play
 *
 * It points at ids, never at coordinates. Most locations have no coordinate at
 * all: a sword in a chest carried by a shopkeeper is three pointers deep and
 * nowhere on the map.
 */
export type Location = string | null;

export const IN_PLAYER: Location = 'player';
export const inRoom = (roomId: string): Location => `room:${roomId}`;
export const inObject = (objectId: string): Location => `obj:${objectId}`;
export const heldBy = (npcId: string): Location => `npc:${npcId}`;

/** The room a location points at, or undefined when it points elsewhere. */
export const roomOfLocation = (location: Location): string | undefined =>
  location?.startsWith('room:') ? location.slice(5) : undefined;

/**
 * Behaviour comes from flags, not subtypes — one objects table holds items,
 * doors, scenery and containers alike.
 */
export interface ObjectFlags {
  takeable?: boolean;
  scenery?: boolean;
  container?: boolean;
  open?: boolean;
  locked?: boolean;
  lockedById?: string;
  lightSource?: boolean;
  lit?: boolean;
  wearable?: boolean;
  worn?: boolean;
  edible?: boolean;
  weapon?: boolean;
  armour?: boolean;
  untradable?: boolean;
  /** Dropped player gear, which repopulation must never clear away. */
  persistent?: boolean;
}

export interface ObjectRecord {
  campaignId: string;
  id: string;
  name: string;
  /** What the parser will match on. Never the display name alone. */
  nouns: string[];
  adjectives: string[];
  location: Location;
  desc: string;
  tags: string[];
  /** What it was generated from. Every combat value derives from these three. */
  baseId: string;
  quality: string;
  affixes: string[];
  flags: ObjectFlags;
  /** Starts at 100, drops on a fumble, and is what `repair` repairs. */
  condition: number;
  /** Turns of light left. Zero on anything that does not burn. */
  burnRemaining: number;
  /**
   * Coin held, for a purse or a spill of it. Stored rather than derived: a
   * count of coins is not recoverable from a base and a quality.
   */
  gold?: number;
}

export interface Attributes {
  brawn: number;
  agility: number;
  toughness: number;
  charisma: number;
  willpower: number;
  wits: number;
}

/**
 * One table for everyone who is not the player — shopkeepers, quest givers and
 * the things that attack you. `hostile` is a flag on the record, not a second
 * table, because a bribed footpad and a hired sword are the same record with a
 * different disposition.
 *
 * Monsters skip weapon-skill and armour-expertise maths entirely and store
 * final values. Everything the player derives from attributes, they store.
 */
export interface NpcRecord {
  campaignId: string;
  id: string;
  name: string;
  /** Every former name. Matchers read name plus aliases, never name alone. */
  aliases: string[];
  location: Location;
  persona: string;
  tags: string[];
  /** Rolled per instance. Drives pronouns and nothing mechanical. */
  sex: string;
  stats: Attributes;
  hp: number;
  maxHp: number;
  resolve: number;
  maxResolve: number;
  armourReduction: number;
  penetration: number;
  weaponDamage: string;
  /** Added to the die. The player derives this from Brawn; a creature stores it. */
  damageBonus: number;
  attacksPerRound: number;
  threat: number;
  friendliness: number;
  bribeThreshold: number;
  disposition: number;
  standing: number;
  sensed: boolean;
  isVendor: boolean;
  priceModifier: number;
  hostile: boolean;
  /** What it was generated from, which is what repopulation reads. */
  baseId: string;
  role: string;
  /** The gambit list this creature decides with, by name in abilities.json. */
  gambits: string;
  abilities: string[];
  /** True when Presence pressure can never land — undead, constructs, minds. */
  presenceImmune: boolean;
}
