/**
 * Items — base × quality × up to two affixes.
 *
 * Twenty bases and twenty-two affixes give thousands of distinct results from
 * a page of JSON, which is the whole reason there is no editor.
 *
 * Two rules hold the system in place:
 *
 *  - **An affix may only modify a value the engine already has.** Validation
 *    enforces it against `ALLOWED_MODS`; this file never invents a field.
 *  - **Combat values are derived, never stored.** The record keeps `baseId`,
 *    `quality` and `affixes[]`, and `itemValues` computes the rest against the
 *    rules tables at the moment they are read. Storing them would mean
 *    retuning a weapon silently failed to reach every sword already in play.
 */

import type { Json, JsonObject } from '../campaign/merge';
import type { AffixDef, ItemBaseDef, QualityDef, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber } from '../engine/rules';
import { matches } from '../engine/tags';
import type { Location, ObjectFlags, ObjectRecord } from '../world/types';

export interface ItemOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  /** The area's tier. Shifts the quality roll upward and sets the gold range. */
  tier: number;
  /** A kind from `tags.json`, or `any`. `light` is how a lamp is asked for. */
  kind?: string | undefined;
  /**
   * A specific base, when something is asked for by name rather than rolled —
   * the starter kit is a list of base ids, not a list of kinds.
   */
  baseId?: string | undefined;
  /**
   * A value band from `placement.wealth.bands`, when the caller is spending
   * against an area's wealth budget rather than rolling free. It narrows the
   * pool by base price and takes over the quality bias, which is how a chest
   * can be worth opening without any single roll being able to produce a
   * masterwork heirloom plate.
   */
  band?: ValueBand | undefined;
  id: string;
  location: Location;
}

/** One row of `placement.wealth.bands`. */
export interface ValueBand {
  priceRange: [number, number];
  qualityBias: number;
}

/** The generated shape, before it is written into an `ObjectRecord`. */
export interface ItemRoll {
  base: ItemBaseDef;
  quality: QualityDef;
  affixes: AffixDef[];
  name: string;
  nouns: string[];
  adjectives: string[];
  tags: string[];
}

/**
 * Roll one item and write the record. Returns undefined only when no base
 * matches the requested kind, which is a table problem, not a play outcome.
 */
export function generateItem(options: ItemOptions): ObjectRecord | undefined {
  const roll = rollItem(options);
  if (!roll) return undefined;
  const { campaign, rng } = options;

  const record: ObjectRecord = {
    campaignId: campaign.id,
    id: options.id,
    name: roll.name,
    nouns: roll.nouns,
    adjectives: roll.adjectives,
    location: options.location,
    desc: '',
    tags: roll.tags,
    baseId: roll.base.id,
    quality: roll.quality.id,
    affixes: roll.affixes.map((affix) => affix.id),
    flags: flagsFor(roll),
    condition: 100,
    burnRemaining: burnOf(campaign, roll),
  };

  // A purse is the one thing whose value cannot be recovered from a base and a
  // quality, so the coin in it is rolled once and stored.
  if (record.tags.includes('treasure')) record.gold = rollGold(campaign, rng, options.tier);
  return record;
}

/** The roll on its own, for callers that want the parts rather than a record. */
export function rollItem(options: ItemOptions): ItemRoll | undefined {
  const { campaign, rng } = options;
  const wanted = options.kind && options.kind !== 'any' ? options.kind : undefined;
  const pool = options.baseId
    ? campaign.items.bases.filter((base) => base.id === options.baseId)
    : wanted
      ? campaign.items.bases.filter((base) => base.kind === wanted)
      : campaign.items.bases;
  const base = rng.maybeWeighted(inBand(campaign, pool, options.band));
  if (!base) return undefined;

  const quality = rollQuality(campaign, rng, options.tier, options.band);
  // Affixes filter on the base's kind and the quality's tags, which is why
  // Reinforced only lands on armour and Hooded only on lights.
  const filterTags = [base.kind, ...quality.tags];
  const pools = [campaign.items.affixes.prefix, campaign.items.affixes.suffix];
  const affixes: AffixDef[] = [];
  for (let i = 0; i < quality.affixes; i++) {
    const fits = (pools[i % pools.length] ?? []).filter((affix) => matches(filterTags, affix.requires));
    const chosen = rng.maybeWeighted(fits);
    if (chosen) affixes.push(chosen);
  }

  const prefix = affixes.find((affix) => campaign.items.affixes.prefix.includes(affix));
  const suffix = affixes.find((affix) => campaign.items.affixes.suffix.includes(affix));
  const adjective = rng.pick(base.adjectives);
  const noun = rng.pick(base.nouns);

  // "Hooded masterwork brand of Long Roads". A plain item wears an adjective
  // instead of its quality, because "plain brand" reads as a mistake.
  const name = [prefix?.name, quality.id === 'plain' ? adjective : quality.id, noun, suffix?.name]
    .filter(Boolean)
    .join(' ');

  return {
    base,
    quality,
    affixes,
    name,
    nouns: [...base.nouns],
    adjectives: [...base.adjectives],
    tags: [
      ...new Set([
        base.kind,
        ...quality.tags,
        ...affixes.flatMap((affix) => (affix as { tags?: string[] }).tags ?? []),
      ]),
    ],
  };
}

