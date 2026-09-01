/**
 * The placement roller — step five of area generation.
 *
 * Every content type is rolled per room against a chance and a tag filter in
 * `content/placement.json`, and then `guarantees` tops up whatever the dice
 * failed to produce. **The guarantees are not optional:** a ten-room area
 * rolled barren on the reference generator's first run — no hostiles, no NPCs,
 * one loot room — and small areas fall below expectation often enough that the
 * top-up pass is load-bearing rather than a safety net.
 *
 * Empty rooms are wanted too. Roughly a third of an area is meant to hold
 * nothing mechanical, because that is where atmosphere lives, so the top-ups
 * fill rooms that already have something before they eat into the slack.
 *
 * Each rule names the **maker** the engine runs — `item`, `container`, `door`,
 * `gold`, `hostile`, `npc` — and the tables say what it draws from. A new kind
 * of thing is a table change; only a new behaviour is an engine change.
 *
 * Structure is already fixed when this runs, and nothing here touches it: a
 * room's type, tags and connections are decided before the first roll.
 */

import type { JsonObject } from '../campaign/merge';
import type { AreaDef, PlacementRule, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { bandOf, ruleAt, ruleBool, ruleNumber } from '../engine/rules';
import { matches } from '../engine/tags';
import { rollGold, rollItem } from '../content/items';
import { rollEncounter } from '../content/monsters';
import { rollNpc } from '../content/npcs';
import { inObject, inRoom, type NpcRecord, type ObjectRecord } from '../content/records';
import type { AreaRecord, EdgeRecord, RoomRecord } from './types';

export interface PlacementOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  area: AreaRecord;
  areaDef: AreaDef;
  rooms: readonly RoomRecord[];
  /** The area's own edges. Gates are ignored: a gate never carries a door. */
  edges: readonly EdgeRecord[];
  /** World flags, for spawn upgrades and conditional stats. */
  flags?: ReadonlySet<string> | undefined;
}

export interface PlacementResult {
  objects: ObjectRecord[];
  npcs: NpcRecord[];
  /** `edgeId -> door object id`, applied by the caller onto the edges. */
  doors: { edgeId: string; objectId: string }[];
  notes: string[];
}

/** Every maker the engine knows. A rule naming anything else is reported. */
export const MAKERS = ['item', 'container', 'door', 'gold', 'hostile', 'npc'] as const;

export function placeContents(options: PlacementOptions): PlacementResult {
  const { campaign, rng, area, rooms, edges } = options;
  const rules = campaign.rules;
  const state = new Placement(options);
  if (rooms.length === 0) return state.result();

  const entry = area.entryRoomId ?? (rooms[0] as RoomRecord).id;
  const hops = hopsWithin(rooms, edges, entry);
  const deepest = [...rooms].sort(
    (a, b) => (hops.get(b.id) ?? 0) - (hops.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  )[0] as RoomRecord;

  // Rooms further from the entrance lean one tier harder, reusing the same
  // distance bands quests do — exploration has a gradient, not a flat field.
  const tierOf = (room: RoomRecord): number => {
    const band = bandOf(rules, hops.get(room.id) ?? 0);
    const bonus = band ? ruleNumber(rules, `DEPTH_TIER.roomDepthBonus.${band}`, 0) : 0;
    return area.tier + bonus;
  };

  for (const room of rooms) {
    for (const [key, rule] of placementRules(campaign)) {
      if (!matches(room.tags, rule.requires)) continue;
      if (!rng.chance(rule.chance)) continue;
      state.run(key, rule, room, tierOf(room), { forceElite: room.id === deepest.id });
    }
  }

  state.topUp({ tierOf, deepest });
  return state.result();
}

/**
 * The rules in table order, notes and guarantees skipped. Table order is the
 * roll order, so a campaign can change what lands first by moving a block.
 */
export function placementRules(campaign: ResolvedCampaign): [string, PlacementRule][] {
  return Object.entries(campaign.placement ?? {})
    .filter(([key]) => !key.startsWith('_') && key !== 'guarantees')
    .map(([key, rule]) => [key, rule as PlacementRule]);
}

/** Hops from the entry room, along this area's own edges only. */
function hopsWithin(
  rooms: readonly RoomRecord[],
  edges: readonly EdgeRecord[],
  entry: string,
): Map<string, number> {
  const neighbours = new Map<string, string[]>();
  for (const room of rooms) neighbours.set(room.id, []);
  for (const edge of edges) {
    if (!edge.roomB) continue;
    neighbours.get(edge.roomA)?.push(edge.roomB);
    neighbours.get(edge.roomB)?.push(edge.roomA);
  }
  const seen = new Map<string, number>([[entry, 0]]);
  const queue = [entry];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head] as string;
    const depth = seen.get(at) as number;
    for (const next of neighbours.get(at) ?? []) {
      if (seen.has(next)) continue;
      seen.set(next, depth + 1);
      queue.push(next);
    }
  }
  return seen;
}

