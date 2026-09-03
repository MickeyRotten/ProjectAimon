/**
 * The world lattice — one X/Y/Z coordinate space for the whole campaign.
 *
 * The world runs **downward, in Rungs**. Each area is one Rung, and each Rung
 * owns a whole plane of Z all to itself: a newly allocated cube is placed
 * strictly *below* every cube already reserved. Because no two areas ever share
 * a Z level, two cubes can never overlap however their X/Y footprints fall —
 * which is why the old collision subsystem (probe, slide, nearest-free-cube) is
 * gone. Allocation is now a single downward step.
 *
 * A cube is still **reserved when a gate is created, not when the area behind
 * it is generated.** That ordering is the point: it is what lets a `Distant`
 * quest name a coordinate inside an area that is still nothing but a gate stub.
 *
 * The one rule that must never bend: **coordinates are identity and
 * allocation only.** Distance is hop count along edges. The moment anything
 * measures euclidean distance between two rooms, the filler-corridor problem
 * the coordinates were once removed for is back.
 *
 * Every number here — slack, gap, footprint ratio, bounds — is read from
 * `rules.json` at call time. None of them is written down twice.
 */

import type { JsonObject } from '../campaign/merge';
import { ruleLookup, ruleNumber, ruleRange } from '../engine/rules';
import {
  cubesOverlap,
  type Coord,
  type Cube,
  type Direction,
} from './types';

export interface CubeSize {
  w: number;
  h: number;
  d: number;
}

export interface AllocationRequest {
  /** The area asking for room. Used as the reservation key. */
  areaId: string;
  archetype: string;
  /** The most rooms the archetype may roll, so the cube always fits. */
  maxRooms: number;
  /** The room the gate leads out of. */
  gateCoord: Coord;
  gateDir: Direction;
}

export interface Allocation {
  cube: Cube;
  /**
   * Where the entry room lands: the slot on the cube's top face (its highest Z)
   * nearest the descending gate's X/Y. The descent itself is an edge, not a
   * lattice step, so the two rooms need not be one coordinate apart — the map
   * draws the crossing as a stair, per floor.
   */
  entryCoord: Coord;
  /**
   * Retained for callers that logged a "slide". A Rung never slides, so this is
   * always 0; kept so the shape does not churn across the reframe.
   */
  slid: number;
  /** A Rung always sits directly below its parent, so never a long road. */
  longRoad: boolean;
}

export class WorldLattice {
  private readonly cubes = new Map<string, Cube>();

  constructor(private readonly rules: JsonObject) {}

  /** Every reservation, in allocation order. */
  entries(): [string, Cube][] {
    return [...this.cubes.entries()];
  }

  cubeOf(areaId: string): Cube | undefined {
    return this.cubes.get(areaId);
  }

  /** Reserve a cube outright. The Hub is placed this way, before anything else. */
  reserve(areaId: string, cube: Cube): void {
    this.cubes.set(areaId, { ...cube });
  }

  release(areaId: string): void {
    this.cubes.delete(areaId);
  }

  /**
   * Cube dimensions for a room count.
   *
   *   slots  = ceil(rooms x slotsPerRoom)
   *   ratio  = footprint w:h by archetype (1 = square)
   *   h      = ceil(sqrt(slots / ratio)), w = ceil(sqrt(slots x ratio))
   *   zSpan  = by archetype
   *
   * A per-archetype ratio replaces the old `ceil(sqrt(slots))` square. That
   * square was the geometric root of the claustrophobia — a Rung packed 60%
   * full with equal sides has no long axis and no corridors. A long, thin
   * farmland Rung and a squarish town Rung read differently the moment you
   * walk them, and a non-square footprint is a hard prerequisite for any
   * hand-authored layout too, since the cube is allocated before the layout is
   * drawn.
   *
   * Both dimensions round up independently rather than solving for the
   * smallest w*h that covers `slots` exactly — that tighter form packs a large
   * area almost airtight (a 20-room farmland comes out with zero spare cells),
   * leaving the layout walk nowhere to step sideways when a placement
   * collides. Rounding up on both axes reproduces the old formula's slack —
   * at `ratio = 1` this is `ceil(sqrt(slots))` on both sides, identical to
   * before — while still stretching the footprint the right way.
   */
  sizeFor(archetype: string, rooms: number, slackMultiplier = 1): CubeSize {
    const slotsPerRoom = ruleNumber(this.rules, 'WORLD.cubeSizing.slotsPerRoom');
    const slots = Math.ceil(Math.max(1, rooms) * slotsPerRoom * slackMultiplier);
    const ratio = Math.max(0.1, this.footprintRatio(archetype));
    const h = Math.max(1, Math.ceil(Math.sqrt(slots / ratio)));
    const w = Math.max(1, Math.ceil(Math.sqrt(slots * ratio)));
    const zSpan = ruleLookup(this.rules, 'WORLD.cubeSizing.zSpanByArchetype', archetype);
    return { w, h, d: Math.max(1, zSpan) };
  }

