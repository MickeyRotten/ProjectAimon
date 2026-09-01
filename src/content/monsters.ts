/**
 * Monsters — base × role × elite, assembled into encounters by composition.
 *
 * **Stats are never authored per monster.** They derive from `statCurve[tier]`
 * with a jitter either side, then role modifiers, then elite modifiers, then
 * taxonomy tag multipliers. Fifteen bases, five roles and six elites is the
 * whole table, and it produces creatures that read as individuals.
 *
 * Two gates matter and both came from bugs the reference generator surfaced:
 *
 *  - **Tier gating.** A base may appear when `base.tier <= area.tier + 1`, and
 *    an over-tier base has its weight cut. Without it a tier-1 farm rolls a
 *    barrow wight.
 *  - **Role exclusion.** A role is refused when the base carries any of its
 *    `excludeTags`. A mindless skeleton must never roll `leader`, because
 *    leader gambits use Presence abilities it can never land.
 */

import type { Json, JsonObject } from '../campaign/merge';
import type {
  AreaDef,
  CompositionDef,
  MonsterBaseDef,
  MonsterRoleDef,
  ResolvedCampaign,
} from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber, ruleObject } from '../engine/rules';
import { matches } from '../engine/tags';
import type { LocationRef, NpcRecord, Stats } from './records';
import { rollSex } from './sex';

export interface MonsterRoll {
  campaign: ResolvedCampaign;
  rng: Rng;
  /** The area archetype, which is what `bases[].areas` filters on. */
  archetype: string;
  areaDef?: AreaDef | undefined;
  roomTags: readonly string[];
  tier: number;
  location: LocationRef;
  /** World flags, for spawn upgrades and conditional stats. Empty is normal. */
  flags?: ReadonlySet<string> | undefined;
}

export interface EncounterRoll extends MonsterRoll {
  /** Mints one id per creature, because ids are unique across the world. */
  mintId: () => string;
  /** The deepest room in an area is guaranteed one. */
  forceElite?: boolean | undefined;
}

/** One creature. Undefined when no base in the tables belongs here. */
export function rollMonster(
  roll: MonsterRoll & { id: string; role?: string | undefined; elite?: boolean | undefined },
): NpcRecord | undefined {
  const { campaign, rng } = roll;
  const rules = campaign.rules;
  const table = campaign.monsters;

  const base = pickBase(roll);
  if (!base) return undefined;
  const role = pickRole(rng, table.roles ?? [], base, roll.role);

  const curve = statCurve(campaign, base.tier);
  const jitter = ruleNumber(rules, 'MONSTER_ROLL.statJitter');
  const attributes = (ruleAt(rules, 'STAT_ROLL.attributes') ?? []) as Json;
  const stats: Stats = {};
  for (const attribute of Array.isArray(attributes) ? attributes : []) {
    if (typeof attribute !== 'string') continue;
    const mean = ruleNumber(curve, 'mean');
    stats[attribute] = mean + rng.int(-jitter, jitter) + (role.mods?.[attribute] ?? 0);
  }

  let tags = [...new Set([...(base.tags ?? []), ...(role.tags ?? [])])];
  let title = '';
  let reduction = ruleNumber(curve, 'reduction', 0);
  let damageBonus = 0;
  let eliteId = '';

  // Taxonomy is a lookup, not a field: `hulking` is worth 40% more HP wherever
  // it appears, and `armoured` is worth reduction on anything carrying it.
  for (const tag of tags) {
    const taxonomy = ruleAt(rules, `TAXONOMY.${tag}`);
    if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) continue;
    const entry = taxonomy as JsonObject;
    if (typeof entry['hp'] === 'number' && typeof stats['toughness'] === 'number') {
      stats['toughness'] = Math.round(stats['toughness'] * entry['hp']);
    }
    if (typeof entry['reduction'] === 'number') reduction += entry['reduction'];
  }

  if (roll.elite || rng.chance(eliteChanceFor(campaign, base.tier))) {
    const elite = rng.maybeWeighted(table.elites?.table ?? []);
    if (elite) {
      eliteId = elite.id;
      title = `${elite.title} `;
      tags = [...new Set([...tags, ...(elite.tags ?? [])])];
      for (const [key, value] of Object.entries(elite.mods ?? {})) {
        if (key === 'reduction') reduction += value;
        else if (key === 'damage') damageBonus += value;
        else if (stats[key] !== undefined) stats[key] = (stats[key] as number) + value;
      }
    }
  }

  // What the player did elsewhere shows up in what they meet later. Both
  // tables are inert until the flag system writes a flag.
  for (const row of conditionalRows(campaign)) {
    if (!row.ifFlag || !roll.flags?.has(row.ifFlag)) continue;
    if (!(row.appliesTo ?? []).some((tag) => tags.includes(tag))) continue;
    title = `${row.title ?? ''}${title}`;
    for (const [key, value] of Object.entries(row.mods ?? {})) {
      if (key === 'reduction') reduction += value;
      else if (key === 'damage') damageBonus += value;
      else if (stats[key] !== undefined) stats[key] = (stats[key] as number) + value;
    }
  }

  const presenceImmune = tags.some(
    (tag) => (ruleAt(rules, `TAXONOMY.${tag}.presenceImmune`) as boolean | undefined) === true,
  );
  const name = `${title}${role.name ?? ''}${base.name}`;

  return {
    campaignId: campaign.id,
    id: roll.id,
    name,
    aliases: [],
    location: roll.location,
    persona: `${name}. ${tags.join(', ')}.`,
    tags,
    stats,
    hp: Math.max(1, Math.round((stats['toughness'] ?? 1) * ruleNumber(rules, 'DERIVED.hpPerToughness'))),
    resolve: presenceImmune
      ? null
      : Math.max(
          1,
          Math.round((stats['willpower'] ?? 1) * ruleNumber(rules, 'DERIVED.resolvePerWillpower')),
        ),
    armourReduction: Math.max(0, reduction),
    penetration: ruleNumber(curve, 'penetration', 0),
    weaponDamage: String(ruleAt(curve, 'damage') ?? ''),
    damageBonus,
    attacksPerRound: base.attacks ?? ruleNumber(rules, 'DERIVED.attacksPerRound'),
    threat: ruleNumber(rules, 'DERIVED.threatBase') + (role.mods?.['threat'] ?? 0),
    friendliness: rollFrom(rng, campaign.npcs.friendlinessRoll),
    bribeThreshold: bribeThreshold(campaign, roll.tier, tags),
    disposition: rollFrom(rng, campaign.npcs.dispositionRoll),
    standing: 0,
    sensed: false,
    isVendor: false,
    priceModifier: 1,
    imageBlob: null,
    services: [],
    hostile: true,
    sex: rollSex(rng, roll.areaDef, base.sex, campaign.monsters.sexDefault ?? {}),
    baseId: base.id,
    role: role.id,
    elite: eliteId,
    tier: base.tier,
  };
}

