import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

function marda(game: Game): NpcRecord {
  const npc: NpcRecord = {
    campaignId: campaign.id,
    id: 'marda',
    name: 'Marda',
    aliases: [],
    location: inRoom(game.player.roomId),
    persona: 'quartermaster. blunt and watchful. Wants a fair price, for once.',
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

/** The exact session from the bug report, replayed with no narrator key. */
describe('the reported session', () => {
  it('examine marda describes her', () => {
    const game = Game.begin({ campaign, seed: 'bug-report', name: 'Vess', archetype: 'freebooter' });
    marda(game);
    const result = game.submit('examine marda');
    const text = result.lines.map((l) => l.text).join('\n');
    expect(text).toContain('Marda');
    expect(text).toContain('no harm');
    // The persona line is no longer printed eagerly — it rides along as the
    // fallback main.ts shows only when there's no narrator to ask instead.
    expect(result.appearance?.fallback.text).toContain('quartermaster');
  });

  it('talk to marda no longer answers "Talk what?"', () => {
    const game = Game.begin({ campaign, seed: 'bug-report', name: 'Vess', archetype: 'freebooter' });
    marda(game);
    const result = game.submit('talk to marda');
    const text = result.lines.map((l) => l.text).join('\n');
    expect(text).not.toContain('Talk what?');
    expect(result.voice).toEqual({ npcId: 'marda', topic: '' });
  });

  it('a continued conversation still prints something with no narrator to ask', () => {
    const game = Game.begin({ campaign, seed: 'bug-report', name: 'Vess', archetype: 'freebooter' });
    marda(game);

    // Opening prints the header outright. Continuing suppresses it and leans
    // on the voiced reply — which does not exist without a key, so the header
    // rides along as the fallback main.ts prints instead. Either way the turn
    // is never silent.
    const opened = game.submit('talk to marda');
    expect(opened.lines.map((l) => l.text)).toContain('Marda turns to hear you out.');
    expect(opened.voice?.fallback).toBeUndefined();

    const continued = game.submit('talk to marda');
    expect(continued.lines.map((l) => l.text)).not.toContain('Marda turns to hear you out.');
    expect(continued.voice?.fallback?.text).toBe('Marda turns to hear you out.');
  });

  it('i say hi to marda no longer answers "I does not take an object" — i alone still works', () => {
    const game = Game.begin({ campaign, seed: 'bug-report', name: 'Vess', archetype: 'freebooter' });
    marda(game);

    // Sans a narrator key, an unparsed input degrades to the engine's own
    // honest failure — never the "I" abbreviation swallowing the sentence.
    const noKey = game.submit('i say hi to marda').lines.map((l) => l.text).join('\n');
    expect(noKey).not.toContain('I does not take an object');
    expect(noKey).toBe('i say hi to marda\n"i" is not something you can do.');

    // The abbreviation itself is untouched.
    const inventory = game.submit('i').lines.map((l) => l.text).join('\n');
    expect(inventory).not.toContain('not something you can do');
  });
});
