import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { execute } from '../src/game/commands';
import { Game } from '../src/game/game';
import { parse } from '../src/engine/parser';
import { heldBy, inRoom, IN_PLAYER, type NpcRecord } from '../src/world/types';

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
    expect(reply.effects).toEqual([
      { kind: 'pronoun', ref: 'it', id: 'marda' },
      { kind: 'converse', op: { t: 'open', npcId: 'marda' } },
    ]);
    expect(reply.lines.map((entry) => entry.text)).toContain('Marda turns to hear you out.');
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

  it('never returns an effect beyond the pronoun and the conversation — no mechanical resolution', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('tell marda about the plan', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    // Opening a conversation is bookkeeping — who is being spoken to. Nothing
    // here moves an item, a number or a quest.
    expect(reply.effects).toEqual([
      { kind: 'pronoun', ref: 'it', id: 'marda' },
      { kind: 'converse', op: { t: 'open', npcId: 'marda' } },
    ]);
  });

  it('a conversation already open is continued, not re-opened: no second header line', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = { ...game.context(), conversation: { npcId: 'marda' } };
    const command = parse('ask marda about the ruins', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.lines).toEqual([]);
    expect(reply.effects).toEqual([{ kind: 'pronoun', ref: 'it', id: 'marda' }]);
    expect(reply.voice).toEqual({
      npcId: 'marda',
      topic: 'ruins',
      // With no narrator the header stands in, so a keyless game never gets a
      // turn that prints nothing at all.
      fallback: { text: 'Marda turns to hear you out.', kind: 'rule' },
    });
  });

  it('addressing someone else opens on them instead', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = { ...game.context(), conversation: { npcId: 'someone-else' } };
    const command = parse('talk marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.effects).toContainEqual({ kind: 'converse', op: { t: 'open', npcId: 'marda' } });
  });

  it('LIST against a vendor with nothing in stock says so, and still lets them answer', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = game.context();
    const command = parse('list marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.lines.map((entry) => entry.text)).toEqual(['Marda has nothing to sell just now.']);
    expect(reply.voice).toEqual({ npcId: 'marda', topic: 'what they have for sale' });
  });

  it('LIST reads out a vendor stock with prices, and never their own worn gear', () => {
    const game = start();
    const npc = friendlyNpc(game);
    const carried = game.world.contentsOf(IN_PLAYER).objects;
    const stock = carried.find((object) => !object.flags.worn && object.flags.weapon);
    const worn = carried.find((object) => object.flags.worn);
    if (!stock || !worn) throw new Error('the starting kit has no worn and carried pair');
    // The starter kit is untradable to a man, which is the point of it — a
    // vendor's own stock is not, so clear the flag on the one being sold.
    stock.flags.untradable = false;
    stock.tags = stock.tags.filter((tag) => tag !== 'untradable');
    game.world.moveTo(stock.id, heldBy(npc.id));
    game.world.moveTo(worn.id, heldBy(npc.id));

    const command = parse('list marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(game.context(), command.command);
    const text = reply.lines.map((entry) => entry.text).join('\n');
    expect(text).toContain('Marda deals in:');
    expect(text).toContain('gold');
    // What a shopkeeper is standing up in is not stock.
    expect(text).not.toContain(worn.name);
    // A merchant reading out a price list has nothing left to voice.
    expect(reply.voice).toBeUndefined();
  });

  it('LIST against someone who sells nothing does nothing mechanical, but they still answer', () => {
    const game = start();
    const npc = friendlyNpc(game);
    npc.isVendor = false;
    const command = parse('list marda', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(game.context(), command.command);
    expect(reply.lines).toEqual([]);
    expect(reply.effects).toEqual([]);
    expect(reply.voice).toEqual({
      npcId: 'marda',
      topic: 'what they have for sale',
      fallback: { text: 'Marda has nothing to sell.', kind: 'rule' },
    });
  });

  it('LIST with no target falls to whoever is being talked to', () => {
    const game = start();
    friendlyNpc(game);
    const ctx = { ...game.context(), conversation: { npcId: 'marda' } };
    const command = parse('wares', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');
    const reply = execute(ctx, command.command);
    expect(reply.lines.map((entry) => entry.text)).toEqual(['Marda has nothing to sell just now.']);
  });

  it('BYE closes the conversation; with none open it says so and costs nothing', () => {
    const game = start();
    friendlyNpc(game);
    const command = parse('bye', campaign.verbs);
    if (!command.ok) throw new Error('did not parse');

    const closed = execute({ ...game.context(), conversation: { npcId: 'marda' } }, command.command);
    expect(closed.effects).toEqual([{ kind: 'converse', op: { t: 'close' } }]);
    expect(closed.lines.map((entry) => entry.text)).toEqual(['You take your leave of Marda.']);

    const idle = execute(game.context(), command.command);
    expect(idle.effects).toEqual([]);
    expect(idle.lines.map((entry) => entry.text)).toEqual(['You are not talking to anyone.']);
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
