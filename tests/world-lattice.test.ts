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
    // slots = ceil(rooms x 1.4), footprint = ceil(sqrt(slots)) — the doc's
    // worked examples, read straight off the table.
    expect(lattice.sizeFor('farmland', 9)).toEqual({ w: 4, h: 4, d: 1 });
    expect(lattice.sizeFor('farmland', 12)).toEqual({ w: 5, h: 5, d: 1 });
    expect(lattice.sizeFor('farmland', 15)).toEqual({ w: 5, h: 5, d: 1 });
    expect(lattice.sizeFor('farmland', 20)).toEqual({ w: 6, h: 6, d: 1 });
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

  it('puts the new cube beyond the gate, and the entry room on its near face', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    const east = allocate(lattice, 'farmland_1', 'farmland', { x: 2, y: 2, z: 0 }, 'e');
    expect(east.cube.x0).toBeGreaterThan(HUB.x1);
    expect(cubeContains(east.cube, east.entryCoord)).toBe(true);
    expect(east.entryCoord.x).toBe(east.cube.x0);
    expect(east.longRoad).toBe(false);
  });

  it('drops a warren below the area it was entered from', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    const warren = allocate(lattice, 'warren_1', 'warren', { x: 1, y: 1, z: 0 }, 'n');
    expect(warren.entryCoord.z).toBe(-2);
    expect(warren.cube.z0).toBeLessThan(0);
  });

  it('never overlaps a reservation, and keeps the gap between them', () => {
    const lattice = new WorldLattice(RULES);
    lattice.reserve('hub', HUB);
    // Two gates leaving the same room in the same direction: the second has to
    // slide rather than land on top of the first.
    const first = allocate(lattice, 'a', 'farmland', { x: 2, y: 1, z: 0 }, 'e');
    const second = allocate(lattice, 'b', 'farmland', { x: 2, y: 2, z: 0 }, 'e');
    expect(cubesOverlap(first.cube, second.cube, 1)).toBe(false);
    expect(second.slid).toBeGreaterThan(0);

    for (const [id, cube] of lattice.entries()) {
      for (const [otherId, other] of lattice.entries()) {
        if (id === otherId) continue;
        expect(cubesOverlap(cube, other, 1), `${id} overlaps ${otherId}`).toBe(false);
      }
    }
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
    const far = allocate(lattice, 'edge', 'farmland', { x: 3999, y: 0, z: 0 }, 'e');
    expect(lattice.inBounds(far.cube)).toBe(true);
  });
});
