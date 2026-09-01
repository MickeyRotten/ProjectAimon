import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { breakOutcome } from '../src/game/combat';
import { Game } from '../src/game/game';
import { IN_PLAYER, inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

const start = (seed = 'combat') => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

const text = (game: Game, input: string): string =>
  game
    .submit(input)
    .lines.map((line) => line.text)
    .join('\n');

/** Stand a hostile in the player's room with fully controllable stats. */
function foe(game: Game, over: Partial<NpcRecord> = {}): NpcRecord {
  const stats = { brawn: 10, agility: 10, toughness: 6, charisma: 10, willpower: 6, wits: 8 };
  const npc: NpcRecord = {
    campaignId: campaign.id,
    id: `foe_${game.world.npcs.size}`,
    name: 'straw dummy',
    aliases: [],
    location: inRoom(game.player.roomId),
    persona: '',
    tags: ['humanoid'],
    sex: 'none',
    stats,
    hp: 6,
    maxHp: 6,
    resolve: 6,
    maxResolve: 6,
    armourReduction: 0,
    penetration: 0,
    weaponDamage: '1d4',
    damageBonus: 0,
    attacksPerRound: 1,
    threat: 10,
    friendliness: 50,
    bribeThreshold: 0,
    disposition: 0,
    standing: 0,
    sensed: false,
    isVendor: false,
    priceModifier: 1,
    hostile: true,
    baseId: 'footpad',
    role: 'skirmisher',
    gambits: 'skirmisher',
    abilities: ['attack'],
    presenceImmune: false,
    ...over,
  };
  game.world.npcs.set(npc.id, npc);
  return npc;
}

describe('starting a fight', () => {
  it('turns on the player when a hostile shares the room', () => {
    const game = start();
    foe(game);
    const said = text(game, 'wait');
    expect(said).toContain('turn on you');
    expect(game.combat.active).toBe(true);
  });

  it('does not let the entering turn be a free hit — enemies act only next turn', () => {
    const game = start();
    const monster = foe(game);
    const hpBefore = game.player.hp;
    text(game, 'wait'); // the turn the fight begins
    expect(game.player.hp).toBe(hpBefore); // no enemy swing yet
    expect(monster.hp).toBe(monster.maxHp);
  });
});

describe('weapon attacks', () => {
  it('cuts a weak foe down and clears the room', () => {
    const game = start();
    game.player.stats.brawn = 24; // heavy damage bonus, a one- or two-hit kill
    const monster = foe(game, { hp: 5, maxHp: 5, armourReduction: 0 });
    text(game, 'wait'); // begin
    let guard = 0;
    while (game.combat.active && guard++ < 20) text(game, 'attack dummy');
    expect(monster.defeated).toBe(true);
    expect(game.combat.active).toBe(false);
  });

  it('grows a weapon skill on landed hits over a long fight', () => {
    const game = start();
    game.player.stats.agility = 24; // never miss
    const kind = game.world.objects.get(game.player.weaponWielded)?.baseId as string;
    const before = game.player.weaponSkills[kind] ?? 0;
    foe(game, { hp: 400, maxHp: 400, weaponDamage: '1d2', damageBonus: -5, stats: { brawn: 1, agility: 1, toughness: 200, charisma: 1, willpower: 1, wits: 1 } });
    text(game, 'wait');
    for (let i = 0; i < 60 && game.combat.active; i++) text(game, 'attack dummy');
    expect(game.player.weaponSkills[kind] ?? 0).toBeGreaterThan(before);
  });
});

describe('the Presence route', () => {
  it('breaks a thinking creature and reads the outcome from friendliness', () => {
    const game = start();
    game.player.stats.charisma = 24;
    const monster = foe(game, {
      resolve: 4,
      maxResolve: 4,
      friendliness: 90,
      stats: { brawn: 10, agility: 10, toughness: 6, charisma: 10, willpower: 2, wits: 8 },
    });
    text(game, 'wait');
    let guard = 0;
    while (monster.hostile && !monster.defeated && guard++ < 20) text(game, 'use seduce on dummy');
    expect(monster.hostile).toBe(false);
    expect(monster.broke).toBe('join');
  });

  it('does nothing to the presence-immune', () => {
    const game = start();
    const monster = foe(game, { presenceImmune: true, tags: ['undead', 'mindless'] });
    text(game, 'wait');
    const said = text(game, 'use intimidate on dummy');
    expect(said.toLowerCase()).toContain('presence does nothing');
    expect(monster.resolve).toBe(monster.maxResolve);
  });

  it('reads break bands straight out of the rules', () => {
    expect(breakOutcome(campaign.rules, 10)).toBe('flee');
    expect(breakOutcome(campaign.rules, 50)).toBe('surrender');
    expect(breakOutcome(campaign.rules, 90)).toBe('join');
  });
});

describe('sensing', () => {
  it('reveals a foe and marks it sensed', () => {
    const game = start();
    const monster = foe(game);
    text(game, 'wait');
    const said = text(game, 'examine dummy');
    expect(said).toContain('HP');
    expect(monster.sensed).toBe(true);
  });
});

describe('flight', () => {
  it('always works, ends the fight, and moves the player', () => {
    const game = start();
    // Stand at a room with somewhere to run to.
    foe(game);
    text(game, 'wait');
    const before = game.player.roomId;
    text(game, 'flee');
    expect(game.combat.active).toBe(false);
    expect(game.player.roomId).not.toBe(before);
  });
});

describe('defeat and the corpse run', () => {
  it('strips the player, parks their goods on the victor, and wakes them at the Hub', () => {
    const game = start();
    game.player.purse = 120;
    game.player.stats.toughness = 3; // 6 HP, a glass jaw
    game.player.hp = 6;
    const hub = campaign.manifest.hub.entryRoomId;
    // A brutal foe that will not miss and hits hard.
    const monster = foe(game, {
      hp: 500,
      maxHp: 500,
      weaponDamage: '2d6',
      damageBonus: 40,
      stats: { brawn: 20, agility: 24, toughness: 250, charisma: 10, willpower: 10, wits: 10 },
    });
    text(game, 'wait'); // begin
    let guard = 0;
    // The fight is in the Hub itself here; the corpse run wakes them where they
    // started, so watch the purse empty rather than the room change.
    while (game.combat.active && guard++ < 20) text(game, 'attack dummy');
    expect(game.player.roomId).toBe(hub);
    expect(game.player.purse).toBe(0);
    expect(monster.gold).toBe(120);
    // Re-kitted, not left naked.
    expect(game.player.weaponWielded).not.toBe('');
    expect(game.world.contentsOf(IN_PLAYER).objects.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('re-tells the same fight from the same seed', () => {
    const run = () => {
      const game = start('same-fight');
      foe(game, { hp: 30, maxHp: 30 });
      game.submit('wait');
      const out: string[] = [];
      for (let i = 0; i < 6; i++) out.push(text(game, 'attack dummy'));
      return { out: out.join('|'), hp: game.player.hp };
    };
    const a = run();
    const b = run();
    expect(a.out).toBe(b.out);
    expect(a.hp).toBe(b.hp);
  });
});
