/**
 * NPCs — role × two traits × one want.
 *
 * Twelve roles, fifteen traits and twelve wants is about fifteen thousand
 * personas from three short lists. The engine assembles a persona **string**
 * and nothing else:
 *
 *   "fence. grieving and wheedling. Wants a debt paid."
 *
 * The Narrator writes every line of dialogue from that. **No dialogue is
 * authored, ever**, and no number in this file comes from the model.
 *
 * Roles filter on room tags, which is what stops a smith appearing in a field.
 */

import type { AreaDef, HubNpcDef, NpcRoleDef, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { ruleAt, ruleNumber } from '../engine/rules';
import { matches } from '../engine/tags';
import { rollFrom } from './monsters';
import type { LocationRef, NpcRecord, Stats } from './records';
import { rollSex } from './sex';

export interface NpcRoll {
  campaign: ResolvedCampaign;
  rng: Rng;
  id: string;
  roomTags: readonly string[];
  tier: number;
  location: LocationRef;
  areaDef?: AreaDef | undefined;
}

/** Roll a person. Undefined when no role in the table belongs in this room. */
export function rollNpc(roll: NpcRoll): NpcRecord | undefined {
  const { campaign, rng } = roll;
  const table = campaign.npcs;

  const fitting = (table.roles ?? []).filter((role) => matches(roll.roomTags, role.requires));
  const role = rng.maybeWeighted(fitting);
  if (!role) return undefined;

  const traitA = rng.maybeWeighted(table.traits ?? []);
  let traitB = rng.maybeWeighted(table.traits ?? []);
  if (traitB && traitA && traitB.id === traitA.id) {
    // Two of the same trait reads as a bug, so re-roll once and take what comes.
    traitB = rng.maybeWeighted((table.traits ?? []).filter((trait) => trait.id !== traitA.id));
  }
  const want = rng.maybeWeighted(table.wants ?? []);

  const persona = (table.personaTemplate ?? '{role}. {traitA} and {traitB}. Wants {want}.')
    .replace('{role}', role.id.replace(/_/g, ' '))
    .replace('{traitA}', traitA?.id ?? '')
    .replace('{traitB}', traitB?.id ?? '')
    .replace('{want}', want?.id ?? '');

  // A trait may carry a creature tag — `flirtatious` is `lustful` — so the
  // persona and the resolver agree about what this person is.
  const tags = [
    ...new Set([...(role.tags ?? []), ...(traitA?.tags ?? []), ...(traitB?.tags ?? [])]),
  ] as string[];

  return {
    ...blankPerson(campaign, rng, roll.id, roll.location, persona, tags),
    name: '',
    isVendor: role.vendor === true,
    sex: rollSex(rng, roll.areaDef, role.sex, table.sexDefault ?? {}),
    role: role.id,
    tier: roll.tier,
  };
}

/** The quest types this role offers, straight off the table. */
export function questsOf(campaign: ResolvedCampaign, npc: NpcRecord): string[] {
  const role = (campaign.npcs.roles ?? []).find((entry: NpcRoleDef) => entry.id === npc.role);
  return [...(role?.quests ?? [])];
}

/** A hand-authored Hub NPC, given the same numbers a rolled one gets. */
export function hubNpc(campaign: ResolvedCampaign, rng: Rng, def: HubNpcDef): NpcRecord {
  return {
    ...blankPerson(campaign, rng, def.id, def.location, def.persona, def.tags ?? []),
    name: def.name,
    isVendor: def.isVendor === true,
    services: [...(def.services ?? [])],
    sex: rollSex(rng, undefined, def.sex, campaign.npcs.sexDefault ?? {}),
    role: 'hub',
    tier: 0,
  };
}

// ── the pieces ──────────────────────────────────────────────────────

/**
 * The parts every person shares. Attributes roll on the same dice the player
 * does — an innkeeper and a barrow wight are one record type, and the
 * shopkeeper you decide to rob had better have real numbers.
 */
function blankPerson(
  campaign: ResolvedCampaign,
  rng: Rng,
  id: string,
  location: LocationRef,
  persona: string,
  tags: readonly string[],
): NpcRecord {
  const rules = campaign.rules;
  const dice = ruleNumber(rules, 'STAT_ROLL.dice');
  const sides = ruleNumber(rules, 'STAT_ROLL.sides');
  const attributes = ruleAt(rules, 'STAT_ROLL.attributes');

  const stats: Stats = {};
  for (const attribute of Array.isArray(attributes) ? attributes : []) {
    if (typeof attribute === 'string') stats[attribute] = rng.dice(`${dice}d${sides}`);
  }

  return {
    campaignId: campaign.id,
    id,
    name: '',
    aliases: [],
    location,
    persona,
    tags: [...tags],
    stats,
    hp: Math.round((stats['toughness'] ?? 1) * ruleNumber(rules, 'DERIVED.hpPerToughness')),
    resolve: Math.round((stats['willpower'] ?? 1) * ruleNumber(rules, 'DERIVED.resolvePerWillpower')),
    armourReduction: 0,
    penetration: 0,
    weaponDamage: '',
    damageBonus: 0,
    attacksPerRound: ruleNumber(rules, 'DERIVED.attacksPerRound'),
    threat: ruleNumber(rules, 'DERIVED.threatBase'),
    friendliness: rollFrom(rng, campaign.npcs.friendlinessRoll),
    bribeThreshold: ruleNumber(rules, 'GOLD_SINKS.bribes.baseThreshold'),
    disposition: rollFrom(rng, campaign.npcs.dispositionRoll),
    standing: 0,
    sensed: false,
    isVendor: false,
    priceModifier: 1,
    imageBlob: null,
    services: [],
    hostile: false,
    sex: 'none',
    baseId: '',
    role: '',
    elite: '',
    tier: 0,
  };
}
