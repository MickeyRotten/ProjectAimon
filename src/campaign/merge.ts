/**
 * Campaign layering — a campaign overrides, it never redefines.
 *
 *   resolved = merge(base, campaign)     per file, per key, campaign wins
 *
 *   | Primitives      | Campaign wins            |
 *   | Objects         | Deep merge               |
 *   | Arrays          | Replace entirely         |
 *   | Arrays, append  | "+affixes": [...]        |
 *
 * Arrays replace by default because appending would mean a campaign could
 * never *remove* a base entry — it could only ever add. The `+key` prefix
 * covers the common case of extending a list without restating it.
 *
 * Without this, a second setting means restating every rule and prompt you did
 * not want to change, and the two drift apart the first time anything is tuned.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Something the merge could not do, reported rather than thrown. */
export interface MergeIssue {
  readonly path: string;
  readonly message: string;
}

export interface MergeResult<T> {
  readonly value: T;
  readonly issues: readonly MergeIssue[];
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge an override layer over a base layer.
 *
 * `null` in the override is a value, not a deletion — `"sexOverride": null` in
 * the base area files is a real setting, and giving null a second meaning would
 * make it impossible to write.
 *
 * When a layer supplies both `key` and `+key`, `key` replaces first and `+key`
 * appends to that result. Order is fixed so the outcome never depends on how
 * the JSON happened to be keyed.
 */
export function mergeLayer<T extends Json>(base: Json, override: Json): MergeResult<T> {
  const issues: MergeIssue[] = [];
  const value = mergeNode(base, override, '', issues) as T;
  return { value, issues };
}

/** Merge any number of layers left to right, each overriding the last. */
export function mergeLayers<T extends Json>(...layers: readonly Json[]): MergeResult<T> {
  const issues: MergeIssue[] = [];
  let acc: Json = layers.length > 0 ? (layers[0] as Json) : null;
  for (let i = 1; i < layers.length; i++) {
    acc = mergeNode(acc, layers[i] as Json, '', issues);
  }
  return { value: acc as T, issues };
}

function mergeNode(base: Json, override: Json, path: string, issues: MergeIssue[]): Json {
  if (override === undefined) return base;

  // Deep merge is only ever between two plain objects. Anything else — a
  // primitive over an object, an array over anything — is a replacement.
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(base)) out[key] = clone(value);

  // Replacements first, so a "+key" alongside a "key" appends to the new list
  // rather than to the base one.
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('+')) continue;
    const childPath = path ? `${path}.${key}` : key;
    out[key] = mergeNode(out[key] ?? null, value, childPath, issues);
  }

  for (const [key, value] of Object.entries(override)) {
    if (!key.startsWith('+')) continue;
    const target = key.slice(1);
    const childPath = path ? `${path}.${key}` : key;

    if (!Array.isArray(value)) {
      issues.push({ path: childPath, message: `"${key}" appends, so its value must be an array` });
      continue;
    }

    const existing = out[target];
    if (existing === undefined || existing === null) {
      out[target] = clone(value) as Json[];
      continue;
    }
    if (!Array.isArray(existing)) {
      issues.push({
        path: childPath,
        message: `cannot append to "${target}": it is ${describe(existing)}, not an array`,
      });
      continue;
    }
    out[target] = [...existing, ...(clone(value) as Json[])];
  }

  return out;
}

function clone(value: Json): Json {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) out[key] = clone(child);
    return out;
  }
  return value;
}

function describe(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * Strip `_note`-style annotation keys. The tables are the authoring surface,
 * so they carry explanatory keys throughout; nothing downstream should have to
 * remember to skip them.
 */
export function withoutNotes<T extends Json>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withoutNotes(v)) as T;
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      out[key] = withoutNotes(child);
    }
    return out as T;
  }
  return value;
}
