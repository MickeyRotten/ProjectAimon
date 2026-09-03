/**
 * Graph shapes — the cheapest way to make two areas of the same archetype
 * feel different.
 *
 *   sprawl   branching, dead ends, no loops. Feels wild.
 *   loop     a ring with spurs. Feels walkable and knowable.
 *   hub      a centre with arms. Feels like a settlement.
 *   warren   dense, many connections, easy to get turned around.
 *
 * Connections come first and coordinates come second, so this file knows
 * nothing about the lattice. It only has to hand the layout walk a graph that
 * can actually be drawn on one, which means obeying two structural limits:
 *
 *  - **Degree.** A slot has four neighbours in a flat area and six in one with
 *    depth. A node with more edges than that can never have all of them drawn.
 *  - **Parity.** A lattice is bipartite: every step flips the parity of
 *    x+y+z. So an odd cycle cannot be embedded at all, and any edge closing
 *    one is an edge the layout walk will have to give up on. Rings are
 *    therefore built even, and the connections that would close arbitrary
 *    cycles — a warren's density — are woven in after placement instead,
 *    between rooms that are already neighbours.
 *
 * Neither limit is a rules value — they are properties of a three-dimensional
 * grid. The shape *parameters* are tunables and live in `rules.json`.
 */

import type { JsonObject } from '../campaign/merge';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber, ruleRange } from '../engine/rules';

export const SHAPES = ['sprawl', 'loop', 'hub', 'warren'] as const;
export type Shape = (typeof SHAPES)[number];

export const isShape = (value: string): value is Shape => (SHAPES as readonly string[]).includes(value);

/**
 * The hub shape's designated centre node — node 1, built as "the centre...
 * you arrive at the edge of a town and walk in to the square" (see `hub`
 * below). `null` for every other shape, which has no equivalent node.
 */
export function hubCentreNode(shape: Shape): number | null {
  return shape === 'hub' ? 1 : null;
}

/** An abstract graph. Node 0 is always the entry. */
export interface Graph {
  readonly nodes: number;
  readonly edges: readonly [number, number][];
}

export function neighbourLists(graph: Graph): number[][] {
  const lists: number[][] = Array.from({ length: graph.nodes }, () => []);
  for (const [a, b] of graph.edges) {
    lists[a]?.push(b);
    lists[b]?.push(a);
  }
  return lists;
}

export function degrees(graph: Graph): number[] {
  return neighbourLists(graph).map((list) => list.length);
}

