/**
 * Monsters — base × role × elite, assembled into an encounter by composition.
 *
 * Nothing here is authored per monster. A base says what a thing *is* and
 * where it belongs; the numbers come from `statCurve[tier]`, and the tier
 * comes from how far the player has walked. That is the whole difficulty
 * curve, and it is why fifteen bases cover five tiers.
 *
 * Creatures store final values. The player derives HP, damage and armour from
 * attributes and skills every time they are read; a creature has no skills to
 * read, so the roll happens once here and is written down.
 *
 * Two guards that both came from real bugs in the reference generator:
 *
 *  - **A role is refused if the base carries any of its `excludeTags`.** A
 *    mindless skeleton must never roll `leader`, because leader gambits use
 *    Presence abilities it can never land.
 *  - **Group size is clamped by taxonomy.** A `pack` of hulking brutes is not
 *    four brutes; `groupSize.byTag` is what stops the composition table
 *    producing an encounter nobody could survive.
 */

import type { JsonObject } from '../campaign/merge';
import type {
  AreaDef,
  CompositionDef,
  EliteDef,
  MonsterBaseDef,
  MonsterRoleDef,
  ResolvedCampaign,
} from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber } from '../engine/rules';
import { matches } from '../engine/tags';
import type { Location, NpcRecord } from '../world/types';
import { rollSex } from './sex';
import {
  applyAttributeMods,
  deriveHp,
  deriveResolve,
  floorAttributes,
  rollAroundMean,
} from './stats';

export interface EncounterOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  areaDef: AreaDef;
  /** The archetype id, which is what a base's `areas[]` names. */
  archetype: string;
  /** The tier this encounter fights at — the area's, plus any room bonus. */
  tier: number;
  roomTags: readonly string[];
  location: Location;
  /** Mints the id for each creature. */
  nextId: () => string;
  /** World flags, which decide spawn upgrades and conditional stats. */
  flags?: ReadonlySet<string> | undefined;
  /** The deepest room in an area is guaranteed one. */
  forceElite?: boolean | undefined;
}

export interface Encounter {
  /** The composition's name: `lone`, `pack`, `warband`, `pair`, `ambush`. */
  shape: string;
  creatures: NpcRecord[];
}

/**
 * Roll a whole encounter. The composition is picked first — it controls *which*
 * variants appear together, which relying on the leader role alone never did —
 * and each part is then filled by a base that fits the area and the room.
 */
export function rollEncounter(options: EncounterOptions): Encounter | undefined {
  const { campaign, rng, roomTags } = options;
  const table = campaign.monsters.compositions?.table ?? [];
  const fitting = table.filter((composition) => matches(roomTags, composition.requires));
  const composition = rng.maybeWeighted(fitting.length > 0 ? fitting : table);
  if (!composition) return undefined;

  const creatures: NpcRecord[] = [];
  const perBase = new Map<string, number>();
  const cap = encounterCap(campaign, options.tier);

  /**
   * Add up to `wanted` of a base, never more than taxonomy allows in one room
   * and never past the tier's cap on the whole encounter. The cap is checked
   * last so a composition that has already filled the room simply contributes
   * nothing further, rather than the parts being rebalanced.
   */
  const add = (rolled: BaseRoll, wanted: number, elite: boolean): void => {
    const allowed = allowedCount(campaign, rolled.base, wanted, perBase.get(rolled.base.id) ?? 0);
    const count = Math.max(0, Math.min(allowed, cap - creatures.length));
    for (let i = 0; i < count; i++) {
      creatures.push(buildCreature(options, rolled, i === 0 && elite));
    }
    perBase.set(rolled.base.id, (perBase.get(rolled.base.id) ?? 0) + count);
  };

  for (const [wanted, lo, hi] of (composition as CompositionDef).parts ?? []) {
    const role = wanted === 'any' ? undefined : wanted;
    // One base per part, so a pack is a pack of one thing rather than a
    // menagerie that happened to share a room.
    const rolled = rollBase(options, role);
    if (rolled) add(rolled, rng.int(lo, hi), options.forceElite === true);
  }

  // A leader that turned up outside a warband still pulls its escort, or the
  // role's whole point disappears the moment the composition roll goes another
  // way.
  const leader = creatures.find((creature) => escortRange(campaign, creature.role));
  if (leader && creatures.length === 1) {
    const range = escortRange(campaign, leader.role) as [number, number];
    const rolled = rollBase(options, undefined);
    if (rolled) add(rolled, rng.int(range[0], range[1]), false);
  }

  if (creatures.length === 0) return undefined;
  return { shape: composition.name ?? composition.id ?? 'lone', creatures };
}

