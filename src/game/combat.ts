/**
 * Combat — build step 6. Dice-roll fighting over a world that already works.
 *
 * The whole of it obeys the core rule: **code owns every number.** Nothing here
 * invents a formula — the chance, the damage, the armour maths, the crit and
 * fumble tables all read out of `rules.json` at the moment they are used, so a
 * campaign that retunes a weapon reaches every fight already in progress. The
 * only thing this file decides is *order*: who rolls, against what, and in which
 * of the two write points the result lands.
 *
 * A player action resolves at the turn loop's player-half write point; the
 * enemy round resolves at the world-half write point, because the creatures are
 * the movers that half was always going to hold. Neither writes state directly:
 * both return `Effect[]`, exactly like every other handler.
 *
 * Two combat routes, one formula. A **weapon** attack rolls Accuracy against
 * Evasion and takes HP; a **Presence** approach rolls Presence against Composure
 * and takes Resolve. At zero HP a creature dies; at zero Resolve it breaks, and
 * how it breaks — flee, surrender, join — is read from its friendliness. Both
 * defeats cost the player exactly the same, so neither track is the real one.
 */

import type { JsonObject } from '../campaign/merge';
import type { AbilityDef } from '../campaign/types';
import { itemValues, weaponDie } from '../content/items';
import {
  deriveAccuracy,
  deriveComposure,
  deriveCrit,
  deriveEvasion,
  derivePresence,
  derivePressureBonus,
  deriveDamageBonus,
  libidoBand,
} from '../content/stats';
import type { Command } from '../engine/parser';
import { Rng } from '../engine/rng';
import { ruleAt, ruleNumber, ruleRange, ruleWeightedPairs } from '../engine/rules';
import type { NpcRecord } from '../world/types';
import { inRoom } from '../world/types';
import type { World } from '../world/world';
import { line, type CommandContext, type Line } from './commands';
import type { CombatOp, Effect } from './effects';
import { matchPhrase } from './scope';

// ── the volatile session ──────────────────────────────────────────────

/**
 * Everything a fight needs that is not durable: whose turn primers are set,
 * which stance each combatant holds, what is on cooldown. Keyed by `player` or
 * an npc id. It is saved with the game so a fight survives a reload, but it is
 * born and dies with the encounter and never outlives it.
 */
export interface CombatState {
  active: boolean;
  round: number;
  primer: Record<string, string>;
  stance: Record<string, string>;
  recharge: Record<string, Record<string, number>>;
  usedEncounter: Record<string, string[]>;
  threat: Record<string, number>;
}

export const PLAYER = 'player';

export const emptyCombat = (): CombatState => ({
  active: false,
  round: 0,
  primer: {},
  stance: {},
  recharge: {},
  usedEncounter: {},
  threat: {},
});

/** Apply one bookkeeping change to the session. The turn loop calls this. */
export function combatReduce(state: CombatState, op: CombatOp): void {
  switch (op.t) {
    case 'begin':
      state.active = true;
      state.round = 1;
      state.primer = {};
      state.stance = {};
      state.recharge = {};
      state.usedEncounter = {};
      state.threat = {};
      break;
    case 'end':
      state.active = false;
      state.round = 0;
      state.primer = {};
      state.stance = {};
      state.recharge = {};
      state.usedEncounter = {};
      state.threat = {};
      break;
    case 'round':
      state.round += 1;
      break;
    case 'tickRecharge':
      for (const who of Object.keys(state.recharge)) {
        for (const ability of Object.keys(state.recharge[who] ?? {})) {
          const left = (state.recharge[who]?.[ability] ?? 0) - 1;
          if (left > 0) (state.recharge[who] as Record<string, number>)[ability] = left;
          else delete state.recharge[who]?.[ability];
        }
      }
      break;
    case 'primer':
      if (op.value) state.primer[op.who] = op.value;
      else delete state.primer[op.who];
      break;
    case 'stance':
      if (op.value) state.stance[op.who] = op.value;
      else delete state.stance[op.who];
      break;
    case 'recharge':
      (state.recharge[op.who] ??= {})[op.ability] = op.rounds;
      break;
    case 'useEncounter':
      (state.usedEncounter[op.who] ??= []).push(op.ability);
      break;
    case 'threat':
      state.threat[op.who] = (state.threat[op.who] ?? 0) + op.delta;
      break;
    case 'sense':
      // Handled on the record, not here — sensing is durable.
      break;
  }
}

/** Living, still-hostile creatures standing in the room. The fight's enemy side. */
export function hostilesIn(world: World, roomId: string): NpcRecord[] {
  return world.npcsIn(roomId).filter((npc) => npc.hostile && !npc.defeated);
}

// ── a combatant, as combat reads it ─────────────────────────────────────

/**
 * The numbers a fight needs, derived once for the actor and the target. The
 * player derives them from attributes, skills and worn gear every time; a
 * creature reads its stored finals. Nothing here is written back.
 */
interface Fighter {
  id: string;
  isPlayer: boolean;
  name: string;
  hp: number;
  maxHp: number;
  resolve: number;
  maxResolve: number;
  toughness: number;
  accuracy: number;
  evasion: number;
  presence: number;
  composure: number;
  allure: number;
  damageBonus: number;
  pressureBonus: number;
  crit: number;
  armourReduction: number;
  armourPenaltyEff: number;
  weaponKind: string;
  weaponDie: string;
  weaponPenetration: number;
  weaponComplexity: number;
  weaponSkill: number;
  approachSkills: Record<string, number>;
  armourExpertise: number;
  tags: string[];
  presenceImmune: boolean;
  friendliness: number;
  abilities: string[];
}

