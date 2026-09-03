/**
 * The tag system — the entire intelligence layer, and the only one.
 *
 * A room is a bag of tags. Every table declares a `requires[]` and is rolled
 * against candidates that satisfy it. Nothing else decides what goes where, so
 * a new content type needs a table, not engine code.
 *
 *   requires: ["indoor"]              must have
 *   requires: ["dark|wild"]           must have at least one
 *   requires: ["outdoor","!water"]    must have, must not have
 *
 * `tags.json` is the closed vocabulary. A tag that is not in it is a typo, and
 * a typo in a `requires[]` is a rule that quietly never fires — the most likely
 * content bug in the project and the one hardest to notice in play. Validation
 * against this vocabulary is what turns it into a loud failure at load.
 */

import type { Rng, Weighted } from './rng';

/** One alternative inside a requirement term. `!water` is `water`, negated. */
export interface TagAlternative {
  readonly tag: string;
  readonly negated: boolean;
}

/** One entry of a `requires[]`. Passes when any alternative passes. */
export interface Requirement {
  readonly source: string;
  readonly alternatives: readonly TagAlternative[];
}

/** A compiled `requires[]`. Passes when every requirement passes. */
export type Requires = readonly Requirement[];

/** Anything a table can roll that declares a tag filter. */
export interface TagFiltered {
  requires?: readonly string[] | undefined;
}

const EMPTY: Requires = [];

/** Compile one `requires[]` term. */
export function parseRequirement(term: string): Requirement {
  const alternatives = term
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) =>
      part.startsWith('!')
        ? { tag: part.slice(1), negated: true }
        : { tag: part, negated: false },
    );
  return { source: term, alternatives };
}

/** Compile a whole `requires[]`. */
export function parseRequires(requires: readonly string[] | undefined): Requires {
  if (!requires || requires.length === 0) return EMPTY;
  return requires.map(parseRequirement);
}

/** Does this bag of tags satisfy one compiled requirement? */
export function satisfiesRequirement(tags: readonly string[], req: Requirement): boolean {
  if (req.alternatives.length === 0) return true;
  return req.alternatives.some((alt) =>
    alt.negated ? !tags.includes(alt.tag) : tags.includes(alt.tag),
  );
}

/** Does this bag of tags satisfy a compiled `requires[]`? */
export function satisfies(tags: readonly string[], requires: Requires): boolean {
  return requires.every((req) => satisfiesRequirement(tags, req));
}

/**
 * Does this bag of tags satisfy a raw `requires[]`? Convenient for one-off
 * checks; compile with `parseRequires` when filtering a table repeatedly.
 */
export function matches(tags: readonly string[], requires: readonly string[] | undefined): boolean {
  return satisfies(tags, parseRequires(requires));
}

/** Every entry of a table whose `requires[]` the tags satisfy. */
export function filterByTags<T extends TagFiltered>(
  items: readonly T[],
  tags: readonly string[],
): T[] {
  return items.filter((item) => matches(tags, item.requires));
}

/**
 * Roll one entry from a weighted table, considering only entries whose
 * `requires[]` the tags satisfy. Returns undefined when nothing fits — which
 * is a normal outcome, not an error: a shrine room simply has no hostile that
 * belongs in it.
 */
export function rollByTags<T extends TagFiltered & Weighted>(
  rng: Rng,
  items: readonly T[],
  tags: readonly string[],
): T | undefined {
  return rng.maybeWeighted(filterByTags(items, tags));
}

/** The closed tag vocabulary, read from `tags.json`. */
export class TagVocabulary {
  /** tag -> "room.light", "creature.taxonomy", ... */
  private readonly namespaces = new Map<string, string>();
  /** tag -> its one-line description. */
  private readonly descriptions = new Map<string, string>();

  /**
   * Builds from the nested shape of `tags.json`: a plain object whose values
   * are all strings is a category — its keys are tags, its values their
   * descriptions, and its path is the namespace. Every other object is a
   * namespace group to recurse into. Keys starting with `_` are notes, and
   * `operators` documents the matcher rather than declaring tags — both are
   * skipped.
   */
  constructor(source: unknown) {
    this.collect(source, []);
  }

  private collect(node: unknown, path: readonly string[]): void {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const entries = Object.entries(node as Record<string, unknown>);
    const isCategory = entries.length > 0 && entries.every(([, value]) => typeof value === 'string');
    if (isCategory) {
      const namespace = path.join('.');
      for (const [tag, description] of entries) {
        if (!this.namespaces.has(tag)) {
          this.namespaces.set(tag, namespace);
          this.descriptions.set(tag, description as string);
        }
      }
      return;
    }
    for (const [key, value] of entries) {
      if (key.startsWith('_')) continue;
      if (path.length === 0 && key === 'operators') continue;
      this.collect(value, [...path, key]);
    }
  }

  has(tag: string): boolean {
    return this.namespaces.has(tag);
  }

  namespaceOf(tag: string): string | undefined {
    return this.namespaces.get(tag);
  }

  /** The tag's one-line description, if it has one. */
  descriptionOf(tag: string): string | undefined {
    return this.descriptions.get(tag);
  }

  all(): string[] {
    return [...this.namespaces.keys()].sort();
  }

  size(): number {
    return this.namespaces.size;
  }

  /** Every tag in one namespace, e.g. "room.light". */
  inNamespace(namespace: string): string[] {
    return [...this.namespaces.entries()]
      .filter(([, ns]) => ns === namespace)
      .map(([tag]) => tag)
      .sort();
  }

  /**
   * Nearest known tags to an unknown one, so a typo reports "did you mean".
   * Cheap Levenshtein over a vocabulary of a hundred or so entries.
   */
  suggest(tag: string, limit = 3): string[] {
    return this.all()
      .map((known) => ({ known, distance: editDistance(tag, known) }))
      .filter(({ known, distance }) => distance <= Math.max(2, Math.floor(known.length / 3)))
      .sort((a, b) => a.distance - b.distance || a.known.localeCompare(b.known))
      .slice(0, limit)
      .map(({ known }) => known);
  }
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (row[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}
