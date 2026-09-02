/**
 * The shape of the tables, as the engine reads them.
 *
 * These describe the resolved (base + campaign + settings) layer, not the raw
 * files. Every table carries `_note` keys throughout — the tables are the
 * authoring surface — so every interface here tolerates extra keys.
 *
 * No rule value is restated here. These are shapes, not numbers: the numbers
 * live in `rules.json` and are read at runtime.
 */

import type { Json, JsonObject } from './merge';

export interface Weighted {
  w?: number | undefined;
}

export interface TagFiltered {
  requires?: string[] | undefined;
}

/** A weight distribution over sex keys, e.g. `{ "f": 85, "m": 15 }`. */
export type SexWeights = Record<string, number>;

// ── campaign.json ───────────────────────────────────────────────────

export interface HubRoomDef {
  id: string;
  x: number;
  y: number;
  z: number;
  name: string;
  tags: string[];
  baseDesc: string;
}

/** `[fromRoomId, direction, toRoomId]` — the hub's hand-authored edges. */
export type HubEdgeDef = [string, string, string];

export interface HubGateDef {
  fromRoom: string;
  dir: string;
  archetype: string;
}

export interface HubNpcDef {
  id: string;
  name: string;
  location: string;
  persona: string;
  tags: string[];
  sex?: SexWeights | undefined;
  isVendor?: boolean | undefined;
  services?: string[] | undefined;
}

export interface Cube {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface HubDef {
  cube: Cube;
  entryRoomId: string;
  rooms: HubRoomDef[];
  edges: HubEdgeDef[];
  gates: HubGateDef[];
  npcs: HubNpcDef[];
}

export interface StarterKitDef {
  items: string[];
  tags?: string[] | undefined;
  gold: number;
}

export interface ArchetypeDef {
  id: string;
  name: string;
  favours: string[];
  kit: string[];
  blurb: string;
}

export interface CharacterCreationDef {
  method: string;
  rerollsAllowed: number;
  archetypes: ArchetypeDef[];
}

export interface CampaignManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  permadeath: boolean;
  startingArea: string;
  gatewayArchetypes: string[];
  hub: HubDef;
  starterKit: StarterKitDef;
  characterCreation: CharacterCreationDef;
}

// ── areas/*.json ────────────────────────────────────────────────────

export interface RoomTypeDef extends Weighted {
  tags: string[];
}

/**
 * The questions this kind of place answers about itself. Each trait rolls one
 * weighted option; the whole block may miss, and an area with no identity is a
 * real outcome rather than a failure — somewhere nothing of note happens.
 */
export interface AreaIdentityDef {
  chance: number;
  /** trait name -> `[value, weight]` rows. */
  traits: Record<string, [string, number][]>;
}

export interface AreaDef {
  id: string;
  name: string;
  /** `[min, max]` room count. */
  size: [number, number];
  shapes: string[];
  areaTags: string[];
  themeTokens: string[];
  roomTypes: Record<string, RoomTypeDef>;
  /** archetype id -> weight, for the gates this area may roll. */
  gates: Record<string, number>;
  sexOverride: SexWeights | null;
  sexOverrideRespects: string[];
  tierFloor: number;
  tierCeil: number;
  identity?: AreaIdentityDef | undefined;
}

// ── content/placement.json ──────────────────────────────────────────

export interface PlacementRule extends TagFiltered {
  chance: number;
  lootRolls?: [number, number] | undefined;
  keyBand?: string | undefined;
}

export interface PlacementGuarantees {
  minHostiles: number;
  minLootRooms: number;
  minNpcs: number;
  lightSourceIfDarkArea: boolean;
  maxHostilesPerRoom: number;
}

export interface PlacementTable {
  guarantees: PlacementGuarantees;
  [key: string]: PlacementRule | PlacementGuarantees | Json;
}

// ── content/adjacency.json ──────────────────────────────────────────

export interface DepthGateDef {
  minDepth?: number | undefined;
  maxDepth?: number | undefined;
}

/**
 * What may be built next to what. `gates` on an area template says what that
 * area opens onto; this says what the world tolerates standing side by side,
 * which is the case `gates` cannot see — two areas become neighbours through a
 * third one's allocation without either naming the other.
 */
export interface AdjacencyTable {
  /** Slack, in lattice slots, for counting two cubes as neighbours. */
  radius: number;
  depthGate: Record<string, DepthGateDef>;
  /** `affinity[candidate][neighbour]` — a weight multiplier. 0 forbids. */
  affinity: Record<string, Record<string, number>>;
}

// ── content/items.json ──────────────────────────────────────────────

export interface QualityDef extends Weighted {
  id: string;
  mult: number;
  priceMult: number;
  affixes: number;
  tags: string[];
}

export interface ItemBaseDef extends Weighted {
  id: string;
  kind: string;
  nouns: string[];
  adjectives: string[];
}

export interface AffixDef extends Weighted, TagFiltered {
  id: string;
  name: string;
  mods: Record<string, number>;
}

export interface ItemTable {
  qualities: QualityDef[];
  bases: ItemBaseDef[];
  affixes: { prefix: AffixDef[]; suffix: AffixDef[] };
  lootTiers: Record<string, JsonObject>;
}

// ── content/monsters.json ───────────────────────────────────────────

export interface MonsterBaseDef extends Weighted, TagFiltered {
  id: string;
  name: string;
  tier: number;
  tags: string[];
  areas: string[];
  sex?: SexWeights | undefined;
}

export interface MonsterRoleDef extends Weighted {
  id: string;
  name: string;
  mods: Record<string, number>;
  gambits: string;
  excludeTags: string[];
  tags?: string[] | undefined;
  escort?: [number, number] | undefined;
}