function playerFighter(ctx: CombatContext): Fighter {
  const { campaign, player } = ctx;
  const rules = campaign.rules;
  const s = player.stats;

  const wielded = player.weaponWielded ? ctx.world.objects.get(player.weaponWielded) : undefined;
  const worn = player.armourWorn ? ctx.world.objects.get(player.armourWorn) : undefined;
  const unarmed = ruleAt(rules, 'COMBAT.unarmed') as JsonObject | undefined;

  const weaponKind = wielded?.baseId ?? 'unarmed';
  const die = wielded ? weaponDie(campaign, wielded.baseId) : '';
  const wValues = wielded ? itemValues(campaign, wielded) : {};
  const aValues = worn ? itemValues(campaign, worn) : {};
  const complexity = wielded
    ? (numberAt(ruleAt(rules, `WEAPON_TABLE.${wielded.baseId}`), 'complexity', 0) + (wValues['complexity'] ?? 0))
    : numberAt(unarmed, 'complexity', 0);

  const band = libidoBand(rules, player.libido);
  const gearAllure = (wValues['allure'] ?? 0) + (aValues['allure'] ?? 0);
  const penalty = (aValues['penalty'] ?? 0);
  const unarmedDie = typeof unarmed?.['damage'] === 'string' ? unarmed['damage'] : '1d2';

  return {
    id: PLAYER,
    isPlayer: true,
    name: player.name,
    hp: player.hp,
    maxHp: Math.max(1, Math.round(s.toughness * ruleNumber(rules, 'DERIVED.hpPerToughness'))),
    resolve: player.resolve,
    maxResolve: Math.max(1, Math.round(s.willpower * ruleNumber(rules, 'DERIVED.resolvePerWillpower'))),
    toughness: s.toughness,
    accuracy: deriveAccuracy(rules, s.agility) + (wValues['accuracy'] ?? 0),
    evasion: deriveEvasion(rules, s.agility) + (aValues['evasion'] ?? 0) + (wValues['evasion'] ?? 0),
    presence: derivePresence(rules, s.charisma),
    composure: deriveComposure(rules, s.willpower) + band.composure,
    allure: band.allure + gearAllure,
    damageBonus: deriveDamageBonus(rules, s),
    pressureBonus: derivePressureBonus(rules, s),
    crit: deriveCrit(rules, s.wits),
    armourReduction: (aValues['reduction'] ?? 0),
    armourPenaltyEff: Math.max(0, penalty - player.armourExpertise),
    weaponKind,
    weaponDie: die || unarmedDie,
    weaponPenetration: wielded ? (wValues['penetration'] ?? 0) : numberAt(unarmed, 'penetration', 0),
    weaponComplexity: complexity,
    weaponSkill: player.weaponSkills[weaponKind] ?? 0,
    approachSkills: { ...player.approachSkills },
    armourExpertise: player.armourExpertise,
    tags: ['humanoid'],
    presenceImmune: false,
    friendliness: 0,
    abilities: playerAbilities(ctx),
  };
}

function npcFighter(ctx: CombatContext, npc: NpcRecord): Fighter {
  const rules = ctx.campaign.rules;
  const s = npc.stats;
  return {
    id: npc.id,
    isPlayer: false,
    name: npc.name,
    hp: npc.hp,
    maxHp: npc.maxHp,
    resolve: npc.resolve,
    maxResolve: npc.maxResolve,
    toughness: s.toughness,
    accuracy: deriveAccuracy(rules, s.agility),
    evasion: deriveEvasion(rules, s.agility),
    presence: derivePresence(rules, s.charisma),
    composure: deriveComposure(rules, s.willpower),
    allure: 0,
    damageBonus: npc.damageBonus,
    pressureBonus: derivePressureBonus(rules, s),
    crit: deriveCrit(rules, s.wits),
    armourReduction: npc.armourReduction,
    armourPenaltyEff: 0,
    weaponKind: '',
    weaponDie: npc.weaponDamage || '1d4',
    weaponPenetration: npc.penetration,
    weaponComplexity: 0,
    weaponSkill: 0,
    approachSkills: {},
    armourExpertise: 0,
    tags: npc.tags,
    presenceImmune: npc.presenceImmune,
    friendliness: npc.friendliness,
    abilities: npc.abilities,
  };
}

/** Which abilities the player may reach for, filtered by `grantedBy`. */
function playerAbilities(ctx: CombatContext): string[] {
  const out: string[] = [];
  for (const ability of ctx.campaign.abilities.table) {
    if (grantsToPlayer(ctx, ability.grantedBy)) out.push(ability.id);
  }
  return out;
}

function grantsToPlayer(ctx: CombatContext, grantedBy: string): boolean {
  if (!grantedBy || grantedBy === 'always') return true;
  const { player, world } = ctx;
  const [head, arg] = grantedBy.split(':');
  if (head === 'weapon') {
    const kind = player.weaponWielded ? world.objects.get(player.weaponWielded)?.baseId : undefined;
    return kind ? (arg ?? '').split('|').includes(kind) : false;
  }
  if (head === 'armour') {
    const kind = player.armourWorn ? world.objects.get(player.armourWorn)?.baseId : undefined;
    return kind ? (arg ?? '').split('|').includes(kind) : false;
  }
  if (head === 'skill') {
    // `skill:intimidate>=20`
    const m = (arg ?? '').match(/^([a-z]+)>=(\d+)$/);
    if (!m) return false;
    const have = player.approachSkills[m[1] as string] ?? 0;
    return have >= Number(m[2]);
  }
  if (head === 'role') return false; // leader-only abilities are the enemy's
  return false;
}

// ── the context the turn loop hands in ──────────────────────────────────

export interface CombatContext extends CommandContext {
  rng: Rng;
  combat: CombatState;
}

export interface CombatReply {
  lines: Line[];
  effects: Effect[];
  /** A query, not an action: no turn spent, no enemy round. */
  free: boolean;
  /** The player left the fight — the world half must not run an enemy round. */
  fled?: boolean;
}

// ── the player's turn ───────────────────────────────────────────────────

/** The line printed the moment a fight starts. Reads the enemy side aloud. */
export function engageLines(ctx: CombatContext): Line[] {
  const hostiles = hostilesIn(ctx.world, ctx.room.id);
  const names = countNames(hostiles);
  return [
    line(`${names} turn on you. Fight, flee, or bend them with a Presence approach.`, 'warn'),
    line('ATTACK <foe> · USE <intimidate|taunt|seduce> ON <foe> · USE <ability> ON <foe> · EXAMINE <foe> · FLEE', 'rule'),
  ];
}

/**
 * One player command, inside a fight. Queries stay free; a real action rolls,
 * returns its effects for the player-half write point, and lets the world half
 * run the enemy round after.
 */
export function playerCombatAction(ctx: CombatContext, command: Command): CombatReply {
  switch (command.verb) {
    case 'look':
    case 'inventory':
    case 'stats':
    case 'map':
    case 'quests':
    case 'help':
    case 'examine':
      // Examine that names a foe is Sensing and costs the turn; handled below.
      if (command.verb === 'examine' && namesHostile(ctx, command)) break;
      return { lines: [], effects: [], free: true };
    default:
      break;
  }

  switch (command.verb) {
    case 'flee':
      return fleeAction(ctx);
    case 'attack':
      return weaponAction(ctx, command);
    case 'examine':
      return senseAction(ctx, command);
    case 'use':
      return useAction(ctx, command);
    case 'wait':
      return { lines: [line('You hold your ground.', 'plain')], effects: [], free: false };
    case 'go':
    case 'enter':
    case 'exit':
    case 'climb':
      return { lines: [line('Not while something is swinging at you. FLEE to break away.', 'warn')], effects: [], free: true };
    default:
      return {
        lines: [line('No time for that. ATTACK, a Presence approach, or FLEE.', 'warn')],
        effects: [],
        free: true,
      };
  }
}