// ── the roller ──────────────────────────────────────────────────────

interface MakeContext {
  forceElite?: boolean | undefined;
}

class Placement {
  private readonly objects: ObjectRecord[] = [];
  private readonly npcs: NpcRecord[] = [];
  private readonly doors: { edgeId: string; objectId: string }[] = [];
  private readonly notes: string[] = [];
  private readonly hostileRooms = new Map<string, number>();
  private readonly lootRooms = new Set<string>();
  private readonly npcRooms = new Set<string>();
  private readonly touched = new Set<string>();
  private readonly doorEdges = new Set<string>();
  private objectCount = 0;
  private npcCount = 0;

  constructor(private readonly options: PlacementOptions) {}

  result(): PlacementResult {
    return { objects: this.objects, npcs: this.npcs, doors: this.doors, notes: this.notes };
  }

  /** Run one placement rule against one room. */
  run(key: string, rule: PlacementRule, room: RoomRecord, tier: number, context: MakeContext): boolean {
    switch (rule.makes) {
      case 'item':
        return this.makeItem(rule, room, tier);
      case 'container':
        return this.makeContainer(rule, room, tier);
      case 'gold':
        return this.makeGold(rule, room, tier);
      case 'door':
        return this.makeDoor(rule, room, tier);
      case 'hostile':
        return this.makeHostile(room, tier, context);
      case 'npc':
        return this.makeNpc(room, tier);
      default:
        this.note(`placement rule "${key}" makes "${rule.makes ?? 'nothing'}", which no maker builds`);
        return false;
    }
  }

  private makeItem(rule: PlacementRule, room: RoomRecord, tier: number): boolean {
    const item = rollItem(this.options.rng, this.options.campaign, {
      id: this.mintObjectId(),
      tier,
      location: inRoom(room.id),
      kind: rule.kind,
      baseId: rule.base,
      quality: rule.quality,
    });
    if (!item) return false;
    this.keep(item, room);
    return true;
  }

  /** A container, plus whatever the rule says is inside it. */
  private makeContainer(rule: PlacementRule, room: RoomRecord, tier: number): boolean {
    const container = rollItem(this.options.rng, this.options.campaign, {
      id: this.mintObjectId(),
      tier,
      location: inRoom(room.id),
      kind: rule.kind,
      baseId: rule.base,
      quality: rule.quality,
    });
    if (!container) return false;
    this.keep(container, room);

    // A container the table said nothing about holds one thing.
    const [lo, hi] = rule.lootRolls ?? [1, 1];
    const wanted = this.options.rng.int(lo, hi);
    for (let i = 0; i < wanted; i++) {
      const loot = rollItem(this.options.rng, this.options.campaign, {
        id: this.mintObjectId(),
        tier,
        location: inObject(container.id),
      });
      // Contents point at the container, not at the room: a chest carried out
      // of the area takes what is inside it, with no second field to update.
      if (loot) this.keep(loot, room);
    }
    return true;
  }

  private makeGold(rule: PlacementRule, room: RoomRecord, tier: number): boolean {
    const pile = rollItem(this.options.rng, this.options.campaign, {
      id: this.mintObjectId(),
      tier,
      location: inRoom(room.id),
      kind: rule.kind,
      baseId: rule.base,
      quality: rule.quality,
    });
    if (!pile) return false;
    pile.gold = rollGold(this.options.rng, this.options.campaign, tier);
    this.keep(pile, room);
    return true;
  }

