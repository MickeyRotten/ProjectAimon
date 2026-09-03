/**
 * Quick travel — the teleporter.
 *
 * Structurally placed every `WORLD.descent.teleporterEveryNRungs` Rungs, the
 * same way node 0 is always the entry and node 1 is always the hub's centre:
 * never a weighted roll that could fail to spawn one. Unlocked by walking to
 * it — no separate action — and only usable from the Hub, only to a Rung
 * already found. It is the complement of the (not yet built) Hub-return
 * consumable, not a substitute for it: that gets the player out from
 * anywhere, this gets them back in to a known depth.
 */
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game, type GameSnapshot } from '../src/game/game';
import { ruleNumber } from '../src/engine/rules';
import type { Direction } from '../src/world/types';
import { HUB_AREA_ID, teleporterFlag, World } from '../src/world/world';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const EVERY = ruleNumber(campaign.rules, 'WORLD.descent.teleporterEveryNRungs');

const generatedAreas = (world: World) =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== HUB_AREA_ID);

/** Walk through gates, entry-first, until `wanted` areas exist. */
function explore(world: World, wanted: number): void {
  while (generatedAreas(world).length < wanted) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

/** Every room across the explored world tagged as a teleporter. */
const teleporterRooms = (world: World) => [...world.rooms.values()].filter((room) => room.type === 'teleporter');

describe('structural placement', () => {
  it('appears only on a Rung a multiple of teleporterEveryNRungs deep, never elsewhere', () => {
    let sawOne = false;
    let sawNone = false;
    for (let i = 0; i < 16; i++) {
      const world = World.create({ campaign, seed: `tp-${i}` });
      explore(world, 12);
      for (const area of generatedAreas(world)) {
        const rooms = teleporterRooms(world).filter((room) => room.areaId === area.id);
        if (area.depth % EVERY === 0) {
          expect(rooms.length, `${area.id} at depth ${area.depth}`).toBe(1);
          sawOne = true;
        } else {
          expect(rooms.length, `${area.id} at depth ${area.depth}`).toBe(0);
          sawNone = true;
        }
      }
    }
    expect(sawOne).toBe(true);
    expect(sawNone).toBe(true);
  });

  it('never lands on the entry room — the walk always has to happen once', () => {
    for (let i = 0; i < 16; i++) {
      const world = World.create({ campaign, seed: `tp-entry-${i}` });
      explore(world, 12);
      for (const room of teleporterRooms(world)) {
        const area = world.areas.get(room.areaId);
        expect(room.id, room.id).not.toBe(area?.entryRoomId);
      }
    }
  });

  it('carries the tags and glyph the table defines, never a hostile, never a gate', () => {
    const tags = campaign.rules['WORLD'] as Record<string, unknown>;
    const descent = (tags['descent'] as Record<string, unknown>)['teleporterRoom'] as {
      tags: string[];
      glyph: string;
    };
    let checked = 0;
    for (let i = 0; i < 16; i++) {
      const world = World.create({ campaign, seed: `tp-tags-${i}` });
      explore(world, 12);
      for (const room of teleporterRooms(world)) {
        checked++;
        for (const tag of descent.tags) expect(room.tags, room.id).toContain(tag);
        expect(room.glyph).toBe(descent.glyph);
        expect(world.npcsIn(room.id).some((npc) => npc.hostile), room.id).toBe(false);
        expect(
          world.exitsOf(room.id).some((exit) => exit.toRoomId === null),
          `${room.id} carries a gate`,
        ).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

// ── the write-point wiring ───────────────────────────────────────────

/** BFS from `fromRoomId` to `toRoomId` over real (generated) edges only. */
function pathWithin(world: World, fromRoomId: string, toRoomId: string): Direction[] {
  const parent = new Map<string, { via: Direction; from: string }>();
  const seen = new Set([fromRoomId]);
  const queue = [fromRoomId];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as string;
    if (at === toRoomId) break;
    for (const exit of world.exitsOf(at)) {
      if (!exit.toRoomId || seen.has(exit.toRoomId)) continue;
      seen.add(exit.toRoomId);
      parent.set(exit.toRoomId, { via: exit.dir, from: at });
      queue.push(exit.toRoomId);
    }
  }
  const path: Direction[] = [];
  let at = toRoomId;
  while (at !== fromRoomId) {
    const step = parent.get(at);
    if (!step) return [];
    path.unshift(step.via);
    at = step.from;
  }
  return path;
}

/**
 * A world explored deep enough to hold at least one teleporter, and the room
 * next door to it (one real hop, so a single `go` reaches it).
 */
/**
 * Finds a teleporter reachable without a light source — the darkness system
 * is not what this file tests, so a dark warren teleporter (or a dark room on
 * the one-step walk to it) is skipped rather than worked around. Tries
 * several seeds derived from `seedPrefix`, since which archetype rolls a
 * teleporter varies with the descent sequence.
 */
function worldWithTeleporterNeighbour(
  seedPrefix: string,
): { world: World; neighbourId: string; teleporterId: string } {
  for (let attempt = 0; attempt < 40; attempt++) {
    const world = World.create({ campaign, seed: `${seedPrefix}-${attempt}` });
    explore(world, 12);
    const lit = teleporterRooms(world).find((room) => !room.tags.includes('dark'));
    if (!lit) continue;
    const area = world.areas.get(lit.areaId);
    const entry = area?.entryRoomId as string;
    const path = pathWithin(world, entry, lit.id);
    if (path.length === 0) continue;

    // Walk to one hop short of the teleporter, so a single further `go` step
    // is the one the unlock test fires — the write point, not the walk.
    let at = entry;
    let sawDark = world.rooms.get(entry)?.tags.includes('dark') ?? false;
    for (const dir of path.slice(0, -1)) {
      const exit = world.exitsOf(at).find((candidate) => candidate.dir === dir);
      at = exit?.toRoomId as string;
      if (world.rooms.get(at)?.tags.includes('dark')) sawDark = true;
    }
    if (sawDark) continue;
    return { world, neighbourId: at, teleporterId: lit.id };
  }
  throw new Error(`no reachable, unlit-free path to a teleporter for "${seedPrefix}" in 40 attempts`);
}

/** A fresh Game whose player already stands beside a found teleporter. */
function gameBesideTeleporter(seedPrefix: string): { game: Game; teleporterId: string; dir: Direction } {
  const { world, neighbourId, teleporterId } = worldWithTeleporterNeighbour(seedPrefix);
  const dir = world.exitsOf(neighbourId).find((exit) => exit.toRoomId === teleporterId)?.dir;
  if (!dir) throw new Error('no direct step from the neighbour to the teleporter');

  const seed0 = Game.begin({ campaign, seed: seedPrefix, name: 'Wayfarer' });
  const snapshot: GameSnapshot = seed0.snapshot();
  // Carry the starter kit's objects across into the pre-explored world, or
  // the player arrives with a `weaponWielded` pointer to an object that no
  // longer exists — irrelevant to this file, but `carriedWeight` and other
  // reads assume it is always resolvable.
  const kit = [...seed0.world.objects.values()];
  const explored = world.snapshot();
  for (const item of kit) explored.objects.push(structuredClone(item));
  snapshot.world = explored;
  snapshot.player.roomId = neighbourId;
  const game = Game.restore(campaign, snapshot);
  return { game, teleporterId, dir };
}

describe('unlocking', () => {
  it('is not unlocked until the room is actually walked to', () => {
    const { world } = worldWithTeleporterNeighbour('tp-lock-1');
    expect(world.unlockedTeleporters()).toEqual([]);
  });

  it('unlocks on the same write point that marks the room visited — no separate action', () => {
    const { game, teleporterId, dir } = gameBesideTeleporter('tp-lock-2');
    expect(game.world.flags.has(teleporterFlag(teleporterId))).toBe(false);
    game.submit(dir);
    expect(game.world.flags.has(teleporterFlag(teleporterId))).toBe(true);
    expect(game.world.unlockedTeleporters().map((d) => d.roomId)).toContain(teleporterId);
  });
});

describe('RECALL', () => {
  it('only answers from the Hub', () => {
    const { game, dir } = gameBesideTeleporter('tp-recall-1');
    game.submit(dir); // unlock it
    const before = game.player.roomId;
    const result = game.submit('recall');
    expect(result.lines.some((line) => /Hub/.test(line.text))).toBe(true);
    expect(game.player.roomId).toBe(before); // a refusal, not a trip anywhere
  });

  it('says nothing has answered yet when nothing is unlocked', () => {
    const game = Game.begin({ campaign, seed: 'tp-recall-2', name: 'Wayfarer' });
    const result = game.submit('recall');
    expect(result.lines.some((line) => /find one|walk/i.test(line.text))).toBe(true);
  });

  it('bare RECALL lists what has been found, RECALL <name> travels there', () => {
    const { game, teleporterId, dir } = gameBesideTeleporter('tp-recall-3');
    game.submit(dir); // unlock the teleporter
    // Walk back to the Hub the only way this test can: restore the player
    // straight there, since the corpse run's own return path is not what is
    // under test here.
    const backAtHub: GameSnapshot = game.snapshot();
    backAtHub.player.roomId = campaign.manifest.hub.entryRoomId;
    const atHub = Game.restore(campaign, backAtHub);

    const destination = atHub.world.unlockedTeleporters()[0];
    expect(destination).toBeDefined();

    const listed = atHub.submit('recall');
    expect(listed.lines.some((line) => line.text.includes(destination!.areaName))).toBe(true);
    expect(listed.spent).toBe(false);

    const travelled = atHub.submit(`recall ${destination!.areaName}`);
    expect(travelled.spent).toBe(true);
    expect(atHub.player.roomId).toBe(teleporterId);
  });
});
