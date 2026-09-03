/**
 * What may be reached at what depth.
 *
 * Under the stack every area owns a whole Z plane to itself — a newly
 * allocated cube always sits strictly below every cube already reserved, so
 * two areas can never stand "beside" each other however their footprints
 * fall. The affinity matrix this file used to hold (what may stand next to
 * what) is retired along with that possibility: `content/adjacency.json`
 * keeps only `depthGate`, a fence on *when* an archetype may be reached at
 * all, which is what actually kept the coven a find rather than a trip-over.
 */
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { World } from '../src/world/world';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const adjacency = campaign.adjacency;

const SEEDS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];

/** The generated areas, which never includes the hand-authored Hub. */
const generatedAreas = (world: World) =>
  [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');

/**
 * Walk through gates until `wanted` areas have actually been generated —
 * `world.areas` also holds a stub behind every uncrossed gate, so counting it
 * would stop after two or three real areas.
 */
function explore(world: World, wanted: number): void {
  while (generatedAreas(world).length < wanted) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

interface Run {
  seed: string;
  world: World;
}

const worlds = (areas: number): Run[] =>
  SEEDS.map((seed) => {
    const world = World.create({ campaign, seed });
    explore(world, areas);
    return { seed, world };
  });

describe('the stack retires "beside"', () => {
  it('never lets two areas share a Z level, so nothing can ever stand next to anything', () => {
    // The structural guarantee the affinity matrix used to enforce by table —
    // now it holds unconditionally, by allocation.
    for (const { seed, world } of worlds(14)) {
      const cubes = world.lattice.entries();
      for (let i = 0; i < cubes.length; i++) {
        for (let j = i + 1; j < cubes.length; j++) {
          const [aId, a] = cubes[i] as [string, { z0: number; z1: number }];
          const [bId, b] = cubes[j] as [string, { z0: number; z1: number }];
          const shareAZLevel = a.z0 <= b.z1 && b.z0 <= a.z1;
          expect(shareAZLevel, `${aId} shares a Z level with ${bId} in ${seed}`).toBe(false);
        }
      }
    }
  });
});

describe('depth gates', () => {
  it('keeps a coven out of the shallows entirely', () => {
    // It is not enough that it is rare near the Hub: `minDepth` means never.
    const min = adjacency.depthGate['coven']?.minDepth as number;
    expect(min).toBeGreaterThan(1);
    for (const { seed, world } of worlds(14)) {
      for (const area of world.areas.values()) {
        if (area.archetype !== 'coven') continue;
        expect(area.depth, `${area.id} in ${seed}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('still lets the coven exist — it was unreachable before this table', () => {
    // No area's gate table named `coven`, so it never spawned at all and the
    // rule "a coven should not neighbour a town" was true only by accident.
    const found = worlds(16).some(({ world }) =>
      [...world.areas.values()].some((area) => area.archetype === 'coven'),
    );
    expect(found).toBe(true);
  });
});

describe('the world still opens up', () => {
  it('does not turn filtered gates into dead ends', () => {
    // A rejection loop here would burn the candidate room and strand areas.
    // Scoring once and picking once is what keeps this true.
    for (const { seed, world } of worlds(12)) {
      const generated = generatedAreas(world);
      expect(generated.length, `in ${seed}`).toBeGreaterThanOrEqual(12);
      const onward = generated.filter((area) =>
        [...world.edges.values()].some(
          (edge) => edge.gateAreaId && world.rooms.get(edge.roomA)?.areaId === area.id,
        ),
      );
      expect(onward.length / generated.length, `in ${seed}`).toBeGreaterThan(0.8);
    }
  });

  it('still reaches every archetype the gate tables name', () => {
    const seen = new Set<string>();
    for (const { world } of worlds(16)) {
      for (const area of world.areas.values()) seen.add(area.archetype);
    }
    for (const id of campaign.areas.keys()) expect([...seen]).toContain(id);
  });
});