  /**
   * A locked door and its key.
   *
   * **Locks are flavour, never structure.** The door only goes on a connection
   * the area can spare — one whose loss still leaves every room reachable from
   * the entrance — and the key is placed on the near side of it. Nothing is
   * ever gated, so nothing needs proving solvable.
   */
  private makeDoor(rule: PlacementRule, room: RoomRecord, tier: number): boolean {
    const { campaign, rng, rooms, edges, area } = this.options;
    const spare = rng.shuffle(
      edges.filter(
        (edge) =>
          edge.roomB !== null &&
          !this.doorEdges.has(edge.id) &&
          !edge.doorId &&
          (edge.roomA === room.id || edge.roomB === room.id) &&
          !isLoadBearing(rooms, edges, area.entryRoomId ?? (rooms[0] as RoomRecord).id, edge),
      ),
    )[0];
    if (!spare) return false;

    const door = rollItem(rng, campaign, {
      id: this.mintObjectId(),
      tier,
      location: inRoom(room.id),
      kind: rule.kind,
      baseId: rule.base,
      quality: rule.quality,
    });
    if (!door) return false;

    const reachable = reachableWithout(
      rooms,
      edges,
      area.entryRoomId ?? (rooms[0] as RoomRecord).id,
      spare,
    );
    const hops = hopsWithin(rooms, edges, room.id);
    const band = rule.keyBand;
    const inBand = rooms.filter(
      (candidate) =>
        reachable.has(candidate.id) &&
        (!band || bandOf(campaign.rules, hops.get(candidate.id) ?? -1) === band),
    );
    const holder =
      rng.maybePick(inBand) ??
      rng.maybePick(rooms.filter((candidate) => reachable.has(candidate.id)));
    if (!holder) return false;

    const key = rollItem(rng, campaign, {
      id: this.mintObjectId(),
      tier,
      location: inRoom(holder.id),
      kind: rule.keyKind,
    });
    if (!key) return false;

    door.flags = { ...door.flags, locked: true, lockedById: key.id };
    this.keep(door, room);
    this.keep(key, holder);
    this.doorEdges.add(spare.id);
    this.doors.push({ edgeId: spare.id, objectId: door.id });
    return true;
  }

  private makeHostile(room: RoomRecord, tier: number, context: MakeContext): boolean {
    const { campaign, rng, area, areaDef } = this.options;
    // The cap counts encounters, not creatures: a warband is one of them.
    const cap = ruleNumber(guarantees(campaign), 'maxHostilesPerRoom', 1);
    if ((this.hostileRooms.get(room.id) ?? 0) >= cap) return false;

    const group = rollEncounter({
      campaign,
      rng,
      archetype: area.archetype,
      areaDef,
      roomTags: room.tags,
      tier,
      location: inRoom(room.id),
      flags: this.options.flags,
      mintId: () => this.mintNpcId(),
      forceElite: context.forceElite,
    });
    if (group.length === 0) return false;

    for (const monster of group) this.npcs.push(monster);
    this.hostileRooms.set(room.id, (this.hostileRooms.get(room.id) ?? 0) + 1);
    this.touched.add(room.id);
    return true;
  }

  private makeNpc(room: RoomRecord, tier: number): boolean {
    const person = rollNpc({
      campaign: this.options.campaign,
      rng: this.options.rng,
      id: this.mintNpcId(),
      roomTags: room.tags,
      tier,
      location: inRoom(room.id),
      areaDef: this.options.areaDef,
    });
    if (!person) return false;
    this.npcs.push(person);
    this.npcRooms.add(room.id);
    this.touched.add(room.id);
    return true;
  }

  /**
   * The guarantees. They run after the dice and they always win: an area that
   * rolled barren is a worse outcome than an area with less slack in it.
   */
  topUp(context: { tierOf: (room: RoomRecord) => number; deepest: RoomRecord }): void {
    const { campaign, rooms } = this.options;
    const table = guarantees(campaign);

    for (const [key, rule] of placementRules(campaign)) {
      const wanted = wantedFor(campaign, rule);
      if (wanted <= 0) continue;
      const held = () => this.countFor(rule);
      let guard = rooms.length * 2;
      while (held() < wanted && guard-- > 0) {
        const room = this.pickTopUpRoom(rule);
        if (!room) {
          this.note(`could not meet ${key} guarantee: no room in this area accepts one`);
          break;
        }
        if (!this.run(key, rule, room, context.tierOf(room), {
          forceElite: room.id === context.deepest.id,
        })) {
          // The room fit the filter and the maker still produced nothing —
          // usually an empty pool for this archetype. Stop, and say so.
          this.note(`could not meet ${key} guarantee: the tables produced nothing for ${room.id}`);
          break;
        }
      }
    }

    // The deepest room is where the area's difficulty gradient points, so it
    // carries an elite whether or not the dice put anything there.
    const deepHostile = (this.hostileRooms.get(context.deepest.id) ?? 0) > 0;
    if (!deepHostile) {
      const hostileRule = placementRules(campaign).find(([, rule]) => rule.makes === 'hostile');
      if (hostileRule && matches(context.deepest.tags, hostileRule[1].requires)) {
        this.makeHostile(context.deepest, context.tierOf(context.deepest), { forceElite: true });
      }
    }

    if (ruleBool(table, 'lightSourceIfDarkArea', false) && this.isDarkArea()) {
      const lightRule = placementRules(campaign).find(
        ([, rule]) => rule.makes === 'item' && rule.kind === 'light',
      );
      const alreadyLit = this.objects.some((object) => object.flags.lightSource === true);
      if (lightRule && !alreadyLit) {
        const room = this.pickTopUpRoom(lightRule[1]) ?? rooms[0];
        if (room) this.run(lightRule[0], lightRule[1], room, context.tierOf(room), {});
      }
    }
  }

