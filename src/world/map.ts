/**
 * The map, drawn on a half-step grid.
 *
 * Adjacency does not imply connection — the rooms along an inn corridor sit
 * side by side and share no doors — so the map cannot leave connections
 * implicit. Render coordinate `(2x, 2y)` holds the room; `(2x+1, 2y)` and
 * `(2x, 2y+1)` hold the connector slots, drawn only where an edge exists.
 *
 *   □─□ □     two joined rooms, then one adjacent but walled off
 *   │   │
 *   □ □─□
 *
 * Storage stays integer; the renderer doubles it. Stairs — edges running in Z
 * — have no slot on a flat page, so the room carries a mark instead.
 *
 * This is the structural view: one Z level of one area, everything known. The
 * player's map, which shows only what has been walked, is the presentation
 * layer's job at step 4; this exists so a generated area can be read at a
 * glance while there is still nothing to walk it with.
 */

import type { World } from './world';
import { roomCoord, type RoomRecord, type Direction } from './types';

export interface MapOptions {
  /** Which level to draw. Defaults to the one the entry room is on. */
  z?: number | undefined;
  /** Marked `@`. */
  here?: string | undefined;
  /** Rooms with an edge running up or down are marked. */
  markStairs?: boolean | undefined;
  /**
   * Draw only these rooms. The player's map passes the rooms they have walked,
   * so the map can never spoil what is ahead: there is no glyph for "seen but
   * not entered", because there is no such state.
   */
  only?: ReadonlySet<string> | undefined;
  /** Half-width of the window around `here`, in rooms. Omit for the whole level. */
  radius?: number | undefined;
}

const HERE = '▣';
const ROOM = '□';
const EMPTY = ' ';

/**
 * The player's own map: only the rooms they have walked, windowed around them
 * when a radius is given. Everything else is the same renderer, because there
 * is only one map.
 */
export function renderPlayerMap(
  world: World,
  roomId: string,
  options: { radius?: number | undefined } = {},
): string {
  const room = world.rooms.get(roomId);
  if (!room) return '';
  const walked = new Set(
    world
      .roomsOf(room.areaId)
      .filter((candidate) => candidate.visited)
      .map((candidate) => candidate.id),
  );
  walked.add(room.id);
  return renderAreaMap(world, room.areaId, {
    here: room.id,
    only: walked,
    z: room.z,
    ...(options.radius !== undefined ? { radius: options.radius } : {}),
  });
}

export function renderAreaMap(world: World, areaId: string, options: MapOptions = {}): string {
  const area = world.areas.get(areaId);
  const rooms = world.roomsOf(areaId);
  if (!area || rooms.length === 0) return '';

  const here = options.here ? world.rooms.get(options.here) : undefined;
  const entry = area.entryRoomId ? world.rooms.get(area.entryRoomId) : undefined;
  const z = options.z ?? here?.z ?? entry?.z ?? (rooms[0] as RoomRecord).z;
  const level = rooms
    .filter((room) => room.z === z)
    .filter((room) => !options.only || options.only.has(room.id));
  if (level.length === 0) return '';

  let x0 = Math.min(...level.map((room) => room.x));
  let x1 = Math.max(...level.map((room) => room.x));
  let y0 = Math.min(...level.map((room) => room.y));
  let y1 = Math.max(...level.map((room) => room.y));

  // A window around the player: the mini-map beside the room description,
  // which is local orientation rather than a survey.
  if (options.radius !== undefined && here) {
    x0 = Math.max(x0, here.x - options.radius);
    x1 = Math.min(x1, here.x + options.radius);
    y0 = Math.max(y0, here.y - options.radius);
    y1 = Math.min(y1, here.y + options.radius);
  }

  const at = (x: number, y: number) =>
    level.find((room) => room.x === x && room.y === y && room.x >= x0 && room.x <= x1);
  const joined = (a: RoomRecord | undefined, b: RoomRecord | undefined) =>
    Boolean(a && b && world.exitsOf(a.id).some((exit) => exit.toRoomId === b.id));

  const lines: string[] = [];
  for (let y = y0; y <= y1; y++) {
    let cells = '';
    let below = '';
    for (let x = x0; x <= x1; x++) {
      const room = at(x, y);
      cells += glyphFor(world, room, options);
      cells += joined(room, at(x + 1, y)) ? '─' : EMPTY;
      below += joined(room, at(x, y + 1)) ? '│' : EMPTY;
      below += EMPTY;
    }
    lines.push(cells.trimEnd());
    if (y < y1) lines.push(below.trimEnd());
  }
  return lines.join('\n');
}

