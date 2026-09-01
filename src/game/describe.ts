/**
 * What the player is shown about a room — with placeholder text.
 *
 * This is step 4, and the Narrator is step 7. Generated rooms carry an empty
 * `baseDesc` until the narrator writes one, so what stands in for it here is
 * the room's own structure: its type, its tags, what is standing in it, and
 * the ways out. It is deliberately plain. If walking a generated area reads as
 * interesting with text this bare, prose will only improve it; if it does not,
 * no prose would have saved it.
 *
 * Contents are listed by code here. That is exactly what step 7 removes — the
 * narrator is handed the same records and writes them into the prose instead.
 */

import type { ObjectRecord, RoomRecord } from '../world/types';
import { roomCode, roomCoord } from '../world/types';
import type { World } from '../world/world';
import { isDark } from './scope';

export interface RoomView {
  name: string;
  desc: string;
  contents: string[];
  exits: string[];
  dark: boolean;
}

export function titleOf(room: RoomRecord): string {
  if (room.name) return room.name;
  // Until the narrator names it, a room is honestly identified by what it is
  // and where it is. `12.7.-3` is also the debug and quest handle.
  return `${titleCase(room.type)} ${roomCode(roomCoord(room))}`;
}

export function viewRoom(world: World, room: RoomRecord): RoomView {
  const dark = isDark(world, room);
  if (dark) {
    return {
      name: 'Darkness',
      desc: 'Pitch dark. You can feel the floor and nothing else.',
      contents: [],
      exits: [],
      dark: true,
    };
  }

  const objects = world.objectsIn(room.id).filter((object) => !object.flags.scenery);
  const scenery = world.objectsIn(room.id).filter((object) => object.flags.scenery);
  const npcs = world.npcsIn(room.id);

  const contents = [
    ...objects.map((object) => describeObject(world, object)),
    ...npcs.map((npc) => `${npc.name}${npc.hostile ? ' (hostile)' : ''}`),
  ];

  const area = world.areas.get(room.areaId);
  const placeholder = [
    `${titleCase(room.type)}${area ? ` in ${area.name}` : ''}.`,
    room.tags.length > 0 ? `Tags: ${room.tags.join(', ')}.` : '',
    scenery.length > 0 ? `${sentenceList(scenery.map((object) => object.name))} here.` : '',
  ]
    .filter((line) => line.length > 0)
    .join(' ');

  return {
    name: titleOf(room),
    desc: room.baseDesc || placeholder,
    contents,
    exits: exitLines(world, room),
    dark: false,
  };
}

/** One line per way out: the direction, and what is known to lie that way. */
export function exitLines(world: World, room: RoomRecord): string[] {
  return world.exitsOf(room.id).map((exit) => {
    if (!exit.toRoomId) return `${exit.dir} — a way out of here, not yet walked`;
    const beyond = world.rooms.get(exit.toRoomId);
    const door = exit.edge.doorId ? world.objects.get(exit.edge.doorId) : undefined;
    const doorNote = door ? ` (${door.flags.locked ? 'locked' : door.flags.open ? 'open' : 'shut'} ${door.name})` : '';
    // Adjacent rooms carry a name only. Listing a neighbour's contents leaks
    // what is coming and burns tokens once the narrator is reading this.
    const name = beyond?.visited ? titleOf(beyond) : 'somewhere unvisited';
    return `${exit.dir} — ${name}${doorNote}`;
  });
}

/** An object as one line: name, and the state that matters about it. */
export function describeObject(world: World, object: ObjectRecord): string {
  const notes: string[] = [];
  if (object.flags.container) {
    notes.push(object.flags.locked ? 'locked' : object.flags.open ? 'open' : 'shut');
    if (object.flags.open) {
      const inside = world.contentsOfObject(object.id);
      notes.push(inside.length > 0 ? `holding ${sentenceList(inside.map((o) => o.name))}` : 'empty');
    }
  }
  if (object.flags.lightSource) {
    notes.push(object.flags.lit ? `lit, ${object.burnRemaining} turns left` : 'unlit');
  }
  if (object.gold !== undefined) notes.push(`${object.gold} gold`);
  if (object.flags.worn) notes.push('worn');
  return notes.length > 0 ? `${object.name} (${notes.join(', ')})` : object.name;
}

export function sentenceList(items: readonly string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export const titleCase = (text: string): string =>
  text
    .split(/[_\s]+/)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(' ');
