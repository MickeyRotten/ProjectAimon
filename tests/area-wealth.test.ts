/**
 * An area's identity and its worth.
 *
 * Both answer the same complaint from opposite ends: a generated area used to
 * be a bag of rooms with no reason to be the place it is, and its contents were
 * independent per-room rolls with no ceiling — so a lucky run could put
 * something valuable in every room, and one chest could hold an item worth more
 * than the rest of the world put together.
 */
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { AreaDef, ResolvedCampaign } from '../src/campaign/types';
import { basePrice, itemValues } from '../src/content/items';
import { Rng } from '../src/engine/rng';
import { rollIdentity } from '../src/world/area';
import type { ObjectRecord } from '../src/world/types';
import { World } from '../src/world/world';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const wealth = (campaign.placement as unknown as Record<string, Record<string, unknown>>)[
  'wealth'
] as Record<string, unknown>;
const areaDef = (id: string): AreaDef => campaign.areas.get(id) as AreaDef;

const generated = (world: World) =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');

/** Walk gates entry-first until `wanted` areas have actually been generated. */
function explore(world: World, wanted: number): void {
  while (generated(world).length < wanted) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

const worlds = (count: number, areas = 6): World[] =>
  Array.from({ length: count }, (_, i) => {
    const world = World.create({ campaign, seed: `wealth-${i}` });
    explore(world, areas);
    return world;
  });

const sample = worlds(8);

/** Everything the placement roller made for one area — ids are minted from it. */
const contentsOf = (world: World, areaId: string): ObjectRecord[] =>
  [...world.objects.values()].filter((object) => object.id.startsWith(`${areaId}:`));

describe('area identity', () => {
  it("rolls one value per trait, from its archetype's own table", () => {
    const def = areaDef('town').identity;
    expect(def).toBeDefined();
    const rng = new Rng('identity');
    let found = 0;
    for (let i = 0; i < 200; i++) {
      const identity = rollIdentity(rng, areaDef('town'));
      if (!identity) continue;
      found++;
      for (const [trait, value] of Object.entries(identity)) {
        const options = (def?.traits[trait] ?? []).map(([text]) => text);
        expect(options).toContain(value);
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it('lets an area have no identity at all, which is itself an answer', () => {
    // Somewhere nothing of note happens. A world where every place has a story
    // has no stories in it.
    const rng = new Rng('identity-misses');
    const rolled = Array.from({ length: 300 }, () => rollIdentity(rng, areaDef('farmland')));
    expect(rolled.some((identity) => identity === null)).toBe(true);
    expect(rolled.some((identity) => identity !== null)).toBe(true);
  });

  it('fixes it at generation and carries it through a save', () => {
    const world = sample[0] as World;
    const area = generated(world)[0];
    expect(area).toBeDefined();
    expect(area?.identity).not.toBeUndefined();

    const restored = World.restore(campaign, world.snapshot());
    expect(restored.areas.get(area?.id as string)?.identity).toEqual(area?.identity);
  });
});

describe('the wealth budget', () => {
  it('never exceeds the container budget for an area', () => {
    const max = (wealth['containersPerArea'] as number[])[1] as number;
    expect(sample.flatMap(generated).length).toBeGreaterThan(20);
    for (const world of sample) {
      for (const area of generated(world)) {
        const boxes = contentsOf(world, area.id).filter((o) => o.flags.container === true);
        expect(boxes.length, `${area.id}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('never spends more coin in an area than its purse held', () => {
    const budgets = wealth['goldBudgetByTier'] as Record<string, number[]>;
    for (const world of sample) {
      for (const area of generated(world)) {
        const tiers = Object.keys(budgets).filter((k) => !k.startsWith('_')).map(Number);
        const key = String(Math.min(Math.max(area.tier, Math.min(...tiers)), Math.max(...tiers)));
        const max = (budgets[key] as number[])[1] as number;
        const gold = contentsOf(world, area.id).reduce((sum, o) => sum + (o.gold ?? 0), 0);
        expect(gold, `${area.id} at tier ${area.tier}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it('keeps loose room items in the low band, so containers are where value lives', () => {
    const low = (wealth['bands'] as Record<string, { priceRange: number[] }>)['low'];
    const ceiling = (low?.priceRange as number[])[1] as number;
    let checked = 0;
    for (const world of sample) {
      for (const object of world.objects.values()) {
        // Loose means lying in a room, not inside something.
        if (!object.location?.startsWith('room:')) continue;
        if (object.flags.container === true || object.flags.scenery === true) continue;
        const base = campaign.items.bases.find((entry) => entry.id === object.baseId);
        if (!base) continue; // a fixture, not an item
        checked++;
        expect(basePrice(campaign, base), `${object.name}`).toBeLessThanOrEqual(ceiling);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('holds the total worth of an area to something a shop could absorb', () => {
    // The number that prompted this: one chest could roll a masterwork heirloom
    // plate worth 7000 gold, which is more than the rest of the world.
    let checked = 0;
    for (const world of sample) {
      for (const area of generated(world)) {
        checked++;
        const worth = contentsOf(world, area.id).reduce(
          (sum, o) => sum + (o.gold ?? 0) + (itemValues(campaign, o)['price'] ?? 0),
          0,
        );
        expect(worth, `${area.id}`).toBeLessThan(2500);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
