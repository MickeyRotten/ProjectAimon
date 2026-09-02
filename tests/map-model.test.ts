import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { World } from '../src/world/world';
import { floorLabel, mapModel, type MapCell } from '../src/world/map';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

/** Mark rooms visited the way the turn loop's visit effect would. */
function visit(world: World, ...ids: string[]): void {
  for (const id of ids) {
    const room = world.rooms.get(id);
    if (room) room.visited = true;
  }
}

const kinds = (cells: MapCell[], kind: string) => cells.filter((cell) => cell.kind === kind);

describe('floorLabel', () => {
  it('reads ground and up as F, below ground as B', () => {
    expect(floorLabel(0)).toBe('F1');
    expect(floorLabel(1)).toBe('F2');
    expect(floorLabel(-1)).toBe('B1');
    expect(floorLabel(-2)).toBe('B2');
  });
});

describe('mapModel', () => {
  it('marks the current room, and its unentered neighbours as frontier', () => {
    const world = World.create({ campaign, seed: 'map-here' });
    visit(world, 'hub_yard');
    const model = mapModel(world, 'hub_yard', { radius: 2 });
    expect(model).toBeDefined();

    const here = kinds(model!.cells, 'here');
    expect(here).toHaveLength(1);
    expect(here[0]!.label).toContain('here');

    // The yard's four neighbours (hall, armoury, bank, post) are one step out
    // from a walked room, so they are frontier — shown with a '?'.
    const frontier = kinds(model!.cells, 'frontier');
    expect(frontier.length).toBe(4);
    for (const cell of frontier) expect(cell.glyph).toBe('?');
  });

  it('never reveals a room two steps out from anywhere walked', () => {
    const world = World.create({ campaign, seed: 'map-ring' });
    visit(world, 'hub_yard');
    const model = mapModel(world, 'hub_yard', { radius: 2 })!;
    // hub_gate sits two steps from the yard (past hub_bank), and hub_bank is
    // not walked, so hub_gate is not known yet — no cell for it.
    const gate = world.rooms.get('hub_gate')!;
    const shown = model.cells.some(
      (cell) =>
        cell.gc === 2 * (gate.x - (world.rooms.get('hub_yard')!.x - 2)) + 1 &&
        cell.gr === 2 * (gate.y - (world.rooms.get('hub_yard')!.y - 2)) + 1,
    );
    expect(shown).toBe(false);
  });

  it('draws a connector between a walked room and a frontier neighbour', () => {
    const world = World.create({ campaign, seed: 'map-conn' });
    visit(world, 'hub_yard');
    const model = mapModel(world, 'hub_yard', { radius: 2 })!;
    // Four real connections leave the yard, each toward a frontier cell.
    const solid = model.connectors.filter((connector) => !connector.stub);
    expect(solid.length).toBe(4);
  });

  it('reveals a gate as a way out once the room holding it is walked', () => {
    const world = World.create({ campaign, seed: 'map-gate' });
    // Walk to the gate room, so its ways out of the area become gate cells.
    visit(world, 'hub_yard', 'hub_bank', 'hub_gate');
    const model = mapModel(world, 'hub_gate', { radius: 2 })!;
    const gates = kinds(model.cells, 'gate');
    expect(gates.length).toBeGreaterThan(0);
    for (const cell of gates) expect(cell.label).toBe('a way out');
  });
});