/**
 * Quality, biased upward by the area's tier. `lootTiers[tier].qualityBias` is
 * added once per step up the quality list, so a bias of zero leaves the table
 * exactly as authored and a large one makes masterwork reachable deep in.
 */
function rollQuality(
  campaign: ResolvedCampaign,
  rng: Rng,
  tier: number,
  band?: ValueBand | undefined,
): QualityDef {
  const bias = band ? band.qualityBias : (lootTierValue(campaign, tier, 'qualityBias') ?? 0);
  const biased = campaign.items.qualities.map((quality, step) => ({
    ...quality,
    w: Math.max(0, (quality.w ?? 1) + bias * step),
  }));
  return rng.weighted(biased);
}

/**
 * Narrow a pool to the bases whose price sits in the band. A band that matches
 * nothing is ignored rather than obeyed: an empty pool would mean no item at
 * all, and a slightly-too-cheap thing in a chest is a tuning problem, while a
 * chest that generates nothing is a bug.
 */
function inBand(
  campaign: ResolvedCampaign,
  pool: readonly ItemBaseDef[],
  band: ValueBand | undefined,
): ItemBaseDef[] {
  if (!band) return [...pool];
  const [lo, hi] = band.priceRange;
  const fits = pool.filter((base) => {
    const price = basePrice(campaign, base);
    return price >= lo && price <= hi;
  });
  return fits.length > 0 ? fits : [...pool];
}

/** Coin for a purse or a spill of it, from the tier's `goldRange`. */
export function rollGold(campaign: ResolvedCampaign, rng: Rng, tier: number): number {
  const range = lootTierRange(campaign, tier, 'goldRange');
  return range ? rng.int(range[0], range[1]) : 0;
}

/**
 * `lootTiers` is authored for the tiers loot actually varies across, not for
 * every tier an area can reach, so a tier above the table clamps to the top
 * entry rather than falling back to nothing.
 */
function lootTierEntry(campaign: ResolvedCampaign, tier: number): JsonObject | undefined {
  const keys = Object.keys(campaign.items.lootTiers)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter((key) => Number.isFinite(key))
    .sort((a, b) => a - b);
  if (keys.length === 0) return undefined;
  const first = keys[0] as number;
  const last = keys[keys.length - 1] as number;
  const clamped = Math.min(Math.max(tier, first), last);
  const key = [...keys].reverse().find((candidate) => candidate <= clamped) ?? first;
  return campaign.items.lootTiers[String(key)] as JsonObject | undefined;
}

function lootTierValue(campaign: ResolvedCampaign, tier: number, key: string): number | undefined {
  const value = lootTierEntry(campaign, tier)?.[key];
  return typeof value === 'number' ? value : undefined;
}

function lootTierRange(
  campaign: ResolvedCampaign,
  tier: number,
  key: string,
): [number, number] | undefined {
  const value = lootTierEntry(campaign, tier)?.[key];
  if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
    return undefined;
  }
  return [value[0], value[1]];
}

/** Behaviour comes from flags, and every flag here follows from the kind. */
function flagsFor(roll: ItemRoll): ObjectFlags {
  const kind = roll.base.kind;
  const flags: ObjectFlags = { takeable: true };
  if (kind === 'weapon') flags.weapon = true;
  if (kind === 'armour' || kind === 'shield') {
    flags.armour = true;
    flags.wearable = true;
  }
  if (kind === 'light') flags.lightSource = true;
  if (kind === 'consumable') flags.edible = true;
  if (roll.tags.includes('untradable')) flags.untradable = true;
  return flags;
}

/**
 * Turns of light. `DEPLETION_RATES` is the rule and wins; a base's own `burn`
 * covers a light the rates table has never heard of, and a Hooded lantern adds
 * its affix on top.
 */
function burnOf(campaign: ResolvedCampaign, roll: ItemRoll): number {
  if (roll.base.kind !== 'light') return 0;
  const rated = ruleAt(campaign.rules, `DEPLETION_RATES.${roll.base.id}`);
  const declared = (roll.base as { burn?: number }).burn;
  const base = typeof rated === 'number' ? rated : (declared ?? 0);
  return Math.max(0, base + (affixMods(roll.affixes)['burn'] ?? 0));
}