export interface EliteDef extends Weighted {
  id: string;
  title: string;
  mods: Record<string, number>;
  tags?: string[] | undefined;
}

export interface CompositionDef extends Weighted, TagFiltered {
  id: string;
  name: string;
  /** `[roleWanted | "any", min, max]`. */
  parts: [string, number, number][];
}

export interface MonsterTable {
  statCurve: Record<string, JsonObject>;
  bases: MonsterBaseDef[];
  roles: MonsterRoleDef[];
  elites: { chance: Record<string, number>; table: EliteDef[] };
  groupSize: { default: [number, number]; byTag: Record<string, [number, number]> };
  /**
   * Most creatures one encounter may field, by tier. Optional: a table that
   * omits it fields whatever the composition asked for, as it always did.
   */
  encounterCap?: Record<string, number> | undefined;
  tierGate: { overTierWeight: number };
  sexDefault: SexWeights;
  compositions: { table: CompositionDef[] };
  spawnUpgrades: { table: Json[] };
  conditionalStats: { table: Json[] };
  likes: { perMatch: number; cap: number; enabled: boolean };
}

// ── content/npcs.json ───────────────────────────────────────────────

export interface NpcRoleDef extends Weighted, TagFiltered {
  id: string;
  vendor: boolean;
  quests: string[];
  tags?: string[] | undefined;
  sex?: SexWeights | undefined;
}

export interface NamedWeight extends Weighted {
  id: string;
}

export interface NpcTable {
  roles: NpcRoleDef[];
  traits: NamedWeight[];
  wants: NamedWeight[];
  dispositionRoll: JsonObject;
  friendlinessRoll: JsonObject;
  personaTemplate: string;
  sexDefault: SexWeights;
}

// ── content/abilities.json ──────────────────────────────────────────

export interface AbilityDef {
  id: string;
  name: string;
  type: string;
  targets: string;
  grantedBy: string;
  effect: JsonObject;
  attack?: string | undefined;
  applies?: string | undefined;
  triggers?: string[] | undefined;
}

export interface GambitDef {
  when: string;
  use: string;
}

export interface AbilityTable {
  types: Record<string, Json>;
  primers: Record<string, Json>;
  table: AbilityDef[];
  gambitConditions: string[];
  gambitsByRole: Record<string, GambitDef[]>;
}

// ── quests/*.json ───────────────────────────────────────────────────

/**
 * What a quest's single objective is, and how it is satisfied. `place` and
 * `completedBy` are the two small closed sets the engine understands — the same
 * kind of engine-level vocabulary as `hostile` and `npc` in placement. A new
 * quest type is a new template plus, at most, a new predicate; never new
 * engine code beyond that.
 */
export interface QuestObjectiveDef {
  kind: string;
  /** `item` · `hostile` · `parcel` · `none` — what is placed at the target. */
  place: string;
  /** `hasItem` · `npcDead` · `roomCleared` · `flagSet` · `atRoom`. */
  completedBy: string;
  /** Narrows a placed item, e.g. `treasure`. Read only when `place` is `item`. */
  itemKind?: string | undefined;
}

export interface QuestTemplate {
  type: string;
  /** Distance band name -> weight. `distant` means another area entirely. */
  bands: Record<string, number>;
  /** Room tags the objective's room must satisfy, in `requires[]` syntax. */
  targetTags: string[];
  objective: QuestObjectiveDef;
  hintFrom: string[];
  /** Reward kinds granted on completion. A table roll, never hardcoded. */
  rewards: string[];
}

// ── verbs.json — global, never campaign-scoped ──────────────────────

export interface VerbDef {
  id: string;
  words: string[];
  patterns: string[];
  /** Prepositions this verb swallows when they'd otherwise strand the object. */
  absorbs?: string[];
  /** Words that match this verb only when they are the entire input. */
  soloWords?: string[];
  /** No state change; always narrated fresh — smell, listen, grope, … */
  flavourOnly?: boolean;
}

export interface VerbTable {
  patterns: Record<string, string>;
  directions: Record<string, string>;
  verbs: VerbDef[];
  articlesStripped: string[];
  /** Leading first-person lead-ins the parser strips: `[["i"],["let","me"],…]`. */
  subjectPrefixes?: string[][];
  pronouns: string[];
  allWord: string;
  exceptWords: string[];
}

// ── rules.json ──────────────────────────────────────────────────────

/**
 * Deliberately untyped beyond "an object of values".
 *
 * `rules.json` is the single source of truth for every formula, table and
 * threshold. Naming its keys here would be restating rules outside the rules
 * file, which is the one thing the design forbids. Consumers read the keys
 * they need and are responsible for failing loudly when one is missing.
 */
export type RulesTable = JsonObject;

// ── the resolved campaign ───────────────────────────────────────────

export interface ResolvedCampaign {
  readonly id: string;
  readonly manifest: CampaignManifest;
  readonly rules: RulesTable;
  readonly tags: JsonObject;
  readonly areas: ReadonlyMap<string, AreaDef>;
  readonly items: ItemTable;
  readonly monsters: MonsterTable;
  readonly npcs: NpcTable;
  readonly abilities: AbilityTable;
  readonly placement: PlacementTable;
  readonly adjacency: AdjacencyTable;
  /** Quest templates, keyed by type. An NPC rolls its work against these. */
  readonly quests: ReadonlyMap<string, QuestTemplate>;
  /** Global, loaded from outside every campaign folder. */
  readonly verbs: VerbTable;
  /**
   * Narrator prompt fragments, keyed by campaign-relative path
   * (`prompts/room-base.md`). Raw Markdown — the narrator reads them, the
   * engine never does. A campaign overrides a prompt whole, by filename.
   */
  readonly prompts: Readonly<Record<string, string>>;
}
