import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import type { ChatRequest, LlmClient } from '../src/narrator/llm';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { Translator } from '../src/narrator/translate';
import { inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const settings = { ...DEFAULT_SETTINGS, apiKey: 'k' };

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

const translatorWith = (replies: (string | Error)[]): { translator: Translator; client: ScriptedClient } => {
  const client = new ScriptedClient(replies);
  return { translator: new Translator({ campaign, client, settings }), client };
};

const start = (seed = 'translate') => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

function friendlyNpc(game: Game): NpcRecord {
  const npc: NpcRecord = {
    campaignId: campaign.id,
    id: 'marda',
    name: 'Marda',
    aliases: [],
    location: inRoom(game.player.roomId),
    persona: 'quartermaster',
    tags: [],
    sex: 'none',
    stats: { brawn: 8, agility: 8, toughness: 8, charisma: 8, willpower: 8, wits: 8 },
    hp: 10,
    maxHp: 10,
    resolve: 10,
    maxResolve: 10,
    armourReduction: 0,
    penetration: 0,
    weaponDamage: '1d4',
    damageBonus: 0,
    attacksPerRound: 1,
    threat: 0,
    friendliness: 70,
    bribeThreshold: 0,
    disposition: 0,
    standing: 0,
    sensed: false,
    isVendor: true,
    priceModifier: 1,
    hostile: false,
    baseId: 'quartermaster',
    role: 'vendor',
    gambits: '',
    abilities: [],
    presenceImmune: false,
  };
  game.world.npcs.set(npc.id, npc);
  return npc;
}

describe('Translator.toCommand — re-enters the deterministic parser once', () => {
  it('accepts a canonical rewrite the parser can actually parse', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator, client } = translatorWith(['talk marda']);

    const command = await translator.toCommand('i say hi to marda', game.room.id, scope, campaign.verbs);
    expect(command).toMatchObject({ verb: 'talk', object: { words: ['marda'] } });
    expect(client.calls).toHaveLength(1);
  });

  it('discards a reply the grammar refuses, never trusting the model directly', async () => {
    const game = start();
    const scope = game.context().scope;
    const { translator } = translatorWith(['xyzzy the impossible']);

    const command = await translator.toCommand('gibberish', game.room.id, scope, campaign.verbs);
    expect(command).toBeUndefined();
  });

  it('treats a literal "null" reply as no command', async () => {
    const game = start();
    const scope = game.context().scope;
    const { translator } = translatorWith(['null']);

    const command = await translator.toCommand('I ponder the void', game.room.id, scope, campaign.verbs);
    expect(command).toBeUndefined();
  });

  it('caches per room and raw text — a repeat costs no second call', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator, client } = translatorWith(['talk marda']);

    await translator.toCommand('i say hi to marda', game.room.id, scope, campaign.verbs);
    await translator.toCommand('i say hi to marda', game.room.id, scope, campaign.verbs);
    expect(client.calls).toHaveLength(1);
  });

  it('degrades to undefined when the client throws', async () => {
    const game = start();
    const scope = game.context().scope;
    const { translator } = translatorWith([new Error('network down')]);

    const command = await translator.toCommand('anything', game.room.id, scope, campaign.verbs);
    expect(command).toBeUndefined();
  });
});

describe('Translator.classify — read lenient, emit canonical', () => {
  it('reads a clean canonical reply', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator } = translatorWith(['{ "stat": "charisma", "band": "moderate", "target": "marda" }']);

    const result = await translator.classify('I ask marda about her day', game.room.id, scope);
    expect(result).toEqual({ stat: 'charisma', band: 'moderate', target: 'marda' });
  });

  it('accepts alias keys models actually reach for', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator } = translatorWith(['{ "attribute": "charisma", "difficulty": "moderate", "who": "marda" }']);

    const result = await translator.classify('I flatter marda', game.room.id, scope);
    expect(result).toEqual({ stat: 'charisma', band: 'moderate', target: 'marda' });
  });

  it('merges nested and top-level fields, with the nested answer winning', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator } = translatorWith([
      '{ "stat": "wits", "attempt": { "stat": "charisma", "band": "moderate", "target": "marda" } }',
    ]);

    const result = await translator.classify('I charm marda', game.room.id, scope);
    expect(result).toMatchObject({ stat: 'charisma', band: 'moderate', target: 'marda' });
  });

  it('takes the last brace-balanced object when there is no clean marker', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator } = translatorWith([
      'Sure thing! Here is the classification: { "stat": "charisma", "band": "easy", "target": "marda" } — hope that helps.',
    ]);

    const result = await translator.classify('I banter with marda', game.room.id, scope);
    expect(result).toEqual({ stat: 'charisma', band: 'easy', target: 'marda' });
  });

  it('fires exactly one repair call after salvage fails, and none when it succeeds', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator: repaired, client: repairedClient } = translatorWith([
      'not json at all, sorry',
      '{ "stat": "charisma", "band": "moderate", "target": "marda" }',
    ]);
    const afterRepair = await repaired.classify('I appeal to marda', game.room.id, scope);
    expect(afterRepair).toEqual({ stat: 'charisma', band: 'moderate', target: 'marda' });
    expect(repairedClient.calls).toHaveLength(2);

    const { translator: clean, client: cleanClient } = translatorWith([
      '{ "stat": "charisma", "band": "moderate", "target": "marda" }',
    ]);
    await clean.classify('I appeal to marda', game.room.id, scope);
    expect(cleanClient.calls).toHaveLength(1);
  });

  it('swallows a failed repair rather than throwing', async () => {
    const game = start();
    const scope = game.context().scope;
    const { translator } = translatorWith(['garbage', 'still garbage']);
    const result = await translator.classify('mumble mumble', game.room.id, scope);
    expect(result).toBeUndefined();
  });

  it('caches a classification per room and raw text', async () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const { translator, client } = translatorWith(['{ "stat": "charisma", "band": "moderate", "target": "marda" }']);

    await translator.classify('I appeal to marda', game.room.id, scope);
    await translator.classify('I appeal to marda', game.room.id, scope);
    expect(client.calls).toHaveLength(1);
  });
});
