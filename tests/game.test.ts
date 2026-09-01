import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { MemorySaveStore, openSave, recordOf } from '../src/game/save';
import { IN_PLAYER, inRoom, type ObjectRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

const start = (seed = 'turn-loop') =>
  Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

/** Everything the last turn printed, as one string. */
const text = (game: Game, input: string): string =>
  game
    .submit(input)
    .lines.map((line) => line.text)
    .join('\n');

describe('starting a game', () => {
  it('rolls a character, issues the kit, and stands them in the Hub', () => {
    const game = start();
    expect(game.player.roomId).toBe(campaign.manifest.hub.entryRoomId);
    expect(game.player.purse).toBe(campaign.manifest.starterKit.gold);

    const carried = game.world.contentsOf(IN_PLAYER).objects;
    const bases = carried.map((object) => object.baseId);
    for (const wanted of campaign.manifest.starterKit.items) expect(bases).toContain(wanted);
    // The free kit is untradable, or dying on purpose becomes a gold fountain.
    for (const object of carried) expect(object.flags.untradable).toBe(true);
    expect(game.player.weaponWielded).not.toBe('');
    expect(game.player.armourWorn).not.toBe('');
  });

  it('derives HP and Resolve rather than inventing them', () => {
    const game = start();
    expect(game.player.hp).toBe(game.player.stats.toughness * 2);
    expect(game.player.resolve).toBe(game.player.stats.willpower * 2);
  });

  it('is the same game from the same seed', () => {
    expect(start('same').player.stats).toEqual(start('same').player.stats);
    expect(start('one').world.rooms.size).toBe(start('two').world.rooms.size);
  });
});

describe('the turn loop', () => {
  it('spends a turn on a world action and not on a query', () => {
    const game = start();
    expect(game.submit('wait').spent).toBe(true);
    expect(game.turn).toBe(1);
    expect(game.submit('i').spent).toBe(false);
    expect(game.turn).toBe(1);
  });

  it('moves along an edge and marks the room visited', () => {
    const game = start();
    const before = game.player.roomId;
    game.submit('n');
    expect(game.player.roomId).not.toBe(before);
    expect(game.room.visited).toBe(true);
  });

  it('refuses a direction with no edge, and says so without spending state', () => {
    const game = start();
    const room = game.player.roomId;
    const missing = ['n', 's', 'e', 'w', 'u', 'd'].find(
      (dir) => !game.world.exitsOf(room).some((exit) => exit.dir === dir),
    ) as string;
    expect(text(game, missing)).toContain("can't go that way");
    expect(game.player.roomId).toBe(room);
  });

  it('generates the area behind a gate on the turn it is walked through', () => {
    const game = start();
    const gate = [...game.world.edges.values()].find((edge) => edge.roomB === null);
    const stub = game.world.areas.get(gate?.gateAreaId as string);
    expect(stub?.generated).toBe(false);

    // Walk to the gate room, then out through it.
    const gateRoom = gate?.roomA as string;
    game.player.roomId = gateRoom;
    game.submit(gate?.dirFromA as string);

    expect(game.world.areas.get(stub?.id as string)?.generated).toBe(true);
    expect(game.room.areaId).toBe(stub?.id);
    // And it never generates twice: walking back and forth is free.
    const rooms = game.world.rooms.size;
    game.submit('map');
    expect(game.world.rooms.size).toBe(rooms);
  });
});

describe('Game.appendVoiceLine — the narration edge filling in a reply after the fact', () => {
  it('appends onto the transcript entry for the given turn', () => {
    const game = start();
    game.submit('wait');
    game.appendVoiceLine(game.turn, 'Buying or selling?');
    const entry = game.transcript[game.transcript.length - 1];
    expect(entry?.output).toContain('Buying or selling?');
  });

  it('is a no-op when no transcript entry matches the turn', () => {
    const game = start();
    game.submit('wait');
    const before = JSON.stringify(game.transcript);
    game.appendVoiceLine(999, 'unreachable');
    expect(JSON.stringify(game.transcript)).toBe(before);
  });
});

describe('the hub as authored', () => {
  it('leaves every gate walkable — no two ways out share a direction', () => {
    const game = start();
    for (const gate of campaign.manifest.hub.gates) {
      const sameWay = game.world
        .exitsOf(gate.fromRoom)
        .filter((exit) => exit.dir === gate.dir);
      expect(sameWay).toHaveLength(1);
      expect(sameWay[0]?.toRoomId).toBeNull();
    }
    expect(game.world.notes).toEqual([]);
  });
});

describe('inventory and the world it sits in', () => {
  /** Put a rollable item on the floor beside the player, for the parser to find. */
  const dropIn = (game: Game, object: ObjectRecord): ObjectRecord => {
    object.location = inRoom(game.player.roomId);
    game.world.objects.set(object.id, object);
    return object;
  };

  const item = (game: Game, over: Partial<ObjectRecord> = {}): ObjectRecord =>
    dropIn(game, {
      campaignId: campaign.id,
      id: `test_${game.world.objects.size}`,
      name: 'iron sword',
      nouns: ['sword', 'blade'],
      adjectives: ['iron'],
      location: '',
      desc: '',
      tags: ['weapon'],
      baseId: 'sword',
      quality: 'plain',
      affixes: [],
      flags: { takeable: true, weapon: true },
      condition: 100,
      burnRemaining: 0,
      ...over,
    } as ObjectRecord);

  it('takes and drops by noun, and the pointer is the only thing that moves', () => {
    const game = start();
    const sword = item(game);
    expect(text(game, 'take iron sword')).toContain('Taken');
    expect(sword.location).toBe(IN_PLAYER);
    game.submit('drop blade');
    expect(sword.location).toBe(inRoom(game.player.roomId));
    // Dropped gear is persistent, so repopulation can never sweep it away.
    expect(sword.flags.persistent).toBe(true);
  });

  it('never matches something in another room', () => {
    const game = start();
    const sword = item(game);
    sword.location = inRoom('hub_gate');
    expect(text(game, 'take sword')).toContain("don't see");
  });

  it('asks which one, then accepts the answer as the next input', () => {
    const game = start();
    item(game, { name: 'iron sword' });
    item(game, { name: 'bone sword', adjectives: ['bone'] });
    expect(text(game, 'take sword')).toContain('Which do you mean');
    expect(text(game, 'bone')).toContain('Taken');
    expect(game.world.contentsOf(IN_PLAYER).objects.some((o) => o.name === 'bone sword')).toBe(true);
  });

  it('respects the carry limit, which comes from Brawn', () => {
    const game = start();
    game.player.stats.brawn = 1; // carry 10, and a sword weighs 4
    for (let i = 0; i < 4; i++) item(game, { name: `sword ${i}`, nouns: ['sword'] });
    const said = text(game, 'take all');
    expect(said).toContain('too heavy');
  });

  it('opens a container and reaches what is inside it', () => {
    const game = start();
    const chest = item(game, {
      name: 'banded chest',
      nouns: ['chest'],
      adjectives: ['banded'],
      flags: { container: true, open: false, takeable: false },
    });
    const key = item(game, { name: 'brass key', nouns: ['key'], adjectives: ['brass'], baseId: 'key' });
    key.location = `obj:${chest.id}`;

    // Shut, its contents are out of scope entirely.
    expect(text(game, 'take brass key')).not.toContain('Taken');
    game.submit('open chest');
    expect(chest.flags.open).toBe(true);
    expect(text(game, 'take brass key')).toContain('Taken');
    game.submit('put key in chest');
    expect(key.location).toBe(`obj:${chest.id}`);
  });

  it('takes the key it needs to unlock a door, and says that it did', () => {
    const game = start();
    const key = item(game, { name: 'brass key', nouns: ['key'], adjectives: ['brass'], baseId: 'key' });
    const door = item(game, {
      name: 'studded door',
      nouns: ['door'],
      adjectives: ['studded'],
      tags: ['door'],
      flags: { scenery: true, takeable: false, locked: true, open: false, lockedById: key.id },
    });
    const said = text(game, 'unlock door with brass key');
    expect(said).toContain('first taking');
    expect(said).toContain('Unlocked');
    expect(door.flags.locked).toBe(false);
  });
});

describe('light, and running out of it', () => {
  /** A dark room next door, and the player standing in it with a lit torch. */
  const intoTheDark = (game: Game) => {
    const room = game.room;
    const dark = [...game.world.rooms.values()].find((candidate) => candidate.id !== room.id);
    if (!dark) throw new Error('the hub has one room');
    dark.tags = [...dark.tags.filter((tag) => tag !== 'lit'), 'dark'];
    game.player.roomId = dark.id;
    return dark;
  };

  it('burns a lit source down by one turn per turn, and warns before it goes', () => {
    const game = start();
    const torch = game.world.contentsOf(IN_PLAYER).objects.find((o) => o.flags.lightSource);
    if (!torch) throw new Error('the kit had no light');
    game.submit('light torch');
    const before = torch.burnRemaining;
    game.submit('wait');
    expect(torch.burnRemaining).toBe(before - 1);

    torch.burnRemaining = 11;
    expect(text(game, 'wait')).toContain('guttering');
  });

  it('hides the room when the light goes out, then forces a retreat', () => {
    const game = start();
    const torch = game.world.contentsOf(IN_PLAYER).objects.find((o) => o.flags.lightSource);
    if (!torch) throw new Error('the kit had no light');
    game.submit('light torch');
    const dark = intoTheDark(game);
    torch.burnRemaining = 1;

    const said = text(game, 'wait');
    expect(said).toContain('gutters out');
    expect(torch.flags.lit).toBe(false);
    // Not a softlock: the world walks you back to somewhere lit, and charges
    // you the turns for it.
    expect(game.player.roomId).not.toBe(dark.id);
    expect(game.turn).toBeGreaterThan(1);
  });

  it('shows nothing but your own pack in the dark', () => {
    const game = start();
    intoTheDark(game);
    expect(text(game, 'look')).toContain('dark');
    // Your own kit is still in scope: you can rummage, and light a torch.
    expect(text(game, 'light torch')).toContain('catches');
  });
});

describe('saving', () => {
  it('round-trips the world without regenerating any of it', async () => {
    const game = start('save-me');
    const gate = [...game.world.edges.values()].find((edge) => edge.roomB === null);
    game.player.roomId = gate?.roomA as string;
    game.submit(gate?.dirFromA as string);
    game.submit('wait');

    const store = new MemorySaveStore();
    await store.put(recordOf(game, 'auto', 'autosave'));
    const record = await store.get(`auto:${campaign.id}`);
    if (!record) throw new Error('nothing was saved');

    const { game: loaded } = openSave(campaign, record);
    expect(loaded.turn).toBe(game.turn);
    expect(loaded.player).toEqual(game.player);
    expect(loaded.world.rooms.size).toBe(game.world.rooms.size);
    expect(loaded.world.edges.size).toBe(game.world.edges.size);
    expect(loaded.world.objects.size).toBe(game.world.objects.size);
    expect([...loaded.world.rooms.keys()].sort()).toEqual([...game.world.rooms.keys()].sort());
    // The area behind the gate stays generated, and its rooms stay the same.
    for (const [id, room] of game.world.rooms) expect(loaded.world.rooms.get(id)).toEqual(room);
  });

  it('keeps loading after the campaign version moves on', async () => {
    const game = start('drift');
    const record = recordOf(game, 'snapshot', 'before');
    record.campaignVersion = '0.0.1';
    const { notes } = openSave(campaign, record);
    expect(notes.join(' ')).toContain('unchanged');
  });

  it('refuses a save belonging to a campaign that is not loaded', () => {
    const game = start('other');
    const record = recordOf(game, 'snapshot', 'x');
    record.campaignId = 'not-installed';
    expect(() => openSave(campaign, record)).toThrow(/not-installed/);
  });
});