// ── weapon attacks ──────────────────────────────────────────────────────

function weaponAction(ctx: CombatContext, command: Command): CombatReply {
  const target = pickTarget(ctx, command);
  if (!target) return noTarget(ctx);
  const actor = playerFighter(ctx);
  const attack = campaignAbility(ctx, 'attack');
  const { lines, effects } = resolveWeapon(ctx, actor, npcFighter(ctx, target), attack);
  effects.push({ kind: 'combat', op: { t: 'sense', id: target.id } }, { kind: 'pronoun', ref: 'it', id: target.id });
  return { lines, effects, free: false };
}

/**
 * Resolve one weapon strike, all the way through: chance, the to-hit roll and
 * its fumble tail, damage floored before armour, armour scaled by Toughness
 * then pierced, and the critical roll on top. Every number is read, never
 * assumed.
 */
function resolveWeapon(
  ctx: CombatContext,
  actor: Fighter,
  target: Fighter,
  ability: AbilityDef | undefined,
): { lines: Line[]; effects: Effect[] } {
  const rules = ctx.campaign.rules;
  const lines: Line[] = [];
  const effects: Effect[] = [];
  const eff = (ability?.effect ?? {}) as JsonObject;
  const trig = triggerFor(ctx, actor, ability);
  const bonus = trig ? { ...eff, ...(trig.effect as JsonObject) } : eff;

  const stanceA = stanceEffect(ctx, actor.id);
  const stanceB = stanceEffect(ctx, target.id);
  const accMod = num(bonus, 'accuracy') + num(stanceA, 'accuracy');
  const attackVal = actor.accuracy - actor.armourPenaltyEff + actor.weaponSkill + actor.weaponComplexity + accMod;
  const defenceVal = target.evasion + num(stanceB, 'evasion');
  const chance = clampChance(rules, attackVal - defenceVal + ruleNumber(rules, 'TO_HIT_BASE'));

  const roll = ctx.rng.int(1, 100);
  const [fumbleLo, fumbleHi] = ruleRange(rules, 'FUMBLE_RANGE');
  const verb = ability && ability.id !== 'attack' ? ability.name : 'strike';

  if (roll >= fumbleLo && roll <= fumbleHi) {
    lines.push(...weaponFumble(ctx, actor));
    if (trig) effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: '' } });
    pushRecharge(effects, actor.id, ability);
    return { lines, effects };
  }
  if (roll > chance) {
    lines.push(line(`Your ${verb} misses the ${target.name}. (${chance}% to hit)`, 'roll'));
    pushRecharge(effects, actor.id, ability);
    return { lines, effects };
  }

  // Hit. Damage, then armour, then the crit roll on top.
  const ignoreArmour = bonus['ignoreArmour'] === true;
  const penetration = actor.weaponPenetration + num(bonus, 'penetration');
  const mult = 'damageMult' in bonus ? num(bonus, 'damageMult', 1) : 1;
  const critMod = num(bonus, 'critChance');

  let damage = weaponDamage(ctx, actor, target, { ignoreArmour, penetration, mult, stanceB });
  const critChance = actor.crit + critMod;
  let critNote = '';
  if (ctx.rng.int(1, 100) <= critChance) {
    const outcome = pickTable(ctx, 'CRIT_TABLE');
    critNote = ` Critical: ${critLabel(outcome)}.`;
    if (outcome === 'ignoreArmour') {
      damage = weaponDamage(ctx, actor, target, { ignoreArmour: true, penetration, mult, stanceB });
    } else if (outcome === 'x1.5') damage = Math.round(damage * 1.5);
    else if (outcome === 'x2') damage *= 2;
    else if (outcome === 'x3') damage *= 3;
    else if (outcome === 'autoDefeat') damage = Math.max(damage, target.hp);
  }
  damage = Math.max(1, damage);

  lines.push(line(`Your ${verb} lands on the ${target.name} for ${damage}.${critNote} (${chance}%)`, 'roll'));
  effects.push({ kind: 'npcHp', id: target.id, delta: -damage });

  // Skill growth on a landed hit, and the primer this ability sets or spends.
  pushWeaponSkillGrowth(effects, ctx, actor);
  if (ability?.applies) effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: ability.applies } });
  if (trig) effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: '' } });
  pushRecharge(effects, actor.id, ability);

  if (bonus['dropWeapon'] === true) lines.push(line(`The ${target.name} is knocked off its guard.`, 'plain'));

  if (target.hp - damage <= 0) lines.push(...killLines(target, effects));
  return { lines, effects };
}

interface DamageOpts {
  ignoreArmour: boolean;
  penetration: number;
  mult: number;
  stanceB: JsonObject;
}

function weaponDamage(ctx: CombatContext, actor: Fighter, target: Fighter, opts: DamageOpts): number {
  const rules = ctx.campaign.rules;
  const raw = Math.max(1, ctx.rng.dice(actor.weaponDie) + actor.damageBonus);
  const scaled = Math.max(1, Math.round(raw * opts.mult));
  const reduction = target.armourReduction + num(opts.stanceB, 'reduction');
  if (opts.ignoreArmour) return Math.max(1, scaled);
  const cap = ruleNumber(rules, 'ARMOUR_CAP');
  const net = Math.max(0, reduction * (1 + target.toughness / 50) - opts.penetration);
  return Math.max(1, Math.round(scaled * (1 - Math.min(net, cap) / 100)));
}

function weaponFumble(ctx: CombatContext, actor: Fighter): Line[] {
  const outcome = pickTable(ctx, 'FUMBLE_TABLE');
  const target = actor.isPlayer ? 'You' : `The ${actor.name}`;
  switch (outcome) {
    case 'dropWeapon':
      return [line(`${target} fumble and lose ${actor.isPlayer ? 'your' : 'its'} grip for a moment.`, 'roll')];
    case 'breakWeapon':
      return [line(`${target} overreach — the blow goes wide and jars ${actor.isPlayer ? 'your' : 'its'} arm.`, 'roll')];
    case 'hitSelf':
      return [line(`${target} misjudge it badly and take the shock of it.`, 'roll')];
    default:
      return [line(`${target} recover ${actor.isPlayer ? 'your' : 'its'} footing. Nothing comes of the swing.`, 'roll')];
  }
}

// ── Presence approaches ─────────────────────────────────────────────────