  /** The footprint w:h ratio for an archetype; `default` is a square. */
  private footprintRatio(archetype: string): number {
    return ruleLookup(this.rules, 'WORLD.cubeSizing.footprintRatioByArchetype', archetype);
  }

  /**
   * Reserve a cube for the area behind a gate — one Rung lower.
   *
   * The world is a downward stack, so every new cube is placed strictly *below*
   * every cube already reserved: its top face sits one gap under the current
   * deepest level, and it extends down by the archetype's Z span. Because each
   * Rung owns its own Z levels, no two cubes can ever overlap in X/Y, so there
   * is nothing to slide around and nothing to probe. The footprint is centred
   * under the gate's X/Y so the descent reads as going down through the map
   * rather than shooting off sideways, and the entry room lands on the cube's
   * top face nearest that column.
   */
  allocate(request: AllocationRequest): Allocation {
    const size = this.sizeFor(request.archetype, request.maxRooms);
    const gap = ruleNumber(this.rules, 'WORLD.cubeSizing.gap');

    // The top of the new cube sits one gap below the deepest level any cube
    // currently reaches. The Hub is the first reservation, so the first Rung
    // drops just beneath it.
    const z1 = this.deepestFloor() - gap - 1;
    const z0 = z1 - (size.d - 1);

    // Centre the footprint under the descending gate's column.
    const x0 = request.gateCoord.x - Math.floor((size.w - 1) / 2);
    const y0 = request.gateCoord.y - Math.floor((size.h - 1) / 2);
    const cube: Cube = { x0, y0, z0, x1: x0 + size.w - 1, y1: y0 + size.h - 1, z1 };

    this.cubes.set(request.areaId, cube);
    // The entry room takes the top face, in the column nearest the gate.
    const entryCoord: Coord = {
      x: Math.min(Math.max(request.gateCoord.x, cube.x0), cube.x1),
      y: Math.min(Math.max(request.gateCoord.y, cube.y0), cube.y1),
      z: cube.z1,
    };
    return { cube, entryCoord, slid: 0, longRoad: false };
  }

  /** The lowest Z any reserved cube reaches, or 0 when nothing is reserved. */
  private deepestFloor(): number {
    let low = 0;
    for (const cube of this.cubes.values()) low = Math.min(low, cube.z0);
    return low;
  }

  /**
   * Enlarge a reserved cube, which is step three of the layout-failure ladder.
   * Returns the new cube, or undefined when a neighbour is in the way — the
   * caller then falls through to logging and accepting, never to dropping a
   * bridge edge.
   */
  grow(areaId: string, archetype: string, rooms: number, slackMultiplier: number): Cube | undefined {
    const current = this.cubes.get(areaId);
    if (!current) return undefined;
    const size = this.sizeFor(archetype, rooms, slackMultiplier);
    const gap = ruleNumber(this.rules, 'WORLD.cubeSizing.gap');
    const grown: Cube = {
      x0: current.x0,
      y0: current.y0,
      z0: current.z0,
      x1: Math.max(current.x1, current.x0 + size.w - 1),
      y1: Math.max(current.y1, current.y0 + size.h - 1),
      z1: Math.max(current.z1, current.z0 + size.d - 1),
    };
    if (!this.isFree(grown, areaId, gap) || !this.inBounds(grown)) return undefined;
    this.cubes.set(areaId, grown);
    return grown;
  }

  /** Is a cube clear of every reservation but its own, allowing for the gap? */
  isFree(cube: Cube, exceptAreaId: string, gap: number): boolean {
    for (const [id, other] of this.cubes) {
      if (id === exceptAreaId) continue;
      if (cubesOverlap(cube, other, gap)) return false;
    }
    return true;
  }

  inBounds(cube: Cube): boolean {
    const [x0, x1] = ruleRange(this.rules, 'WORLD.bounds.x');
    const [y0, y1] = ruleRange(this.rules, 'WORLD.bounds.y');
    const [z0, z1] = ruleRange(this.rules, 'WORLD.bounds.z');
    return cube.x0 >= x0 && cube.x1 <= x1 && cube.y0 >= y0 && cube.y1 <= y1 && cube.z0 >= z0 && cube.z1 <= z1;
  }
}