/** One creature, for a caller that wants exactly one — a quest target, a companion. */
export function generateMonster(options: EncounterOptions, role?: string): NpcRecord | undefined {
  const rolled = rollBase(options, role);
  return rolled ? buildCreature(options, rolled, options.forceElite === true) : undefined;
}

interface BaseRoll {
  base: MonsterBaseDef;
  role: MonsterRoleDef;
}

/**
 * Pick a base that belongs in this area and this room, then a role the base
 * can carry. A base above the area's tier may still appear — that is what
 * makes a deep area feel dangerous rather than merely bigger — but at
 * `tierGate.overTierWeight` of its usual weight.
 */
function rollBase(options: EncounterOptions, wantedRole?: string): BaseRoll | undefined {
  const { campaign, rng, tier, roomTags, archetype } = options;
  const overTierWeight = campaign.monsters.tierGate?.overTierWeight ?? 1;

  const pool = campaign.monsters.bases
    .filter((base) => base.areas.includes(archetype))
    .filter((base) => base.tier <= tier + 1)
    .filter((base) => matches(roomTags, base.requires))
    .map((base) => ({
      ...base,
      w: (base.w ?? 1) * (base.tier > tier ? overTierWeight : 1),
    }));

  const picked = rng.maybeWeighted(pool);
  if (!picked) return undefined;
  const base = upgradeBase(options, picked);

  const allowed = campaign.monsters.roles.filter(
    (role) => !(role.excludeTags ?? []).some((tag) => base.tags.includes(tag)),
  );
  const roles = allowed.length > 0 ? allowed : campaign.monsters.roles;
  const role = wantedRole
    ? (roles.find((entry) => entry.id === wantedRole) ?? rng.maybeWeighted(roles))
    : rng.maybeWeighted(roles);
  return role ? { base, role } : undefined;
}

/**
 * `spawnUpgrades` — what the player did elsewhere changes what turns up here.
 * The flag was set by the world, so a footpad becoming a cutthroat costs no
 * quest chain and no engine code.
 */
function upgradeBase(options: EncounterOptions, base: MonsterBaseDef): MonsterBaseDef {
  const flags = options.flags;
  if (!flags || flags.size === 0) return base;
  for (const row of options.campaign.monsters.spawnUpgrades?.table ?? []) {
    const rule = row as { ifFlag?: string; replace?: Record<string, string>; weight?: number };
    if (!rule.ifFlag || !flags.has(rule.ifFlag)) continue;
    const replacement = rule.replace?.[base.id];
    if (!replacement) continue;
    if (!options.rng.chance(rule.weight ?? 1)) continue;
    const upgraded = options.campaign.monsters.bases.find((entry) => entry.id === replacement);
    if (upgraded) return upgraded;
  }
  return base;
}

/**
 * How many of a base a composition may actually field, given how many are
 * already standing there. `groupSize.byTag` is the cap and it counts across
 * the whole encounter, not per part — a warband of a hulking leader and
 * hulking escorts is still four hulking things in one room.
 */
function allowedCount(
  campaign: ResolvedCampaign,
  base: MonsterBaseDef,
  wanted: number,
  already: number,
): number {
  const byTag = campaign.monsters.groupSize?.byTag ?? {};
  const fallback = campaign.monsters.groupSize?.default ?? [1, 1];
  const tag = base.tags.find((entry) => byTag[entry]);
  const [lo, hi] = tag ? (byTag[tag] as [number, number]) : fallback;
  const asked = Math.max(1, Math.min(Math.max(wanted, lo), hi));
  return Math.max(0, Math.min(asked, hi - already));
}