function useAction(ctx: CombatContext, command: Command): CombatReply {
  const name = (command.object?.words ?? []).join(' ').toLowerCase();
  const approach = APPROACHES.find((a) => name.includes(a));
  if (approach) return presenceAction(ctx, command, approach, undefined);

  const ability = ctx.campaign.abilities.table.find(
    (entry) => entry.id === name.replace(/\s+/g, '_') || entry.name.toLowerCase() === name,
  );
  if (!ability) {
    return { lines: [line(`No such move. Try ATTACK, USE INTIMIDATE ON <foe>, or FLEE.`, 'warn')], effects: [], free: true };
  }
  if (!playerFighter(ctx).abilities.includes(ability.id)) {
    return { lines: [line(`You have not the training for ${ability.name}.`, 'warn')], effects: [], free: true };
  }
  if (!available(ctx, PLAYER, ability)) {
    return { lines: [line(`${ability.name} is not ready.`, 'warn')], effects: [], free: true };
  }
  return runAbility(ctx, command, ability);
}

const APPROACHES = ['intimidate', 'taunt', 'seduce'];

function runAbility(ctx: CombatContext, command: Command, ability: AbilityDef): CombatReply {
  if (ability.effect['leaveFight'] === true) return fleeAction(ctx);
  if (ability.attack === 'weapon') {
    const target = pickTarget(ctx, command);
    if (!target) return noTarget(ctx);
    const { lines, effects } = resolveWeapon(ctx, playerFighter(ctx), npcFighter(ctx, target), ability);
    effects.push({ kind: 'combat', op: { t: 'sense', id: target.id } });
    return { lines, effects, free: false };
  }
  if (ability.attack === 'presence') {
    const approach = approachOf(ability);
    return presenceAction(ctx, command, approach, ability);
  }
  // attack === 'none': a stance, a heal, a mark, a summon.
  return selfAction(ctx, command, ability);
}

function presenceAction(
  ctx: CombatContext,
  command: Command,
  approach: string,
  ability: AbilityDef | undefined,
): CombatReply {
  const target = pickTarget(ctx, command);
  if (!target) return noTarget(ctx);
  const actor = playerFighter(ctx);
  const foe = npcFighter(ctx, target);
  const { lines, effects } = resolvePresence(ctx, actor, foe, approach, ability);
  effects.push({ kind: 'combat', op: { t: 'sense', id: target.id } }, { kind: 'pronoun', ref: 'it', id: target.id });
  return { lines, effects, free: false };
}

/**
 * Resolve one Presence approach. It rolls the same shape as a weapon — attack
 * against defence plus the base — but takes Resolve, and at zero Resolve the
 * creature breaks the way its friendliness says it does.
 */
function resolvePresence(
  ctx: CombatContext,
  actor: Fighter,
  target: Fighter,
  approach: string,
  ability: AbilityDef | undefined,
): { lines: Line[]; effects: Effect[] } {
  const rules = ctx.campaign.rules;
  const lines: Line[] = [];
  const effects: Effect[] = [];

  if (target.presenceImmune) {
    return { lines: [line(`The ${target.name} is beyond reach of words. Presence does nothing.`, 'warn')], effects };
  }
  const blocked = blockedApproach(rules, approach, target.tags);
  if (blocked) {
    return { lines: [line(`${titleCase(approach)} finds no purchase on the ${target.name}.`, 'warn')], effects };
  }

  const eff = (ability?.effect ?? {}) as JsonObject;
  const trig = triggerFor(ctx, actor, ability);
  const bonus = trig ? { ...eff, ...(trig.effect as JsonObject) } : eff;

  const skill = actor.approachSkills[approach] ?? 0;
  const attackVal = actor.presence + skill + actor.allure;
  const defenceVal = bonus['ignoreComposure'] === true ? 0 : target.composure;
  const chance = clampChance(rules, attackVal - defenceVal + ruleNumber(rules, 'TO_HIT_BASE'));

  const roll = ctx.rng.int(1, 100);
  const label = ability && ability.id !== 'attack' ? ability.name : titleCase(approach);
  if (roll > chance) {
    lines.push(line(`Your ${label} slides off the ${target.name}. (${chance}%)`, 'roll'));
    pushRecharge(effects, actor.id, ability);
    return { lines, effects };
  }

  const pressureDie = approachPressure(rules, approach);
  let pressure = Math.max(1, ctx.rng.dice(pressureDie) + actor.pressureBonus);
  pressure = Math.round(pressure * approachMult(rules, approach, target.tags) * num(bonus, 'pressureMult', 1));

  let critNote = '';
  if (ctx.rng.int(1, 100) <= actor.crit + num(bonus, 'critChance')) {
    const outcome = pickTable(ctx, 'CRIT_TABLE');
    critNote = ` Critical: ${critLabel(outcome)}.`;
    if (outcome === 'x1.5') pressure = Math.round(pressure * 1.5);
    else if (outcome === 'x2') pressure *= 2;
    else if (outcome === 'x3') pressure *= 3;
    else if (outcome === 'autoDefeat' || outcome === 'ignoreArmour') pressure = Math.max(pressure, target.resolve);
  }
  pressure = Math.max(1, pressure);

  lines.push(line(`Your ${label} presses the ${target.name} for ${pressure} Resolve.${critNote} (${chance}%)`, 'roll'));
  effects.push({ kind: 'npcResolve', id: target.id, delta: -pressure });
  pushApproachSkillGrowth(effects, ctx, actor, approach);
  if (ability?.applies) effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: ability.applies } });
  if (trig) effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: '' } });
  pushRecharge(effects, actor.id, ability);

  if (target.resolve - pressure <= 0) lines.push(...breakLines(ctx, target, effects));
  return { lines, effects };
}

// ── self / stance / heal / summon ───────────────────────────────────────

function selfAction(ctx: CombatContext, command: Command, ability: AbilityDef): CombatReply {
  const effects: Effect[] = [];
  const lines: Line[] = [];
  const eff = ability.effect as JsonObject;

  if (isStance(ability)) {
    effects.push({ kind: 'combat', op: { t: 'stance', who: PLAYER, value: ability.id } });
    lines.push(line(`You settle into ${ability.name}.`, 'plain'));
    return { lines, effects, free: false };
  }

  if (eff['restoreHp'] !== undefined) {
    const heal = num(eff, 'restoreHp');
    const actor = playerFighter(ctx);
    const gain = Math.min(heal, actor.maxHp - actor.hp);
    lines.push(line(gain > 0 ? `You bind your wounds — ${gain} HP back.` : 'Nothing left to bind.', 'ok'));
    if (gain > 0) effects.push({ kind: 'hp', delta: gain });
    pushRecharge(effects, PLAYER, ability);
    return { lines, effects, free: false };
  }
  if (eff['restoreResolve'] !== undefined) {
    const heal = num(eff, 'restoreResolve');
    const actor = playerFighter(ctx);
    const gain = Math.min(heal, actor.maxResolve - actor.resolve);
    lines.push(line(gain > 0 ? `You steady yourself — ${gain} Resolve back.` : 'Your nerve is already whole.', 'ok'));
    if (gain > 0) effects.push({ kind: 'resolve', delta: gain });
    pushRecharge(effects, PLAYER, ability);
    return { lines, effects, free: false };
  }
  if (ability.applies) {
    const target = pickTarget(ctx, command);
    if (!target) return noTarget(ctx);
    lines.push(line(`You single out the ${target.name}.`, 'plain'));
    effects.push({ kind: 'combat', op: { t: 'primer', who: target.id, value: ability.applies } });
    pushRecharge(effects, PLAYER, ability);
    return { lines, effects, free: false };
  }
  return { lines: [line(`${ability.name} does nothing you can bring to bear here.`, 'warn')], effects: [], free: true };
}

