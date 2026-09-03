import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { viewRoom } from '../src/game/describe';
import { NoApiKeyError, type ChatRequest, type LlmClient } from '../src/narrator/llm';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { RoomNarrator } from '../src/narrator/rooms';

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

describe('the permanent descriptions', () => {
  it('batch-generates every empty baseDesc in the area, and its name, in one call', async () => {
    const game = Game.begin({ campaign, seed: 'batch', name: 'Vess', archetype: 'freebooter' });
    const room = game.room;
    room.baseDesc = '';
    room.name = '';
    const { narrator, client } = narratorWith([
      'AREA :: Saltmere Rewritten\n1. The Cleared Yard :: Stone and silence. Nothing moves in it.',
    ]);

    await narrator.ensureArea(game.world, room);

    expect(room.name).toBe('The Cleared Yard');
    expect(room.baseDesc).toContain('Stone and silence');
    expect(game.world.areas.get(room.areaId)?.name).toBe('Saltmere Rewritten');
    expect(client.calls).toHaveLength(1); // one batch for the whole area, no per-room call
  });

  it('makes no call for an area whose rooms already carry a baseDesc', async () => {
    // The Hub ships hand-authored descriptions for all six rooms, so nothing is
    // pending and the narrator never reaches the wire.
    const game = Game.begin({ campaign, seed: 'hub', name: 'Vess', archetype: 'freebooter' });
    const { narrator, client } = narratorWith(['should never be used']);

    await narrator.ensureArea(game.world, game.room);

    expect(client.calls).toHaveLength(0);
  });

  it('batches an area only once per session', async () => {
    const game = Game.begin({ campaign, seed: 'once', name: 'Vess', archetype: 'freebooter' });
    game.room.baseDesc = '';
    const { narrator, client } = narratorWith(['1. The Cleared Yard :: Stone and silence.']);

    await narrator.ensureArea(game.world, game.room);
    await narrator.ensureArea(game.world, game.room);

    expect(client.calls).toHaveLength(1); // the baseDone guard holds
  });
});

describe('resilience', () => {
  it('retries a failed batch on the next entry instead of stranding the area', async () => {
    // The bug: a single timeout on the big batch used to mark the area done and
    // leave every room on its developer placeholder for the whole session.
    const game = Game.begin({ campaign, seed: 'retry', name: 'Vess', archetype: 'freebooter' });
    game.room.baseDesc = '';
    const { narrator, client } = narratorWith([
      new Error('timeout'),
      '1. The Cleared Yard :: Stone and quiet. Nothing moves.',
    ]);

    await narrator.ensureArea(game.world, game.room);
    expect(game.room.baseDesc).toBe(''); // first attempt failed
    expect(client.calls).toHaveLength(1);

    await narrator.ensureArea(game.world, game.room); // a later entry retries
    expect(game.room.baseDesc).toContain('Stone and quiet');
    expect(client.calls).toHaveLength(2);
  });

  it('stops retrying after a few failures so a dead key does not cost a call a move', async () => {
    const game = Game.begin({ campaign, seed: 'giveup', name: 'Vess', archetype: 'freebooter' });
    game.room.baseDesc = '';
    const { narrator, client } = narratorWith(Array.from({ length: 6 }, () => new Error('dead')));

    for (let i = 0; i < 6; i += 1) await narrator.ensureArea(game.world, game.room);
    expect(client.calls).toHaveLength(3); // capped at MAX_TRIES
  });
});

describe('truth without a narrator', () => {
  it('leaves baseDesc empty on a failed call, so the structural placeholder stands', async () => {
    const game = Game.begin({ campaign, seed: 'nokey', name: 'Vess', archetype: 'freebooter' });
    const room = game.room;
    room.baseDesc = '';
    const { narrator } = narratorWith([new NoApiKeyError()]);

    await narrator.ensureArea(game.world, room);

    // The narrator wrote nothing; the game builds a truthful placeholder itself.
    expect(room.baseDesc).toBe('');
    expect(viewRoom(game.world, room).desc.length).toBeGreaterThan(0);
  });
});