const escortRange = (campaign: ResolvedCampaign, roleId: string): [number, number] | undefined =>
  campaign.monsters.roles.find((role) => role.id === roleId)?.escort;

function buildCreature(
  options: EncounterOptions,
  rolled: BaseRoll,
  forceElite: boolean,
): NpcRecord {
  const { campaign, rng, tier } = options;
  const rules = campaign.rules;
  const { base, role } = rolled;
  const curve = statCurve(campaign, tier);

  let stats = rollAroundMean(rng, rules, numberAt(curve, 'mean', 1), monsterSpread(campaign));
  stats = applyAttributeMods(stats, role.mods);

  let tags = [...new Set([...base.tags, ...(role.tags ?? [])])];
  let title = '';
  let reduction = numberAt(curve, 'reduction', 0) + (role.mods?.['reduction'] ?? 0);
  let penetration = numberAt(curve, 'penetration', 0) + (role.mods?.['penetration'] ?? 0);
  let damageBonus = role.mods?.['damage'] ?? 0;
  let threat = role.mods?.['threat'] ?? 0;

  const elite = rollElite(campaign, rng, tier, forceElite);
  if (elite) {
    title = `${elite.title} `;
    tags = [...new Set([...tags, ...(elite.tags ?? [])])];
    stats = applyAttributeMods(stats, elite.mods);
    reduction += elite.mods?.['reduction'] ?? 0;
    penetration += elite.mods?.['penetration'] ?? 0;
    damageBonus += elite.mods?.['damage'] ?? 0;
    threat += elite.mods?.['threat'] ?? 0;
  }

  // Taxonomy is a lookup, not a field: `armoured` is worth armour wherever it
  // appears, whether it came from the base, the role or the elite roll. The
  // curve's own multiplier is the starting point, so `frail` at tier 1 stacks
  // on top of the tier's discount rather than replacing it.
  let hpMult = numberAt(curve, 'hpMult', 1);
  for (const tag of tags) {
    const taxonomy = ruleAt(rules, `TAXONOMY.${tag}`) as JsonObject | undefined;
    if (!taxonomy) continue;
    if (typeof taxonomy['hp'] === 'number') hpMult *= taxonomy['hp'];
    if (typeof taxonomy['reduction'] === 'number') reduction += taxonomy['reduction'];
  }

  // `conditionalStats` — an eighty-point swing decided hours ago somewhere
  // else. The flag system already exists, so this costs nothing.
  for (const row of campaign.monsters.conditionalStats?.table ?? []) {
    const rule = row as {
      ifFlag?: string;
      appliesTo?: string[];
      mods?: Record<string, number>;
      title?: string;
    };
    if (!rule.ifFlag || !options.flags?.has(rule.ifFlag)) continue;
    if (!(rule.appliesTo ?? []).some((tag) => tags.includes(tag))) continue;
    reduction += rule.mods?.['reduction'] ?? 0;
    penetration += rule.mods?.['penetration'] ?? 0;
    damageBonus += rule.mods?.['damage'] ?? 0;
    if (rule.title) title = `${rule.title}${title}`;
  }

  stats = floorAttributes(stats);
  const presenceImmune = tags.some(
    (tag) => (ruleAt(rules, `TAXONOMY.${tag}.presenceImmune`) as boolean | undefined) === true,
  );
  const gambits = role.gambits ?? role.id;
  const maxHp = Math.max(1, Math.round(deriveHp(rules, stats.toughness) * hpMult));
  const maxResolve = Math.max(
    1,
    Math.round(deriveResolve(rules, stats.willpower) * numberAt(curve, 'resolveMult', 1)),
  );
  const friendliness = rollFriendliness(campaign, rng, tags);

  return {
    campaignId: campaign.id,
    id: options.nextId(),
    name: `${title}${role.name ?? ''}${base.name}`,
    aliases: [],
    location: options.location,
    persona: '',
    tags,
    sex: rollSex({
      rng,
      areaDef: options.areaDef,
      own: base.sex,
      fallback: campaign.monsters.sexDefault,
    }),
    stats,
    hp: maxHp,
    maxHp,
    resolve: maxResolve,
    maxResolve,
    armourReduction: Math.max(0, reduction),
    penetration: Math.max(0, penetration),
    weaponDamage: String(curve['damage'] ?? ''),
    damageBonus,
    attacksPerRound: (base as { attacks?: number }).attacks ?? 1,
    threat,
    // Friendliness decides how a creature breaks under Presence — flee,
    // surrender or join — read against PRESENCE_BREAK. Bribery, standing and
    // prices still wait for the shop; those columns stay at rest.
    friendliness,
    bribeThreshold: 0,
    disposition: 0,
    standing: 0,
    sensed: false,
    isVendor: false,
    priceModifier: 1,
    hostile: true,
    baseId: base.id,
    role: role.id,
    gambits,
    abilities: abilitiesFor(campaign, gambits),
    presenceImmune,
  };
}