const isStance = (ability: AbilityDef): boolean => (ability as { stance?: boolean }).stance === true;

// ── sensing ─────────────────────────────────────────────────────────────

function senseAction(ctx: CombatContext, command: Command): CombatReply {
  const target = pickTarget(ctx, command);
  if (!target) return noTarget(ctx);
  if (target.tags.includes('mindless')) {
    return {
      lines: [line(`You read the ${target.name} and find nothing to read. It is mindless.`, 'warn')],
      effects: [{ kind: 'combat', op: { t: 'sense', id: target.id } }],
      free: false,
    };
  }
  const lines = [
    line(`You size up the ${target.name}.`, 'ok'),
    line(`HP ${target.hp}/${target.maxHp} · Resolve ${target.resolve}/${target.maxResolve} · armour ${target.armourReduction}%`, 'rule'),
    line(`Tags: ${target.tags.join(', ')}${target.presenceImmune ? ' — beyond Presence' : ''}`, 'rule'),
  ];
  return { lines, effects: [{ kind: 'combat', op: { t: 'sense', id: target.id } }], free: false };
}

// ── flight ──────────────────────────────────────────────────────────────

/**
 * Flee always works. The cost is a parting hit from one enemy still on its
 * feet — the safety valve that stands in for a winnability solver.
 */
function fleeAction(ctx: CombatContext): CombatReply {
  const rules = ctx.campaign.rules;
  const lines: Line[] = [line('You break off and run.', 'warn')];
  const effects: Effect[] = [{ kind: 'combat', op: { t: 'end' } }];

  const back = retreatRoom(ctx);
  if (ruleAt(rules, 'COMBAT.fleeParting') !== false) {
    const hostiles = hostilesIn(ctx.world, ctx.room.id);
    const chaser = hostiles[0];
    if (chaser) {
      const actor = npcFighter(ctx, chaser);
      const target = playerFighter(ctx);
      const dealt = weaponDamage(ctx, actor, target, {
        ignoreArmour: false,
        penetration: actor.weaponPenetration,
        mult: 1,
        stanceB: {},
      });
      lines.push(line(`The ${chaser.name} lands a parting blow for ${dealt} as you go.`, 'roll'));
      effects.push({ kind: 'hp', delta: -dealt });
      if (target.hp - dealt <= 0) {
        // Beaten in the act of fleeing. The corpse run takes over.
        effects.push({ kind: 'defeatPlayer', victorId: chaser.id, by: 'hp' });
        return { lines, effects, free: false, fled: true };
      }
    }
  }
  if (back) effects.push({ kind: 'movePlayer', roomId: back });
  else lines.push(line('There is nowhere to fall back to — you back against the wall instead.', 'warn'));
  return { lines, effects, free: false, fled: true };
}

/** The room the player would flee to: a visited neighbour, else any neighbour. */
function retreatRoom(ctx: CombatContext): string | undefined {
  const exits = ctx.world.exitsOf(ctx.room.id).filter((exit) => exit.toRoomId !== null);
  const visited = exits.find((exit) => ctx.world.rooms.get(exit.toRoomId as string)?.visited);
  return (visited ?? exits[0])?.toRoomId ?? undefined;
}

// ── the enemy round (world half) ─────────────────────────────────────────

/**
 * Every living hostile acts, engine-controlled, choosing an ability off its
 * gambit list — an ordered condition→action table, first match wins. This is
 * the world half's mover step; it returns effects for that write point.
 */
export function enemyRound(ctx: CombatContext): { lines: Line[]; effects: Effect[] } {
  const lines: Line[] = [];
  const effects: Effect[] = [];
  const hostiles = hostilesIn(ctx.world, ctx.room.id);
  if (hostiles.length === 0) return { lines, effects };

  // A snapshot of player HP/Resolve, decremented as blows land, so two hits in
  // one round can put the player down and the second one knows it.
  const runningPlayer = { hp: ctx.player.hp, resolve: ctx.player.resolve };
  let victor = '';
  let defeatBy = '';

  for (const npc of hostiles) {
    if (runningPlayer.hp <= 0 || runningPlayer.resolve <= 0) break;
    const abilityId = pickEnemyAbility(ctx, npc);
    const ability = campaignAbility(ctx, abilityId) ?? campaignAbility(ctx, 'attack');
    const actor = npcFighter(ctx, npc);
    const target = playerFighter(ctx);
    const step = resolveEnemyAbility(ctx, npc, actor, target, ability);
    lines.push(...step.lines);
    effects.push(...step.effects);
    if (step.hpDelta) runningPlayer.hp += step.hpDelta;
    if (step.resolveDelta) runningPlayer.resolve += step.resolveDelta;
    if (runningPlayer.hp <= 0 && !victor) {
      victor = npc.id;
      defeatBy = 'hp';
    } else if (runningPlayer.resolve <= 0 && !victor) {
      victor = npc.id;
      defeatBy = 'resolve';
    }
  }

  effects.push({ kind: 'combat', op: { t: 'tickRecharge' } }, { kind: 'combat', op: { t: 'round' } });
  if (victor) {
    // The player's own effects that would have landed this round are dropped —
    // defeat resolves the run in one place.
    return { lines, effects: [{ kind: 'defeatPlayer', victorId: victor, by: defeatBy }] };
  }
  return { lines, effects };
}

interface EnemyStep {
  lines: Line[];
  effects: Effect[];
  hpDelta?: number;
  resolveDelta?: number;
}

function resolveEnemyAbility(
  ctx: CombatContext,
  npc: NpcRecord,
  actor: Fighter,
  target: Fighter,
  ability: AbilityDef | undefined,
): EnemyStep {
  // Enemy self/support and flight, before falling through to a swing.
  if (ability?.effect['leaveFight'] === true) {
    return { lines: [line(`The ${npc.name} loses its nerve and bolts.`, 'ok')], effects: [{ kind: 'npcBreak', id: npc.id, outcome: 'flee' }] };
  }
  if (ability && ability.attack === 'none') {
    return enemySupport(ctx, npc, ability);
  }

  if (ability?.attack === 'presence' && !target.presenceImmune) {
    const approach = approachOf(ability);
    const step = enemyPresence(ctx, actor, target, approach, ability);
    return step;
  }

  // Default: a weapon swing at the player.
  return enemyWeapon(ctx, actor, target, ability);
}

