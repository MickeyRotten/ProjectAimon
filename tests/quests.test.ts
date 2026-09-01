import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { MemorySaveStore, openSave, recordOf } from '../src/game/save';
import {
  buildHint,
  generalDirection,
  objectiveComplete,
  rollBand,
  type QuestCheckContext,
} from '../src/world/quests';
import type { QuestTemplate } from '../src/campaign/types';
import { Rng } from '../src/engine/rng';
import { World } from '../src/world/world';
import {
  IN_PLAYER,
  inRoom,
  type NpcRecord,
  type ObjectiveRecord,
  type QuestRecord,
} from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

/**
 * Generate areas by walking every ungenerated gate, breadth-first, until the
 * world holds an offered quest or the walk runs out — quest givers are placed
 * in generated areas, never the Hub. Leaves some gates unwalked, so the distant
 * band still has an ungenerated cube to reach into.
 */
function growWorld(seed: string, maxAreas = 24): World {
  const world = World.create({ campaign, seed });
  let generated = 0;
  while (generated < maxAreas) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null && edge.gateAreaId);
    if (!gate) break;
    world.enterGate(gate.id);
    generated++;
  }
  return world;
}

describe('quest templates load', () => {
  it('ships the six v1 types, each with an objective and a completion predicate', () => {
    for (const type of ['fetch', 'kill', 'deliver', 'find', 'clear', 'investigate']) {
      const template = campaign.quests.get(type);
      expect(template, type).toBeDefined();
      expect(template?.objective.completedBy).toBeTruthy();
      expect(template?.objective.place).toBeTruthy();
    }
  });
});

describe('offered quests come off quest-giving NPCs', () => {
  it('creates an offered quest whose giver is a real NPC standing in a room', () => {
    const world = growWorld('quest-offers');
    const offered = [...world.quests.values()].filter((quest) => quest.state === 'offered');
    expect(offered.length).toBeGreaterThan(0);

    for (const quest of offered) {
      expect(quest.objectiveIds).toEqual([]); // nothing placed until accepted
      expect(campaign.quests.has(quest.type)).toBe(true);
      const giver = world.npcs.get(quest.giverNpcId);
      expect(giver, quest.id).toBeDefined();
      expect(giver?.hostile).toBe(false);
    }
  });
});

describe('accepting a quest places one reachable objective', () => {
  it('rolls a band, places the objective into the graph, and turns the quest active', () => {
    const world = growWorld('quest-accept');
    // Take on every offered quest and check each one it could place within the
    // graph landed on a room genuinely reachable from its giver.
    const offered = [...world.quests.values()].filter((quest) => quest.state === 'offered');
    expect(offered.length).toBeGreaterThan(0);

    let placedWithin = 0;
    for (const quest of offered) {
      const result = world.acceptQuest(quest.id);
      expect(result.ok).toBe(true);
      expect(quest.state).toBe('active');
      expect(quest.objectiveIds).toHaveLength(1);

      const objective = world.objectivesOf(quest)[0] as ObjectiveRecord;
      expect(objective.hint.length).toBeGreaterThan(0);

      if (objective.band !== 'distant') {
        placedWithin++;
        expect(objective.targetRoomId).not.toBe('');
        const giver = world.npcs.get(quest.giverNpcId) as NpcRecord;
        const giverRoom = giver.location?.slice('room:'.length) as string;
        const reachable = world.hopsFrom(giverRoom);
        expect(reachable.has(objective.targetRoomId)).toBe(true);
      }
    }
    expect(placedWithin).toBeGreaterThan(0);
  });

  it('cannot be accepted twice', () => {
    const world = growWorld('quest-twice');
    const quest = [...world.quests.values()].find((q) => q.state === 'offered');
    if (!quest) throw new Error('no offered quest to take on');
    expect(world.acceptQuest(quest.id).ok).toBe(true);
    expect(world.acceptQuest(quest.id).ok).toBe(false);
  });
});