/**
 * A whole encounter. The composition is picked first and then each slot is
 * filled — which controls *which* variants appear together, rather than hoping
 * a leader role pulls a sensible escort.
 */
export function rollEncounter(roll: EncounterRoll): NpcRecord[] {
  const { campaign, rng } = roll;
  const compositions = (campaign.monsters.compositions?.table ?? []).filter(
    (composition: CompositionDef) => matches(roll.roomTags, composition.requires),
  );
  const composition = rng.maybeWeighted(compositions);
  if (!composition) return [];

  const group: NpcRecord[] = [];
  for (const [wanted, lo, hi] of composition.parts ?? []) {
    const first = rollMonster({
      ...roll,
      id: roll.mintId(),
      ...(wanted === 'any' ? {} : { role: wanted }),
    });
    if (!first) continue;

    // The composition says how many slots; the base's own tags say whether it
    // is the kind of thing that comes in numbers. A pack of hulking brutes is
    // one brute; a lone swarm of rats is still a swarm.
    const [floor, ceiling] = groupSizeFor(campaign, first.tags);
    const count = Math.max(floor, Math.min(ceiling, rng.int(lo, hi)));
    group.push(first);
    for (let i = 1; i < count; i++) {
      const extra = rollMonster({ ...roll, id: roll.mintId(), role: first.role });
      if (extra) group.push(extra);
    }
  }

  // A leader alone is the one case the escort range still answers for: the
  // composition tables handle every other grouping.
  if (group.length === 1) {
    const leader = group[0] as NpcRecord;
    const escort = (campaign.monsters.roles ?? []).find((role) => role.id === leader.role)?.escort;
    if (escort) {
      const wanted = rng.int(escort[0], escort[1]);
      for (let i = 0; i < wanted; i++) {
        const extra = rollMonster({ ...roll, id: roll.mintId() });
        if (extra) group.push(extra);
      }
    }
  }

  // The deepest room's encounter is re-rolled rather than patched: an elite is
  // a roll on its own table, and a creature assembled without one is not the
  // same creature with a title bolted on.
  if (roll.forceElite && group.length > 0 && group.every((monster) => monster.elite === '')) {
    const promoted = rollMonster({ ...roll, id: (group[0] as NpcRecord).id, elite: true });
    if (promoted) group[0] = promoted;
  }
  return group;
}

/** The gambits a creature fights by. Derived from its role, never stored. */
export function gambitsOf(campaign: ResolvedCampaign, npc: NpcRecord) {
  const role = (campaign.monsters.roles ?? []).find((entry) => entry.id === npc.role);
  return campaign.abilities.gambitsByRole?.[role?.gambits ?? npc.role] ?? [];
}

// ── the pieces ──────────────────────────────────────────────────────

