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
import { roomCoord, type RoomRecord } from './types';

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
