/**
 * The records contents are made of, and the one pointer that positions them.
 *
 * **Every object and every creature has a single `location`, and nothing else
 * records position.** A room holds no contents array — "what is in this room"
 * is a query across everything whose `location` points at it. Move something
 * by writing one field; there is no second place to forget.
 *
 *   room:warren_7f3:r04   lying in a room
 *   player                carried
 *   obj:chest_oak         inside a container
 *   npc:hub_marda         held by an NPC — this is also vendor stock
 *   null                  out of play
 *
 * `location` points at ids, never at coordinates. A sword inside a chest
 * carried by a shopkeeper is three pointers deep and nowhere on the map.
 */

/** A pointer at whatever holds this thing, or null when it is out of play. */
export type LocationRef = string | null;

export const PLAYER: LocationRef = 'player';

export const inRoom = (roomId: string): LocationRef => `room:${roomId}`;
export const inObject = (objectId: string): LocationRef => `obj:${objectId}`;
export const heldBy = (npcId: string): LocationRef => `npc:${npcId}`;

export interface Location {
  kind: 'room' | 'obj' | 'npc' | 'player';
  /** The id being pointed at. Empty for `player`, which points at nothing. */
  id: string;
}

export function parseLocation(ref: LocationRef): Location | undefined {
  if (!ref) return undefined;
  if (ref === PLAYER) return { kind: 'player', id: '' };
  const cut = ref.indexOf(':');
  if (cut < 0) return undefined;
  const kind = ref.slice(0, cut);
  if (kind !== 'room' && kind !== 'obj' && kind !== 'npc') return undefined;
  return { kind, id: ref.slice(cut + 1) };
}

/**
 * Behaviour comes from flags, not subtypes — one table holds items, doors,
 * scenery and containers. This is the closed list; `content/items.json`
 * declares which of them each kind carries, and the engine sets nothing else.
 */
export interface ObjectFlags {
  takeable?: boolean;
  scenery?: boolean;
  container?: boolean;
  open?: boolean;
  locked?: boolean;
  /** The key that opens it. A lock is flavour: it never gates progression. */
  lockedById?: string;
  lightSource?: boolean;
  lit?: boolean;
  wearable?: boolean;
  worn?: boolean;
  edible?: boolean;
  weapon?: boolean;
  armour?: boolean;
  untradable?: boolean;
}

export const OBJECT_FLAGS: readonly string[] = [
  'takeable',
  'scenery',
  'container',
  'open',
  'locked',
  'lockedById',
  'lightSource',
  'lit',
  'wearable',
  'worn',
  'edible',
  'weapon',
  'armour',
  'untradable',
];

/**
 * An object. Combat and price values are **derived, never stored** — they
 * compute from `baseId` + `quality` + `affixes[]` against the rules tables, so
 * retuning a weapon reaches every sword already in the world.
 */
export interface ObjectRecord {
  campaignId: string;
  id: string;
  name: string;
  /** Parser vocabulary. The narrator's prose is validated against these. */
  nouns: string[];
  adjectives: string[];
  location: LocationRef;
  /** Written by the narrator. Empty until then. */
  desc: string;
  tags: string[];
  /** What it was generated from, and all that is needed to derive the rest. */
  baseId: string;
  quality: string;
  affixes: string[];
  flags: ObjectFlags;
  /** Starts at 100 and drops on a fumble. This is what `repair` repairs. */
  condition: number;
  /** Turns of light left. Zero for everything that does not burn. */
  burnRemaining: number;
  /** Loose coin. Zero for everything that is not money. */
  gold: number;
}

/** The six attributes, keyed by name so the engine never names them itself. */
export type Stats = Record<string, number>;

/**
 * A creature: a shopkeeper, a companion and a barrow wight are one record type
 * with different numbers. Monsters skip weapon-skill and armour-expertise
 * maths entirely and store final values; the player does not.
 */
export interface NpcRecord {
  campaignId: string;
  id: string;
  name: string;
  /** Every former name. Matchers read `name` plus these, never `name` alone. */
  aliases: string[];
  location: LocationRef;
  /** `"fence. grieving and wheedling. Wants a debt paid."` The narrator's brief. */
  persona: string;
  /** Taxonomy included, so resistances are a lookup rather than a field. */
  tags: string[];
  stats: Stats;
  hp: number;
  /** null when nothing is home: `mindless`, `undead` and `construct` have no track. */
  resolve: number | null;
  armourReduction: number;
  penetration: number;
  weaponDamage: string;
  /** Flat damage on top of the die, from elites and world flags. */
  damageBonus: number;
  attacksPerRound: number;
  threat: number;
  /** How it breaks at zero Resolve: low flees, middle surrenders, high joins. */
  friendliness: number;
  bribeThreshold: number;
  disposition: number;
  /** The companion ladder. Zero for everything that is not travelling with you. */
  standing: number;
  sensed: boolean;
  isVendor: boolean;
  priceModifier: number;
  /** Upload-only. Nothing generates it. */
  imageBlob: string | null;
  /** What a Hub NPC does: buy, sell, repair, train, hire, deposit. */
  services: string[];
  hostile: boolean;
  /** `m`, `f` or `none`. Narration only — it never reaches the resolver. */
  sex: string;
  /** Provenance, exactly as objects carry `baseId`: gambits derive from `role`. */
  baseId: string;
  role: string;
  /** The elite roll, or empty. */
  elite: string;
  tier: number;
}
