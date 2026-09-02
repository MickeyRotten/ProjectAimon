/**
 * Reading `rules.json`.
 *
 * The gameplay rules are the only place a formula, table, threshold or
 * constant is written down, and they are read at runtime. That rule is easy to
 * state and easy to break by accident: one `?? 1.4` in the generator and the
 * tuning knob in the table has quietly stopped working.
 *
 * These readers make the honest path the short one. A missing key throws with
 * the path it looked for, so a table that never got its value fails loudly at
 * generation instead of silently generating the wrong world. Where a key is
 * genuinely optional the caller passes a fallback and says so at the call site.
 */

import type { Json, JsonObject } from '../campaign/merge';

export class RuleError extends Error {
  constructor(readonly path: string, message: string) {
    super(`rules.json ${path}: ${message}`);
    this.name = 'RuleError';
  }
}

/** Walk a dotted path. Returns undefined when any step is missing. */
export function ruleAt(rules: JsonObject, path: string): Json | undefined {
  let node: Json | undefined = rules as Json;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as JsonObject)[key];
    if (node === undefined) return undefined;
  }
  return node;
}

function required(rules: JsonObject, path: string, fallback: Json | undefined): Json {
  const value = ruleAt(rules, path);
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new RuleError(path, 'missing, and the engine has no value of its own to use');
}

export function ruleNumber(rules: JsonObject, path: string, fallback?: number): number {
  const value = required(rules, path, fallback);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RuleError(path, `expected a number, found ${JSON.stringify(value)}`);
  }
  return value;
}

export function ruleString(rules: JsonObject, path: string, fallback?: string): string {
  const value = required(rules, path, fallback);
  if (typeof value !== 'string') {
    throw new RuleError(path, `expected a string, found ${JSON.stringify(value)}`);
  }
  return value;
}

export function ruleBool(rules: JsonObject, path: string, fallback?: boolean): boolean {
  const value = required(rules, path, fallback);
  if (typeof value !== 'boolean') {
    throw new RuleError(path, `expected true or false, found ${JSON.stringify(value)}`);
  }
  return value;
}

export function ruleArray(rules: JsonObject, path: string, fallback?: Json[]): Json[] {
  const value = required(rules, path, fallback);
  if (!Array.isArray(value)) {
    throw new RuleError(path, `expected an array, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** The string members of a rules array — `DEFEAT.lose`, `VENDORS.refusesTags`. */
export function ruleStrings(rules: JsonObject, path: string): string[] {
  return ruleArray(rules, path).filter((entry): entry is string => typeof entry === 'string');
}

export function ruleObject(rules: JsonObject, path: string, fallback?: JsonObject): JsonObject {
  const value = required(rules, path, fallback);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuleError(path, `expected an object, found ${JSON.stringify(value)}`);
  }
  return value;
}

/** A `[min, max]` pair, the shape every range in the tables uses. */
export function ruleRange(rules: JsonObject, path: string, fallback?: [number, number]): [number, number] {
  const value = ruleArray(rules, path, fallback as unknown as Json[] | undefined);
  const [lo, hi] = value;
  if (typeof lo !== 'number' || typeof hi !== 'number') {
    throw new RuleError(path, `expected [min, max], found ${JSON.stringify(value)}`);
  }
  return [lo, hi];
}

/** A `{ key: number }` table, e.g. `zOffsetByArchetype`. */
export function ruleNumberMap(
  rules: JsonObject,
  path: string,
  fallback?: Record<string, number>,
): Record<string, number> {
  const value = ruleObject(rules, path, fallback as unknown as JsonObject | undefined);
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    if (typeof entry !== 'number') {
      throw new RuleError(`${path}.${key}`, `expected a number, found ${JSON.stringify(entry)}`);
    }
    out[key] = entry;
  }
  return out;
}

/**
 * A weighted table written as `[[value, weight], ...]` — the shape
 * `DEPTH_TIER.jitter` and the crit and fumble tables use.
 */
export function ruleWeightedPairs(rules: JsonObject, path: string): { value: Json; w: number }[] {
  const rows = ruleArray(rules, path);
  return rows.map((row, i) => {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[1] !== 'number') {
      throw new RuleError(`${path}[${i}]`, `expected [value, weight], found ${JSON.stringify(row)}`);
    }
    return { value: row[0] as Json, w: row[1] };
  });
}

/**
 * Look a key up in a table that carries a `default` entry — the shape
 * `zSpanByArchetype` uses, where most archetypes want the same value and two
 * do not.
 */
export function ruleLookup(rules: JsonObject, path: string, key: string, fallbackKey = 'default'): number {
  const table = ruleNumberMap(rules, path);
  const value = table[key] ?? table[fallbackKey];
  if (value === undefined) {
    throw new RuleError(`${path}.${key}`, `no entry, and no "${fallbackKey}" to fall back to`);
  }
  return value;
}

/**
 * The hard tier ceiling for an area at this many gates from the Hub, from
 * `DEPTH_TIER.tierCeilByDepth`. The match is exact: a depth the table does not
 * name is uncapped and falls back to `DEPTH_TIER.max`, so the table reads as
 * "the first N steps out are held down" rather than as a curve of its own.
 *
 * It exists because the tier roll's jitter and spike, left alone, made a third
 * of first areas tier 2 or worse. Both the area roll and the per-room tier read
 * it, or the room bonus would climb straight back over it.
 */
export function depthTierCeil(rules: JsonObject, depth: number): number {
  const max = ruleNumber(rules, 'DEPTH_TIER.max');
  const table = ruleNumberMap(rules, 'DEPTH_TIER.tierCeilByDepth', {});
  return Math.min(max, table[String(depth)] ?? max);
}