function pickBase(roll: MonsterRoll): MonsterBaseDef | undefined {
  const { campaign, rng } = roll;
  const overTier = ruleNumber(
    campaign.monsters.tierGate as unknown as JsonObject,
    'overTierWeight',
    1,
  );
  const pool = (campaign.monsters.bases ?? [])
    .filter(
      (base) =>
        (base.areas ?? []).includes(roll.archetype) &&
        base.tier <= roll.tier + 1 &&
        matches(roll.roomTags, base.requires),
    )
    .map((base) => ({ base, w: (base.w ?? 1) * (base.tier > roll.tier ? overTier : 1) }));

  const chosen = rng.maybeWeighted(pool)?.base;
  if (!chosen) return undefined;
  return upgraded(campaign, chosen, roll.flags, rng);
}

/** `spawnUpgrades` swaps one base for another once a flag is set. */
function upgraded(
  campaign: ResolvedCampaign,
  base: MonsterBaseDef,
  flags: ReadonlySet<string> | undefined,
  rng: Rng,
): MonsterBaseDef {
  if (!flags || flags.size === 0) return base;
  for (const row of (campaign.monsters.spawnUpgrades?.table ?? []) as JsonObject[]) {
    const flag = row['ifFlag'];
    const replace = row['replace'];
    if (typeof flag !== 'string' || !flags.has(flag)) continue;
    if (!replace || typeof replace !== 'object' || Array.isArray(replace)) continue;
    const target = (replace as JsonObject)[base.id];
    if (typeof target !== 'string') continue;
    const weight = typeof row['weight'] === 'number' ? row['weight'] : 1;
    if (!rng.chance(weight)) continue;
    const upgrade = (campaign.monsters.bases ?? []).find((entry) => entry.id === target);
    if (upgrade) return upgrade;
  }
  return base;
}

function pickRole(
  rng: Rng,
  roles: readonly MonsterRoleDef[],
  base: MonsterBaseDef,
  wanted: string | undefined,
): MonsterRoleDef {
  const allowed = roles.filter(
    (role) => !(role.excludeTags ?? []).some((tag) => (base.tags ?? []).includes(tag)),
  );
  const pool = allowed.length > 0 ? allowed : roles;
  if (wanted) {
    const asked = allowed.find((role) => role.id === wanted);
    if (asked) return asked;
  }
  const chosen = rng.maybeWeighted(pool);
  if (!chosen) throw new Error('content/monsters.json roles: empty, so nothing can be rolled');
  return chosen;
}

function statCurve(campaign: ResolvedCampaign, tier: number): JsonObject {
  const table = (campaign.monsters.statCurve ?? {}) as unknown as JsonObject;
  const tiers = Object.keys(table)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (tiers.length === 0) {
    throw new Error('content/monsters.json statCurve: no tiers, so nothing can be rolled');
  }
  const first = tiers[0] as number;
  const last = tiers[tiers.length - 1] as number;
  return ruleObject(table, String(Math.max(first, Math.min(last, Math.round(tier)))));
}

function eliteChanceFor(campaign: ResolvedCampaign, tier: number): number {
  const chances = (campaign.monsters.elites?.chance ?? {}) as Record<string, number>;
  const exact = chances[String(Math.round(tier))];
  if (typeof exact === 'number') return exact;
  const known = Object.keys(chances)
    .filter((key) => !key.startsWith('_'))
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const last = known[known.length - 1];
  return last === undefined ? 0 : (chances[String(last)] ?? 0);
}

function groupSizeFor(campaign: ResolvedCampaign, tags: readonly string[]): [number, number] {
  const byTag = campaign.monsters.groupSize?.byTag ?? {};
  for (const tag of tags) {
    const band = byTag[tag];
    if (Array.isArray(band)) return band;
  }
  return campaign.monsters.groupSize?.default ?? [1, 1];
}

interface ConditionalRow {
  ifFlag?: string;
  appliesTo?: string[];
  mods?: Record<string, number>;
  title?: string;
}

const conditionalRows = (campaign: ResolvedCampaign): ConditionalRow[] =>
  (campaign.monsters.conditionalStats?.table ?? []) as unknown as ConditionalRow[];

/** What it costs to buy a creature off. `venal` halves it, per the taxonomy. */
function bribeThreshold(campaign: ResolvedCampaign, tier: number, tags: readonly string[]): number {
  const rules = campaign.rules;
  const base =
    ruleNumber(rules, 'GOLD_SINKS.bribes.baseThreshold') +
    ruleNumber(rules, 'GOLD_SINKS.bribes.perTier') * tier;
  let mult = 1;
  for (const tag of tags) {
    const tagMult = ruleAt(rules, `TAXONOMY.${tag}.bribeMult`);
    if (typeof tagMult === 'number') mult *= tagMult;
  }
  return Math.round(base * mult);
}

/** A `{ base: [lo, hi] }` roll, the shape the NPC table writes them in. */
export function rollFrom(rng: Rng, table: JsonObject | undefined): number {
  const range = table?.['base'];
  if (!Array.isArray(range) || typeof range[0] !== 'number' || typeof range[1] !== 'number') return 0;
  return rng.int(range[0], range[1]);
}
