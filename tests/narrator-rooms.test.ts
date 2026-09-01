import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { NoApiKeyError, type ChatRequest, type LlmClient } from '../src/narrator/llm';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { RoomNarrator } from '../src/narrator/rooms';
import { IN_PLAYER, inRoom } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const settings = { ...DEFAULT_SETTINGS, apiKey: 'k' };

/** A client that answers from a script and records what it was asked. */
class ScriptedClient implements LlmClient {
  readonly calls: ChatRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  async complete(request: ChatRequest): Promise<string> {
    this.calls.push(request);
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? '';
  }
}

const narratorWith = (replies: (string | Error)[]): { narrator: RoomNarrator; client: ScriptedClient } => {
  const client = new ScriptedClient(replies);
  return { narrator: new RoomNarrator({ campaign, client, settings }), client };
};

/** Move a carried kit item into the room so there is a notable to weave in. */
const dropAKitItemHere = (game: Game): string => {
  const object = game.world.contentsOf(IN_PLAYER).objects[0];
  if (!object) throw new Error('the starter kit is empty');
  game.world.moveTo(object.id, inRoom(game.player.roomId));
  return object.nouns[0] ?? object.name.split(/\s+/)[0] ?? object.name;
};

describe('the woven render', () => {
  it('weaves the contents, then serves an unchanged room from cache', async () => {
    const game = Game.begin({ campaign, seed: 'weave', name: 'Vess', archetype: 'freebooter' });
    const noun = dropAKitItemHere(game);
    const reply = `Worn flagstones underfoot. A ${noun} lies where it was set down.`;
    const { narrator, client } = narratorWith([reply]);

    const first = await narrator.describe(game.world, game.room);
    expect(first?.prose).toBe(reply);
    // The Hub's rooms ship with baseDesc, so nothing was batch-generated.
    expect(client.calls).toHaveLength(1);

    const second = await narrator.describe(game.world, game.room);
    expect(second?.prose).toBe(reply);
    expect(client.calls).toHaveLength(1); // free on return, identical prose
  });

  it('re-weaves once the contents change, and caches that too', async () => {
    const game = Game.begin({ campaign, seed: 'change', name: 'Vess', archetype: 'freebooter' });
    const object = game.world.contentsOf(IN_PLAYER).objects[0]!;
    const noun = object.nouns[0] ?? object.name;
    const { narrator, client } = narratorWith([
      'An empty yard, swept by wind.',
      `An empty yard, and now a ${noun} on the stones.`,
    ]);

    const bare = await narrator.describe(game.world, game.room);
    expect(bare?.prose).toContain('empty yard');
    expect(client.calls).toHaveLength(1);

    // Drop the item into the room: the content signature changes, so the cache
    // misses and the narrator re-weaves.
    game.world.moveTo(object.id, inRoom(game.player.roomId));
    const withItem = await narrator.describe(game.world, game.room);
    expect(withItem?.prose).toContain(noun);
    expect(withItem?.prose).not.toBe(bare?.prose);
    expect(client.calls).toHaveLength(2);
  });
});

describe('truth over prose', () => {
  it('falls back to a record-built render when the model is unavailable', async () => {
    const game = Game.begin({ campaign, seed: 'nokey', name: 'Vess', archetype: 'freebooter' });
    const object = game.world.contentsOf(IN_PLAYER).objects[0]!;
    game.world.moveTo(object.id, inRoom(game.player.roomId));
    const { narrator } = narratorWith([new NoApiKeyError()]);

    const rendered = await narrator.describe(game.world, game.room);
    expect(rendered?.prose).toContain(game.room.baseDesc);
    expect(rendered?.prose).toContain(object.name);
  });

  it('repairs a render that dropped a listed thing, once', async () => {
    const game = Game.begin({ campaign, seed: 'repair', name: 'Vess', archetype: 'freebooter' });
    const noun = dropAKitItemHere(game);
    const good = `Flagstones, and a ${noun} left on them.`;
    const { narrator, client } = narratorWith(['A bare and empty yard.', good]);

    const rendered = await narrator.describe(game.world, game.room);
    expect(rendered?.prose).toBe(good);
    expect(client.calls).toHaveLength(2); // first attempt, then one repair
  });
});

describe('the permanent descriptions', () => {
  it('batch-generates an empty baseDesc, writing both name and description', async () => {
    const game = Game.begin({ campaign, seed: 'batch', name: 'Vess', archetype: 'freebooter' });
    const room = game.room;
    room.baseDesc = '';
    room.name = '';
    const { narrator, client } = narratorWith([
      '1. The Cleared Yard :: Stone and silence. Nothing moves in it.',
      'The cleared yard lies quiet.',
    ]);

    const rendered = await narrator.describe(game.world, room);
    expect(room.name).toBe('The Cleared Yard');
    expect(room.baseDesc).toContain('Stone and silence');
    expect(rendered?.name).toBe('The Cleared Yard');
    expect(client.calls).toHaveLength(2); // one batch, one render
  });
});
