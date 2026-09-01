import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { generateItem, itemValues, weaponDie } from '../src/content/items';
import { Rng } from '../src/engine/rng';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

const roll = (seed: string, tier = 1, kind?: string) =>
  generateItem({
    campaign,
    rng: new Rng(seed),
    tier,
    ...(kind ? { kind } : {}),
    id: `test:${seed}`,
    location: 'room:test',
  });

/** A thousand items, which is enough for every affix to have had its chance. */
const many = (tier: number, kind?: string) => {
  const rng = new Rng(`items-${tier}-${kind ?? 'any'}`);
  return Array.from({ length: 1000 }, (_, i) =>
    generateItem({
      campaign,
      rng,
      tier,
      ...(kind ? { kind } : {}),
      id: `test:o${i}`,
      location: 'room:test',
    }),
  ).filter((item) => item !== undefined);
};

describe('item generation', () => {
  it('is deterministic for a seed', () => {
    expect(roll('same')).toEqual(roll('same'));
  });

  it('stores what it was generated from, and nothing derived', () => {
    const item = roll('spine');
    expect(item?.baseId).toBeTruthy();
    expect(item?.quality).toBeTruthy();
    // The record must never carry a combat value: retuning a weapon in
    // rules.json has to reach every sword already in the world.
    for (const derived of ['damage', 'penetration', 'reduction', 'penalty', 'price', 'weight']) {
      expect(item).not.toHaveProperty(derived);
    }
  });

  it('honours a requested kind', () => {
    for (const item of many(1, 'light')) {
      expect(item.tags).toContain('light');
      expect(item.flags.lightSource).toBe(true);
    }
  });

  it('only lands an affix where its requires[] allows', () => {
    const affixes = [...campaign.items.affixes.prefix, ...campaign.items.affixes.suffix];
    for (const item of many(3)) {
      for (const id of item.affixes) {
        const affix = affixes.find((entry) => entry.id === id);
        const filterOn = [item.baseId, ...item.tags];
        for (const requirement of affix?.requires ?? []) {
          const ok = requirement
            .split('|')
            .some((term) =>
              term.startsWith('!')
                ? !filterOn.includes(term.slice(1))
                : filterOn.includes(term) || item.tags.includes(term),
            );
          expect(ok, `${affix?.id} landed on ${item.name}`).toBe(true);
        }
      }
    }
  });

  it('gives a plain item an adjective and a graded one its quality', () => {
    for (const item of many(2)) {
      if (item.quality === 'plain') {
        expect(item.adjectives.some((word) => item.name.includes(word))).toBe(true);
      } else {
        expect(item.name).toContain(item.quality);
      }
    }
  });

  it('biases quality upward with the area tier', () => {
    const share = (tier: number) => {
      const items = many(tier);
      const good = items.filter((item) => item.quality === 'fine' || item.quality === 'masterwork');
      return good.length / items.length;
    };
    expect(share(3)).toBeGreaterThan(share(1));
  });

  it('burns for as long as the depletion rates say', () => {
    const torch = many(1, 'light').find((item) => item.baseId === 'torch');
    const lantern = many(1, 'light').find((item) => item.baseId === 'lantern');
    expect(torch?.burnRemaining).toBeGreaterThan(0);
    // A Hooded lantern adds its affix on top, so this is a floor, not equality.
    expect(lantern?.burnRemaining ?? 0).toBeGreaterThanOrEqual(torch?.burnRemaining ?? 0);
  });

  it('gives a spill of coin a value and nothing else one', () => {
    const treasure = many(2).filter((item) => item.tags.includes('treasure'));
    expect(treasure.length).toBeGreaterThan(0);
    for (const item of treasure) expect(item.gold).toBeGreaterThan(0);
    for (const item of many(2).filter((entry) => !entry.tags.includes('treasure'))) {
      expect(item.gold).toBeUndefined();
    }
  });
});

describe('derived item values', () => {
  it('reads a weapon spine out of the rules table', () => {
    const values = itemValues(campaign, { baseId: 'sword', quality: 'plain', affixes: [] });
    expect(weaponDie(campaign, 'sword')).toBe('1d8');
    expect(values['penetration']).toBe(10);
    expect(values['price']).toBe(35);
  });

  it('scales price by quality and by affix', () => {
    const plain = itemValues(campaign, { baseId: 'sword', quality: 'plain', affixes: [] });
    const fine = itemValues(campaign, { baseId: 'sword', quality: 'fine', affixes: [] });
    const gilded = itemValues(campaign, {
      baseId: 'shield',
      quality: 'fine',
      affixes: ['gilded'],
    });
    const plainShield = itemValues(campaign, { baseId: 'shield', quality: 'fine', affixes: [] });
    expect(fine['price']).toBeGreaterThan(plain['price'] as number);
    expect(gilded['price']).toBeGreaterThan(plainShield['price'] as number);
  });

  it('adds an affix mod the spine never had', () => {
    const values = itemValues(campaign, {
      baseId: 'leather',
      quality: 'fine',
      affixes: ['of_the_bear'],
    });
    expect(values['hp']).toBe(4);
  });

  it('takes a price that is itself a rule from the rules', () => {
    const values = itemValues(campaign, {
      baseId: 'waystone_token',
      quality: 'plain',
      affixes: [],
    });
    expect(values['price']).toBe(90);
  });
});
