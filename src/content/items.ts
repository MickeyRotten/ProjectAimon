/**
 * Items — base × quality × affixes.
 *
 * Twenty-odd bases and twenty-two affixes produce thousands of distinct
 * results from a page of JSON, and that ratio is the entire reason there is no
 * editor. Nothing here is authored: the tables are, and this rolls them.
 *
 * **Every combat and price value is derived, never stored.** `itemValues`
 * computes them from `baseId` + `quality` + `affixes[]` on read, so retuning a
 * weapon in `rules.json` reaches every sword already lying in the world.
 */

import type { JsonObject } from '../campaign/merge';
import type { ItemBaseDef, QualityDef, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber, ruleObject, ruleRange } from '../engine/rules';
import { matches } from '../engine/tags';
import type { LocationRef, ObjectFlags, ObjectRecord } from './records';

export interface ItemRoll {
  /** Minted by the caller, because ids must be unique across the whole world. */
  id: string;
  tier: number;
  location: LocationRef;
  /** Roll among bases of this kind. Omitted, it rolls among takeable kinds. */
  kind?: string | undefined;
  /** Pin one base, the way the corpse placement rule pins `corpse`. */
  baseId?: string | undefined;
  /** Pin the quality, for things a quality roll would be nonsense on. */
  quality?: string | undefined;
  /** Extra tags, e.g. the starter kit's `untradable`. */
  tags?: readonly string[] | undefined;
}

/** Roll one object. Undefined when the tables hold nothing that fits. */
export function rollItem(
  rng: Rng,
  campaign: ResolvedCampaign,
  roll: ItemRoll,
): ObjectRecord | undefined {
  const base = roll.baseId ? baseById(campaign, roll.baseId) : rollBase(rng, campaign, roll.kind);
  if (!base) return undefined;

  const qualities = campaign.items.qualities ?? [];
  const quality =
    (roll.quality ? qualities.find((entry) => entry.id === roll.quality) : undefined) ??
    rollQuality(rng, campaign, roll.tier);
  if (!quality) return undefined;

  // Affixes filter on the base's kind and the quality's tags, so `Reinforced`
  // only lands on armour and `Hooded` only on lights.
  const filterTags = [base.kind, ...(quality.tags ?? [])];
  const pools = [campaign.items.affixes?.prefix ?? [], campaign.items.affixes?.suffix ?? []];
  const chosen: { slot: number; id: string; name: string }[] = [];
  for (let i = 0; i < (quality.affixes ?? 0); i++) {
    const slot = i % pools.length;
    const fitting = (pools[slot] ?? []).filter((affix) => matches(filterTags, affix.requires));
    const affix = rng.maybeWeighted(fitting);
    if (affix) chosen.push({ slot, id: affix.id, name: affix.name });
  }

  const adjective = rng.maybePick(base.adjectives ?? []) ?? '';
  const noun = rng.maybePick(base.nouns ?? []) ?? base.id;
  const name = [
    chosen.find((affix) => affix.slot === 0)?.name,
    quality.id === defaultQuality(campaign) ? adjective : quality.id,
    noun,
    chosen.find((affix) => affix.slot === 1)?.name,
  ]
    .filter((part) => part && part.length > 0)
    .join(' ');

  return {
    campaignId: campaign.id,
    id: roll.id,
    name,
    nouns: [...(base.nouns ?? [])],
    adjectives: [...new Set([...(base.adjectives ?? []), quality.id])],
    location: roll.location,
    desc: '',
    tags: [...new Set([base.kind, quality.id, ...(roll.tags ?? [])])],
    baseId: base.id,
    quality: quality.id,
    affixes: chosen.map((affix) => affix.id),
    flags: flagsOf(campaign, base.kind),
    condition: ruleNumber(campaign.rules, 'GOLD_SINKS.repair.conditionMax'),
    burnRemaining: burnOf(campaign, base.id),
    gold: 0,
  };
}

/** A pile of coin, sized by the area's loot tier. */
export function rollGold(rng: Rng, campaign: ResolvedCampaign, tier: number): number {
  const [lo, hi] = lootTier(campaign, tier).goldRange;
  return rng.int(lo, hi);
}

/**
 * The quality roll, shifted by the area's tier.
 *
 * The base weights sum to 100, so `qualityBias` is points on a d100 — bias 18
 * shifts every result 18 points up the table. Scaling by the table's own total
 * keeps that true for a campaign whose weights sum to something else.
 */
export function rollQuality(rng: Rng, campaign: ResolvedCampaign, tier: number): QualityDef | undefined {
  const qualities = campaign.items.qualities ?? [];
  const total = qualities.reduce((sum, quality) => sum + Math.max(0, quality.w ?? 1), 0);
  if (total <= 0) return undefined;

  const bias = (lootTier(campaign, tier).qualityBias * total) / 100;
  let roll = rng.next() * total + bias;
  let last: QualityDef | undefined;
  for (const quality of qualities) {
    const w = Math.max(0, quality.w ?? 1);
    if (w <= 0) continue;
    last = quality;
    roll -= w;
    if (roll < 0) return quality;
  }
  return last;
}

export interface ItemValues {
  /** The weapon die, as written in the table. Empty when it is not a weapon. */
  damage: string;
  penetration: number;
  reduction: number;
  penalty: number;
  price: number;
  weight: number;
  /** Everything the affixes moved, `damage` and `accuracy` included. */
  mods: Record<string, number>;
}

/**
 * Derive an object's numbers. Read it; never store what it returns.
 *
 * Quality's `mult` scales what the base table gives, affixes add on top, and
 * `priceMult` multiplies rather than adds — which is what keeps a masterwork
 * heirloom worth a fortune and a crude notched club worth almost nothing.
 */