/** Sum a set of affixes. `priceMult` multiplies; everything else adds. */
export function affixMods(affixes: readonly AffixDef[]): Record<string, number> {
  const mods: Record<string, number> = {};
  for (const affix of affixes) {
    for (const [key, value] of Object.entries(affix.mods ?? {})) {
      mods[key] = key === 'priceMult' ? (mods[key] ?? 1) * value : (mods[key] ?? 0) + value;
    }
  }
  return mods;
}

const affixesById = (campaign: ResolvedCampaign, ids: readonly string[]): AffixDef[] => {
  const all = [...campaign.items.affixes.prefix, ...campaign.items.affixes.suffix];
  return ids.map((id) => all.find((affix) => affix.id === id)).filter((a): a is AffixDef => !!a);
};

/**
 * Every value the rules call derived, computed from `baseId + quality +
 * affixes[]`. Weapons and armour read their spine out of `WEAPON_TABLE` and
 * `ARMOUR_TABLE`; everything else carries `price` and `weight` on its base,
 * or a `priceFrom` path when its price is itself a rule.
 */
export function itemValues(
  campaign: ResolvedCampaign,
  object: Pick<ObjectRecord, 'baseId' | 'quality' | 'affixes'>,
): Record<string, number> {
  const rules = campaign.rules;
  const base = campaign.items.bases.find((entry) => entry.id === object.baseId);
  const quality = campaign.items.qualities.find((entry) => entry.id === object.quality);
  const mods = affixMods(affixesById(campaign, object.affixes));

  const spine =
    (ruleAt(rules, `WEAPON_TABLE.${object.baseId}`) as JsonObject | undefined) ??
    (ruleAt(rules, `ARMOUR_TABLE.${object.baseId}`) as JsonObject | undefined) ??
    {};

  const mult = quality?.mult ?? 1;
  const values: Record<string, number> = {};
  const scaled = (key: string): number | undefined => {
    const value = spine[key];
    return typeof value === 'number' ? value : undefined;
  };

  // `damage` on a weapon is a die string, not a number — `weaponDie` reads it.
  for (const key of ['penetration', 'reduction', 'penalty'] as const) {
    const value = scaled(key);
    if (value !== undefined) values[key] = Math.round(value * mult) + (mods[key] ?? 0);
  }
  values['weight'] = numberOrDefault(spine['weight'], (base as { weight?: number })?.weight ?? 0);
  values['price'] = priceOf(campaign, base, spine, quality?.priceMult ?? 1, mods);

  // Anything an affix adds that the spine never had — hp, evasion, allure —
  // still belongs in the answer, or a Bear-tagged hauberk quietly does nothing.
  for (const [key, value] of Object.entries(mods)) {
    if (key === 'priceMult' || key in values) continue;
    values[key] = value;
  }
  return values;
}

/**
 * What a base is worth before quality and affixes touch it — the same lookup
 * `itemValues` makes, asked of a base rather than of a made item, so a value
 * band can filter the pool before anything is rolled. No price is restated
 * here; it goes through `priceOf` exactly as a finished item's does.
 */
export function basePrice(campaign: ResolvedCampaign, base: ItemBaseDef): number {
  const spine =
    (ruleAt(campaign.rules, `WEAPON_TABLE.${base.id}`) as JsonObject | undefined) ??
    (ruleAt(campaign.rules, `ARMOUR_TABLE.${base.id}`) as JsonObject | undefined) ??
    {};
  return priceOf(campaign, base, spine, 1, {});
}

function priceOf(
  campaign: ResolvedCampaign,
  base: ItemBaseDef | undefined,
  spine: JsonObject,
  priceMult: number,
  mods: Record<string, number>,
): number {
  const fromRules = (base as { priceFrom?: string } | undefined)?.priceFrom;
  const listed =
    numberOrUndefined(spine['price']) ??
    numberOrUndefined((base as { price?: Json } | undefined)?.price) ??
    (fromRules ? ruleNumber(campaign.rules, fromRules) : undefined);
  if (listed === undefined) return 0;
  return Math.max(1, Math.round(listed * priceMult * (mods['priceMult'] ?? 1)));
}

/** The die a weapon rolls, straight from `WEAPON_TABLE`. Empty for anything else. */
export function weaponDie(campaign: ResolvedCampaign, baseId: string): string {
  const die = ruleAt(campaign.rules, `WEAPON_TABLE.${baseId}.damage`);
  return typeof die === 'string' ? die : '';
}

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const numberOrDefault = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;
