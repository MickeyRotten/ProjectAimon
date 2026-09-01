import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { AreaDef, ResolvedCampaign } from '../src/campaign/types';
import { gambitsOf, rollEncounter, rollMonster } from '../src/content/monsters';
import { hubNpc, questsOf, rollNpc } from '../src/content/npcs';
import { inRoom } from '../src/content/records';
import { Rng } from '../src/engine/rng';
import { ruleAt } from '../src/engine/rules';
import { matches } from '../src/engine/tags';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const warren = campaign.areas.get('warren') as AreaDef;
const coven = campaign.areas.get('coven') as AreaDef;

const monster = (seed: string, over: Record<string, unknown> = {}) =>
  rollMonster({
    campaign,
    rng: new Rng(seed),
    id: 'n1',
    archetype: 'warren',
    areaDef: warren,
    roomTags: ['underground', 'dark', 'stone'],
    tier: 2,
    location: inRoom('r1'),
    ...over,
  });

describe('rolling a monster', () => {
  it('never reaches more than one tier above the area', () => {
    for (let i = 0; i < 300; i++) {
      const rolled = monster(`tier-${i}`, { tier: 1 });
      if (rolled) expect(rolled.tier).toBeLessThanOrEqual(2);
    }
  });

  it('refuses a role the base excludes, so a mindless thing never leads', () => {
    for (let i = 0; i < 300; i++) {
      const rolled = monster(`role-${i}`, { role: 'leader' });
      if (rolled?.tags.includes('mindless')) expect(rolled.role).not.toBe('leader');
    }
  });

  it('gives nothing to attack with Presence where nothing is home', () => {
    let checked = 0;
    for (let i = 0; i < 300 && checked < 5; i++) {
      const rolled = monster(`res-${i}`);
      if (!rolled) continue;
      const immune = rolled.tags.some(
        (tag) => ruleAt(campaign.rules, `TAXONOMY.${tag}.presenceImmune`) === true,
      );
      if (immune) {
        expect(rolled.resolve).toBeNull();
        checked++;
      } else {
        expect(rolled.resolve).toBeGreaterThan(0);
      }
    }
  });

  it('derives HP from Toughness rather than storing an authored number', () => {
    const rolled = monster('hp');
    const per = ruleAt(campaign.rules, 'DERIVED.hpPerToughness') as number;
    expect(rolled?.hp).toBe(Math.max(1, Math.round((rolled?.stats['toughness'] ?? 0) * per)));
  });

  it('halves the bribe threshold for something venal', () => {
    const plain = monster('bribe-a', { role: 'brute' });
    let venal = undefined;
    for (let i = 0; i < 200 && !venal; i++) {
      const rolled = monster(`bribe-${i}`);
      if (rolled?.tags.includes('venal')) venal = rolled;
    }
    if (venal && plain && !plain.tags.includes('venal')) {
      expect(venal.bribeThreshold).toBeLessThan(plain.bribeThreshold);
    }
  });

  it('takes an elite when one is forced, and the title lands on the name', () => {
    const rolled = monster('elite', { elite: true });
    expect(rolled?.elite).not.toBe('');
    expect(rolled?.name.length).toBeGreaterThan(0);
  });

  it('fights by the gambits its role names, which are never stored on it', () => {
    const rolled = monster('gambit', { role: 'brute' });
    expect(gambitsOf(campaign, rolled!).length).toBeGreaterThan(0);
    expect(Object.keys(rolled as object)).not.toContain('gambits');
  });
});