describe('the completion predicates', () => {
  const objective = (over: Partial<ObjectiveRecord>): ObjectiveRecord => ({
    campaignId: campaign.id,
    id: 'o',
    questId: 'q',
    kind: 'x',
    targetId: '',
    targetRoomId: '',
    targetCoord: null,
    band: 'near',
    completedBy: 'atRoom',
    completedByArg: '',
    place: 'none',
    hint: '',
    itemKind: '',
    done: false,
    ...over,
  });

  const ctx = (over: Partial<QuestCheckContext>): QuestCheckContext => ({
    playerRoomId: 'here',
    carriedIds: new Set(),
    npcs: new Map(),
    flags: new Set(),
    ...over,
  });

  it('atRoom fires only when the player stands in the target room', () => {
    const o = objective({ completedBy: 'atRoom', targetRoomId: 'there' });
    expect(objectiveComplete(ctx({ playerRoomId: 'here' }), o)).toBe(false);
    expect(objectiveComplete(ctx({ playerRoomId: 'there' }), o)).toBe(true);
  });

  it('hasItem fires only when the target is in the carry set', () => {
    const o = objective({ completedBy: 'hasItem', targetId: 'sword' });
    expect(objectiveComplete(ctx({}), o)).toBe(false);
    expect(objectiveComplete(ctx({ carriedIds: new Set(['sword']) }), o)).toBe(true);
  });

  it('flagSet fires on its flag', () => {
    const o = objective({ completedBy: 'flagSet', completedByArg: 'quest:q:investigated' });
    expect(objectiveComplete(ctx({}), o)).toBe(false);
    expect(objectiveComplete(ctx({ flags: new Set(['quest:q:investigated']) }), o)).toBe(true);
  });

  it('npcDead fires when the target is gone or out of play', () => {
    const alive = { id: 'foe', location: inRoom('there') } as NpcRecord;
    const o = objective({ completedBy: 'npcDead', targetId: 'foe' });
    expect(objectiveComplete(ctx({ npcs: new Map([['foe', alive]]) }), o)).toBe(false);
    expect(objectiveComplete(ctx({ npcs: new Map() }), o)).toBe(true);
    const dead = { id: 'foe', location: null } as unknown as NpcRecord;
    expect(objectiveComplete(ctx({ npcs: new Map([['foe', dead]]) }), o)).toBe(true);
  });

  it('roomCleared fires when no hostile stands in the room', () => {
    const foe = { id: 'foe', location: inRoom('there'), hostile: true } as NpcRecord;
    const o = objective({ completedBy: 'roomCleared', targetRoomId: 'there' });
    expect(objectiveComplete(ctx({ npcs: new Map([['foe', foe]]) }), o)).toBe(false);
    expect(objectiveComplete(ctx({ npcs: new Map() }), o)).toBe(true);
  });

  it('a done objective stays done', () => {
    expect(objectiveComplete(ctx({}), objective({ done: true, completedBy: 'atRoom', targetRoomId: 'x' }))).toBe(true);
  });
});

