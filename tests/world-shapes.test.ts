import { describe, expect, it } from 'vitest';
import { Rng } from '../src/engine/rng';
import {
  SHAPES,
  buildGraph,
  chordFraction,
  degrees,
  hopsFrom,
  isBridge,
  isConnected,
  neighbourLists,
  type Graph,
  type Shape,
} from '../src/world/shapes';
import rules from '../campaigns/base/rules.json';
import type { JsonObject } from '../src/campaign/merge';

const RULES = rules as unknown as JsonObject;

/** A lattice is bipartite, so a graph with an odd cycle cannot be drawn on one. */
function isBipartite(graph: Graph): boolean {
  const lists = neighbourLists(graph);
  const colour = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    for (const next of lists[node] ?? []) {
      const wanted = 1 - (colour.get(node) as number);
      if (!colour.has(next)) {
        colour.set(next, wanted);
        queue.push(next);
      } else if (colour.get(next) !== wanted) {
        return false;
      }
    }
  }
  return true;
}

describe('graph shapes', () => {
  for (const shape of SHAPES) {
    describe(shape, () => {
      const sizes = [4, 9, 12, 20];

      it('is always one connected piece', () => {
        for (const seed of [1, 2, 3, 7, 99]) {
          for (const size of sizes) {
            const graph = buildGraph(new Rng(seed), RULES, shape, size, { maxDegree: 4 });
            expect(graph.nodes).toBe(size);
            expect(isConnected(graph), `${shape} ${size} rooms, seed ${seed}`).toBe(true);
          }
        }
      });

      it('never exceeds the degree cap', () => {
        for (const seed of [4, 5, 6]) {
          for (const maxDegree of [4, 6]) {
            const graph = buildGraph(new Rng(seed), RULES, shape, 18, { maxDegree });
            expect(Math.max(...degrees(graph))).toBeLessThanOrEqual(maxDegree);
          }
        }
      });

      it('carries no cycle the lattice could not draw', () => {
        for (const seed of [11, 12, 13, 14]) {
          const graph = buildGraph(new Rng(seed), RULES, shape, 16, { maxDegree: 6 });
          expect(isBipartite(graph), `${shape}, seed ${seed}`).toBe(true);
        }
      });
    });
  }

  it('builds sprawl as a tree, where every edge is a bridge', () => {
    const graph = buildGraph(new Rng(21), RULES, 'sprawl', 12, { maxDegree: 4 });
    expect(graph.edges.length).toBe(graph.nodes - 1);
    expect(graph.edges.every((_, i) => isBridge(graph, i))).toBe(true);
  });

  it('builds loop with a ring, so not every edge is a bridge', () => {
    const graph = buildGraph(new Rng(22), RULES, 'loop', 12, { maxDegree: 4 });
    expect(graph.edges.length).toBeGreaterThan(graph.nodes - 1);
    expect(graph.edges.some((_, i) => !isBridge(graph, i))).toBe(true);
  });

  it('builds hub with the centre one room in from the entry', () => {
    const graph = buildGraph(new Rng(23), RULES, 'hub', 13, { maxDegree: 4 });
    // You arrive at the edge of a settlement and walk in to the square, which
    // also keeps the busiest room off the cube face where it could not fit.
    expect(degrees(graph)[0]).toBe(1);
    expect(degrees(graph)[1]).toBeGreaterThanOrEqual(3);
    const hops = hopsFrom(graph, 0);
    expect(Math.max(...hops.values())).toBeLessThanOrEqual(7);
  });

  it('respects a tighter cap on the entry room, which sits on a cube face', () => {
    for (const seed of [31, 32, 33, 34]) {
      for (const shape of SHAPES) {
        const graph = buildGraph(new Rng(seed), RULES, shape, 14, { maxDegree: 4, entryMaxDegree: 2 });
        expect(degrees(graph)[0], `${shape}, seed ${seed}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("leaves a warren's density to be woven in after placement", () => {
    // The builder only lays the backbone: every extra connection has to be one
    // the lattice can draw, which is not knowable until the rooms have slots.
    const warren = buildGraph(new Rng(24), RULES, 'warren', 20, { maxDegree: 6 });
    expect(warren.edges.length).toBe(warren.nodes - 1);
    expect(chordFraction(RULES, 'warren')).toBeGreaterThan(0);
    expect(chordFraction(RULES, 'sprawl')).toBe(0);
  });

  it('rejects a shape name it does not build', () => {
    const shapes: string[] = [...SHAPES];
    expect(shapes.includes('spiral')).toBe(false);
    expect(shapes).toContain('warren' satisfies Shape);
  });
});