export function itemValues(campaign: ResolvedCampaign, object: ObjectRecord): ItemValues {
  const rules = campaign.rules;
  const weapon = ruleAt(rules, `WEAPON_TABLE.${object.baseId}`) as JsonObject | undefined;
  const armour = ruleAt(rules, `ARMOUR_TABLE.${object.baseId}`) as JsonObject | undefined;
  const stat = (weapon ?? armour ?? {}) as Record<string, unknown>;
  const base = baseById(campaign, object.baseId);
  const quality = (campaign.items.qualities ?? []).find((entry) => entry.id === object.quality);
  const mult = quality?.mult ?? 1;

  const mods: Record<string, number> = {};
  const pools = [campaign.items.affixes?.prefix ?? [], campaign.items.affixes?.suffix ?? []];
  for (const affixId of object.affixes) {
    const affix = pools.flat().find((entry) => entry.id === affixId);
    if (!affix) continue;
    for (const [key, value] of Object.entries(affix.mods ?? {})) {
      mods[key] = key === 'priceMult' ? (mods[key] ?? 1) * value : (mods[key] ?? 0) + value;
    }
  }

  const number = (key: string): number => (typeof stat[key] === 'number' ? (stat[key] as number) : 0);
  const basePrice = number('price') || fixedPrice(campaign, object.baseId) || (base?.price ?? 0);
  const baseWeight = number('weight') || (base?.weight ?? 0);

  return {
    damage: typeof stat['damage'] === 'string' ? (stat['damage'] as string) : '',
    penetration: Math.round(number('penetration') * mult + (mods['penetration'] ?? 0)),
    reduction: Math.round(number('reduction') * mult + (mods['reduction'] ?? 0)),
    // Penalty is a cost, so quality lightens it rather than multiplying it up.
    penalty: Math.round(number('penalty') / (mult || 1) + (mods['penalty'] ?? 0)),
    price: Math.max(
      0,
      Math.round(basePrice * (quality?.priceMult ?? 1) * (mods['priceMult'] ?? 1)),
    ),
    weight: baseWeight,
    mods,
  };
}

export const baseById = (campaign: ResolvedCampaign, id: string): ItemBaseDef | undefined =>
  (campaign.items.bases ?? []).find((base) => base.id === id);

/** Every kind whose flags make it takeable — what loose loot rolls among. */
export function takeableKinds(campaign: ResolvedCampaign): Set<string> {
  const table = kindFlagTable(campaign);
  return new Set(
    Object.entries(table)
      .filter(([kind, flags]) => !kind.startsWith('_') && (flags as JsonObject)?.['takeable'] === true)
      .map(([kind]) => kind),
  );
}

/** The flags a kind carries, read from the table and never invented here. */
export function flagsOf(campaign: ResolvedCampaign, kind: string): ObjectFlags {
  const declared = kindFlagTable(campaign)[kind];
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return {};
  return { ...(declared as ObjectFlags) };
}

// ── the pieces ──────────────────────────────────────────────────────

function rollBase(rng: Rng, campaign: ResolvedCampaign, kind: string | undefined): ItemBaseDef | undefined {
  const takeable = takeableKinds(campaign);
  const pool = (campaign.items.bases ?? []).filter((base) =>
    kind ? base.kind === kind : takeable.has(base.kind),
  );
  return rng.maybeWeighted(pool);
}

/** Whichever quality the table calls unremarkable — the one that shows an adjective. */
function defaultQuality(campaign: ResolvedCampaign): string {
  const qualities = campaign.items.qualities ?? [];
  const plain = qualities.find((quality) => quality.mult === 1 && quality.priceMult === 1);
  return (plain ?? qualities[0])?.id ?? '';
}

/** Turns of light, from the rules. A second copy on the base would drift. */
function burnOf(campaign: ResolvedCampaign, baseId: string): number {
  const rate = ruleAt(campaign.rules, `DEPLETION_RATES.${baseId}`);
  return typeof rate === 'number' ? rate : 0;
}

/** A price the rules fix outright, like the Hub-return consumable's. */
function fixedPrice(campaign: ResolvedCampaign, baseId: string): number {
  if (ruleAt(campaign.rules, 'FAST_TRAVEL.itemId') !== baseId) return 0;
  const price = ruleAt(campaign.rules, 'FAST_TRAVEL.price');
  return typeof price === 'number' ? price : 0;
}

const kindFlagTable = (campaign: ResolvedCampaign): JsonObject =>
  (campaign.items.kindFlags ?? {}) as unknown as JsonObject;

/**
 * The loot tier's row, clamped to what the table actually defines. An area may
 * roll tier 5 in a campaign whose loot table stops at 3, and the deepest row is
 * a better answer than a crash.
 */
export function lootTier(
  campaign: ResolvedCampaign,
  tier: number,
): { qualityBias: number; goldRange: [number, number] } {
  const table = campaign.items.lootTiers ?? {};
  const tiers = Object.keys(table)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter((key) => Number.isFinite(key))
    .sort((a, b) => a - b);
  if (tiers.length === 0) {
    throw new Error('content/items.json lootTiers: no tiers, so nothing can be rolled');
  }
  const first = tiers[0] as number;
  const last = tiers[tiers.length - 1] as number;
  const key = String(Math.max(first, Math.min(last, Math.round(tier))));
  const row = ruleObject(table as unknown as JsonObject, key);
  return {
    qualityBias: ruleNumber(row, 'qualityBias', 0),
    goldRange: ruleRange(row, 'goldRange'),
  };
}
