import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { execute } from '../src/game/commands';
import { Game } from '../src/game/game';
import { parse } from '../src/engine/parser';
import { inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const start = (seed = 'voice') => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

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

describe('ask, tell and say — voicing, never resolution', () => {
  it('talk with no quest work hands off to voicing rather than a step-7 stub', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('talk marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.voice).toEqual({ npcId: 'marda', topic: '' });
    expect(reply.effects).toEqual([{ kind: 'pronoun', ref: 'it', id: 'marda' }]);
  });

  it('ask carries the topic after the preposition, and voices the addressee', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('ask marda about the ruins', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.voice).toEqual({ npcId: 'marda', topic: 'ruins' });
  });

  it('say carries the addressee after "to", not the object', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('say hi to marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.voice).toEqual({ npcId: 'marda', topic: 'hi' });
  });

  it('say with no addressee lands on no one and voices nothing', () => {
    const game = start();
    const ctx = game.context();
    const command = parse('say hi', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.voice).toBeUndefined();
  });

  it('never returns an effect outside the pronoun update — no mechanical resolution', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('tell marda about the plan', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.effects).toEqual([{ kind: 'pronoun', ref: 'it', id: 'marda' }]);
  });

  it('give and show still answer honestly that trading is not built', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const gift = parse('give sword to marda', campaign.verbs);
    if (!gift.ok) throw new Error('did not parse');
    const reply = execute(ctx, gift.command);
    expect(reply.free).toBe(true);
    expect(reply.voice).toBeUndefined();
  });
});
