/**
 * The layout walk — connections into coordinates.
 *
 * The graph is built first; this puts it on the lattice. The rule it enforces
 * is the one direction the design allows:
 *
 *   Adjacency does not imply connection — two rooms side by side with no edge
 *   between them are two rooms with a wall between them, which is wanted.
 *   Connection *does* imply adjacency, within an area. Gaps between connected
 *   rooms happen only across gates, where the map already shows a boundary.
 *
 * So a placement is legal only when every edge of the node being placed
 * reaches an orthogonally adjacent slot. When the walk cannot finish,
 * `LAYOUT_FAILURE.order` in the rules decides what to try next — and the one
 * thing it may never do is drop a bridge edge. In a `sprawl` every edge is a
 * bridge, so dropping one severs part of the area for good and can strand the
 * only route to a quest objective.
 *
 * The ladder gives up a coordinate promised to a `Distant` objective before it
 * gives up on the map, because an undrawable connection is a wrong exit the
 * player can see and a released coordinate is an objective the quest system
 * places somewhere else. Both are reported.
 */

import type { JsonObject } from '../campaign/merge';
import type { Rng } from '../engine/rng';
import { ruleArray, ruleNumber } from '../engine/rules';
import {
  hopsFrom,
  isBridge,
  neighbourLists,
  pathTo,
  stretchToDepth,
  type Graph,
} from './shapes';
import {
  ALL_DIRECTIONS,
  coordKey,
  cubeContains,
  cubeCoords,
  parseCoordKey,
  sidesInside,
  step,
  type Coord,
  type Cube,
} from './types';

export interface LayoutResult {
  /**
   * The graph as it was actually laid out — stretched to reach a reserved
   * coordinate, and short any edge the ladder had to drop. The caller builds
   * its edges from this, not from what it passed in.
   */
  graph: Graph;
  /** Coordinate per node index. Always complete: the ladder ends in one. */
  placements: Coord[];
  /** Graph edges the ladder had to drop. Never a bridge. */
  droppedEdges: [number, number][];
  /**
   * Edges that ended up between non-adjacent slots. Only ever non-empty after
   * `logAndAccept`, and the map cannot draw a connector for them.
   */
  looseEdges: [number, number][];
  /**
   * Coordinates that were promised and could not be kept — out of reach for
   * the room count, or given up to keep every connection drawable. The quest
   * system re-places whatever was counting on them.
   */
  unfilledReservations: Coord[];
  /** What the ladder did, for the boot report and the save's generation log. */
  notes: string[];
}

export interface LayoutRequest {
  graph: Graph;
  rng: Rng;
  rules: JsonObject;
  cube: Cube;
  /** Fixed: the slot facing the gate the player walked through. */
  entryCoord: Coord;
  /** Promised to a `Distant` quest before this area existed. */
  reservedCoords?: Coord[];
  /**
   * Enlarge the area's cube. Returns the new cube, or undefined when a
   * neighbouring area is in the way.
   */
  growCube?: (slackMultiplier: number) => Cube | undefined;
}

/**
 * The entry room's slot, nudged out of a cramped corner.
 *
 * The promised slot is used as it is whenever there is room to build from it.
 * A corner has two sides and the slots beside it have three, which is not
 * enough to hang an area off — the walk would fail and the ladder would start
 * dropping things. A corner is only ever handed over when the cube had to
 * slide or take a long road, where the one-step crossing was already lost, so
 * stepping along the face costs nothing that was still there to lose.
 */