/**
 * How readily a creature breaks rather than dies. A base range, shifted by the
 * tags it carries: the venal and lustful can be turned, the relentless run.
 * Read against `PRESENCE_BREAK` the moment its Resolve hits zero.
 */
function rollFriendliness(campaign: ResolvedCampaign, rng: Rng, tags: readonly string[]): number {
  const roll = (campaign.monsters as {
    friendlinessRoll?: { base?: [number, number]; byTag?: Record<string, number> };
  }).friendlinessRoll;
  const [lo, hi] = roll?.base ?? [0, 0];
  const byTag = roll?.byTag ?? {};
  let value = rng.int(lo, hi);
  for (const tag of tags) value += byTag[tag] ?? 0;
  return Math.max(0, Math.min(100, value));
}

/** The elite roll: a title, a tag and a stat lift, at the tier's chance. */
function rollElite(
  campaign: ResolvedCampaign,
  rng: Rng,
  tier: number,
  force: boolean,
): EliteDef | undefined {
  const table = campaign.monsters.elites?.table ?? [];
  if (table.length === 0) return undefined;
  const chance = campaign.monsters.elites?.chance?.[String(tier)] ?? 0;
  if (!force && !rng.chance(chance)) return undefined;
  return rng.maybeWeighted(table);
}

/** Abilities come from the gambit list, capped by the rules. */
function abilitiesFor(campaign: ResolvedCampaign, gambitList: string): string[] {
  const gambits = campaign.abilities.gambitsByRole?.[gambitList] ?? [];
  const cap = ruleNumber(campaign.rules, 'ABILITIES.maxAbilitiesPerCombatant');
  return [...new Set(gambits.map((gambit) => gambit.use))].slice(0, cap);
}

/** The curve for a tier, clamped to what the table actually authors. */
function statCurve(campaign: ResolvedCampaign, tier: number): JsonObject {
  const keys = Object.keys(campaign.monsters.statCurve)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter((key) => Number.isFinite(key))
    .sort((a, b) => a - b);
  const first = keys[0] ?? 1;
  const last = keys[keys.length - 1] ?? first;
  const clamped = Math.min(Math.max(tier, first), last);
  return (campaign.monsters.statCurve[String(clamped)] ?? {}) as JsonObject;
}

/**
 * How many creatures one encounter may field at this tier, clamped to the
 * authored keys the way the stat curve is. A table that says nothing means no
 * cap, so a campaign that omits it behaves exactly as before.
 */
function encounterCap(campaign: ResolvedCampaign, tier: number): number {
  const table = (campaign.monsters as { encounterCap?: JsonObject }).encounterCap;
  if (!table) return Number.POSITIVE_INFINITY;
  const keys = Object.keys(table)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter((key) => Number.isFinite(key))
    .sort((a, b) => a - b);
  const first = keys[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  const last = keys[keys.length - 1] as number;
  const clamped = Math.min(Math.max(tier, first), last);
  return numberAt(table, String(clamped), Number.POSITIVE_INFINITY);
}

const monsterSpread = (campaign: ResolvedCampaign): number => {
  const spread = (campaign.monsters as { statRoll?: { spread?: number } }).statRoll?.spread;
  return typeof spread === 'number' ? spread : 0;
};

const numberAt = (table: JsonObject, key: string, fallback: number): number =>
  typeof table[key] === 'number' ? (table[key] as number) : fallback;
