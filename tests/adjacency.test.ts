/**
 * What may be built beside what.
 *
 * Area kind used to be a flat weighted roll off the source area's `gates`
 * table, which cannot see the case that actually matters: two areas become
 * neighbours through a *third* one's allocation, without either table naming
 * the other. So a coven could end up sharing a wall with a town however the
 * gate weights were tuned. These tests hold both layers — the directional gate
 * tables and the spatial affinity pass — and the invariant that neither may
 * strangle the world into dead ends.
 */
import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { cubesOverlap } from '../src/world/types';
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

/** Every pair of areas whose cubes sit within the adjacency radius. */
function neighbourPairs(world: World): [string, string][] {
  const cubes = world.lattice.entries();
  const out: [string, string][] = [];
  for (let i = 0; i < cubes.length; i++) {
    for (let j = i + 1; j < cubes.length; j++) {
      const [aId, a] = cubes[i] as [string, never];
      const [bId, b] = cubes[j] as [string, never];
      if (!cubesOverlap(a, b, adjacency.radius)) continue;
      const aKind = world.areas.get(aId)?.archetype;
      const bKind = world.areas.get(bId)?.archetype;
      if (aKind && bKind) out.push([aKind, bKind]);
    }
  }
  return out;
}

describe('the affinity table', () => {
  it('never stands a coven beside a town', () => {
    // The rule the whole feature was asked for. Zero in the table means zero
    // on the ground, not "rarely".
    expect(adjacency.affinity['coven']?.['town']).toBe(0);
    for (const { seed, world } of worlds(14)) {
      for (const [a, b] of neighbourPairs(world)) {
        const pair = [a, b].sort().join('+');
        expect(pair, `in ${seed}`).not.toBe('coven+town');
      }
    }
  });

  it('honours every zero in the table, both ways round', () => {
    const forbidden = new Set<string>();
    for (const [candidate, row] of Object.entries(adjacency.affinity)) {
      for (const [neighbour, weight] of Object.entries(row)) {
        if (weight === 0) forbidden.add([candidate, neighbour].sort().join('+'));
      }
    }
    expect(forbidden.size).toBeGreaterThan(0);
    for (const { seed, world } of worlds(14)) {
      for (const [a, b] of neighbourPairs(world)) {
        expect(forbidden.has([a, b].sort().join('+')), `${a}+${b} in ${seed}`).toBe(false);
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