/** Hops from `from` to every node it can reach. Unreachable nodes are absent. */
export function hopsFrom(graph: Graph, from = 0): Map<number, number> {
  const lists = neighbourLists(graph);
  const seen = new Map<number, number>([[from, 0]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    const depth = seen.get(node) as number;
    for (const next of lists[node] ?? []) {
      if (seen.has(next)) continue;
      seen.set(next, depth + 1);
      queue.push(next);
    }
  }
  return seen;
}

export const isConnected = (graph: Graph): boolean => hopsFrom(graph).size === graph.nodes;

/**
 * Is this edge a bridge — would removing it split the graph?
 *
 * **Check before dropping, always.** In a `sprawl` every edge is a bridge, so
 * the old "drop the offending edge and log it" rule would have severed part of
 * the area permanently, potentially stranding the only way to a quest
 * objective.
 */
export function isBridge(graph: Graph, edgeIndex: number): boolean {
  const kept = graph.edges.filter((_, i) => i !== edgeIndex);
  return !isConnected({ nodes: graph.nodes, edges: kept });
}

/** Every edge whose removal leaves the graph in one piece. */
export function nonBridgeEdges(graph: Graph): number[] {
  return graph.edges.map((_, i) => i).filter((i) => !isBridge(graph, i));
}

/**
 * The rules each shape reads. Validation checks these resolve before a
 * campaign loads, so a table that overrode `WORLD.shapes` badly fails at the
 * boot screen rather than under the player's feet on first entry.
 */
export const SHAPE_RULES: Record<Shape, string[]> = {
  sprawl: ['WORLD.shapes.sprawl.branchWindow'],
  loop: ['WORLD.shapes.loop.ringFraction', 'WORLD.shapes.loop.spurWindow'],
  hub: ['WORLD.shapes.hub.arms'],
  warren: ['WORLD.shapes.warren.backWindow'],
};

export interface ShapeOptions {
  /** Four in a flat area, six where the cube has depth. */
  maxDegree: number;
  /**
   * The entry room sits on the face of its cube, so it has fewer sides than a
   * room in the middle — a corner slot has two. Giving node 0 more edges than
   * that builds an area whose first room can never be drawn.
   */
  entryMaxDegree?: number;
}

/**
 * Build the room graph for a shape. The result is always connected, always
 * within the degree cap, and carries no cycle the lattice cannot draw.
 */
export function buildGraph(
  rng: Rng,
  rules: JsonObject,
  shape: Shape,
  nodes: number,
  options: ShapeOptions,
): Graph {
  const n = Math.max(1, nodes);
  const builder = BUILDERS[shape];
  return builder(rng, rules, n, options);
}

type Builder = (rng: Rng, rules: JsonObject, n: number, options: ShapeOptions) => Graph;

/** A graph under construction, which enforces the degree cap for every shape. */
class GraphBuild {
  readonly edges: [number, number][] = [];
  private readonly degree: number[];

  constructor(
    readonly nodes: number,
    private readonly maxDegree: number,
    private readonly entryMaxDegree: number,
  ) {
    this.degree = Array.from({ length: nodes }, () => 0);
  }

  degreeOf(node: number): number {
    return this.degree[node] ?? 0;
  }

  hasRoom(node: number): boolean {
    return this.degreeOf(node) < (node === 0 ? this.entryMaxDegree : this.maxDegree);
  }

  linked(a: number, b: number): boolean {
    return this.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }

  /** Join two nodes. Refuses silently when either is full or already joined. */
  link(a: number, b: number): boolean {
    if (a === b || this.linked(a, b) || !this.hasRoom(a) || !this.hasRoom(b)) return false;
    this.edges.push([a, b]);
    this.degree[a] = this.degreeOf(a) + 1;
    this.degree[b] = this.degreeOf(b) + 1;
    return true;
  }

  /** Attach `node` to the nearest earlier node that still has a free side. */
  attachBackwards(node: number, window: number, rng: Rng): void {
    const lo = Math.max(0, node - window);
    const candidates = rng.shuffle(range(lo, node - 1)).filter((c) => this.hasRoom(c));
    for (const candidate of candidates) if (this.link(candidate, node)) return;
    // The window is full: walk the whole graph rather than leave an orphan.
    for (const candidate of range(0, node - 1)) if (this.link(candidate, node)) return;
  }

  build(): Graph {
    return { nodes: this.nodes, edges: this.edges };
  }
}

const range = (lo: number, hi: number): number[] =>
  hi < lo ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** Branching, dead ends, no loops. Every edge is a bridge — by design. */
const sprawl: Builder = (rng, rules, n, options) => {
  const window = ruleNumber(rules, 'WORLD.shapes.sprawl.branchWindow');
  const graph = new GraphBuild(n, options.maxDegree, options.entryMaxDegree ?? options.maxDegree);
  for (let i = 1; i < n; i++) graph.attachBackwards(i, window, rng);
  return graph.build();
};

/**
 * A ring with spurs. The ring is built even-length because a lattice cannot
 * draw an odd cycle, and a ring the map cannot close is not a loop.
 */
const loop: Builder = (rng, rules, n, options) => {
  const fraction = ruleNumber(rules, 'WORLD.shapes.loop.ringFraction');
  const spurWindow = ruleNumber(rules, 'WORLD.shapes.loop.spurWindow');
  const graph = new GraphBuild(n, options.maxDegree, options.entryMaxDegree ?? options.maxDegree);

  let ring = Math.max(4, Math.round(n * fraction));
  if (ring % 2 === 1) ring += 1;
  ring = Math.min(ring, n - (n % 2)); // never more nodes than there are
  if (ring < 4) return sprawl(rng, rules, n, options);

  for (let i = 1; i < ring; i++) graph.link(i - 1, i);
  graph.link(ring - 1, 0);

  // Spurs hang off the ring, one to a room, and chain off each other after
  // that. One spur per ring room is not a style choice: in a lattice, a short
  // ring's rooms already have a neighbouring slot taken by the room across the
  // ring, so a second spur is a connection the map could never draw.
  const spurred = new Set<number>();
  for (let i = ring; i < n; i++) {
    const free = rng.shuffle(range(0, ring - 1)).find((node) => !spurred.has(node) && graph.hasRoom(node));
    if (free !== undefined) {
      graph.link(free, i);
      spurred.add(free);
      continue;
    }
    const chain = rng
      .shuffle(range(Math.max(ring, i - spurWindow), i - 1))
      .find((node) => graph.hasRoom(node));
    if (chain === undefined) graph.attachBackwards(i, spurWindow + 1, rng);
    else graph.link(chain, i);
  }
  return graph.build();
};

/**
 * A centre with arms. Feels like a settlement, because settlements have one.
 *
 * The centre is node 1, not the entry: you arrive at the edge of a town and
 * walk in to the square. That also keeps the busiest room off the cube face,
 * where there would not be enough sides for its arms.
 */
const hub: Builder = (rng, rules, n, options) => {
  const [minArms, maxArms] = ruleRange(rules, 'WORLD.shapes.hub.arms');
  const graph = new GraphBuild(n, options.maxDegree, options.entryMaxDegree ?? options.maxDegree);
  if (n < 3) {
    for (let i = 1; i < n; i++) graph.link(i - 1, i);
    return graph.build();
  }

  const centre = 1;
  graph.link(0, centre);
  // One side of the centre is spent on the way in.
  const arms = Math.min(rng.int(minArms, maxArms), options.maxDegree - 1, Math.max(1, n - 2));

  const tips: number[] = [];
  let next = 2;
  for (let arm = 0; arm < arms && next < n; arm++, next++) {
    graph.link(centre, next);
    tips.push(next);
  }
  // Everything left extends an arm, so the centre keeps no more than it can hold.
  for (; next < n; next++) {
    const armIndex = (next - arms - 2) % Math.max(1, tips.length);
    const tip = tips[armIndex] as number;
    if (graph.link(tip, next)) tips[armIndex] = next;
    else graph.attachBackwards(next, 2, rng);
  }
  return graph.build();
};

/**
 * Dense and easy to get turned around in — but only the backbone is built
 * here.
 *
 * The extra connections are woven **after** the layout walk, between rooms
 * that ended up side by side. A dense graph drawn first and placed second is a
 * graph the lattice usually cannot draw: every chord is another pair of rooms
 * that must land exactly one step apart, and the walk spends its whole budget
 * failing to satisfy them. Weaving afterwards makes every extra connection
 * drawable by construction, and gives the same feel — a warren is dense
 * *because* neighbouring rooms all open into one another.
 */
const warren: Builder = (rng, rules, n, options) => {
  const window = ruleNumber(rules, 'WORLD.shapes.warren.backWindow');
  const graph = new GraphBuild(n, options.maxDegree, options.entryMaxDegree ?? options.maxDegree);
  for (let i = 1; i < n; i++) graph.attachBackwards(i, window, rng);
  return graph.build();
};

/**
 * Stretch a graph until something is `wantedDepth` hops from the entry.
 *
 * A coordinate reserved by a `Distant` quest can be right across the area's
 * cube, and a room can only land on it if the graph has a branch long enough
 * to reach — twelve rooms in a bushy tree may have nothing more than five hops
 * out. Leaves are re-hung on the end of the deepest branch until it is long
 * enough, which changes the shape's silhouette slightly and keeps the promise.
 *
 * Re-hanging a leaf can never disconnect anything, so the area stays whole.
 */
export function stretchToDepth(graph: Graph, wantedDepth: number): Graph {
  let edges = [...graph.edges];
  for (let guard = 0; guard < graph.nodes * 2; guard++) {
    const current: Graph = { nodes: graph.nodes, edges };
    const hops = hopsFrom(current, 0);
    const deepest = [...hops.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    if ((hops.get(deepest) as number) >= wantedDepth) break;

    // Anything on the way to the deepest room has to stay where it is, or the
    // branch being lengthened is the branch being taken apart.
    const spine = pathTo(current, deepest);
    const lists = neighbourLists(current);
    const leaf = [...hops.keys()]
      .filter((node) => node !== 0 && !spine.has(node) && (lists[node]?.length ?? 0) === 1)
      .sort((a, b) => (hops.get(a) as number) - (hops.get(b) as number))[0];
    if (leaf === undefined) break; // as long as this graph can be made

    edges = edges.filter(([a, b]) => a !== leaf && b !== leaf);
    edges.push([deepest, leaf]);
  }
  return { nodes: graph.nodes, edges };
}

/** The rooms between the entry and `target`, inclusive. */
export function pathTo(graph: Graph, target: number): Set<number> {
  const lists = neighbourLists(graph);
  const parent = new Map<number, number>([[0, 0]]);
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    for (const next of lists[node] ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, node);
      queue.push(next);
    }
  }
  const path = new Set<number>();
  let at = target;
  while (!path.has(at)) {
    path.add(at);
    const up = parent.get(at);
    if (up === undefined || up === at) break;
    at = up;
  }
  return path;
}

/**
 * How many extra connections a shape wants woven in after placement, as a
 * fraction of the room count. Absent from the table means none.
 */
export function chordFraction(rules: JsonObject, shape: Shape): number {
  const value = ruleAt(rules, `WORLD.shapes.${shape}.extraEdges`);
  return typeof value === 'number' ? value : 0;
}

const BUILDERS: Record<Shape, Builder> = { sprawl, loop, hub, warren };
