/**
 * Seeded, serialisable random number generator.
 *
 * Everything the engine rolls goes through one of these. The state is a single
 * uint32 so it can be written into a save and resumed exactly, which is what
 * makes "areas are generated once and never regenerate" checkable: the same
 * seed and the same call order produce the same world.
 *
 * The murmur3 finalizer is not decoration. A raw LCG fed sequential seeds
 * produces correlated first outputs, so the first roll of every generation
 * comes out nearly identical — the bug that made every area roll the same tier
 * in the reference generator. Seeds are avalanched before use, and again on
 * every step.
 */

/** murmur3 finalizer. Avalanches a uint32 so nearby seeds diverge immediately. */
export function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Avalanche an arbitrary string into a uint32 seed. FNV-1a, then mixed. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mix(h >>> 0);
}

/** An entry in a weighted table. `w` defaults to 1. */
export interface Weighted {
  w?: number | undefined;
}

export class Rng {
  private state: number;

  constructor(seed: number | string = 0) {
    this.state = mix(typeof seed === 'string' ? seedFrom(seed) : seed >>> 0);
  }

  /** Restore an RNG mid-stream from a saved state. */
  static fromState(state: number): Rng {
    const r = new Rng(0);
    r.state = state >>> 0;
    return r;
  }

  /** The whole of the RNG's memory. Write this into the save. */
  toState(): number {
    return this.state;
  }

  /**
   * A derived generator, independent of this one and reproducible from the
   * same label. Use it to give each area its own stream, so generating area B
   * cannot shift the rolls area A would have made.
   */
  fork(label: string): Rng {
    return Rng.fromState(mix(this.state ^ seedFrom(label)));
  }

  /** Float in [0, 1). */
  next(): number {
    this.state = mix((Math.imul(this.state, 1664525) + 1013904223) >>> 0);
    return this.state / 4294967296;
  }

  /** Integer in [lo, hi], inclusive both ends. */
  int(lo: number, hi: number): number {
    if (hi < lo) [lo, hi] = [hi, lo];
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Roll dice written as "3d8". */
  dice(spec: string): number {
    const [n, faces] = spec.split('d').map(Number);
    if (!n || !faces) throw new Error(`bad dice spec: ${spec}`);
    let total = 0;
    for (let i = 0; i < n; i++) total += this.int(1, faces);
    return total;
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Uniform pick, or undefined when the list is empty. */
  maybePick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : this.pick(items);
  }

  /**
   * Weighted pick. Entries carry `w`, defaulting to 1. Non-positive weights
   * are skipped entirely rather than being allowed to fall out of the residue,
   * which is how a `w: 0` entry sneaks into results in a naive walk.
   */
  weighted<T extends Weighted>(items: readonly T[]): T {
    const chosen = this.maybeWeighted(items);
    if (chosen === undefined) throw new Error('weighted pick from empty table');
    return chosen;
  }

  /** Weighted pick, or undefined when nothing has positive weight. */
  maybeWeighted<T extends Weighted>(items: readonly T[]): T | undefined {
    let total = 0;
    for (const item of items) {
      const w = item.w ?? 1;
      if (w > 0) total += w;
    }
    if (total <= 0) return undefined;

    let r = this.next() * total;
    let last: T | undefined;
    for (const item of items) {
      const w = item.w ?? 1;
      if (w <= 0) continue;
      last = item;
      r -= w;
      if (r < 0) return item;
    }
    return last;
  }

  /**
   * Weighted pick over a table keyed by id, the shape `roomTypes` uses. The
   * id is folded into the returned entry so callers never have to carry the
   * key alongside the value.
   */
  weightedEntry<T extends Weighted>(table: Readonly<Record<string, T>>): T & { id: string } {
    const chosen = this.maybeWeightedEntry(table);
    if (chosen === undefined) throw new Error('weighted pick from empty table');
    return chosen;
  }

  maybeWeightedEntry<T extends Weighted>(
    table: Readonly<Record<string, T>>,
  ): (T & { id: string }) | undefined {
    const entries = Object.entries(table)
      .filter(([id]) => !id.startsWith('_'))
      .map(([id, value]) => ({ ...value, id }));
    return this.maybeWeighted(entries);
  }

  /** Fisher-Yates. Returns a new array; the input is untouched. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** `n` distinct items, or all of them when the list is shorter. */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, n));
  }
}