export function roomyEntry(cube: Cube, wanted: Coord): Coord {
  if (sidesInside(cube, wanted) >= 3) return wanted;
  let best = wanted;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const slot of cubeCoords(cube)) {
    if (sidesInside(cube, slot) < 3) continue;
    const distance =
      Math.abs(slot.x - wanted.x) + Math.abs(slot.y - wanted.y) + Math.abs(slot.z - wanted.z);
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Place a graph strictly: every edge orthogonally adjacent, every reserved
 * coordinate filled. Returns null when the walk runs out of options or budget.
 */
export function placeStrictly(
  graph: Graph,
  cube: Cube,
  entryCoord: Coord,
  reservedCoords: readonly Coord[],
  rng: Rng,
  budget = 12000,
  restarts = 12,
): Coord[] | null {
  const lists = neighbourLists(graph);
  // A promise made before this area existed is kept by giving one room the
  // reserved slot outright, rather than hoping the walk wanders onto it — and
  // by laying the rooms between here and there down first, before the space
  // that route needs has been spent on something else.
  const promised = assignReservations(graph, entryCoord, reservedCoords);
  const route = new Set<number>();
  for (const node of promised.keys()) for (const step of pathTo(graph, node)) route.add(step);
  const order = walkOrder(graph, route);
  const placements: (Coord | undefined)[] = Array.from({ length: graph.nodes }, () => undefined);
  const taken = new Set<string>();
  const reserved = new Set(reservedCoords.map(coordKey));
  let steps = 0;

  const freeNeighbours = (at: Coord): Coord[] =>
    ALL_DIRECTIONS.map((dir) => step(at, dir)).filter(
      (next) => cubeContains(cube, next) && !taken.has(coordKey(next)),
    );

  const put = (node: number, at: Coord) => {
    placements[node] = at;
    taken.add(coordKey(at));
  };
  const lift = (node: number) => {
    const at = placements[node];
    if (at) taken.delete(coordKey(at));
    placements[node] = undefined;
  };

  const candidatesFor = (node: number): Coord[] => {
    const placedNeighbours = (lists[node] ?? []).filter((other) => placements[other]);
    if (placedNeighbours.length === 0) return [];
    // Every edge must be drawable, so a candidate has to touch all of them.
    const first = placements[placedNeighbours[0] as number] as Coord;
    let cells = ALL_DIRECTIONS.map((dir) => step(first, dir));
    for (const other of placedNeighbours.slice(1)) {
      const at = placements[other] as Coord;
      const near = new Set(ALL_DIRECTIONS.map((dir) => coordKey(step(at, dir))));
      cells = cells.filter((cell) => near.has(coordKey(cell)));
    }
    const openNeeded = (lists[node] ?? []).filter((other) => !placements[other]).length;
    return cells.filter(
      (cell) =>
        cubeContains(cube, cell) &&
        !taken.has(coordKey(cell)) &&
        freeNeighbours(cell).length >= openNeeded,
    );
  };

  const pending = (): Coord[] =>
    [...reserved].filter((key) => !taken.has(key)).map(parseCoordKey);

  const rank = (cells: Coord[]): Coord[] => {
    const wanted = pending();
    return rng
      .shuffle(cells)
      .map((cell) => ({
        cell,
        score:
          // A reserved slot is a promise already made: take it when offered.
          (reserved.has(coordKey(cell)) ? 1000 : 0) +
          // Otherwise walk towards the nearest promise still outstanding, and
          // keep room to grow, or the walk paints itself into a corner and
          // spends the whole budget backing out again.
          freeNeighbours(cell).length -
          2 * nearestDistance(cell, wanted),
      }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.cell)
      // A wide fan-out at every level turns backtracking into an exhaustive
      // search of the cube. Six is plenty when the cube is half empty, and the
      // restarts below cover the orderings it cuts off.
      .slice(0, 6);
  };

  const remainingReservations = (fromIndex: number): boolean => {
    let unfilled = 0;
    for (const key of reserved) if (!taken.has(key)) unfilled++;
    return unfilled <= order.length - fromIndex;
  };

  const walk = (index: number): boolean => {
    if (index >= order.length) return [...reserved].every((key) => taken.has(key));
    if (++steps > budget) return false;
    if (!remainingReservations(index)) return false;

    const node = order[index] as number;
    // The room that owes a reserved slot takes that slot and nothing else;
    // every other room leaves reserved slots alone.
    const owed = promised.get(node);
    const cells = candidatesFor(node).filter((cell) =>
      owed ? coordKey(cell) === coordKey(owed) : !reserved.has(coordKey(cell)),
    );
    for (const cell of rank(cells)) {
      put(node, cell);
      if (walk(index + 1)) return true;
      lift(node);
    }
    return false;
  };

  if (!cubeContains(cube, entryCoord)) return null;

  // Restarts rather than one long search. A layout walk that has gone wrong
  // goes wrong early, and backing all the way out of a bad first branch costs
  // more than starting again with a different shuffle.
  for (let attempt = 0; attempt < restarts; attempt++) {
    placements.fill(undefined);
    taken.clear();
    steps = 0;
    put(order[0] as number, entryCoord);
    if (walk(1)) return placements as Coord[];
  }
  return null;
}

/**
 * Which room owes which reserved slot.
 *
 * A room can only sit `d` lattice steps from the entry if it is at least `d`
 * hops away along edges — and, because a lattice flips parity at every step,
 * an *odd* number of hops away when `d` is odd. The shallowest room that fits
 * both is picked, so the promise costs the layout as little slack as possible.
 */
function assignReservations(
  graph: Graph,
  entryCoord: Coord,
  reservedCoords: readonly Coord[],
): Map<number, Coord> {
  const hops = hopsFrom(graph, 0);
  const taken = new Set<number>([0]);
  const out = new Map<number, Coord>();

  for (const coord of reservedCoords) {
    const steps =
      Math.abs(coord.x - entryCoord.x) +
      Math.abs(coord.y - entryCoord.y) +
      Math.abs(coord.z - entryCoord.z);
    if (steps === 0) continue;
    let best: number | undefined;
    for (const [node, depth] of hops) {
      if (taken.has(node) || depth < steps || (depth - steps) % 2 !== 0) continue;
      if (best === undefined || depth < (hops.get(best) as number)) best = node;
    }
    if (best === undefined) continue; // out of reach; the caller reports it
    taken.add(best);
    out.set(best, coord);
  }
  return out;
}

/** Chebyshev distance to the nearest of `targets`, or 0 when there are none. */
function nearestDistance(from: Coord, targets: readonly Coord[]): number {
  let best = 0;
  for (const target of targets) {
    const distance = Math.max(
      Math.abs(target.x - from.x),
      Math.abs(target.y - from.y),
      Math.abs(target.z - from.z),
    );
    if (best === 0 || distance < best) best = distance;
  }
  return best;
}

/**
 * Place a graph the best way that still works: adjacent to at least one
 * connected room where the strict walk would give up. This is the bottom of
 * the ladder — `logAndAccept` — and every edge it cannot draw is reported.
 */
function placeLoosely(
  graph: Graph,
  cube: Cube,
  entryCoord: Coord,
  reservedCoords: readonly Coord[],
  rng: Rng,
): { placements: Coord[]; looseEdges: [number, number][] } {
  const lists = neighbourLists(graph);
  const order = walkOrder(graph);
  const placements: (Coord | undefined)[] = Array.from({ length: graph.nodes }, () => undefined);
  const taken = new Set<string>([coordKey(entryCoord)]);
  placements[order[0] as number] = entryCoord;

  const free = (cell: Coord) => cubeContains(cube, cell) && !taken.has(coordKey(cell));
  const wanted = reservedCoords.filter((coord) => cubeContains(cube, coord));

  for (const node of order.slice(1)) {
    const placedNeighbours = (lists[node] ?? []).filter((other) => placements[other]);
    const touching = rng.shuffle(
      placedNeighbours.flatMap((other) =>
        ALL_DIRECTIONS.map((dir) => step(placements[other] as Coord, dir)).filter(free),
      ),
    );
    const promise = wanted.find((coord) => free(coord) && touching.some((cell) => coordKey(cell) === coordKey(coord)));
    const anywhere = () => allSlots(cube).find(free);
    const at = promise ?? touching[0] ?? anywhere();
    if (!at) break; // the cube is full — the caller grows it and retries
    placements[node] = at;
    taken.add(coordKey(at));
  }

  const looseEdges: [number, number][] = [];
  for (const [a, b] of graph.edges) {
    const pa = placements[a];
    const pb = placements[b];
    if (!pa || !pb) continue;
    const near = ALL_DIRECTIONS.some((dir) => coordKey(step(pa, dir)) === coordKey(pb));
    if (!near) looseEdges.push([a, b]);
  }
  return { placements: placements as Coord[], looseEdges };
}

/**
 * Weave extra connections between rooms that ended up side by side.
 *
 * This is how a shape gets its density — a warren is dense because
 * neighbouring rooms all open into one another — and doing it here rather than
 * in the graph builder means every connection it adds is one the map can
 * draw, by construction.
 */
export function weaveChords(options: {
  placements: readonly Coord[];
  edges: readonly [number, number][];
  rng: Rng;
  wanted: number;
  maxDegree: number;
}): [number, number][] {
  const { placements, rng, wanted, maxDegree } = options;
  if (wanted <= 0) return [];

  const degree = placements.map(() => 0);
  const linked = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const [a, b] of options.edges) {
    linked.add(key(a, b));
    degree[a] = (degree[a] ?? 0) + 1;
    degree[b] = (degree[b] ?? 0) + 1;
  }

  const byCoord = new Map<string, number>();
  placements.forEach((coord, node) => byCoord.set(coordKey(coord), node));

  const pairs: [number, number][] = [];
  placements.forEach((coord, node) => {
    for (const dir of ALL_DIRECTIONS) {
      const other = byCoord.get(coordKey(step(coord, dir)));
      if (other === undefined || other <= node) continue;
      if (!linked.has(key(node, other))) pairs.push([node, other]);
    }
  });

  const woven: [number, number][] = [];
  for (const [a, b] of rng.shuffle(pairs)) {
    if (woven.length >= wanted) break;
    if ((degree[a] ?? 0) >= maxDegree || (degree[b] ?? 0) >= maxDegree) continue;
    degree[a] = (degree[a] ?? 0) + 1;
    degree[b] = (degree[b] ?? 0) + 1;
    woven.push([a, b]);
  }
  return woven;
}

/**
 * Lay a graph out, following `LAYOUT_FAILURE.order` from the rules when the
 * strict walk fails. The order is read from the table, not written here, so
 * retuning it is a table edit.
 */
export function layoutArea(request: LayoutRequest): LayoutResult {
  const { rules, rng } = request;
  const reserved = request.reservedCoords ?? [];
  const notes: string[] = [];
  const droppedEdges: [number, number][] = [];
  const slackStep = ruleNumber(rules, 'LAYOUT_FAILURE.repackSlackStep');
  const maxRepacks = ruleNumber(rules, 'LAYOUT_FAILURE.maxRepacks');

  let cube = request.cube;
  // A coordinate promised before this area existed may be right across the
  // cube, and only a branch long enough can reach it.
  let graph: Graph = reserved.length === 0 ? request.graph : stretchToDepth(request.graph, furthest(request.entryCoord, reserved));

  let promises: readonly Coord[] = reserved;
  const attempt = (): Coord[] | null =>
    placeStrictly(graph, cube, request.entryCoord, promises, rng);

  let placements = attempt();

  const stages = ruleArray(rules, 'LAYOUT_FAILURE.order').filter(
    (stage): stage is string => typeof stage === 'string',
  );

  for (const stage of stages) {
    if (placements) break;
    if (stage === 'repackWithMoreSlack') {
      for (let i = 1; i <= maxRepacks && !placements; i++) {
        const grown = request.growCube?.(1 + slackStep * i);
        if (grown) cube = grown;
        notes.push(`repack ${i} with ${Math.round(slackStep * i * 100)}% more slack`);
        placements = attempt();
      }
    } else if (stage === 'dropNonBridgeEdge') {
      // Only ever a non-bridge. A bridge would sever the area permanently.
      for (let i = 0; i < 3 && !placements; i++) {
        const index = graph.edges.findIndex((_, edgeIndex) => !isBridge(graph, edgeIndex));
        if (index < 0) {
          notes.push('every edge is a bridge, so none may be dropped');
          break;
        }
        const dropped = graph.edges[index] as [number, number];
        droppedEdges.push(dropped);
        graph = { nodes: graph.nodes, edges: graph.edges.filter((_, e) => e !== index) };
        notes.push(`dropped non-bridge edge ${dropped[0]}-${dropped[1]}`);
        placements = attempt();
      }
    } else if (stage === 'releaseReservedCoords') {
      // A promise is given up before the map is. An undrawable connection is a
      // wrong exit the player can see; a released coordinate is an objective
      // the quest system places somewhere else, and it is reported either way.
      if (promises.length > 0) {
        promises = [];
        notes.push('gave up a reserved coordinate to keep every connection drawable');
        placements = attempt();
      }
    } else if (stage === 'growCubeAndRetry') {
      const grown = request.growCube?.(1 + slackStep * (maxRepacks + 2));
      if (grown) {
        cube = grown;
        notes.push('grew the cube');
        placements = attempt();
      }
    }
  }

  if (placements) {
    return {
      graph,
      placements,
      droppedEdges,
      looseEdges: [],
      unfilledReservations: unfilled(reserved, placements),
      notes,
    };
  }

  const loose = placeLoosely(graph, cube, request.entryCoord, reserved, rng);
  notes.push(
    `layout accepted with ${loose.looseEdges.length} connection(s) the map cannot draw`,
  );
  return {
    graph,
    placements: loose.placements,
    droppedEdges,
    looseEdges: loose.looseEdges,
    unfilledReservations: unfilled(reserved, loose.placements),
    notes,
  };
}

/** The furthest reserved slot from the entry, in lattice steps. */
const furthest = (entryCoord: Coord, reserved: readonly Coord[]): number =>
  reserved.reduce(
    (most, coord) =>
      Math.max(
        most,
        Math.abs(coord.x - entryCoord.x) +
          Math.abs(coord.y - entryCoord.y) +
          Math.abs(coord.z - entryCoord.z),
      ),
    0,
  );

const unfilled = (reserved: readonly Coord[], placements: readonly Coord[]): Coord[] => {
  const taken = new Set(placements.filter(Boolean).map(coordKey));
  return reserved.filter((coord) => !taken.has(coordKey(coord)));
};

/**
 * The order rooms are placed in: grow outward from the entry, but put the
 * load-bearing structure down first.
 *
 * Two rules, both learned from watching the walk fail:
 *
 *  - **Rings before spurs.** A cycle has to close, and it can only close if
 *    the slots it needs are still free. A dead end placed early can sit in the
 *    gap the ring was going to use. So nodes on a cycle — everything left
 *    after leaves are peeled away — go down before anything hanging off them.
 *  - **Busy rooms early.** A four-way junction placed last has to find a slot
 *    with four free sides left. Placed early it takes one, and the quieter
 *    rooms fit around it.
 *
 * Every node still arrives after a room it connects to, which is what the
 * walk needs to have somewhere to put it.
 */
function walkOrder(graph: Graph, route: ReadonlySet<number> = new Set()): number[] {
  const lists = neighbourLists(graph);
  const degree = lists.map((list) => list.length);
  const core = cycleCore(graph);
  const depth = hopsFrom(graph, 0);

  const order = [0];
  const placed = new Set([0]);
  const frontier = new Set<number>(lists[0] ?? []);

  while (frontier.size > 0) {
    let best: number | undefined;
    let bestKey: [number, number, number, number] | undefined;
    for (const node of frontier) {
      const key: [number, number, number, number] = [
        // The route to a promised slot comes first: it is the one part of the
        // layout that has somewhere it must end up.
        route.has(node) ? 0 : 1,
        core.has(node) ? 0 : 1,
        -(degree[node] ?? 0),
        depth.get(node) ?? Number.MAX_SAFE_INTEGER,
      ];
      if (!bestKey || less(key, bestKey)) {
        best = node;
        bestKey = key;
      }
    }
    const node = best as number;
    frontier.delete(node);
    placed.add(node);
    order.push(node);
    for (const next of lists[node] ?? []) if (!placed.has(next)) frontier.add(next);
  }

  // A disconnected node cannot happen — the builders keep the graph whole —
  // but if one ever did, laying it out beats dropping it on the floor.
  for (let node = 0; node < graph.nodes; node++) if (!placed.has(node)) order.push(node);
  return order;
}

/** Lexicographic compare over the ordering key. */
const less = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
  }
  return false;
};

/** Everything left once dead ends are peeled away: the rooms on a cycle. */
function cycleCore(graph: Graph): Set<number> {
  const degree = neighbourLists(graph).map((list) => list.length);
  const lists = neighbourLists(graph);
  const alive = new Set(degree.map((_, node) => node));
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const node of [...alive]) {
      if ((degree[node] ?? 0) > 1) continue;
      alive.delete(node);
      peeled = true;
      for (const next of lists[node] ?? []) degree[next] = (degree[next] ?? 1) - 1;
      degree[node] = 0;
    }
  }
  return alive;
}

const allSlots = (cube: Cube): Coord[] => {
  const out: Coord[] = [];
  for (let z = cube.z0; z <= cube.z1; z++)
    for (let y = cube.y0; y <= cube.y1; y++)
      for (let x = cube.x0; x <= cube.x1; x++) out.push({ x, y, z });
  return out;
};
