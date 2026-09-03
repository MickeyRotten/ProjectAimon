import { describe, expect, it } from 'vitest';
import rules from '../campaigns/base/rules.json';
import type { JsonObject } from '../src/campaign/merge';
import { WorldLattice } from '../src/world/lattice';
import { cubeContains, cubeSlots, cubesOverlap, type Coord, type Cube } from '../src/world/types';

const RULES = rules as unknown as JsonObject;
const HUB: Cube = { x0: 0, y0: 0, z0: 0, x1: 2, y1: 2, z1: 0 };

describe('cube sizing', () => {
  const lattice = new WorldLattice(RULES);

  it('sizes the footprint to the room count', () => {
    // slots = ceil(rooms x 1.4); h = ceil(sqrt(slots/ratio)), w = ceil(sqrt(slots*ratio)).
    // farmland's footprint ratio (1.6) stretches this into a long rectangle
    // rather than the old square — the geometric fix for the claustrophobia.
    expect(lattice.sizeFor('farmland', 9)).toEqual({ w: 5, h: 3, d: 1 });
    expect(lattice.sizeFor('farmland', 12)).toEqual({ w: 6, h: 4, d: 1 });
    expect(lattice.sizeFor('farmland', 15)).toEqual({ w: 6, h: 4, d: 1 });
    expect(lattice.sizeFor('farmland', 20)).toEqual({ w: 7, h: 5, d: 1 });
  });

  it('stays square at ratio 1, reproducing the pre-Rungs formula exactly', () => {
    // town's ratio is 1, so this is ceil(sqrt(slots)) on both sides — the
    // doc's original worked examples, unchanged for an archetype that asks
    // for a square.
    expect(lattice.sizeFor('town', 9)).toEqual({ w: 4, h: 4, d: 1 });
    expect(lattice.sizeFor('town', 12)).toEqual({ w: 5, h: 5, d: 1 });
    expect(lattice.sizeFor('town', 15)).toEqual({ w: 5, h: 5, d: 1 });
    expect(lattice.sizeFor('town', 20)).toEqual({ w: 6, h: 6, d: 1 });
  });

  it('gives warrens depth and ruins a little', () => {
    expect(lattice.sizeFor('warren', 12).d).toBe(3);
    expect(lattice.sizeFor('ruin', 12).d).toBe(2);
    expect(lattice.sizeFor('town', 12).d).toBe(1);
  });

  it('leaves a cube roughly half empty, so the layout walk can step sideways', () => {
    const cube = { x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 0 };
    expect(cubeSlots(cube)).toBe(25);
    expect(12 / cubeSlots(cube)).toBeGreaterThan(0.4);
  });
});

describe('allocation', () => {
  const allocate = (lattice: WorldLattice, areaId: string, archetype: string, gateCoord: Coord, dir: 'n' | 's' | 'e' | 'w' | 'u' | 'd') =>
    lattice.allocate({ areaId, archetype, maxRooms: 15, gateCoord, gateDir: dir });

  it('puts the new cube one Rung below the gate, and the entry room on its top face', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    const down = allocate(lattice, 'farmland_1', 'farmland', { x: 2, y: 2, z: 0 }, 'd');
    // Strictly below the Hub, with the configured gap between them.
    expect(down.cube.z1).toBeLessThan(HUB.z0);
    expect(cubeContains(down.cube, down.entryCoord)).toBe(true);
    // The entry room sits on the cube's top face, in the column nearest the
    // gate — a one-step descent reads as a stair, not a journey.
    expect(down.entryCoord.z).toBe(down.cube.z1);
    expect(down.longRoad).toBe(false);
  });

  it('drops a warren below the area it was entered from', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    const warren = allocate(lattice, 'warren_1', 'warren', { x: 1, y: 1, z: 0 }, 'n');
    expect(warren.entryCoord.z).toBe(-2);
    expect(warren.cube.z0).toBeLessThan(0);
  });

  it('never overlaps a reservation — every Rung takes a fresh plane below every one already reserved', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    // A chain of descents, each starting from the last one's entry column.
    // With no two Rungs ever sharing a Z level, collision cannot happen
    // however their X/Y footprints fall — there is nothing left to slide.
    const first = allocate(lattice, 'a', 'farmland', { x: 1, y: 1, z: 0 }, 'd');
    const second = allocate(lattice, 'b', 'town', { x: 2, y: 2, z: first.cube.z1 }, 'd');
    const third = allocate(lattice, 'c', 'warren', { x: 0, y: 0, z: second.cube.z1 }, 'd');

    expect(first.slid).toBe(0);
    expect(second.slid).toBe(0);
    expect(third.slid).toBe(0);
    for (const [id, cube] of lattice.entries()) {
      for (const [otherId, other] of lattice.entries()) {
        if (id === otherId) continue;
        expect(cubesOverlap(cube, other, 1), `${id} overlaps ${otherId}`).toBe(false);
      }
    }
    // Each Rung sits strictly below the one before it, gap included.
    expect(first.cube.z1).toBeLessThan(HUB.z0);
    expect(second.cube.z1).toBeLessThan(first.cube.z0);
    expect(third.cube.z1).toBeLessThan(second.cube.z0);
  });

  it('grows a cube only when nothing is in the way', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    const before = allocate(lattice, 'a', 'farmland', { x: 2, y: 1, z: 0 }, 'e').cube;
    const grown = lattice.grow('a', 'farmland', 15, 1.6) as Cube;
    expect(grown).toBeDefined();
    expect(cubeSlots(grown)).toBeGreaterThan(cubeSlots(before));
    expect(lattice.isFree(grown, 'a', 1)).toBe(true);

    // A neighbour pressed up against it blocks the growth instead.
    const blocked = new WorldLattice(RULES);
    blocked.reserve('a', { x0: 0, y0: 0, z0: 0, x1: 2, y1: 2, z1: 0 });
    blocked.reserve('b', { x0: 4, y0: 0, z0: 0, x1: 6, y1: 2, z1: 0 });
    expect(blocked.grow('a', 'farmland', 15, 2)).toBeUndefined();
  });

  it('stays inside the world bounds', () => {
    const lattice = new WorldLattice(RULES);
    const rung = allocate(lattice, 'edge', 'farmland', { x: 0, y: 0, z: 0 }, 'd');
    expect(lattice.inBounds(rung.cube)).toBe(true);
    // Z runs as wide as X/Y, deliberately, so an open descent never runs out
    // of Rungs — thousands of floors down is still comfortably in bounds.
    const deep: Cube = { x0: 0, y0: 0, z0: -3000, x1: 5, y1: 5, z1: -3000 };
    expect(lattice.inBounds(deep)).toBe(true);
  });
});
