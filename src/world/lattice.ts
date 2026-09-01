/**
 * The world lattice — one X/Y/Z coordinate space for the whole campaign.
 *
 * Areas are allocated non-overlapping cubes inside it, and **a cube is
 * reserved when a gate is created, not when the area behind it is generated.**
 * That ordering is the point: it is what lets a `Distant` quest name a
 * coordinate inside an area that is still nothing but a gate stub.
 *
 * The one rule that must never bend: **coordinates are identity and
 * allocation only.** Distance is hop count along edges. The moment anything
 * measures euclidean distance between two rooms, the filler-corridor problem
 * the coordinates were once removed for is back.
 *
 * Every number here — slack, gap, z offsets, slide attempts, bounds — is read
 * from `rules.json` at call time. None of them is written down twice.
 */

import type { JsonObject } from '../campaign/merge';
import { ruleLookup, ruleNumber, ruleNumberMap, ruleRange } from '../engine/rules';
import {
  cubeContains,
  cubesOverlap,
  DIRECTIONS,
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
   * Where the entry room must go: the slot on the incoming face nearest the
   * gate. A one-hop crossing then costs one lattice step, and the crossing
   * reads as a step rather than a journey.
   */
  entryCoord: Coord;
  /** Slots the cube was pushed along the gate axis to dodge a neighbour. */
  slid: number;
  /** True when sliding failed and the area went wherever there was room. */
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
   *   slots     = ceil(rooms x slotsPerRoom)
   *   footprint = ceil(sqrt(slots))
   *   zSpan     = by archetype
   *
   * Sizing to the room count is half of what makes filler rooms unnecessary:
   * the shape stays solid enough to read as a place and open enough that the
   * layout walk can resolve a collision by stepping sideways.
   */
  sizeFor(archetype: string, rooms: number, slackMultiplier = 1): CubeSize {
    const slotsPerRoom = ruleNumber(this.rules, 'WORLD.cubeSizing.slotsPerRoom');
    const slots = Math.ceil(Math.max(1, rooms) * slotsPerRoom * slackMultiplier);
    const footprint = Math.max(1, Math.ceil(Math.sqrt(slots)));
    const zSpan = ruleLookup(this.rules, 'WORLD.cubeSizing.zSpanByArchetype', archetype);
    return { w: footprint, h: footprint, d: Math.max(1, zSpan) };
  }

  /**
   * Reserve a cube for the area behind a gate.
   *
   * It goes adjacent to the source area along the gate's direction, offset in
   * Z by archetype — a warren gate drops two levels, so a warren can sit
   * beneath farmland without either knowing about the other. Collisions slide
   * outward along the gate axis; when the slide is exhausted the area takes
   * the nearest free cube and the crossing is logged as a long road.
   */
  allocate(request: AllocationRequest): Allocation {
    const size = this.sizeFor(request.archetype, request.maxRooms);
    const gap = ruleNumber(this.rules, 'WORLD.cubeSizing.gap');
    const maxSlides = ruleNumber(this.rules, 'WORLD.allocation.maxSlideAttempts');
    const zOffsets = ruleNumberMap(this.rules, 'WORLD.allocation.zOffsetByArchetype');
    const v = DIRECTIONS[request.gateDir];
    const vertical = v.z !== 0;

    // The slot the entry room wants: one step beyond the gate, plus the gap,
    // dropped to the archetype's own level when the gate runs horizontally.
    const zOffset = vertical ? 0 : (zOffsets[request.archetype] ?? 0);
    const wanted: Coord = {
      x: request.gateCoord.x + v.x * (gap + 1),
      y: request.gateCoord.y + v.y * (gap + 1),
      z: request.gateCoord.z + v.z * (gap + 1) + zOffset,
    };

    for (let slide = 0; slide <= maxSlides; slide++) {
      const anchor: Coord = {
        x: wanted.x + v.x * slide,
        y: wanted.y + v.y * slide,
        z: wanted.z + v.z * slide,
      };
      const cube = this.cubeAround(anchor, request.gateDir, size);
      if (this.isFree(cube, request.areaId, gap) && this.inBounds(cube)) {
        this.cubes.set(request.areaId, cube);
        return { cube, entryCoord: this.faceSlot(cube, anchor, request.gateDir), slid: slide, longRoad: false };
      }
    }

    const cube = this.nearestFreeCube(wanted, size, request.areaId, gap);
    this.cubes.set(request.areaId, cube);
    return { cube, entryCoord: this.faceSlot(cube, wanted, request.gateDir), slid: maxSlides, longRoad: true };
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

  /**
   * Build a cube whose incoming face holds `anchor`: the cube extends away
   * from the gate along its axis, and is centred on the anchor across the
   * other two.
   */
  private cubeAround(anchor: Coord, dir: Direction, size: CubeSize): Cube {
    const v = DIRECTIONS[dir];
    const spanOn = (axis: 'x' | 'y' | 'z') => (axis === 'x' ? size.w : axis === 'y' ? size.h : size.d);
    const range = (axis: 'x' | 'y' | 'z'): [number, number] => {
      const span = spanOn(axis);
      const at = anchor[axis];
      const step = v[axis];
      if (step > 0) return [at, at + span - 1]; // travelling up this axis
      if (step < 0) return [at - span + 1, at]; // travelling down it
      const before = Math.floor((span - 1) / 2);
      return [at - before, at - before + span - 1]; // across it: centre on the anchor
    };
    const [x0, x1] = range('x');
    const [y0, y1] = range('y');
    const [z0, z1] = range('z');
    return { x0, y0, z0, x1, y1, z1 };
  }

  /**
   * The slot inside `cube` closest to `wanted` — the entry room's coordinate
   * once sliding or a long road has moved the cube away from the gate.
   */
  private faceSlot(cube: Cube, wanted: Coord, _dir: Direction): Coord {
    if (cubeContains(cube, wanted)) return wanted;
    return {
      x: Math.min(Math.max(wanted.x, cube.x0), cube.x1),
      y: Math.min(Math.max(wanted.y, cube.y0), cube.y1),
      z: Math.min(Math.max(wanted.z, cube.z0), cube.z1),
    };
  }

  /**
   * Last resort: the free cube nearest the wanted slot, searched outward in
   * rings. The caller logs a long road, because the crossing now spans more
   * of the world map than one step.
   */
  private nearestFreeCube(wanted: Coord, size: CubeSize, areaId: string, gap: number): Cube {
    const stride = Math.max(size.w, size.h) + gap;
    for (let ring = 1; ring <= 64; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const origin: Coord = { x: wanted.x + dx * stride, y: wanted.y + dy * stride, z: wanted.z };
          const cube: Cube = {
            x0: origin.x,
            y0: origin.y,
            z0: origin.z,
            x1: origin.x + size.w - 1,
            y1: origin.y + size.h - 1,
            z1: origin.z + size.d - 1,
          };
          if (this.isFree(cube, areaId, gap) && this.inBounds(cube)) return cube;
        }
      }
    }
    // Nothing free within sixty-four rings means the lattice is full, which at
    // eight thousand slots a side it never is. Take the wanted spot and let the
    // caller log it rather than failing a generation the player is standing in.
    return {
      x0: wanted.x,
      y0: wanted.y,
      z0: wanted.z,
      x1: wanted.x + size.w - 1,
      y1: wanted.y + size.h - 1,
      z1: wanted.z + size.d - 1,
    };
  }
}