function glyphFor(world: World, room: RoomRecord | undefined, options: MapOptions): string {
  if (!room) return EMPTY;
  if (room.id === options.here) return HERE;
  if (options.markStairs !== false) {
    const stairs = world
      .exitsOf(room.id)
      .some((exit) => (exit.dir === 'u' || exit.dir === 'd') && exit.toRoomId);
    if (stairs) return '⇕';
  }
  // A gate is a way out of the area, and must not wear the glyph that means
  // "you are here" — one player, one ▣.
  const gate = world.exitsOf(room.id).some((exit) => exit.toRoomId === null);
  if (gate) return '▨';
  return room.glyph || ROOM;
}

// ── the structured grid model ───────────────────────────────────────
//
// The string renderers above draw for tests and the debug dump; the model
// below is the same half-step grid, but as data the DOM map renderer turns
// into a CSS grid. It also carries the one state the string renderers refuse
// to: a room known through a connection but not yet entered — a `frontier`
// cell. That is a deliberate reversal of the "there is no seen-but-not-entered
// state" note above, made so the map can be a navigation tool rather than only
// a record of where the player has been.

export type MapCellKind = 'here' | 'visited' | 'frontier' | 'gate';

export interface MapCell {
  kind: MapCellKind;
  /** The one symbol drawn inside the square. */
  glyph: string;
  /** For a screen reader, since the visible map is glyphs only. */
  label: string;
}

/** A cell placed on the doubled grid (room cells sit on odd track indices). */
export interface PlacedCell extends MapCell {
  gc: number;
  gr: number;
}

/** A drawn connector between two adjacent cells, or a stub off the window edge. */
export interface MapConnector {
  gc: number;
  gr: number;
  dir: 'h' | 'v';
  /** True when it points past the window at the third ring, with no cell beyond. */
  stub: boolean;
}

export interface MapModel {
  areaName: string;
  /** `F1`, `F2`, `B1` — the floor this level reads as. */
  floorLabel: string;
  z: number;
  /** Total tracks each way, margins included, so the renderer sizes the grid. */
  gridCols: number;
  gridRows: number;
  cells: PlacedCell[];
  connectors: MapConnector[];
}

/** Ground and up are floors F1, F2, …; below ground is B1, B2, … */
export function floorLabel(z: number): string {
  return z >= 0 ? `F${z + 1}` : `B${-z}`;
}

const OUTWARD: Record<'w' | 'e' | 'n' | 's', Direction> = { w: 'w', e: 'e', n: 'n', s: 's' };

/**
 * The player's map as data. `radius` gives the mini-map its small fixed
 * window (centred on the player); omit it for the whole floor, as the MAP
 * command wants. Only the player's own floor is ever in one model — another
 * level is its own map.
 */