function enemyWeapon(ctx: CombatContext, actor: Fighter, target: Fighter, ability: AbilityDef | undefined): EnemyStep {
  const rules = ctx.campaign.rules;
  const eff = (ability?.effect ?? {}) as JsonObject;
  const stanceA = stanceEffect(ctx, actor.id);
  const attackVal = actor.accuracy + actor.weaponSkill + num(eff, 'accuracy') + num(stanceA, 'accuracy');
  const defenceVal = target.evasion + num(stanceEffect(ctx, PLAYER), 'evasion');
  const chance = clampChance(rules, attackVal - defenceVal + ruleNumber(rules, 'TO_HIT_BASE'));
  const roll = ctx.rng.int(1, 100);
  const named = ability && ability.id !== 'attack';

  if (roll > chance) {
    const miss = named ? `tries ${ability?.name} and misses you` : 'swings at you and misses';
    return { lines: [line(`The ${actor.name} ${miss}. (${chance}%)`, 'roll')], effects: [] };
  }
  const ignoreArmour = eff['ignoreArmour'] === true;
  const penetration = actor.weaponPenetration + num(eff, 'penetration');
  const mult = 'damageMult' in eff ? num(eff, 'damageMult', 1) : 1;
  let damage = weaponDamage(ctx, actor, target, { ignoreArmour, penetration, mult, stanceB: stanceEffect(ctx, PLAYER) });
  if (ctx.rng.int(1, 100) <= actor.crit + num(eff, 'critChance')) {
    const outcome = pickTable(ctx, 'CRIT_TABLE');
    if (outcome === 'x1.5') damage = Math.round(damage * 1.5);
    else if (outcome === 'x2') damage *= 2;
    else if (outcome === 'x3') damage *= 3;
    else if (outcome === 'autoDefeat') damage = Math.max(damage, target.hp);
  }
  damage = Math.max(1, damage);
  const effects: Effect[] = [{ kind: 'hp', delta: -damage }];
  // Armour that soaked a hit trains: expertise rises on damage absorbed.
  if (target.armourReduction > 0) pushArmourGrowth(effects, ctx);
  const hit = named ? `lands ${ability?.name} on you for ${damage}` : `strikes you for ${damage}`;
  return {
    lines: [line(`The ${actor.name} ${hit}. (${chance}%)`, 'roll')],
    effects,
    hpDelta: -damage,
  };
}

function enemyPresence(ctx: CombatContext, actor: Fighter, target: Fighter, approach: string, ability: AbilityDef): EnemyStep {
  const rules = ctx.campaign.rules;
  const eff = ability.effect as JsonObject;
  const attackVal = actor.presence + num(eff, 'presence');
  const defenceVal = eff['ignoreComposure'] === true ? 0 : target.composure;
  const chance = clampChance(rules, attackVal - defenceVal + ruleNumber(rules, 'TO_HIT_BASE'));
  const roll = ctx.rng.int(1, 100);
  if (roll > chance) {
    return { lines: [line(`The ${actor.name} tries to ${approach} you, and fails. (${chance}%)`, 'roll')], effects: [] };
  }
  let pressure = Math.max(1, ctx.rng.dice(approachPressure(rules, approach)) + actor.pressureBonus);
  pressure = Math.round(pressure * num(eff, 'pressureMult', 1));
  pressure = Math.max(1, pressure);
  // Losing Resolve in a fight stokes Libido — the corruption axis the world moves.
  const effects: Effect[] = [
    { kind: 'resolve', delta: -pressure },
    { kind: 'libido', delta: libidoOnPressure(ctx, actor) },
  ];
  return {
    lines: [line(`The ${actor.name} ${approach}s you — ${pressure} Resolve gone. (${chance}%)`, 'roll')],
    effects,
    resolveDelta: -pressure,
  };
}

/** A creature that heals, rallies or calls for help. Support, not a swing. */
function enemySupport(ctx: CombatContext, npc: NpcRecord, ability: AbilityDef): EnemyStep {
  const eff = ability.effect as JsonObject;
  const effects: Effect[] = [];
  const lines: Line[] = [];

  if ((ability as { stance?: boolean }).stance === true) {
    effects.push({ kind: 'combat', op: { t: 'stance', who: npc.id, value: ability.id } });
    lines.push(line(`The ${npc.name} sets itself — ${ability.name}.`, 'plain'));
  } else if (eff['restoreHp'] !== undefined) {
    const ally = lowestHpAlly(ctx, npc);
    if (ally) {
      const gain = Math.min(num(eff, 'restoreHp'), ally.maxHp - ally.hp);
      if (gain > 0) effects.push({ kind: 'npcHp', id: ally.id, delta: gain });
      lines.push(line(`The ${npc.name} tends the ${ally.name}'s wounds.`, 'plain'));
    }
  } else if (eff['restoreResolve'] !== undefined) {
    const ally = lowestResolveAlly(ctx, npc);
    if (ally) {
      const gain = Math.min(num(eff, 'restoreResolve'), ally.maxResolve - ally.resolve);
      if (gain > 0) effects.push({ kind: 'npcResolve', id: ally.id, delta: gain });
      lines.push(line(`The ${npc.name} rallies its own.`, 'plain'));
    }
  } else if (eff['summon'] !== undefined) {
    const summoned = summon(ctx, npc, eff['summon']);
    for (const record of summoned) effects.push({ kind: 'spawnCreature', record });
    lines.push(line(summoned.length > 0 ? `The ${npc.name} calls, and more answer.` : `The ${npc.name} calls for help. None comes.`, 'warn'));
  } else if (ability.applies) {
    effects.push({ kind: 'combat', op: { t: 'primer', who: PLAYER, value: ability.applies } });
    lines.push(line(`The ${npc.name} marks you.`, 'plain'));
  }
  pushRecharge(effects, npc.id, ability);
  return { lines, effects };
}

// ── gambits: the enemy's decision table ─────────────────────────────────

function pickEnemyAbility(ctx: CombatContext, npc: NpcRecord): string {
  const gambits = ctx.campaign.abilities.gambitsByRole[npc.gambits] ?? [];
  for (const gambit of gambits) {
    if (!gambitHolds(ctx, npc, gambit.when)) continue;
    const ability = campaignAbility(ctx, gambit.use);
    if (!ability) continue;
    if (!npc.abilities.includes(ability.id) && ability.id !== 'attack') continue;
    if (!availableNpc(ctx, npc, ability)) continue;
    return ability.id;
  }
  return 'attack';
}

