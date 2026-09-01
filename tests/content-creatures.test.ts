import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { AreaDef, ResolvedCampaign } from '../src/campaign/types';
import { rollEncounter, type Encounter } from '../src/content/monsters';
import { generateNpc } from '../src/content/npcs';
import { rollSex } from '../src/content/sex';
import { Rng } from '../src/engine/rng';
import { matches } from '../src/engine/tags';
import type { NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const areaDef = (id: string): AreaDef => campaign.areas.get(id) as AreaDef;

let seq = 0;
const nextId = () => `test:n${seq++}`;

function encounters(archetype: string, roomTags: string[], tier: number, count = 200): Encounter[] {
  const rng = new Rng(`encounters-${archetype}-${roomTags.join('-')}-${tier}`);
  const out: Encounter[] = [];
  for (let i = 0; i < count; i++) {
    const rolled = rollEncounter({
      campaign,
      rng,
      areaDef: areaDef(archetype),
      archetype,
      tier,
      roomTags,
      location: 'room:test',
      nextId,
    });
    if (rolled) out.push(rolled);
  }
  return out;
}

const creaturesOf = (rolled: Encounter[]): NpcRecord[] =>
  rolled.flatMap((encounter) => encounter.creatures);

describe('creature generation', () => {
  it('only spawns bases that belong in the area and the room', () => {
    const roomTags = ['underground', 'dark', 'grave', 'stone'];
    for (const creature of creaturesOf(encounters('warren', roomTags, 3))) {
      const base = campaign.monsters.bases.find((entry) => entry.id === creature.baseId);
      expect(base?.areas).toContain('warren');
      expect(matches(roomTags, base?.requires)).toBe(true);
    }
  });

  it('never spawns a base more than one tier above the room', () => {
    for (const tier of [1, 2, 3]) {
      for (const creature of creaturesOf(encounters('ruin', ['indoor', 'ruin', 'dim'], tier))) {
        const base = campaign.monsters.bases.find((entry) => entry.id === creature.baseId);
        expect(base?.tier ?? 0).toBeLessThanOrEqual(tier + 1);
      }
    }
  });

  it('refuses a role the base carries an excludeTag for', () => {
    // The bug the gate was written for: a mindless skeleton rolling `leader`,
    // whose gambits use Presence abilities it can never land.
    for (const creature of creaturesOf(encounters('warren', ['underground', 'grave', 'dark'], 3))) {
      const role = campaign.monsters.roles.find((entry) => entry.id === creature.role);
      for (const tag of role?.excludeTags ?? []) expect(creature.tags).not.toContain(tag);
    }
  });

  it('clamps a group by taxonomy, so hulking things come alone', () => {
    for (const encounter of encounters('farmland', ['outdoor', 'wild', 'cultivated'], 3)) {
      const byBase = new Map<string, number>();
      for (const creature of encounter.creatures) {
        byBase.set(creature.baseId, (byBase.get(creature.baseId) ?? 0) + 1);
      }
      for (const [baseId, count] of byBase) {
        const base = campaign.monsters.bases.find((entry) => entry.id === baseId);
        if (base?.tags.includes('hulking')) expect(count).toBe(1);
      }
    }
  });

  it('derives every stat from the tier curve rather than from an author', () => {
    const meanOf = (tier: number) => {
      const all = creaturesOf(encounters('ruin', ['indoor', 'ruin', 'stone', 'dim'], tier));
      return all.reduce((sum, creature) => sum + creature.maxHp, 0) / all.length;
    };
    expect(meanOf(4)).toBeGreaterThan(meanOf(1));
    for (const creature of creaturesOf(encounters('ruin', ['indoor', 'ruin', 'dim'], 2))) {
      expect(creature.hp).toBe(creature.maxHp);
      expect(creature.maxHp).toBeGreaterThan(0);
      expect(creature.weaponDamage).toMatch(/^\d+d\d+$/);
      expect(creature.hostile).toBe(true);
    }
  });

  it('marks the taxonomies Presence can never reach', () => {
    for (const creature of creaturesOf(encounters('warren', ['underground', 'grave', 'dark'], 3))) {
      const immune = ['undead', 'construct', 'mindless'].some((tag) => creature.tags.includes(tag));
      expect(creature.presenceImmune).toBe(immune);
    }
  });

  it('gives every creature a gambit list and abilities within the cap', () => {
    const cap = 5;
    for (const creature of creaturesOf(encounters('town', ['settled', 'path', 'open'], 2))) {
      expect(campaign.abilities.gambitsByRole[creature.gambits]).toBeDefined();
      expect(creature.abilities.length).toBeGreaterThan(0);
      expect(creature.abilities.length).toBeLessThanOrEqual(cap);
    }
  });

  it('forces an elite when the deepest room asks for one', () => {
    const rng = new Rng('elite');
    const encounter = rollEncounter({
      campaign,
      rng,
      areaDef: areaDef('ruin'),
      archetype: 'ruin',
      tier: 2,
      roomTags: ['indoor', 'ruin', 'stone', 'dim'],
      location: 'room:test',
      nextId,
      forceElite: true,
    });
    const titles = campaign.monsters.elites.table.map((elite) => elite.title);
    const first = encounter?.creatures[0] as NpcRecord;
    expect(titles.some((title) => first.name.startsWith(title))).toBe(true);
  });

  it('answers a world flag with a different spawn', () => {
    const roomTags = ['settled', 'path', 'concealment'];
    const upgraded = new Rng('flags');
    let sawCutthroat = false;
    for (let i = 0; i < 200; i++) {
      const encounter = rollEncounter({
        campaign,
        rng: upgraded,
        areaDef: areaDef('town'),
        archetype: 'town',
        tier: 1,
        roomTags,
        location: 'room:test',
        nextId,
        flags: new Set(['smugglers_unbeaten']),
      });
      if (encounter?.creatures.some((creature) => creature.baseId === 'cutthroat')) {
        sawCutthroat = true;
      }
    }
    // A cutthroat is tier 3 and cannot roll at tier 1 on its own, so its only
    // way into this room is the spawn upgrade.
    expect(sawCutthroat).toBe(true);
  });
});

describe('npc generation', () => {
  const people = (roomTags: string[], count = 200) => {
    const rng = new Rng(`npcs-${roomTags.join('-')}`);
    return Array.from({ length: count }, (_, i) =>
      generateNpc({
        campaign,
        rng,
        areaDef: areaDef('town'),
        roomTags,
        location: 'room:test',
        id: `test:p${i}`,
      }),
    ).filter((person) => person !== undefined);
  };

  it('only places a role its room allows', () => {
    const roomTags = ['settled', 'market', 'open'];
    for (const person of people(roomTags)) {
      expect(matches(roomTags, person.role.requires)).toBe(true);
    }
  });

  it('returns nothing where no role fits, which is a normal outcome', () => {
    expect(people(['underground', 'grave', 'dark'], 20)).toHaveLength(0);
  });

  it('assembles a persona from the role, two distinct traits and a want', () => {
    for (const person of people(['settled', 'dwelling', 'hearth'])) {
      expect(person.record.persona).not.toContain('{');
      const [, traits] = person.record.persona.split('. ');
      const [a, b] = (traits ?? '').replace(' and', '').split(' ');
      expect(a).not.toBe(b);
      expect(person.record.hostile).toBe(false);
      expect(person.record.maxHp).toBeGreaterThan(0);
    }
  });

  it('offers a quest type its role actually gives', () => {
    for (const person of people(['settled', 'market', 'path'])) {
      expect(person.role.quests).toContain(person.questType);
    }
  });
});

describe('sex', () => {
  it('follows an area override', () => {
    const rng = new Rng('coven');
    const rolls = Array.from({ length: 200 }, () =>
      rollSex({ rng, areaDef: areaDef('coven'), fallback: campaign.monsters.sexDefault }),
    );
    const women = rolls.filter((sex) => sex === 'f').length;
    // Weighted, not binary, on purpose: the exception carries meaning.
    expect(women).toBeGreaterThan(rolls.length * 0.6);
    expect(women).toBeLessThan(rolls.length);
  });

  it('leaves sexless things sexless, whatever the area says', () => {
    const rng = new Rng('skeletons');
    for (let i = 0; i < 100; i++) {
      const sex = rollSex({
        rng,
        areaDef: areaDef('coven'),
        own: { none: 100 },
        fallback: campaign.monsters.sexDefault,
      });
      expect(sex).toBe('none');
    }
  });
});
