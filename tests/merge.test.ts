import { describe, expect, it } from 'vitest';
import { mergeLayer, mergeLayers, withoutNotes } from '../src/campaign/merge';

const merged = <T>(base: unknown, override: unknown) =>
  mergeLayer(base as never, override as never).value as T;

describe('campaign layering', () => {
  it('lets the campaign win on primitives', () => {
    expect(merged({ chance: 0.2, band: 'near' }, { chance: 0.5 })).toEqual({
      chance: 0.5,
      band: 'near',
    });
  });

  it('deep merges objects', () => {
    const result = merged(
      { roomTypes: { field: { w: 30, tags: ['outdoor'] }, barn: { w: 8 } } },
      { roomTypes: { field: { w: 5 } } },
    );
    expect(result).toEqual({
      roomTypes: { field: { w: 5, tags: ['outdoor'] }, barn: { w: 8 } },
    });
  });

  it('replaces arrays entirely, so a campaign can remove a base entry', () => {
    expect(merged({ shapes: ['sprawl', 'loop', 'hub'] }, { shapes: ['loop'] })).toEqual({
      shapes: ['loop'],
    });
  });

  it('appends with a + prefix', () => {
    expect(merged({ affixes: ['keen', 'heavy'] }, { '+affixes': ['salted'] })).toEqual({
      affixes: ['keen', 'heavy', 'salted'],
    });
  });

  it('replaces before appending when both are given', () => {
    const result = merged(
      { themeTokens: ['harvest', 'debt'] },
      { themeTokens: ['salt'], '+themeTokens': ['tide'] },
    );
    expect(result).toEqual({ themeTokens: ['salt', 'tide'] });
  });

  it('creates the list when + targets a key the base does not have', () => {
    expect(merged({}, { '+quirks': ['a'] })).toEqual({ quirks: ['a'] });
  });

  it('reports rather than throws when + targets a non-array', () => {
    const { value, issues } = mergeLayer({ size: 4 } as never, { '+size': [1] } as never);
    expect(value).toEqual({ size: 4 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/not an array/);
  });

  it('reports when a + key is given a non-array value', () => {
    const { issues } = mergeLayer({ tags: [] } as never, { '+tags': 'wild' } as never);
    expect(issues[0]?.message).toMatch(/must be an array/);
  });

  it('treats null as a value, not a deletion', () => {
    // `"sexOverride": null` is a real setting in the base area files. Giving
    // null a second meaning would make it impossible to write.
    expect(merged({ sexOverride: { f: 85 } }, { sexOverride: null })).toEqual({
      sexOverride: null,
    });
  });

  it('replaces an object with a primitive when the campaign says so', () => {
    expect(merged({ gates: { warren: 25 } }, { gates: 0 })).toEqual({ gates: 0 });
  });

  it('does not mutate or alias either layer', () => {
    const base = { tags: ['a'], nested: { list: [1] } };
    const override = { nested: { extra: true } };
    const result = merged<{ tags: string[]; nested: { list: number[] } }>(base, override);
    result.tags.push('b');
    result.nested.list.push(2);
    expect(base.tags).toEqual(['a']);
    expect(base.nested.list).toEqual([1]);
  });

  it('merges any number of layers left to right', () => {
    const { value } = mergeLayers(
      { a: 1, b: 1, c: 1 } as never,
      { b: 2, c: 2 } as never,
      { c: 3 } as never,
    );
    expect(value).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('collects issues from every layer', () => {
    const { issues } = mergeLayers({ n: 1 } as never, { '+n': [1] } as never, {
      '+n': [2],
    } as never);
    expect(issues).toHaveLength(2);
  });
});

describe('withoutNotes', () => {
  it('strips underscore-prefixed annotation keys at every depth', () => {
    expect(
      withoutNotes({
        _note: 'gone',
        keep: 1,
        nested: { _why: 'gone', keep: [{ _x: 1, y: 2 }] },
      } as never),
    ).toEqual({ keep: 1, nested: { keep: [{ y: 2 }] } });
  });
});
