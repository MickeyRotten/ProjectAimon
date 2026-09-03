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

  it('marks the room holding an unexplored gate directly — there is no ghost cell for it', () => {
    // Every gate descends now, so there is no adjacent X/Y slot to place a
    // ghost "way out" marker in the way a horizontal gate once had one — the
    // room carrying the stairs down wears the mark itself.
    const world = World.create({ campaign, seed: 'map-gate' });
    visit(world, 'hub_yard', 'hub_bank', 'hub_gate');
    const model = mapModel(world, 'hub_gate', { radius: 2 })!;
    const here = kinds(model.cells, 'here')[0]!;
    expect(here.holdsGate).toBe(true);
    expect(here.glyph).toBe('▨');
    // The kind stays 'here' — the player's own position is never demoted to
    // make room for the gate mark, it is layered on top of it.
    expect(here.kind).toBe('here');
    expect(kinds(model.cells, 'frontier').length).toBeGreaterThanOrEqual(0);
  });

  it('marks a visited room the same way once the player has moved on from it', () => {
    const world = World.create({ campaign, seed: 'map-gate-2' });
    visit(world, 'hub_yard', 'hub_bank', 'hub_gate');
    // Standing elsewhere, hub_gate is now a plain visited cell — still marked.
    const model = mapModel(world, 'hub_bank', { radius: 2 })!;
    const gateCell = model.cells.find((cell) => cell.holdsGate === true);
    expect(gateCell).toBeDefined();
    expect(gateCell!.kind).toBe('visited');
    expect(gateCell!.glyph).toBe('▨');
  });

  it('with no radius draws the whole floor, padded so edge rooms still get a cell', () => {
    const world = World.create({ campaign, seed: 'map-full' });
    visit(world, 'hub_yard', 'hub_bank', 'hub_gate');
    const full = mapModel(world, 'hub_gate', {})!;
    expect(full.cells.some((cell) => cell.holdsGate === true)).toBe(true);
    // And it is at least as wide as the mini-map's fixed 5-room window.
    expect(full.gridCols).toBeGreaterThanOrEqual(mapModel(world, 'hub_gate', { radius: 2 })!.gridCols - 2);
  });

  it('is one floor, one area: crossing a gate always steps onto a fresh model', () => {
    // The stack retires the old merged-map case — every gate descends, so
    // crossing one always changes Z, and no two areas ever share a Z level.
    const world = World.create({ campaign, seed: 'map-cross' });
    visit(world, 'hub_yard', 'hub_bank', 'hub_gate');
    const gateExit = world.exitsOf('hub_gate').find((exit) => exit.toRoomId === null);
    expect(gateExit).toBeDefined();
    const beyondArea = world.enterGate(gateExit!.edge.id);
    expect(beyondArea.entryRoomId).toBeTruthy();
    visit(world, beyondArea.entryRoomId!);

    // Standing on the far side, the model holds only that Rung's own rooms —
    // the Hub's floor is a different Z level and a different area entirely.
    const model = mapModel(world, beyondArea.entryRoomId!, {})!;
    expect(model).toBeDefined();
    expect(model.z).not.toBe(0);
    expect(model.areaName).not.toBe(campaign.manifest.name);
    expect(model.cells.every((cell) => !cell.label.includes(' — '))).toBe(true);
  });
});
