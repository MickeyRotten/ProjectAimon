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
    const text = game
      .submit('examine marda')
      .lines.map((l) => l.text)
      .join('\n');
    expect(text).toContain('Marda');
    expect(text).toContain('quartermaster');
    expect(text).toContain('no harm');
  });

  it('talk to marda no longer answers "Talk what?"', () => {
    const game = Game.begin({ campaign, seed: 'bug-report', name: 'Vess', archetype: 'freebooter' });
    marda(game);
    const result = game.submit('talk to marda');
    const text = result.lines.map((l) => l.text).join('\n');
    expect(text).not.toContain('Talk what?');
    expect(result.voice).toEqual({ npcId: 'marda', topic: '' });
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
