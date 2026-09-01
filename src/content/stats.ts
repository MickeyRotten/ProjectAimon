/**
 * Attributes, and the values derived from them.
 *
 * The derived block lives in `rules.json` under `DERIVED`, because a formula
 * written in the engine is a tuning knob nobody can turn: raising HP per point
 * of Toughness has to reach every creature already standing in the world, and
 * it only can if the value is read at the moment it is used.
 *
 * Nothing derived is ever stored on a player record. Creatures are the stated
 * exception — they store final values and skip weapon-skill and
 * armour-expertise maths entirely — so this module is where they get them.
 */

import type { Json, JsonObject } from '../campaign/merge';
import type { Rng } from '../engine/rng';
import { RuleError, ruleArray, ruleNumber, ruleString } from '../engine/rules';
import type { Attributes } from '../world/types';

export const ATTRIBUTE_KEYS = [
  'brawn',
  'agility',
  'toughness',
  'charisma',
  'willpower',
  'wits',
] as const;

/** The attribute list as the rules declare it, not as the engine assumes it. */
export function attributeNames(rules: JsonObject): string[] {
  return ruleArray(rules, 'STAT_ROLL.attributes').filter(
    (name): name is string => typeof name === 'string',
  );
}

const emptyAttributes = (): Attributes => ({
  brawn: 0,
  agility: 0,
  toughness: 0,
  charisma: 0,
  willpower: 0,
  wits: 0,
});

const isAttribute = (key: string): key is keyof Attributes =>
  (ATTRIBUTE_KEYS as readonly string[]).includes(key);

/** Roll a full set the way a character is rolled: `STAT_ROLL.dice`d`sides`. */
export function rollAttributes(rng: Rng, rules: JsonObject): Attributes {
  const dice = ruleNumber(rules, 'STAT_ROLL.dice');
  const sides = ruleNumber(rules, 'STAT_ROLL.sides');
  const out = emptyAttributes();
  for (const name of attributeNames(rules)) {
    if (isAttribute(name)) out[name] = rng.dice(`${dice}d${sides}`);
  }
  return out;
}

/**
 * Roll a creature's set: the tier mean, give or take the spread. Creatures do
 * not roll 3d8 — their curve is the one thing area tier is for.
 */
export function rollAroundMean(
  rng: Rng,
  rules: JsonObject,
  mean: number,
  spread: number,
): Attributes {
  const out = emptyAttributes();
  for (const name of attributeNames(rules)) {
    if (isAttribute(name)) out[name] = mean + rng.int(-spread, spread);
  }
  return out;
}

/** Add a table's `mods` block to a set of attributes. Non-attribute keys are ignored. */
export function applyAttributeMods(
  stats: Attributes,
  mods: Readonly<Record<string, number>> | undefined,
): Attributes {
  if (!mods) return stats;
  const out = { ...stats };
  for (const [key, value] of Object.entries(mods)) {
    if (isAttribute(key)) out[key] += value;
  }
  return out;
}

/** Nothing may fall below 1: a zero attribute divides by nothing and reads as dead. */
export const floorAttributes = (stats: Attributes): Attributes => {
  const out = { ...stats };
  for (const key of ATTRIBUTE_KEYS) out[key] = Math.max(1, Math.round(out[key]));
  return out;
};

export const deriveHp = (rules: JsonObject, toughness: number): number =>
  Math.max(1, Math.round(toughness * ruleNumber(rules, 'DERIVED.hpPerToughness')));

export const deriveResolve = (rules: JsonObject, willpower: number): number =>
  Math.max(1, Math.round(willpower * ruleNumber(rules, 'DERIVED.resolvePerWillpower')));

export const deriveCarry = (rules: JsonObject, brawn: number): number =>
  Math.round(brawn * ruleNumber(rules, 'DERIVED.carryPerBrawn'));

export const deriveEvasion = (rules: JsonObject, agility: number): number =>
  Math.round(agility * ruleNumber(rules, 'DERIVED.evasionPerAgility'));

export const deriveAccuracy = (rules: JsonObject, agility: number): number =>
  Math.round(agility * ruleNumber(rules, 'DERIVED.accuracyPerAgility'));

export const deriveCrit = (rules: JsonObject, wits: number): number =>
  Math.max(0, Math.round(wits * ruleNumber(rules, 'DERIVED.critPerWits')));

export const derivePresence = (rules: JsonObject, charisma: number): number =>
  Math.round(charisma * ruleNumber(rules, 'DERIVED.presencePerCharisma'));

export const deriveRapport = (rules: JsonObject, charisma: number): number =>
  Math.round(charisma * ruleNumber(rules, 'DERIVED.rapportPerCharisma'));

export const deriveComposure = (rules: JsonObject, willpower: number): number =>
  Math.round(willpower * ruleNumber(rules, 'DERIVED.composurePerWillpower'));

/** `floor((attribute - offset) / div)` — the shape both bonus rules share. */
export function deriveBonus(rules: JsonObject, path: string, stats: Attributes): number {
  const from = ruleString(rules, `${path}.from`);
  const offset = ruleNumber(rules, `${path}.offset`);
  const div = ruleNumber(rules, `${path}.div`);
  if (!isAttribute(from)) throw new RuleError(`${path}.from`, `"${from}" is not an attribute`);
  return Math.floor((stats[from] - offset) / div);
}

/** The Libido band a value falls in — its name and its Allure/Composure swing. */
export interface LibidoBand {
  name: string;
  allure: number;
  composure: number;
}

export function libidoBand(rules: JsonObject, libido: number): LibidoBand {
  const bands = ruleArray(rules, 'LIBIDO_BANDS');
  for (const entry of bands) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const band = entry as Record<string, Json>;
    const range = band['range'];
    if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') continue;
    if (libido >= range[0] && libido <= range[1]) {
      return {
        name: typeof band['name'] === 'string' ? band['name'] : '',
        allure: typeof band['allure'] === 'number' ? band['allure'] : 0,
        composure: typeof band['composure'] === 'number' ? band['composure'] : 0,
      };
    }
  }
  return { name: '', allure: 0, composure: 0 };
}

export const deriveDamageBonus = (rules: JsonObject, stats: Attributes): number =>
  deriveBonus(rules, 'DERIVED.damageBonus', stats);

export const derivePressureBonus = (rules: JsonObject, stats: Attributes): number =>
  deriveBonus(rules, 'DERIVED.pressureBonus', stats);