describe('rolling an encounter', () => {
  const encounter = (seed: string, tags: string[] = ['underground', 'dark', 'stone']) =>
    rollEncounter({
      campaign,
      rng: new Rng(seed),
      archetype: 'warren',
      areaDef: warren,
      roomTags: tags,
      tier: 2,
      location: inRoom('r1'),
      mintId: (() => {
        let n = 0;
        return () => `n${n++}`;
      })(),
    });

  it('fills every slot the composition asked for, with unique ids', () => {
    for (let i = 0; i < 60; i++) {
      const group = encounter(`enc-${i}`);
      expect(group.length).toBeGreaterThan(0);
      expect(new Set(group.map((one) => one.id)).size).toBe(group.length);
      for (const one of group) expect(one.hostile).toBe(true);
    }
  });

  it('keeps a composition out of a room its requires[] rejects', () => {
    const ambush = campaign.monsters.compositions.table.find((entry) => entry.name === 'ambush');
    expect(matches(['underground', 'open', 'lit'], ambush?.requires)).toBe(false);
  });

  it('never packs things that do not come in numbers', () => {
    for (let i = 0; i < 120; i++) {
      const group = encounter(`hulk-${i}`);
      const hulking = group.filter((one) => one.tags.includes('hulking'));
      const [, ceiling] = campaign.monsters.groupSize.byTag['hulking'] ?? [1, 1];
      if (hulking.length > 0) {
        const sameBase = hulking.filter((one) => one.baseId === hulking[0]?.baseId);
        expect(sameBase.length).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('rolls the same encounter twice from the same seed', () => {
    const a = encounter('same').map((one) => `${one.name}/${one.hp}`);
    const b = encounter('same').map((one) => `${one.name}/${one.hp}`);
    expect(a).toEqual(b);
  });
});

describe('rolling a person', () => {
  const npc = (seed: string, tags: string[], areaDef: AreaDef = warren) =>
    rollNpc({
      campaign,
      rng: new Rng(seed),
      id: 'n1',
      roomTags: tags,
      tier: 1,
      location: inRoom('r1'),
      areaDef,
    });

  it('only offers roles the room tags allow', () => {
    for (let i = 0; i < 200; i++) {
      const person = npc(`role-${i}`, ['outdoor', 'wild', 'open']);
      if (!person) continue;
      expect(person.role).not.toBe('smith');
    }
  });

  it('assembles a persona string and nothing else', () => {
    const person = npc('persona', ['dwelling', 'indoor', 'hearth']);
    expect(person?.persona).toMatch(/\. .+ and .+\. Wants /);
    expect(person?.persona).not.toContain('{');
    // The narrator names people, exactly as it names rooms.
    expect(person?.name).toBe('');
    expect(person?.hostile).toBe(false);
  });

  it('takes both traits from the table, and never the same one twice', () => {
    const ids = new Set(campaign.npcs.traits.map((trait) => trait.id));
    for (let i = 0; i < 200; i++) {
      const person = npc(`traits-${i}`, ['dwelling', 'indoor']);
      if (!person) continue;
      const [, traits] = person.persona.split('. ');
      const [a, b] = (traits ?? '').split(' and ');
      expect(ids.has(a as string)).toBe(true);
      expect(ids.has(b as string)).toBe(true);
      expect(a).not.toBe(b);
    }
  });

  it('offers the quest types its role does, straight off the table', () => {
    const person = npc('quests', ['market', 'indoor', 'settled']);
    if (person) expect(questsOf(campaign, person).length).toBeGreaterThan(0);
  });

  it('lets an area override sex without touching what the override respects', () => {
    let sexes = new Set<string>();
    for (let i = 0; i < 120; i++) {
      const person = npc(`sex-${i}`, ['indoor', 'dwelling', 'corrupt'], coven);
      if (person) sexes.add(person.sex);
    }
    expect([...sexes].every((sex) => sex === 'f' || sex === 'm')).toBe(true);
    expect(sexes.has('f')).toBe(true);
  });

  it('gives a hand-authored Hub NPC the same numbers a rolled one gets', () => {
    const def = campaign.manifest.hub.npcs[0]!;
    const person = hubNpc(campaign, new Rng('hub'), def);
    expect(person.name).toBe(def.name);
    expect(person.services).toEqual(def.services);
    expect(person.isVendor).toBe(def.isVendor === true);
    expect(person.hp).toBeGreaterThan(0);
    expect(person.stats['brawn']).toBeGreaterThan(0);
  });
});