export function mapModel(
  world: World,
  roomId: string,
  options: { radius?: number | undefined } = {},
): MapModel | undefined {
  const here = world.rooms.get(roomId);
  if (!here) return undefined;
  const area = world.areas.get(here.areaId);
  const z = here.z;
  const level = world.roomsOf(here.areaId).filter((room) => room.z === z);
  if (level.length === 0) return undefined;

  // The window: a fixed square around the player for the mini-map, the whole
  // floor otherwise. Fixed rather than clipped so the mini-map does not jitter
  // in size as the player walks, and so a gate one step off the area's edge
  // still has a cell to sit in.
  let x0: number;
  let x1: number;
  let y0: number;
  let y1: number;
  if (options.radius !== undefined) {
    x0 = here.x - options.radius;
    x1 = here.x + options.radius;
    y0 = here.y - options.radius;
    y1 = here.y + options.radius;
  } else {
    x0 = Math.min(...level.map((room) => room.x));
    x1 = Math.max(...level.map((room) => room.x));
    y0 = Math.min(...level.map((room) => room.y));
    y1 = Math.max(...level.map((room) => room.y));
  }

  const roomAt = (x: number, y: number): RoomRecord | undefined =>
    level.find((room) => room.x === x && room.y === y);
  const visited = (room: RoomRecord | undefined): boolean =>
    Boolean(room && (room.visited || room.id === roomId));
  const isFrontier = (room: RoomRecord): boolean =>
    !visited(room) &&
    world
      .exitsOf(room.id)
      .some((exit) => exit.toRoomId !== null && visited(world.rooms.get(exit.toRoomId)));

  // Gate cells: a visited room's way out of the area, placed one step along the
  // gate's direction where no room of this area stands.
  const gates = new Map<string, true>();
  for (const room of level) {
    if (!visited(room)) continue;
    for (const exit of world.exitsOf(room.id)) {
      if (exit.toRoomId !== null) continue;
      const gx = room.x + dx(exit.dir);
      const gy = room.y + dy(exit.dir);
      if (dz(exit.dir) !== 0) continue; // a gate up or down has no slot on a flat floor
      if (!roomAt(gx, gy)) gates.set(`${gx},${gy}`, true);
    }
  }

  const cellAt = (x: number, y: number): MapCell | undefined => {
    const room = roomAt(x, y);
    if (room) {
      if (room.id === roomId) return { kind: 'here', glyph: stairGlyph(world, room) ?? '▣', label: `${room.name} (here)` };
      if (room.visited) return { kind: 'visited', glyph: stairGlyph(world, room) ?? '□', label: room.name };
      if (isFrontier(room)) return { kind: 'frontier', glyph: '?', label: 'unexplored' };
      return undefined; // an unvisited room with no explored neighbour is not known yet
    }
    if (gates.has(`${x},${y}`)) return { kind: 'gate', glyph: '▨', label: 'a way out' };
    return undefined;
  };

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const gridCols = 2 * cols + 1; // +1 for the margin connector tracks that hold stubs
  const gridRows = 2 * rows + 1;
  const cells: PlacedCell[] = [];
  const connectors: MapConnector[] = [];

  const shown: (MapCell | undefined)[][] = [];
  for (let yi = 0; yi < rows; yi++) {
    shown[yi] = [];
    for (let xi = 0; xi < cols; xi++) {
      const cell = cellAt(x0 + xi, y0 + yi);
      shown[yi]![xi] = cell;
      if (cell) cells.push({ ...cell, gc: 2 * xi + 1, gr: 2 * yi + 1 });
    }
  }

  // A connector is drawn only when at least one end is explored, so two
  // unentered rooms never leak the corridor between them.
  const joined = (ax: number, ay: number, bx: number, by: number): boolean => {
    const a = roomAt(ax, ay);
    const b = roomAt(bx, by);
    const aCell = cellAt(ax, ay);
    const bCell = cellAt(bx, by);
    if (!aCell || !bCell) return false;
    if (aCell.kind === 'gate' || bCell.kind === 'gate') return true; // the gate edge that placed it
    if (!a || !b) return false;
    if (!visited(a) && !visited(b)) return false;
    return world.exitsOf(a.id).some((exit) => exit.toRoomId === b.id);
  };

  for (let yi = 0; yi < rows; yi++) {
    for (let xi = 0; xi < cols; xi++) {
      if (xi + 1 < cols && joined(x0 + xi, y0 + yi, x0 + xi + 1, y0 + yi)) {
        connectors.push({ gc: 2 * xi + 2, gr: 2 * yi + 1, dir: 'h', stub: false });
      }
      if (yi + 1 < rows && joined(x0 + xi, y0 + yi, x0 + xi, y0 + yi + 1)) {
        connectors.push({ gc: 2 * xi + 1, gr: 2 * yi + 2, dir: 'v', stub: false });
      }
    }
  }

  // Stubs: an explored room on the window edge whose corridor runs on past it,
  // toward the third ring the mini-map does not draw. Only from explored rooms,
  // so a frontier room never reveals what lies beyond it.
  const stubIf = (room: RoomRecord | undefined, out: 'w' | 'e' | 'n' | 's', gc: number, gr: number, dir: 'h' | 'v'): void => {
    if (!room || !visited(room)) return;
    if (world.exitsOf(room.id).some((exit) => exit.dir === OUTWARD[out])) {
      connectors.push({ gc, gr, dir, stub: true });
    }
  };
  for (let yi = 0; yi < rows; yi++) {
    stubIf(roomAt(x0, y0 + yi), 'w', 0, 2 * yi + 1, 'h');
    stubIf(roomAt(x1, y0 + yi), 'e', 2 * cols, 2 * yi + 1, 'h');
  }
  for (let xi = 0; xi < cols; xi++) {
    stubIf(roomAt(x0 + xi, y0), 'n', 2 * xi + 1, 0, 'v');
    stubIf(roomAt(x0 + xi, y1), 's', 2 * xi + 1, 2 * rows, 'v');
  }

  return {
    areaName: area?.name ?? here.areaId,
    floorLabel: floorLabel(z),
    z,
    gridCols,
    gridRows,
    cells,
    connectors,
  };
}

