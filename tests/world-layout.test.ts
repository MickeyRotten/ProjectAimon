import { describe, expect, it } from 'vitest';
import rules from '../campaigns/base/rules.json';
import type { JsonObject } from '../src/campaign/merge';
import { Rng } from '../src/engine/rng';
import { layoutArea, placeStrictly, roomyEntry, weaveChords } from '../src/world/layout';
import { SHAPES, buildGraph, type Graph } from '../src/world/shapes';
import { WorldLattice } from '../src/world/lattice';
import { adjacent, coordKey, cubeContains, sidesInside, type Coord, type Cube } from '../src/world/types';

const RULES = rules as unknown as JsonObject;

const cubeFor = (archetype: string, rooms: number, at: Coord = { x: 0, y: 0, z: 0 }): Cube => {
  const size = new WorldLattice(RULES).sizeFor(archetype, rooms);
  return { x0: at.x, y0: at.y, z0: at.z, x1: at.x + size.w - 1, y1: at.y + size.h - 1, z1: at.z + size.d - 1 };
};

const everyEdgeAdjacent = (graph: Graph, placements: readonly Coord[]): boolean =>
  graph.edges.every(([a, b]) => adjacent(placements[a] as Coord, placements[b] as Coord));

describe('the layout walk', () => {
  it('places every shape with every connection drawable', () => {
    for (const shape of SHAPES) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const rooms = 12;
        const archetype = shape === 'warren' ? 'warren' : 'farmland';
        const cube = cubeFor(archetype, rooms);
        const flat = cube.z1 === cube.z0;
        // The generator never hands the walk a corner it cannot build from.
        const entry = roomyEntry(cube, { x: cube.x0, y: cube.y0, z: cube.z0 });
        const graph = buildGraph(new Rng(seed), RULES, shape, rooms, {
          maxDegree: flat ? 4 : 6,
          entryMaxDegree: sidesInside(cube, entry),
        });
        const placements = placeStrictly(graph, cube, entry, [], new Rng(seed));

        expect(placements, `${shape}, seed ${seed}`).not.toBeNull();
        const placed = placements as Coord[];
        expect(everyEdgeAdjacent(graph, placed), `${shape}, seed ${seed}`).toBe(true);
        expect(new Set(placed.map(coordKey)).size).toBe(rooms);
        expect(placed.every((coord) => cubeContains(cube, coord))).toBe(true);
      }
    }
  });

  it('pins the entry room to the slot it was given', () => {
    const cube = cubeFor('farmland', 10);
    const entry = roomyEntry(cube, { x: cube.x0, y: cube.y0 + 2, z: cube.z0 });
    const graph = buildGraph(new Rng(9), RULES, 'sprawl', 10, {
      maxDegree: 4,
      entryMaxDegree: sidesInside(cube, entry),
    });
    const placements = placeStrictly(graph, cube, entry, [], new Rng(9)) as Coord[];
    expect(placements[0]).toEqual(entry);
  });

  it('fills a coordinate reserved before the area existed', () => {
    const cube = cubeFor('farmland', 12);
    const entry = roomyEntry(cube, { x: cube.x0, y: cube.y0, z: cube.z0 });
    const promised: Coord = { x: cube.x1, y: cube.y1, z: cube.z0 };
    for (const seed of [31, 32, 33]) {
      const graph = buildGraph(new Rng(seed), RULES, 'sprawl', 12, {
        maxDegree: 4,
        entryMaxDegree: sidesInside(cube, entry),
      });
      const result = layoutArea({ graph, rng: new Rng(seed), rules: RULES, cube, entryCoord: entry, reservedCoords: [promised] });
      expect(result.unfilledReservations, `seed ${seed}`).toEqual([]);
      expect(result.placements.some((coord) => coordKey(coord) === coordKey(promised))).toBe(true);
    }
  });

  it('nudges an entry slot with no room to build from', () => {
    const cube = cubeFor('farmland', 12);
    const corner: Coord = { x: cube.x0, y: cube.y0, z: cube.z0 };
    expect(sidesInside(cube, corner)).toBe(2);
    const nudged = roomyEntry(cube, corner);
    expect(sidesInside(cube, nudged)).toBeGreaterThanOrEqual(3);
    expect(cubeContains(cube, nudged)).toBe(true);
    // A slot with room to build from is left exactly where it was promised.
    const midFace: Coord = { x: cube.x0, y: cube.y0 + 2, z: cube.z0 };
    expect(roomyEntry(cube, midFace)).toEqual(midFace);
  });

  it('weaves extra connections only between rooms already side by side', () => {
    const cube = cubeFor('warren', 15);
    const entry = roomyEntry(cube, { x: cube.x0, y: cube.y0 + 2, z: cube.z0 });
    const graph = buildGraph(new Rng(41), RULES, 'warren', 15, {
      maxDegree: 6,
      entryMaxDegree: sidesInside(cube, entry),
    });
    const placements = placeStrictly(graph, cube, entry, [], new Rng(41)) as Coord[];
    const woven = weaveChords({ placements, edges: graph.edges, rng: new Rng(41), wanted: 5, maxDegree: 6 });

    expect(woven.length).toBeGreaterThan(0);
    expect(woven.length).toBeLessThanOrEqual(5);
    for (const [a, b] of woven) {
      expect(adjacent(placements[a] as Coord, placements[b] as Coord)).toBe(true);
      expect(graph.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))).toBe(false);
    }
  });

  it('gives up an out-of-reach promise rather than an undrawable map', () => {
    // Six rooms cannot reach the far corner of a cube eight steps across, so
    // the promise cannot be kept. The map still has to be right.
    const cube = cubeFor('farmland', 30);
    const entry = roomyEntry(cube, { x: cube.x0, y: cube.y0, z: cube.z0 });
    const promised: Coord = { x: cube.x1, y: cube.y1, z: cube.z1 };
    const graph = buildGraph(new Rng(51), RULES, 'sprawl', 6, {
      maxDegree: 4,
      entryMaxDegree: sidesInside(cube, entry),
    });
    const result = layoutArea({
      graph,
      rng: new Rng(51),
      rules: RULES,
      cube,
      entryCoord: entry,
      reservedCoords: [promised],
    });

    expect(result.unfilledReservations).toEqual([promised]);
    expect(result.looseEdges).toEqual([]);
    expect(everyEdgeAdjacent(result.graph, result.placements)).toBe(true);
  });

  it('never drops a bridge edge, even when it cannot finish', () => {
    // A star of nine leaves around one room needs nine sides; a slot has six.
    // Every edge is a bridge, so the ladder must reach logAndAccept with
    // nothing dropped rather than sever the area.
    const graph: Graph = { nodes: 10, edges: Array.from({ length: 9 }, (_, i) => [0, i + 1] as [number, number]) };
    const cube = cubeFor('farmland', 10);
    const result = layoutArea({
      graph,
      rng: new Rng(5),
      rules: RULES,
      cube,
      entryCoord: { x: cube.x0 + 2, y: cube.y0 + 2, z: cube.z0 },
    });
    expect(result.droppedEdges).toEqual([]);
    expect(result.placements.length).toBe(10);
    expect(result.looseEdges.length).toBeGreaterThan(0);
    expect(result.notes.join(' ')).toContain('cannot draw');
  });

  it('drops a non-bridge before it gives up', () => {
    // An odd ring: a lattice is bipartite, so this cycle can never be drawn.
    // Its edges are all non-bridges, so one of them may honestly go.
    const ring = 7;
    const edges: [number, number][] = Array.from({ length: ring }, (_, i) => [i, (i + 1) % ring]);
    const cube = cubeFor('farmland', ring);
    const result = layoutArea({
      graph: { nodes: ring, edges },
      rng: new Rng(6),
      rules: RULES,
      cube,
      entryCoord: { x: cube.x0, y: cube.y0, z: cube.z0 },
    });
    expect(result.droppedEdges.length).toBeGreaterThan(0);
    expect(result.looseEdges).toEqual([]);
    expect(result.notes.join(' ')).toContain('non-bridge');
  });
});
