import { describe, expect, it } from 'vitest';
import { Rng, mix, seedFrom } from '../src/engine/rng';

describe('Rng', () => {
  it('is reproducible from a seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const rollsA = Array.from({ length: 20 }, () => a.next());
    const rollsB = Array.from({ length: 20 }, () => b.next());
    expect(rollsA).toEqual(rollsB);
  });

  it('resumes exactly from a saved state', () => {
    const a = new Rng('warren');
    for (let i = 0; i < 7; i++) a.next();
    const b = Rng.fromState(a.toState());
    expect(Array.from({ length: 10 }, () => b.next())).toEqual(
      Array.from({ length: 10 }, () => a.next()),
    );
  });

  it('avalanches sequential seeds, so first rolls are not correlated', () => {
    // The bug this guards: a raw LCG fed 1, 2, 3... produces near-identical
    // first outputs, which made every generated area roll almost the same tier.
    const firsts = Array.from({ length: 400 }, (_, i) => new Rng(i).next());
    const buckets = new Array(10).fill(0) as number[];
    for (const value of firsts) buckets[Math.floor(value * 10)] = (buckets[Math.floor(value * 10)] ?? 0) + 1;
    for (const count of buckets) expect(count).toBeGreaterThan(15);
  });

  it('forks into independent streams', () => {
    const root = new Rng(99);
    const a = root.fork('farmland');
    const b = root.fork('warren');
    expect(a.next()).not.toBe(b.next());
    // A fork is reproducible from the same parent state and label.
    expect(new Rng(99).fork('farmland').next()).toBe(new Rng(99).fork('farmland').next());
  });

  it('rolls integers inside the inclusive range', () => {
    const rng = new Rng('range');
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    expect(seen.size).toBe(5);
  });

  it('respects weights', () => {
    const rng = new Rng('weights');
    const table = [
      { id: 'common', w: 90 },
      { id: 'rare', w: 10 },
    ];
    const counts = { common: 0, rare: 0 };
    for (let i = 0; i < 5000; i++) counts[rng.weighted(table).id as 'common' | 'rare']++;
    expect(counts.rare / 5000).toBeGreaterThan(0.07);
    expect(counts.rare / 5000).toBeLessThan(0.13);
  });

  it('never returns a zero-weight entry', () => {
    const rng = new Rng('zero');
    const table = [
      { id: 'off', w: 0 },
      { id: 'on', w: 5 },
      { id: 'also-off', w: 0 },
    ];
    for (let i = 0; i < 500; i++) expect(rng.weighted(table).id).toBe('on');
  });

  it('returns undefined rather than throwing on an empty weighted table', () => {
    expect(new Rng(1).maybeWeighted([])).toBeUndefined();
    expect(new Rng(1).maybeWeighted([{ w: 0 }])).toBeUndefined();
  });

  it('folds the key into a weighted entry pick and skips note keys', () => {
    const rng = new Rng('entries');
    const table = { field: { w: 30 }, lane: { w: 20 }, _note: { w: 1000 } };
    for (let i = 0; i < 200; i++) {
      expect(['field', 'lane']).toContain(rng.weightedEntry(table).id);
    }
  });

  it('rolls dice', () => {
    const rng = new Rng('dice');
    for (let i = 0; i < 500; i++) {
      const value = rng.dice('3d8');
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(24);
    }
  });

  it('shuffles without mutating the input', () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const rng = new Rng('shuffle');
    const shuffled = rng.shuffle(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(source);
  });

  it('mixes to a uint32', () => {
    for (const value of [0, 1, -1, 2 ** 31, 0xffffffff]) {
      const mixed = mix(value);
      expect(mixed).toBeGreaterThanOrEqual(0);
      expect(mixed).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(mixed)).toBe(true);
    }
  });

  it('seeds distinctly from similar strings', () => {
    expect(seedFrom('warren')).not.toBe(seedFrom('warrem'));
  });
});
