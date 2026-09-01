import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { itemValues, lootTier, rollItem, takeableKinds } from '../src/content/items';
import { inRoom } from '../src/content/records';
import { Rng } from '../src/engine/rng';
import { ruleAt } from '../src/engine/rules';
import { matches } from '../src/engine/tags';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const roll = (seed: string, over: Partial<Parameters<typeof rollItem>[2]> = {}) =>
  rollItem(new Rng(seed), campaign, { id: 'o1', tier: 1, location: inRoom('r1'), ...over });

describe('rolling an item', () => {
  it('carries its kind and quality as tags, and its base as provenance', () => {
    const item = roll('sword-ish', { baseId: 'sword' });
    expect(item?.baseId).toBe('sword');
    expect(item?.tags).toContain('weapon');
    expect(item?.tags).toContain(item?.quality);
    expect(item?.nouns.length).toBeGreaterThan(0);
    expect(item?.location).toBe('room:r1');
  });

  it('takes its flags from the table and never invents one', () => {
    const torch = roll('torch', { baseId: 'torch' });
    expect(torch?.flags.lightSource).toBe(true);
    expect(torch?.flags.takeable).toBe(true);
    const door = roll('door', { baseId: 'door' });
    expect(door?.flags.scenery).toBe(true);
    expect(door?.flags.takeable).toBeUndefined();
  });

  it('burns for as long as the rules say, and nothing else burns at all', () => {
    const torch = roll('t', { baseId: 'torch' });
    expect(torch?.burnRemaining).toBe(ruleAt(campaign.rules, 'DEPLETION_RATES.torch'));
    expect(roll('s', { baseId: 'sword' })?.burnRemaining).toBe(0);
  });

  it('rolls loose loot only among kinds the tables call takeable', () => {
    const takeable = takeableKinds(campaign);
    expect(takeable.has('container')).toBe(false);
    for (let i = 0; i < 200; i++) {
      const item = roll(`loose-${i}`);
      expect(takeable.has(item?.tags[0] as string)).toBe(true);
    }
  });

  it('gives an affix only where the affix says it belongs', () => {
    const pools = [...campaign.items.affixes.prefix, ...campaign.items.affixes.suffix];
    for (let i = 0; i < 300; i++) {
      const item = roll(`affix-${i}`);
      if (!item) continue;
      const quality = campaign.items.qualities.find((entry) => entry.id === item.quality);
      expect(item.affixes.length).toBeLessThanOrEqual(quality?.affixes ?? 0);
      for (const id of item.affixes) {
        const affix = pools.find((entry) => entry.id === id);
        expect(matches([item.tags[0] as string, item.quality], affix?.requires)).toBe(true);
      }
    }
  });

  it('shifts quality upward with the area tier, without ever guaranteeing it', () => {
    const share = (tier: number): number => {
      let good = 0;
      for (let i = 0; i < 400; i++) {
        const item = roll(`q-${tier}-${i}`, { tier, kind: 'weapon' });
        if (item && (item.quality === 'fine' || item.quality === 'masterwork')) good++;
      }
      return good / 400;
    };
    const low = share(1);
    const high = share(3);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeLessThan(1);
  });

  it('clamps a tier the loot table never got a row for', () => {
    expect(lootTier(campaign, 99).goldRange).toEqual(lootTier(campaign, 5).goldRange);
    expect(lootTier(campaign, -3).goldRange).toEqual(lootTier(campaign, 1).goldRange);
  });
});

describe('derived values', () => {
  it('are computed on read and stored nowhere', () => {
    const item = roll('derive', { baseId: 'sword', quality: 'plain' });
    expect(item).toBeDefined();
    expect(Object.keys(item as object)).not.toContain('damage');
    expect(Object.keys(item as object)).not.toContain('price');
    const values = itemValues(campaign, item!);
    expect(values.damage).toBe(ruleAt(campaign.rules, 'WEAPON_TABLE.sword.damage'));
    expect(values.price).toBe(ruleAt(campaign.rules, 'WEAPON_TABLE.sword.price'));
  });

  it('scales price by quality, so a masterwork is worth many crude ones', () => {
    const crude = itemValues(campaign, roll('a', { baseId: 'sword', quality: 'crude' })!);
    const master = itemValues(campaign, roll('b', { baseId: 'sword', quality: 'masterwork' })!);
    expect(master.price).toBeGreaterThan(crude.price * 5);
  });

  it('prices what the combat tables do not, from the item table', () => {
    const rope = itemValues(campaign, roll('rope', { baseId: 'rope', quality: 'plain' })!);
    expect(rope.price).toBeGreaterThan(0);
    expect(rope.weight).toBeGreaterThan(0);
  });
});
