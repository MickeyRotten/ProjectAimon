import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/rng';
import {
  TagVocabulary,
  filterByTags,
  matches,
  parseRequirement,
  rollByTags,
} from '../src/engine/tags';

const ROOM = ['indoor', 'storage', 'dark', 'wood'];

describe('requires[] matching', () => {
  it('treats a plain tag as must-have', () => {
    expect(matches(ROOM, ['indoor'])).toBe(true);
    expect(matches(ROOM, ['outdoor'])).toBe(false);
  });

  it('treats | as at-least-one', () => {
    expect(matches(ROOM, ['dark|wild'])).toBe(true);
    expect(matches(ROOM, ['wild|water'])).toBe(false);
  });

  it('treats ! as must-not-have', () => {
    expect(matches(ROOM, ['!water'])).toBe(true);
    expect(matches(ROOM, ['!dark'])).toBe(false);
  });

  it('ands the terms together', () => {
    expect(matches(ROOM, ['indoor', '!water'])).toBe(true);
    expect(matches(ROOM, ['indoor', '!dark'])).toBe(false);
  });

  it('is satisfied by an empty or absent requires', () => {
    expect(matches(ROOM, [])).toBe(true);
    expect(matches(ROOM, undefined)).toBe(true);
  });

  it('parses a negated alternative inside an any-term', () => {
    const requirement = parseRequirement('dark|!water');
    expect(requirement.alternatives).toEqual([
      { tag: 'dark', negated: false },
      { tag: 'water', negated: true },
    ]);
  });

  it('tolerates whitespace around terms', () => {
    expect(matches(ROOM, [' dark | wild '])).toBe(true);
  });
});

describe('tag-filtered rolls', () => {
  const table = [
    { id: 'rat', requires: ['dark'], w: 10 },
    { id: 'crow', requires: ['outdoor'], w: 10 },
    { id: 'anything', w: 1 },
  ];

  it('filters a table by room tags', () => {
    expect(filterByTags(table, ROOM).map((entry) => entry.id)).toEqual(['rat', 'anything']);
  });

  it('rolls only from what fits', () => {
    const rng = new Rng('roll');
    for (let i = 0; i < 300; i++) {
      expect(['rat', 'anything']).toContain(rollByTags(rng, table, ROOM)?.id);
    }
  });

  it('returns undefined when nothing fits, which is a normal outcome', () => {
    const rng = new Rng('nothing');
    const strict = [{ id: 'crow', requires: ['outdoor'] }];
    expect(rollByTags(rng, strict, ROOM)).toBeUndefined();
  });
});

describe('TagVocabulary', () => {
  const vocabulary = new TagVocabulary({
    _note: 'ignored',
    room: { light: ['lit', 'dim', 'dark'], nature: ['water', 'stone'] },
    creature: { taxonomy: ['beast', 'undead'] },
    operators: { plain: 'indoor — must have' },
  });

  it('flattens nested categories into one closed list', () => {
    expect(vocabulary.all()).toEqual(['beast', 'dark', 'dim', 'lit', 'stone', 'undead', 'water']);
  });

  it('records the namespace a tag came from', () => {
    expect(vocabulary.namespaceOf('dark')).toBe('room.light');
    expect(vocabulary.namespaceOf('beast')).toBe('creature.taxonomy');
  });

  it('skips notes and the operators documentation', () => {
    expect(vocabulary.has('ignored')).toBe(false);
    expect(vocabulary.has('indoor — must have')).toBe(false);
  });

  it('suggests near misses, so a typo reports what was meant', () => {
    expect(vocabulary.suggest('drak')).toContain('dark');
    expect(vocabulary.suggest('wter')).toContain('water');
  });
});