/** Evaluate one gambit condition against the live fight. First match wins. */
function gambitHolds(ctx: CombatContext, npc: NpcRecord, when: string): boolean {
  if (when === 'always') return true;
  const hostiles = hostilesIn(ctx.world, ctx.room.id);

  let m = when.match(/^self\.(hp|resolve)<(\d+)$/);
  if (m) return (m[1] === 'hp' ? npc.hp : npc.resolve) < Number(m[2]);

  m = when.match(/^target\.(hp|resolve)<(\d+)$/);
  if (m) return (m[1] === 'hp' ? ctx.player.hp : ctx.player.resolve) < Number(m[2]);

  m = when.match(/^ally\.hp<(\d+)$/);
  if (m) return hostiles.some((other) => other.id !== npc.id && other.hp < Number(m![1]));

  m = when.match(/^target\.primer==(\w+)$/);
  if (m) return (ctx.combat.primer[PLAYER] ?? '') === m[1];

  m = when.match(/^round==(\d+)$/);
  if (m) return ctx.combat.round === Number(m[1]);

  m = when.match(/^allies>(\d+)$/);
  if (m) return hostiles.length > Number(m[1]);

  return false;
}

// ── breaking and dying ──────────────────────────────────────────────────

/** A killing blow. The creature becomes a corpse and its purse spills. */
function killLines(target: Fighter, effects: Effect[]): Line[] {
  effects.push({ kind: 'npcDead', id: target.id });
  return [line(`The ${target.name} falls.`, 'ok')];
}

/**
 * A creature at zero Resolve breaks the way its friendliness dictates: the cowed
 * flee with their loot, the venal surrender it, the won-over join you. Routing
 * pays worse than killing, and this is where that trade is made.
 */
function breakLines(ctx: CombatContext, target: Fighter, effects: Effect[]): Line[] {
  const outcome = breakOutcome(ctx.campaign.rules, target.friendliness);
  effects.push({ kind: 'npcBreak', id: target.id, outcome });
  switch (outcome) {
    case 'surrender':
      return [line(`The ${target.name} throws down its arms and yields.`, 'ok')];
    case 'join':
      return [line(`The ${target.name} is won over — it stands down and falls in with you.`, 'ok')];
    default:
      return [line(`The ${target.name} breaks and flees, taking what it carried.`, 'ok')];
  }
}

export function breakOutcome(rules: JsonObject, friendliness: number): string {
  for (const name of ['flee', 'surrender', 'join']) {
    const range = ruleAt(rules, `PRESENCE_BREAK.${name}`);
    if (Array.isArray(range) && typeof range[0] === 'number' && typeof range[1] === 'number') {
      if (friendliness >= range[0] && friendliness <= range[1]) return name;
    }
  }
  return 'flee';
}

// ── shared plumbing ─────────────────────────────────────────────────────

function pickTarget(ctx: CombatContext, command: Command): NpcRecord | undefined {
  const hostiles = hostilesIn(ctx.world, ctx.room.id);
  if (hostiles.length === 0) return undefined;
  const phrase = command.indirect ?? command.object;
  if (!phrase || phrase.words.length === 0) return hostiles[0];
  // The named approach word is not a target; strip it before matching.
  if (phrase.words.every((word) => APPROACHES.includes(word.toLowerCase()))) return hostiles[0];
  const scope = ctx.scope.filter((entry) => entry.kind === 'npc' && hostiles.some((h) => h.id === entry.id));
  const matched = matchPhrase(scope, phrase);
  const chosen = matched.find((entry) => hostiles.some((h) => h.id === entry.id));
  return chosen ? hostiles.find((h) => h.id === chosen.id) : hostiles[0];
}

const noTarget = (ctx: CombatContext): CombatReply => ({
  lines: [line(hostilesIn(ctx.world, ctx.room.id).length === 0 ? 'Nothing here to fight.' : 'Which foe?', 'warn')],
  effects: [],
  free: true,
});

function namesHostile(ctx: CombatContext, command: Command): boolean {
  const hostiles = hostilesIn(ctx.world, ctx.room.id);
  const phrase = command.object;
  if (!phrase) return false;
  const scope = ctx.scope.filter((entry) => entry.kind === 'npc' && hostiles.some((h) => h.id === entry.id));
  return matchPhrase(scope, phrase).length > 0;
}

const campaignAbility = (ctx: CombatContext, id: string): AbilityDef | undefined =>
  ctx.campaign.abilities.table.find((entry) => entry.id === id);

/** Is a recharge/encounter ability off cooldown for this combatant? */
function available(ctx: CombatContext, who: string, ability: AbilityDef): boolean {
  if (ability.type === 'recharge') return (ctx.combat.recharge[who]?.[ability.id] ?? 0) <= 0;
  if (ability.type === 'encounter') return !(ctx.combat.usedEncounter[who] ?? []).includes(ability.id);
  return true;
}

const availableNpc = (ctx: CombatContext, npc: NpcRecord, ability: AbilityDef): boolean =>
  available(ctx, npc.id, ability);

function pushRecharge(effects: Effect[], who: string, ability: AbilityDef | undefined): void {
  if (!ability) return;
  if (ability.type === 'recharge') {
    const rounds = (ability as { rc?: number }).rc ?? 2;
    effects.push({ kind: 'combat', op: { t: 'recharge', who, ability: ability.id, rounds: rounds + 1 } });
  } else if (ability.type === 'encounter') {
    effects.push({ kind: 'combat', op: { t: 'useEncounter', who, ability: ability.id } });
  }
}

/** A primer this ability would consume, if the target carries it. */
function triggerFor(
  ctx: CombatContext,
  actor: Fighter,
  ability: AbilityDef | undefined,
): { effect: JsonObject } | undefined {
  if (!ability?.triggers) return undefined;
  const targetPrimer = actor.isPlayer ? firstEnemyPrimer(ctx) : ctx.combat.primer[PLAYER] ?? '';
  if (!ability.triggers.includes(targetPrimer)) return undefined;
  const trig = (ability as { triggerEffect?: JsonObject }).triggerEffect;
  return trig ? { effect: trig } : undefined;
}

function firstEnemyPrimer(ctx: CombatContext): string {
  for (const npc of hostilesIn(ctx.world, ctx.room.id)) {
    const primer = ctx.combat.primer[npc.id];
    if (primer) return primer;
  }
  return '';
}

/** The effect block of the stance a combatant currently holds, or empty. */
function stanceEffect(ctx: CombatContext, who: string): JsonObject {
  const id = ctx.combat.stance[who];
  if (!id) return {};
  return (campaignAbility(ctx, id)?.effect ?? {}) as JsonObject;
}