const dx = (dir: Direction): number => (dir === 'e' ? 1 : dir === 'w' ? -1 : 0);
const dy = (dir: Direction): number => (dir === 's' ? 1 : dir === 'n' ? -1 : 0);
const dz = (dir: Direction): number => (dir === 'u' ? 1 : dir === 'd' ? -1 : 0);

/** `↑`/`↓`/`↕` when a room has stairs, else undefined so the room keeps its glyph. */
function stairGlyph(world: World, room: RoomRecord): string | undefined {
  let up = false;
  let down = false;
  for (const exit of world.exitsOf(room.id)) {
    if (!exit.toRoomId) continue;
    if (exit.dir === 'u') up = true;
    if (exit.dir === 'd') down = true;
  }
  if (up && down) return '↕';
  if (up) return '↑';
  if (down) return '↓';
  return undefined;
}

/** The Z levels an area actually put rooms on, low to high. */
export function levelsOf(world: World, areaId: string): number[] {
  return [...new Set(world.roomsOf(areaId).map((room) => room.z))].sort((a, b) => a - b);
}

/** One line per room: code, type, tags and exits. The debugging view. */
export function describeArea(world: World, areaId: string): string {
  const area = world.areas.get(areaId);
  if (!area) return `no area ${areaId}`;
  const rooms = world.roomsOf(areaId).sort((a, b) => a.id.localeCompare(b.id));
  const hops = area.entryRoomId ? world.hopsFrom(area.entryRoomId) : new Map<string, number>();

  return rooms
    .map((room) => {
      const exits = world
        .exitsOf(room.id)
        .map((exit) => (exit.toRoomId ? exit.dir : `${exit.dir}»${exit.gateArchetype}`))
        .join(' ');
      const code = `${roomCoord(room).x}.${roomCoord(room).y}.${roomCoord(room).z}`;
      return `  ${room.id.split(':').pop()?.padEnd(4)} ${code.padEnd(12)} ${String(hops.get(room.id) ?? '-').padStart(2)}h  ${room.type.padEnd(11)} ${exits.padEnd(14)} ${room.tags.join(' ')}`;
    })
    .join('\n');
}
