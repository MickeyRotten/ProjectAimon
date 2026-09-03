/**
 * The shape of `tags.json`, as the editor needs to understand it.
 *
 * `tags.json` stopped being arrays of tag names and became objects mapping each
 * tag to a one-line description (TODO.md task 10). The generic renderer copes —
 * an object of strings is a list of labelled text fields — but it loses the
 * add/remove affordance the old string-array rows had, and it treats the tag
 * *name* as a structural key rather than as data the designer edits. This
 * module is the small amount of pure logic a purpose-built tag editor needs,
 * kept out of the DOM so it can be tested.
 *
 * The category rule here is deliberately the same one `TagVocabulary` uses when
 * it reads the file at runtime: a non-empty object whose values are all strings
 * is a category, its keys are tags, its path is the namespace — with `_`-noted
 * keys and the top-level `operators` block (documentation of the matcher, not a
 * vocabulary) skipped. If the two ever disagreed, the editor would offer to
 * edit tags the engine does not read.
 */

/** A category: tag name -> its one-line description. */
export type TagCategory = Record<string, string>;

/** A key the vocabulary ignores: a `_note`, or the top-level operators block. */
export function isSkippedTagKey(key: string, parentPath: readonly string[]): boolean {
  if (key.startsWith('_')) return true;
  return parentPath.length === 0 && key === 'operators';
}

/** A non-empty object whose every value is a string — the vocabulary's own rule. */
export function isTagCategory(value: unknown): value is TagCategory {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([, v]) => typeof v === 'string');
}

/**
 * Every tag declared in a `tags.json`, mapped to the namespaces declaring it.
 * A tag with more than one namespace is a real bug and an invisible one:
 * `TagVocabulary` keeps the first it meets and silently drops the rest, so the
 * second declaration's description never appears anywhere.
 */
export function tagOwners(tags: unknown): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const walk = (node: unknown, path: readonly string[]): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if (isTagCategory(node)) {
      const namespace = path.join('.');
      for (const tag of Object.keys(node)) {
        const seen = owners.get(tag);
        if (seen) seen.push(namespace);
        else owners.set(tag, [namespace]);
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isSkippedTagKey(key, path)) continue;
      walk(value, [...path, key]);
    }
  };
  walk(tags, []);
  return owners;
}

/** Tags declared in more than one namespace — all but the first are dead. */
export function duplicateTags(tags: unknown): Set<string> {
  const dupes = new Set<string>();
  for (const [tag, namespaces] of tagOwners(tags)) {
    if (namespaces.length > 1) dupes.add(tag);
  }
  return dupes;
}

/** Why a proposed tag name cannot be used, or null when it can. */
export function rejectTagName(
  proposed: string,
  currentName: string,
  tags: unknown,
): string | null {
  const name = proposed.trim();
  if (name === currentName) return null;
  if (name.length === 0) return 'a tag needs a name';
  if (name !== proposed) return 'a tag name cannot start or end with a space';
  if (/[\s|!]/.test(name)) return 'a tag name cannot contain a space, "|" or "!" — those are requires[] operators';
  const owner = tagOwners(tags).get(name);
  if (owner) return `"${name}" is already a tag in ${owner[0] || 'the vocabulary'}`;
  return null;
}

/** Rename a key without moving it — the file's tag order is meaningful to read. */
export function renameKeyInPlace(record: Record<string, string>, from: string, to: string): void {
  if (from === to || !(from in record)) return;
  const entries = Object.entries(record);
  for (const [key] of entries) delete record[key];
  for (const [key, value] of entries) record[key === from ? to : key] = value;
}

/** A name not yet taken anywhere in the vocabulary, for a freshly added row. */
export function freshTagName(tags: unknown, stem = 'new-tag'): string {
  const owners = tagOwners(tags);
  if (!owners.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}`;
    if (!owners.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Where a tag is used — the delete guard, and the tooltips
// ---------------------------------------------------------------------------

/** Keys whose value is a bag of tags — a plain list, no operators. */
export const TAG_LIST_KEYS: ReadonlySet<string> = new Set(['tags', 'areaTags', 'excludeTags']);
/** Keys whose value is a `requires[]` — tags with `!` and `|` operators. */
export const REQUIRES_KEYS: ReadonlySet<string> = new Set(['requires', 'targetTags']);
/** Keys whose value is a single tag. */
export const SINGLE_TAG_KEYS: ReadonlySet<string> = new Set(['kind', 'itemKind']);

/**
 * Every key whose strings are tag terms. Anything nested under one of these is
 * read as a `requires[]` term: a bare tag, `!tag`, or `a|b` alternatives.
 */
export const TAG_BEARING_KEYS: ReadonlySet<string> = new Set([
  ...TAG_LIST_KEYS, ...REQUIRES_KEYS, ...SINGLE_TAG_KEYS,
]);

/** The tags one `requires[]` term names, operators stripped. */
export function termTags(term: string): string[] {
  return term
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith('!') ? part.slice(1) : part))
    .filter((part) => part.length > 0);
}

/** One place a tag is referenced, addressed the way the validator addresses fields. */
export interface TagUsage {
  /** The editor file the reference lives in. */
  readonly file: string;
  /** Field path within that file, e.g. `roomTypes.taproom.requires[0]`. */
  readonly path: string;
  /** The term as written, so `!dark` reads differently from `dark`. */
  readonly term: string;
}

/**
 * Every reference to a tag across the loaded files. Used to guard a delete:
 * removing a tag that three tables still filter on turns those filters into
 * rules that quietly never fire, which is the exact bug class the closed
 * vocabulary exists to prevent. Listing the uses lets the designer decide
 * rather than discovering it in play.
 *
 * Only strings under a tag-bearing key are read, so an item happening to be
 * *named* "key" is not mistaken for a use of the `key` tag.
 */
export function findTagUsages(
  files: ReadonlyMap<string, unknown>,
  tag: string,
  skipFile?: string,
): TagUsage[] {
  const usages: TagUsage[] = [];
  const walk = (node: unknown, file: string, path: string, inTagField: boolean): void => {
    if (typeof node === 'string') {
      if (inTagField && termTags(node).includes(tag)) usages.push({ file, path, term: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, file, `${path}[${i}]`, inTagField));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, file, path ? `${path}.${key}` : key, inTagField || TAG_BEARING_KEYS.has(key));
    }
  };
  for (const [file, value] of files) {
    if (file === skipFile) continue;
    walk(value, file, '', false);
  }
  return usages;
}
