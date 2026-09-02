/**
 * The player record, and the one place a character is made.
 *
 * The player is not an `npcs` row. A creature stores its final combat values
 * and skips the maths; the player stores attributes and skills and derives
 * everything else at the moment it is read, so retuning `DERIVED` in
 * `rules.json` reaches a character who has already been walking around for two
 * hundred turns.
 *
 * Nothing here invents a number. Attributes are rolled with `STAT_ROLL`,
 * starting skills come out of `WEAPON_TABLE` and `APPROACH_TABLE`, libido
 * starts at `LIBIDO_START`, and the kit is whatever `campaign.json` lists.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { generateItem } from '../content/items';
import { deriveCarry, deriveHp, deriveResolve, floorAttributes, rollAttributes } from '../content/stats';
import type { Rng } from '../engine/rng';
import { ruleNumber, ruleObject } from '../engine/rules';
import { IN_PLAYER, type Attributes, type ObjectRecord } from '../world/types';

export interface PlayerRecord {
  campaignId: string;
  name: string;
  /** The character-creation archetype, which chooses the kit and nothing else. */
  archetype: string;
  roomId: string;
  hp: number;
  resolve: number;
  libido: number;
  purse: number;
  banked: number;
  stats: Attributes;
  weaponSkills: Record<string, number>;
  approachSkills: Record<string, number>;
  armourExpertise: number;
  /** The object id of the worn armour, or empty. Derived values read it. */
  armourWorn: string;
  /** The object id of the wielded weapon, or empty. */
  weaponWielded: string;
  /** What `it`, `him`, `her` and `them` last referred to. */
  pronounRefs: Record<string, string | null>;
}

export interface CreatePlayerOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  name: string;
  /** An id from `characterCreation.archetypes`. Defaults to the first. */
  archetype?: string | undefined;
  /** Where the character starts. The Hub entry room, normally. */
  roomId: string;
}

export interface CreatedPlayer {
  player: PlayerRecord;
  /** The starter kit, already located on the player. */
  kit: ObjectRecord[];
}

/**
 * Roll a character and issue the kit.
 *
 * The archetype supplies gear, not statistics: attributes are 3d8 straight,
 * because weighting a roll toward an archetype's favoured pair would be a rule
 * living in the engine rather than in a table.
 */
export function createPlayer(options: CreatePlayerOptions): CreatedPlayer {
  const { campaign, rng } = options;
  const rules = campaign.rules;
  const creation = campaign.manifest.characterCreation;
  const archetype =
    creation.archetypes.find((entry) => entry.id === options.archetype) ?? creation.archetypes[0];

  const stats = floorAttributes(rollAttributes(rng, rules));
  const player: PlayerRecord = {
    campaignId: campaign.id,
    name: options.name,
    archetype: archetype?.id ?? '',
    roomId: options.roomId,
    hp: deriveHp(rules, stats.toughness),
    resolve: deriveResolve(rules, stats.willpower),
    libido: ruleNumber(rules, 'LIBIDO_START'),
    purse: campaign.manifest.starterKit.gold,
    banked: 0,
    stats,
    weaponSkills: startingSkills(campaign, 'WEAPON_TABLE'),
    approachSkills: startingSkills(campaign, 'APPROACH_TABLE'),
    armourExpertise: 0,
    armourWorn: '',
    weaponWielded: '',
    pronounRefs: { it: null, him: null, her: null, them: null },
  };

  const kit = issueKit(campaign, rng, [
    ...campaign.manifest.starterKit.items,
    ...(archetype?.kit ?? []),
  ]);

  // Whatever the kit brought, the character walks out of the Hub using it.
  const weapon = kit.find((item) => item.flags.weapon);
  const armour = kit.find((item) => item.flags.armour);
  if (weapon) player.weaponWielded = weapon.id;
  if (armour) {
    armour.flags.worn = true;
    player.armourWorn = armour.id;
  }
  return { player, kit };
}

/**
 * Build the kit from base ids. Duplicates are dropped — the archetype's kit
 * and the standing starter kit overlap on purpose, and being issued two clubs
 * for it would read as a bug.
 */
export function issueKit(
  campaign: ResolvedCampaign,
  rng: Rng,
  baseIds: readonly string[],
): ObjectRecord[] {
  const tags = campaign.manifest.starterKit.tags ?? [];
  const out: ObjectRecord[] = [];
  for (const baseId of [...new Set(baseIds)]) {
    const item = generateItem({
      campaign,
      rng,
      tier: 0,
      baseId,
      id: `kit_${baseId}_${rng.int(0x1000, 0xffff).toString(16)}`,
      location: IN_PLAYER,
    });
    if (!item) continue;
    // Untradable, per the manifest: a free kit that can be sold is a gold
    // fountain reachable by walking out of the Hub and dying on purpose.
    item.tags = [...new Set([...item.tags, ...tags])];
    if (tags.includes('untradable')) item.flags.untradable = true;
    out.push(item);
  }
  return out;
}

/** `startSkill` for every entry of a rules table that carries one. */
function startingSkills(campaign: ResolvedCampaign, path: string): Record<string, number> {
  const table = ruleObject(campaign.rules, path);
  const out: Record<string, number> = {};
  for (const [id, entry] of Object.entries(table)) {
    if (id.startsWith('_') || entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const start = (entry as Record<string, unknown>)['startSkill'];
    if (typeof start === 'number') out[id] = start;
  }
  return out;
}

export const playerMaxHp = (campaign: ResolvedCampaign, player: PlayerRecord): number =>
  deriveHp(campaign.rules, player.stats.toughness);

export const playerMaxResolve = (campaign: ResolvedCampaign, player: PlayerRecord): number =>
  deriveResolve(campaign.rules, player.stats.willpower);

export const playerCarry = (campaign: ResolvedCampaign, player: PlayerRecord): number =>
  deriveCarry(campaign.rules, player.stats.brawn);
