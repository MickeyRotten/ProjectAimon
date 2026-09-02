/**
 * Balance regression, not behaviour: everything else asserts that combat *works*,
 * and nothing asserted that a fight is *winnable*. The first area past the Hub
 * shipped full of encounters an average starting character could not survive,
 * and the causes were spread across four tables — the area tier roll, the
 * encounter size, the creature curve and the enemy gambit thresholds. This file
 * is the sum of them: it plays the fights out and counts.
 *
 * Numbers here are deliberately loose floors, not targets. They exist to catch a
 * retune that quietly makes the opening unplayable again.
 */
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { AreaDef, ResolvedCampaign } from '../src/campaign/types';
import { rollEncounter } from '../src/content/monsters';
import { deriveHp, deriveResolve } from '../src/content/stats';
import { Rng } from '../src/engine/rng';
import { Game } from '../src/game/game';
import { rollTier } from '../src/world/area';
import { inRoom, type Attributes } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const areaDef = (id: string): AreaDef => campaign.areas.get(id) as AreaDef;

/**
 * Attributes are 3d8 straight, so 13.5 is the mean. Thirteen is the honest
 * character to balance against: a shade under average, and half of all rolls
 * come in below it.
 */
const AVERAGE = 13;

/** The rooms the two Hub gates actually open onto. */
const FIRST_ROOM_TAGS = ['outdoor', 'path', 'lit', 'junction'];

interface Fought {
  won: boolean;
  /** True when the corpse run fired, which is the only real way to lose. */
  defeated: boolean;
  rounds: number;
  foes: number;
}

/** The corpse-run banner. A loss is this line, not an inference from the room. */
const DEFEAT = 'You wake at the Hub';

/**
 * One fight, played to the end: an average character in their starter kit,
 * against a real encounter rolled off the real tables for a first area.
 */
function fight(seed: string, archetype: string, tier: number): Fought | undefined {
  const game = Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });
  const stats: Attributes = {
    brawn: AVERAGE,
    agility: AVERAGE,
    toughness: AVERAGE,
    charisma: AVERAGE,
    willpower: AVERAGE,
    wits: AVERAGE,
  };
  game.player.stats = stats;
  game.player.hp = deriveHp(campaign.rules, stats.toughness);
  game.player.resolve = deriveResolve(campaign.rules, stats.willpower);

  let seq = 0;
  const encounter = rollEncounter({
    campaign,
    rng: new Rng(`${seed}:encounter`),
    areaDef: areaDef(archetype),
    archetype,
    tier,
    roomTags: FIRST_ROOM_TAGS,
    location: inRoom(game.player.roomId),
    nextId: () => `${seed}:n${seq++}`,
  });
  if (!encounter) return undefined;
  for (const creature of encounter.creatures) game.world.npcs.set(creature.id, creature);

  const standing = (): number =>
    encounter.creatures.filter((c) => {
      const live = game.world.npcs.get(c.id);
      return live && !live.defeated && live.hostile;
    }).length;

  // The turn the player walks in is never a free hit, so the fight opens on a
  // held turn exactly as it does in play.
  game.submit('wait');

  let rounds = 0;
  let defeated = false;
  // Generous: a fight this long is already a loss in every sense but the
  // bookkeeping, and the round count is asserted separately below.
  while (rounds < 60 && standing() > 0 && !defeated) {
    const said = game.submit('attack');
    defeated = said.lines.some((line) => line.text.includes(DEFEAT));
    rounds++;
  }
  return {
    won: !defeated && standing() === 0,
    defeated,
    rounds,
    foes: encounter.creatures.length,
  };
}

const results = (count: number, archetype: string, tier: number): Fought[] => {
  const out: Fought[] = [];
  for (let i = 0; i < count; i++) {
    const fought = fight(`balance-${archetype}-${tier}-${i}`, archetype, tier);
    if (fought) out.push(fought);
  }
  return out;
};

describe('the first area is survivable', () => {
  it('an average character wins the large majority of tier-1 fights', () => {
    for (const archetype of ['farmland', 'town']) {
      const fights = results(40, archetype, 1);
      expect(fights.length).toBeGreaterThan(30);
      const won = fights.filter((f) => f.won).length;
      expect(won / fights.length).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('and wins them without a war of attrition', () => {
    const fights = results(40, 'farmland', 1).filter((f) => f.won);
    const rounds = fights.map((f) => f.rounds).sort((a, b) => a - b);
    const median = rounds[Math.floor(rounds.length / 2)] as number;
    expect(median).toBeLessThanOrEqual(15);
  });

  it('never fields more creatures at once than the tier allows', () => {
    // Every hostile in the room acts every round, so the count is the
    // difficulty however weak each one is.
    const caps = campaign.monsters.encounterCap as Record<string, number>;
    expect(caps).toBeDefined();
    for (const tier of [1, 2, 3]) {
      for (const fought of results(25, 'farmland', tier)) {
        expect(fought.foes).toBeLessThanOrEqual(caps[String(tier)] as number);
      }
    }
  });
});

describe('difficulty by depth', () => {
  it('holds the first gates out of the Hub to the ceiling the rules name', () => {
    const ceilings = (campaign.rules['DEPTH_TIER'] as Record<string, unknown>)[
      'tierCeilByDepth'
    ] as Record<string, number>;
    for (const [depth, ceiling] of Object.entries(ceilings)) {
      const rng = new Rng(`depth-${depth}`);
      for (const archetype of ['farmland', 'town']) {
        for (let i = 0; i < 300; i++) {
          const tier = rollTier(campaign.rules, areaDef(archetype), Number(depth), rng);
          expect(tier).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it('still lets difficulty climb once the ceiling stops applying', () => {
    const rng = new Rng('deep');
    const tiers = new Set<number>();
    for (let i = 0; i < 300; i++) tiers.add(rollTier(campaign.rules, areaDef('ruin'), 8, rng));
    expect(Math.max(...tiers)).toBeGreaterThanOrEqual(4);
  });
});
