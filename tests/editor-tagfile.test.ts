import { describe, expect, it } from 'vitest';
import { bundledSource } from '../src/campaign/source';
import { TagVocabulary } from '../src/engine/tags';
import {
  duplicateTags,
  findTagUsages,
  freshTagName,
  isSkippedTagKey,
  isTagCategory,
  rejectTagName,
  renameKeyInPlace,
  tagOwners,
  termTags,
  TAG_BEARING_KEYS,
} from '../src/editor/tagfile';

/**
 * The editor's tag-file logic. The load-bearing test is the first one: if the
 * editor's idea of "a category" ever drifts from `TagVocabulary`'s, it starts
 * offering to edit tags the engine does not read, or hiding ones it does.
 */

async function baseTags(): Promise<unknown> {
  const tags = await bundledSource('base').read('tags.json');
  if (tags === undefined) throw new Error('tags.json missing from the base bundle');
  return tags;
}

describe('category detection agrees with the engine', () => {
  it('finds exactly the tags TagVocabulary reads', async () => {
    const tags = await baseTags();
    const vocabulary = new TagVocabulary(tags);
    expect([...tagOwners(tags).keys()].sort()).toEqual(vocabulary.all());
  });

  it('namespaces every tag the way the vocabulary does', async () => {
    const tags = await baseTags();
    const vocabulary = new TagVocabulary(tags);
    for (const [tag, owners] of tagOwners(tags)) {
      expect(owners[0]).toBe(vocabulary.namespaceOf(tag));
    }
  });

  it('skips notes and the top-level operators block, as the vocabulary does', () => {
    expect(isSkippedTagKey('_note', [])).toBe(true);
    expect(isSkippedTagKey('operators', [])).toBe(true);
    // Only at the top level — a nested "operators" namespace would be real.
    expect(isSkippedTagKey('operators', ['room'])).toBe(false);
    expect(isSkippedTagKey('light', ['room'])).toBe(false);
  });

  it('calls a non-empty all-strings object a category, and nothing else', () => {
    expect(isTagCategory({ lit: 'bright', dark: 'not' })).toBe(true);
    expect(isTagCategory({})).toBe(false);
    expect(isTagCategory({ room: { lit: 'bright' } })).toBe(false);
    expect(isTagCategory(['lit', 'dark'])).toBe(false);
    expect(isTagCategory(null)).toBe(false);
  });

  it('reports no duplicate declarations in the base vocabulary', async () => {
    expect([...duplicateTags(await baseTags())]).toEqual([]);
  });

  it('catches a tag declared twice — the second is dead weight in the engine', () => {
    const tags = { room: { light: { dark: 'a' } }, creature: { mind: { dark: 'b' } } };
    expect([...duplicateTags(tags)]).toEqual(['dark']);
    // And the engine really does drop the second: same tag, first namespace.
    expect(new TagVocabulary(tags).namespaceOf('dark')).toBe('room.light');
  });
});

describe('renaming a tag', () => {
  const tags = () => ({ room: { light: { lit: 'a', dim: 'b', dark: 'c' } } });

  it('accepts a name nothing else claims', () => {
    expect(rejectTagName('gloomy', 'dim', tags())).toBeNull();
  });

  it('accepts the name it already has', () => {
    expect(rejectTagName('dim', 'dim', tags())).toBeNull();
  });

  it('refuses a collision, naming where the tag already lives', () => {
    expect(rejectTagName('dark', 'dim', tags())).toBe('"dark" is already a tag in room.light');
  });

  it('refuses a blank name, whitespace padding, and requires[] operators', () => {
    expect(rejectTagName('', 'dim', tags())).toBe('a tag needs a name');
    expect(rejectTagName('   ', 'dim', tags())).toBe('a tag needs a name');
    expect(rejectTagName(' dim2', 'dim', tags())).toContain('cannot start or end with a space');
    expect(rejectTagName('half lit', 'dim', tags())).toContain('cannot contain a space');
    expect(rejectTagName('!dim', 'dim', tags())).toContain('cannot contain a space');
    expect(rejectTagName('a|b', 'dim', tags())).toContain('cannot contain a space');
  });

  it('keeps the tag in place — order in the file is how it is read', () => {
    const category: Record<string, string> = { lit: 'a', dim: 'b', dark: 'c' };
    renameKeyInPlace(category, 'dim', 'gloomy');
    expect(Object.keys(category)).toEqual(['lit', 'gloomy', 'dark']);
    expect(category['gloomy']).toBe('b');
  });

  it('is a no-op for an unknown or unchanged key', () => {
    const category: Record<string, string> = { lit: 'a' };
    renameKeyInPlace(category, 'nope', 'x');
    renameKeyInPlace(category, 'lit', 'lit');
    expect(category).toEqual({ lit: 'a' });
  });
});