function pushWeaponSkillGrowth(effects: Effect[], ctx: CombatContext, actor: Fighter): void {
  if (!actor.isPlayer) return;
  const rules = ctx.campaign.rules;
  if (!ctx.rng.chance(ruleNumber(rules, 'SKILL_GROWTH.chanceOnHit'))) return;
  const cap = ruleNumber(rules, 'SKILL_GROWTH.cap');
  if ((ctx.player.weaponSkills[actor.weaponKind] ?? 0) >= cap) return;
  effects.push({ kind: 'growSkill', axis: 'weapon', id: actor.weaponKind, delta: ruleNumber(rules, 'SKILL_GROWTH.step') });
}

function pushApproachSkillGrowth(effects: Effect[], ctx: CombatContext, actor: Fighter, approach: string): void {
  if (!actor.isPlayer) return;
  const rules = ctx.campaign.rules;
  if (!ctx.rng.chance(ruleNumber(rules, 'SKILL_GROWTH.chanceOnHit'))) return;
  const cap = ruleNumber(rules, 'SKILL_GROWTH.cap');
  if ((ctx.player.approachSkills[approach] ?? 0) >= cap) return;
  effects.push({ kind: 'growSkill', axis: 'approach', id: approach, delta: ruleNumber(rules, 'SKILL_GROWTH.step') });
}

function pushArmourGrowth(effects: Effect[], ctx: CombatContext): void {
  const rules = ctx.campaign.rules;
  if (!ctx.rng.chance(ruleNumber(rules, 'SKILL_GROWTH.chanceOnHit'))) return;
  const cap = ruleNumber(rules, 'SKILL_GROWTH.cap');
  if (ctx.player.armourExpertise >= cap) return;
  effects.push({ kind: 'growSkill', axis: 'armour', id: '', delta: ruleNumber(rules, 'SKILL_GROWTH.step') });
}

function libidoOnPressure(ctx: CombatContext, actor: Fighter): number {
  // A lustful aura pushes harder; everything else nudges by one.
  const aura = ruleAt(ctx.campaign.rules, 'TAXONOMY.lustful.libidoAura');
  if (actor.tags.includes('lustful') && typeof aura === 'number') return aura;
  return 1;
}

// summon a copy or two of the caller's kind, at reduced strength.
function summon(ctx: CombatContext, npc: NpcRecord, spec: unknown): NpcRecord[] {
  const [lo, hi] = Array.isArray(spec) && typeof spec[0] === 'number' && typeof spec[1] === 'number' ? [spec[0], spec[1]] : [1, 1];
  const count = ctx.rng.int(lo, hi);
  const out: NpcRecord[] = [];
  for (let i = 0; i < count; i++) {
    const copy: NpcRecord = structuredClone(npc);
    copy.id = `${npc.id}:help${ctx.combat.round}_${i}`;
    copy.name = `lesser ${npc.name}`;
    copy.hp = Math.max(1, Math.round(npc.maxHp * 0.6));
    copy.maxHp = copy.hp;
    // Summoned help fights rather than immediately breaking, or a call for help
    // that flees the moment it arrives is only theatre.
    copy.gambits = 'skirmisher';
    copy.abilities = ['attack'];
    copy.location = inRoom(ctx.room.id);
    copy.defeated = false;
    out.push(copy);
  }
  return out;
}

const lowestHpAlly = (ctx: CombatContext, npc: NpcRecord): NpcRecord | undefined =>
  [...hostilesIn(ctx.world, ctx.room.id)].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] ?? npc;

const lowestResolveAlly = (ctx: CombatContext, npc: NpcRecord): NpcRecord | undefined =>
  [...hostilesIn(ctx.world, ctx.room.id)].sort((a, b) => a.resolve / a.maxResolve - b.resolve / b.maxResolve)[0] ?? npc;

/** The approach an ability rolls, read from its `grantedBy` skill token. */
function approachOf(ability: AbilityDef): string {
  const m = ability.grantedBy.match(/^skill:([a-z]+)/);
  if (m && APPROACHES.includes(m[1] as string)) return m[1] as string;
  if (ability.id === 'browbeat' || ability.id === 'cow') return 'intimidate';
  if (ability.id === 'jeer') return 'taunt';
  if (ability.id === 'allure' || ability.id === 'promise') return 'seduce';
  return 'intimidate';
}

function blockedApproach(rules: JsonObject, approach: string, tags: readonly string[]): boolean {
  const blockedBy = ruleAt(rules, `APPROACH_TABLE.${approach}.blockedBy`);
  if (Array.isArray(blockedBy) && blockedBy.some((tag) => tags.includes(tag as string))) return true;
  // A beast answers only to Intimidate, whatever else the approach lists.
  const beastOnly = ruleAt(rules, 'TAXONOMY.beast.onlyApproaches');
  if (tags.includes('beast') && Array.isArray(beastOnly) && !beastOnly.includes(approach)) return true;
  return false;
}

function approachPressure(rules: JsonObject, approach: string): string {
  const die = ruleAt(rules, `APPROACH_TABLE.${approach}.pressure`);
  return typeof die === 'string' ? die : '1d4';
}

/** Taxonomy multipliers on pressure — proud, lustful, timid. */
function approachMult(rules: JsonObject, approach: string, tags: readonly string[]): number {
  let mult = 1;
  for (const tag of tags) {
    const table = ruleAt(rules, `TAXONOMY.${tag}.pressureMult`);
    if (table && typeof table === 'object' && !Array.isArray(table)) {
      const value = (table as Record<string, unknown>)[approach];
      if (typeof value === 'number') mult *= value;
    }
  }
  return mult;
}

const clampChance = (rules: JsonObject, value: number): number => {
  const [lo, hi] = ruleRange(rules, 'CLAMP');
  return Math.max(lo, Math.min(hi, Math.round(value)));
};

function pickTable(ctx: CombatContext, path: string): string {
  const rows = ruleWeightedPairs(ctx.campaign.rules, path);
  const chosen = ctx.rng.weighted(rows);
  return String(chosen.value);
}

const critLabel = (outcome: string): string =>
  ({ ignoreArmour: 'through the armour', 'x1.5': 'half again', x2: 'doubled', x3: 'tripled', autoDefeat: 'a finishing blow' })[
    outcome
  ] ?? outcome;

const num = (obj: JsonObject, key: string, fallback = 0): number =>
  typeof obj[key] === 'number' ? (obj[key] as number) : fallback;

const numberAt = (obj: unknown, key: string, fallback: number): number => {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  return fallback;
};

function countNames(hostiles: readonly NpcRecord[]): string {
  if (hostiles.length === 0) return 'Nothing';
  if (hostiles.length === 1) return `The ${hostiles[0]?.name}`;
  const counts = new Map<string, number>();
  for (const npc of hostiles) counts.set(npc.name, (counts.get(npc.name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${n} ${name}s` : `a ${name}`));
  return titleCase(parts.join(' and '));
}

const titleCase = (text: string): string => text.slice(0, 1).toUpperCase() + text.slice(1);
