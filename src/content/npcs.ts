/**
 * NPCs — role + two traits + one want.
 *
 * The engine assembles a persona *string* from those three rolls and hands it
 * to the Narrator, which writes the voice. No dialogue is authored anywhere,
 * and the Narrator never gets to decide a number: friendliness, disposition
 * and every attribute are rolled here and written down before it is asked to
 * say a word.
 *
 * An NPC rolls attributes the way a character does — `STAT_ROLL` — because an
 * NPC is a person rather than a tier of difficulty. Only creatures ride the
 * area curve.
 *
 * The name is provisional. Rooms are named by the Narrator on first entry and
 * people are no different; renaming keeps the id and pushes the old name into
 * `aliases`, so the parser and the transcript never lose track of who was
 * being talked about.
 */

import type { AreaDef, NpcRoleDef, ResolvedCampaign } from '../campaign/types';
import type { Rng } from '../engine/rng';
import { filterByTags } from '../engine/tags';
import type { Location, NpcRecord } from '../world/types';
import { rollSex } from './sex';
import {
  deriveHp,
  deriveRapport,
  deriveResolve,
  floorAttributes,
  rollAttributes,
} from './stats';

export interface NpcOptions {
  campaign: ResolvedCampaign;
  rng: Rng;
  areaDef: AreaDef;
  roomTags: readonly string[];
  location: Location;
  id: string;
}

export interface GeneratedNpc {
  record: NpcRecord;
  role: NpcRoleDef;
  /** The quest type this role can offer. Quests themselves arrive at step 5. */
  questType: string | undefined;
}

/** Returns undefined when no role belongs in this room — a normal outcome. */
export function generateNpc(options: NpcOptions): GeneratedNpc | undefined {
  const { campaign, rng, roomTags } = options;
  const fitting = filterByTags(campaign.npcs.roles, roomTags);
  const role = rng.maybeWeighted(fitting);
  if (!role) return undefined;

  const traitA = rng.maybeWeighted(campaign.npcs.traits);
  const traitB = rng.maybeWeighted(
    campaign.npcs.traits.filter((trait) => trait.id !== traitA?.id),
  );
  const want = rng.maybeWeighted(campaign.npcs.wants);

  const persona = campaign.npcs.personaTemplate
    .replace('{role}', label(role.id))
    .replace('{traitA}', traitA?.id ?? '')
    .replace('{traitB}', traitB?.id ?? '')
    .replace('{want}', want?.id ?? '');

  const stats = floorAttributes(rollAttributes(rng, campaign.rules));
  const rapport = deriveRapport(campaign.rules, stats.charisma);
  const maxHp = deriveHp(campaign.rules, stats.toughness);
  const maxResolve = deriveResolve(campaign.rules, stats.willpower);

  const tags = [
    ...new Set([
      ...((campaign.npcs as { defaultTags?: string[] }).defaultTags ?? []),
      ...(role.tags ?? []),
      // A trait may carry a taxonomy tag — `flirtatious` is `lustful` — and
      // that is the only route by which one reaches an NPC.
      ...((traitA as { tags?: string[] } | undefined)?.tags ?? []),
      ...((traitB as { tags?: string[] } | undefined)?.tags ?? []),
    ]),
  ];

  const record: NpcRecord = {
    campaignId: campaign.id,
    id: options.id,
    name: `the ${label(role.id)}`,
    aliases: [],
    location: options.location,
    persona,
    tags,
    sex: rollSex({
      rng,
      areaDef: options.areaDef,
      own: role.sex,
      fallback: campaign.npcs.sexDefault,
    }),
    stats,
    hp: maxHp,
    maxHp,
    resolve: maxResolve,
    maxResolve,
    // A person's armour and weapon come from what they are carrying, which is
    // a query over `location` rather than a number on the record.
    armourReduction: 0,
    penetration: 0,
    weaponDamage: '',
    damageBonus: 0,
    attacksPerRound: 1,
    threat: 0,
    friendliness: roll(rng, campaign, 'friendlinessRoll', rapport),
    bribeThreshold: 0,
    disposition: roll(rng, campaign, 'dispositionRoll', rapport),
    standing: 0,
    sensed: false,
    isVendor: role.vendor === true,
    priceModifier: 1,
    hostile: false,
    baseId: role.id,
    role: role.id,
    gambits: '',
    abilities: [],
    presenceImmune: false,
  };

  return { record, role, questType: rng.maybePick(role.quests ?? []) };
}

/** `{ base: [lo, hi], perRapport: n }` — the shape both NPC rolls share. */
function roll(rng: Rng, campaign: ResolvedCampaign, key: string, rapport: number): number {
  const table = (campaign.npcs as unknown as Record<string, unknown>)[key] as
    | { base?: [number, number]; perRapport?: number }
    | undefined;
  const [lo, hi] = table?.base ?? [0, 0];
  return Math.round(rng.int(lo, hi) + rapport * (table?.perRapport ?? 0));
}

/** `hedge_witch` reads as "hedge witch" everywhere a person is named. */
const label = (id: string): string => id.replace(/_/g, ' ');