describe('a fresh tag name', () => {
  it('takes the stem when it is free, then numbers off it', () => {
    expect(freshTagName({ room: { light: { lit: 'a' } } })).toBe('new-tag');
    expect(freshTagName({ room: { light: { 'new-tag': 'a' } } })).toBe('new-tag-2');
    expect(freshTagName({ room: { light: { 'new-tag': 'a', 'new-tag-2': 'b' } } })).toBe('new-tag-3');
  });
});

describe('finding where a tag is used', () => {
  it('reads operators off a requires[] term', () => {
    expect(termTags('indoor')).toEqual(['indoor']);
    expect(termTags('!water')).toEqual(['water']);
    expect(termTags('dark|wild')).toEqual(['dark', 'wild']);
    expect(termTags('!dark | wild')).toEqual(['dark', 'wild']);
    expect(termTags('')).toEqual([]);
  });

  it('covers every key the editor offers a tag picker on', () => {
    for (const key of ['tags', 'areaTags', 'excludeTags', 'requires', 'targetTags', 'kind', 'itemKind']) {
      expect(TAG_BEARING_KEYS.has(key)).toBe(true);
    }
  });

  it('finds uses under tag-bearing keys, negated and alternated alike', () => {
    const files = new Map<string, unknown>([
      ['a.json', { roomTypes: { crypt: { tags: ['dark', 'stone'], requires: ['!dark|wild'] } } }],
    ]);
    const uses = findTagUsages(files, 'dark');
    expect(uses).toEqual([
      { file: 'a.json', path: 'roomTypes.crypt.tags[0]', term: 'dark' },
      { file: 'a.json', path: 'roomTypes.crypt.requires[0]', term: '!dark|wild' },
    ]);
  });

  it('ignores prose and names — only tag fields count', () => {
    const files = new Map<string, unknown>([
      ['a.json', { items: [{ id: 'key', name: 'key', desc: 'a small key', kind: 'key' }] }],
    ]);
    expect(findTagUsages(files, 'key')).toEqual([
      { file: 'a.json', path: 'items[0].kind', term: 'key' },
    ]);
  });

  it('skips the file it is told to — tags.json declares, it does not use', () => {
    const files = new Map<string, unknown>([
      ['tags.json', { room: { light: { dark: 'no light' } } }],
      ['a.json', { tags: ['dark'] }],
    ]);
    expect(findTagUsages(files, 'dark', 'tags.json').map((u) => u.file)).toEqual(['a.json']);
  });

  it('finds every use of a real base tag across the real tables', async () => {
    const source = bundledSource('base');
    const files = new Map<string, unknown>();
    for (const path of await source.list()) files.set(path, await source.read(path));
    const uses = findTagUsages(files, 'dark', 'tags.json');
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(termTags(use.term)).toContain('dark');
    // A tag nothing uses is a real answer, not a failure.
    expect(findTagUsages(files, 'not-a-tag', 'tags.json')).toEqual([]);
  });
});