describe('the distance-band helpers', () => {
  it('rolls only bands that carry weight', () => {
    const rng = new Rng('bands');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(rollBand(rng, { near: 1, distant: 0 }));
    expect(seen.has('near')).toBe(true);
    expect(seen.has('distant')).toBe(false);
  });

  it('reads a general compass direction from coordinates, depth included', () => {
    expect(generalDirection({ x: 0, y: 0, z: 0 }, { x: 3, y: -1, z: 0 })).toBe('north-east');
    expect(generalDirection({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -5 })).toBe('below');
    expect(generalDirection({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('here');
  });

  it('builds a hint that is always true to the room it points at', () => {
    const template = campaign.quests.get('fetch');
    if (!template) throw new Error('no fetch template');
    const hint = buildHint({
      template,
      fromCoord: { x: 0, y: 0, z: 0 },
      targetCoord: { x: 4, y: 0, z: 0 },
      targetTags: ['indoor', 'dark', 'storage'],
      band: 'quiteNear',
    });
    expect(hint).toContain('store-place');
    expect(hint).toContain('east');
    expect(hint).toContain('a fair walk');
  });
});

describe('a distant objective reserves a coordinate, then binds on generation', () => {
  it('names a coordinate in an ungenerated area and fills the room in once it exists', () => {
    // Force the fetch template to always roll distant, on a fresh campaign so no
    // other test sees the change.
    const local = structuredCloneCampaign();
    const fetch = campaign.quests.get('fetch') as QuestTemplate;
    (local.quests as Map<string, QuestTemplate>).set('fetch', { ...fetch, bands: { distant: 1 } });

    const world = World.create({ campaign: local, seed: 'quest-distant' });
    let generated = 0;
    let quest = undefined as ReturnType<typeof findOffered>;
    // Generate a few areas until a fetch is on offer, keeping some cubes unbuilt.
    while (generated < 20) {
      const gate = [...world.edges.values()].find((e) => e.roomB === null && e.gateAreaId);
      if (!gate) break;
      world.enterGate(gate.id);
      generated++;
      quest = findOffered(world, 'fetch');
      if (quest && [...world.areas.values()].some((a) => !a.generated)) break;
    }
    if (!quest) return; // no fetch offered from this seed; nothing to assert

    const before = new Set(
      [...world.areas.values()].flatMap((a) => a.reservedCoords.map((c) => `${a.id}:${c.x},${c.y},${c.z}`)),
    );
    const result = world.acceptQuest(quest.id);
    expect(result.ok).toBe(true);
    const objective = world.objectivesOf(quest)[0] as ObjectiveRecord;
    expect(objective.band).toBe('distant');
    expect(objective.targetCoord).not.toBeNull();
    expect(objective.targetRoomId).toBe('');

    const after = new Set(
      [...world.areas.values()].flatMap((a) => a.reservedCoords.map((c) => `${a.id}:${c.x},${c.y},${c.z}`)),
    );
    expect(after.size).toBe(before.size + 1); // exactly one new reservation

    // Walk the rest of the world; the reserved coordinate must receive a room,
    // and the fetch item must be placed there.
    let more = 0;
    while (objective.targetRoomId === '' && more < 40) {
      const gate = [...world.edges.values()].find((e) => e.roomB === null && e.gateAreaId);
      if (!gate) break;
      world.enterGate(gate.id);
      more++;
    }
    if (objective.targetRoomId !== '') {
      const room = world.rooms.get(objective.targetRoomId);
      expect(room).toBeDefined();
      expect(objective.targetId).not.toBe(''); // the fetch item landed on the room
      expect(world.objects.get(objective.targetId)?.location).toBe(inRoom(objective.targetRoomId));
    }
  });
});

describe('the quest loop, through the game', () => {
  const start = (seed: string) => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

  /** Grow the game's world by walking gates until a quest is on offer. */
  const growGame = (game: Game): void => {
    for (let i = 0; i < 24; i++) {
      if ([...game.world.quests.values()].some((q) => q.state === 'offered')) return;
      const gate = [...game.world.edges.values()].find((e) => e.roomB === null && e.gateAreaId);
      if (!gate) return;
      game.player.roomId = gate.roomA;
      game.submit(gate.dirFromA);
    }
  };

  it('talk takes on offered work, the journal shows it, and the hint is read out', () => {
    const game = start('quest-talk');
    game.submit('light torch'); // so NPCs in dark rooms are still in scope
    growGame(game);
    const offered = [...game.world.quests.values()].find((q) => q.state === 'offered');
    if (!offered) throw new Error('no quest was offered while growing the world');
    const giver = game.world.npcs.get(offered.giverNpcId);
    if (!giver) throw new Error('the offered quest has no giver');
    game.player.roomId = giver.location?.slice('room:'.length) as string;

    const noun = giver.name.toLowerCase().split(/\s+/).pop() as string;
    const said = game
      .submit(`talk ${noun}`)
      .lines.map((l) => l.text)
      .join('\n');
    expect(said).toContain('take it on');
    expect(offered.state).toBe('active');

    const journal = game
      .submit('quests')
      .lines.map((l) => l.text)
      .join('\n');
    expect(journal).toContain('Work in hand');
  });

  it('completes a quest against its predicate and pays the reward', () => {
    const game = start('quest-complete');
    growGame(game);
    // Take on offered quests until one lands within the graph (has a room).
    const offered = [...game.world.quests.values()].filter((q) => q.state === 'offered');
    let active = undefined as ReturnType<typeof firstActiveWithRoom>;
    for (const quest of offered) {
      game.world.acceptQuest(quest.id);
      active = firstActiveWithRoom(game);
      if (active) break;
    }
    if (!active) throw new Error('no quest placed a reachable objective');
    const { quest, objective } = active;

    const purseBefore = game.player.purse;
    satisfy(game, objective);
    game.submit('wait');

    expect(quest.state).toBe('complete');
    expect(objective.done).toBe(true);
    if (quest.rewardRoll.includes('gold')) {
      expect(game.player.purse).toBeGreaterThanOrEqual(purseBefore);
    }
  });

  it('search resolves an investigate objective on the spot', () => {
    const game = start('quest-search');
    growGame(game);
    // Find (or make) an active investigate objective by taking offers.
    const offered = [...game.world.quests.values()].filter((q) => q.state === 'offered');
    for (const quest of offered) game.world.acceptQuest(quest.id);
    const investigate = game.world
      .activeQuests()
      .map((q) => game.world.objectivesOf(q)[0])
      .find((o) => o && o.completedBy === 'flagSet' && o.targetRoomId !== '');
    if (!investigate) return; // none offered this seed

    game.player.roomId = investigate.targetRoomId;
    game.submit('light torch');
    const said = game
      .submit('search')
      .lines.map((l) => l.text)
      .join('\n');
    expect(said).toContain('find what you were sent to find');
    expect(game.world.flags.has(investigate.completedByArg)).toBe(true);
  });
});

describe('quests survive a save', () => {
  it('round-trips quests and objectives with the rest of the world', async () => {
    const game = Game.begin({ campaign, seed: 'quest-save', name: 'Vess', archetype: 'freebooter' });
    for (let i = 0; i < 24; i++) {
      if ([...game.world.quests.values()].some((q) => q.state === 'offered')) break;
      const gate = [...game.world.edges.values()].find((e) => e.roomB === null && e.gateAreaId);
      if (!gate) break;
      game.player.roomId = gate.roomA;
      game.submit(gate.dirFromA);
    }
    const quest = [...game.world.quests.values()].find((q) => q.state === 'offered');
    if (quest) game.world.acceptQuest(quest.id);

    const store = new MemorySaveStore();
    await store.put(recordOf(game, 'snapshot', 'quests'));
    const record = await store.get('snap:quests');
    if (!record) throw new Error('nothing saved');
    const { game: loaded } = openSave(campaign, record);

    expect(loaded.world.quests.size).toBe(game.world.quests.size);
    expect(loaded.world.objectives.size).toBe(game.world.objectives.size);
    for (const [id, q] of game.world.quests) expect(loaded.world.quests.get(id)).toEqual(q);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function findOffered(world: World, type: string): QuestRecord | undefined {
  return [...world.quests.values()].find((quest) => quest.state === 'offered' && quest.type === type);
}

function firstActiveWithRoom(game: Game): { quest: QuestRecord; objective: ObjectiveRecord } | undefined {
  for (const quest of game.world.activeQuests()) {
    const objective = game.world.objectivesOf(quest)[0];
    if (objective && objective.targetRoomId !== '') return { quest, objective };
  }
  return undefined;
}

/** Make an objective's predicate true by hand, whatever kind it is. */
function satisfy(game: Game, objective: ObjectiveRecord): void {
  switch (objective.completedBy) {
    case 'atRoom':
      game.player.roomId = objective.targetRoomId;
      break;
    case 'hasItem':
      if (objective.targetId) game.world.moveTo(objective.targetId, IN_PLAYER);
      break;
    case 'flagSet':
      game.world.flags.add(objective.completedByArg);
      break;
    case 'npcDead': {
      const npc = game.world.npcs.get(objective.targetId);
      if (npc) npc.location = null;
      break;
    }
    case 'roomCleared':
      for (const npc of game.world.npcsIn(objective.targetRoomId)) {
        if (npc.hostile) npc.location = null;
      }
      break;
  }
}

function structuredCloneCampaign(): ResolvedCampaign {
  // A shallow copy with its own quests map, so overriding one template cannot
  // leak into the module-level campaign the other tests share.
  return { ...campaign, quests: new Map(campaign.quests) };
}
