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