  // ── bookkeeping ───────────────────────────────────────────────────

  private keep(object: ObjectRecord, room: RoomRecord): void {
    this.objects.push(object);
    this.touched.add(room.id);
    if (object.flags.takeable === true) this.lootRooms.add(room.id);
  }

  private countFor(rule: PlacementRule): number {
    if (rule.makes === 'hostile') return this.hostileRooms.size;
    if (rule.makes === 'npc') return this.npcRooms.size;
    return this.lootRooms.size;
  }

  /**
   * Where a top-up goes. Rooms that already hold something come first, so the
   * slack — the third of the area with nothing in it — survives as long as it
   * can. When only empty rooms are left, the guarantee still wins and says so.
   */
  private pickTopUpRoom(rule: PlacementRule): RoomRecord | undefined {
    const { campaign, rng, rooms } = this.options;
    const cap = ruleNumber(guarantees(campaign), 'maxHostilesPerRoom', 1);
    const fitting = rooms.filter((room) => {
      if (!matches(room.tags, rule.requires)) return false;
      if (rule.makes === 'hostile') return (this.hostileRooms.get(room.id) ?? 0) < cap;
      if (rule.makes === 'npc') return !this.npcRooms.has(room.id);
      return !this.lootRooms.has(room.id);
    });
    if (fitting.length === 0) return undefined;

    const busy = fitting.filter((room) => this.touched.has(room.id));
    if (busy.length > 0) return rng.pick(busy);

    const slack = Math.round(
      rooms.length * ruleNumber(guarantees(campaign), 'emptyRoomFraction', 0),
    );
    const empty = rooms.length - this.touched.size;
    if (empty <= slack) {
      this.note('a guarantee ate into the empty-room slack, which guarantees are allowed to do');
    }
    return rng.pick(fitting);
  }

  /** `dark` is the area tag the guarantee is named after; nothing else is. */
  private isDarkArea(): boolean {
    return (this.options.areaDef.areaTags ?? []).includes('dark');
  }

  private note(line: string): void {
    if (!this.notes.includes(line)) this.notes.push(line);
  }

  private mintObjectId(): string {
    return `${this.options.area.id}:o${String(this.objectCount++).padStart(2, '0')}`;
  }

  private mintNpcId(): string {
    return `${this.options.area.id}:n${String(this.npcCount++).padStart(2, '0')}`;
  }
}

const guarantees = (campaign: ResolvedCampaign): JsonObject =>
  (campaign.placement?.guarantees ?? {}) as unknown as JsonObject;

/** How many rooms of this kind the guarantees ask for, if they ask at all. */
function wantedFor(campaign: ResolvedCampaign, rule: PlacementRule): number {
  const table = guarantees(campaign);
  const key =
    rule.makes === 'hostile'
      ? 'minHostiles'
      : rule.makes === 'npc'
        ? 'minNpcs'
        : rule.makes === 'item' || rule.makes === 'container' || rule.makes === 'gold'
          ? 'minLootRooms'
          : '';
  if (!key) return 0;
  // Loot has several makers and one guarantee, so only the plain `item` rule
  // tops it up — otherwise three rules would each chase the same number.
  if (key === 'minLootRooms' && rule.makes !== 'item') return 0;
  const value = ruleAt(table, key);
  return typeof value === 'number' ? value : 0;
}

/** Would losing this connection strand a room? Then it may not carry a lock. */
function isLoadBearing(
  rooms: readonly RoomRecord[],
  edges: readonly EdgeRecord[],
  entry: string,
  edge: EdgeRecord,
): boolean {
  return reachableWithout(rooms, edges, entry, edge).size < rooms.length;
}

function reachableWithout(
  rooms: readonly RoomRecord[],
  edges: readonly EdgeRecord[],
  entry: string,
  without: EdgeRecord,
): Set<string> {
  const neighbours = new Map<string, string[]>();
  for (const room of rooms) neighbours.set(room.id, []);
  for (const edge of edges) {
    if (edge.id === without.id || !edge.roomB) continue;
    neighbours.get(edge.roomA)?.push(edge.roomB);
    neighbours.get(edge.roomB)?.push(edge.roomA);
  }
  const seen = new Set<string>([entry]);
  const queue = [entry];
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours.get(queue[head] as string) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
