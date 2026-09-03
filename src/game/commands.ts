/**
 * Tier 1 — the canonical actions, resolved deterministically.
 *
 * Every handler here answers one question: given the world as it stands, what
 * would this command do? It returns lines to print and effects to apply, and
 * it never writes anything itself — the turn loop owns the two write points.
 *
 * Verbs the closed system list has but this build step has not reached yet
 * (combat, dialogue, the shop) answer honestly with the step they arrive at,
 * rather than pretending to work. Step 4 is the checkpoint where walking a
 * generated area has to be interesting on its own; papering over the gaps
 * would defeat the point of taking the reading.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { itemValues } from '../content/items';
import type { Command, FailureCode, Phrase } from '../engine/parser';
import { ruleNumber, ruleStrings } from '../engine/rules';
import type { NpcRecord, ObjectRecord, RoomRecord } from '../world/types';
import { heldBy, IN_PLAYER, inObject, inRoom } from '../world/types';
import { HUB_AREA_ID, type World } from '../world/world';
import { describeObject, sentenceList, viewRoom } from './describe';
import type { Effect } from './effects';
import { playerCarry, playerMaxHp, playerMaxResolve, type PlayerRecord } from './player';
import { carriedLight, isDark, matchPhrase, type ScopeEntry } from './scope';

export type LineKind = 'plain' | 'echo' | 'roll' | 'warn' | 'ok' | 'rule' | 'speak';

export interface Line {
  text: string;
  kind: LineKind;
}

/**
 * A disambiguation question. The turn loop holds it and checks the next input
 * against the candidates before parsing it as a command.
 */
export interface Pending {
  candidateIds: string[];
}

export interface Reply {
  lines: Line[];
  effects: Effect[];
  /** Free replies are UI queries: they do not run the world half. */
  free: boolean;
  question?: Pending | undefined;
  failure?: FailureCode | undefined;
  /**
   * Set when an NPC has something to answer. The engine already decided
   * everything mechanical; this only tells the edge (main.ts) which NPC to
   * ask the narrator to voice, and about what. No prose ever feeds back into
   * state, so this is read-only for the narrator — it is never validated,
   * never applied, and carries no effect of its own.
   *
   * `fallback` is what to print when there is no narrator to ask and the
   * reply *was* the whole turn — continuing a conversation, or a question
   * answered only in character. Carried as data rather than printed eagerly,
   * the same way `appearance` does it, so a no-key game is never left with a
   * silent turn but a narrated one is never given both.
   */
  voice?: { npcId: string; topic: string; fallback?: Line | undefined } | undefined;
  /**
   * Set when EXAMINE lands on an NPC. Tells the edge (main.ts) which NPC to
   * ask the narrator for an appearance line, in place of the mechanical
   * persona line — `fallback` carries that persona line as data rather than
   * printing it, so it only ever appears if there is no narrator to ask, or
   * the ask fails. Same read-only, no-effect discipline as `voice`.
   */
  appearance?: { npcId: string; fallback: Line } | undefined;
  /**
   * Set by a flavour verb (and by Tier 3 pure expression, from the game loop).
   * Ephemeral prose with no state behind it: main.ts asks the narrator for a
   * fresh line — never cached — and shows `fallback` when there is no narrator
   * to ask. Same read-only, no-effect discipline as `voice` and `appearance`.
   */
  express?: { raw: string; verb?: string | undefined; target?: string | undefined; fallback: Line } | undefined;
  /** A UI-only request to open the full-floor map overlay. Carries no state. */
  showMap?: boolean | undefined;
}

export interface CommandContext {
  campaign: ResolvedCampaign;
  world: World;
  player: PlayerRecord;
  room: RoomRecord;
  dark: boolean;
  scope: ScopeEntry[];
  turn: number;
  /**
   * Who the player is already talking to, if anyone. Read-only here: the talk
   * handlers use it to decide whether they are opening a conversation or
   * continuing one, and only the `converse` effect ever changes it.
   */
  conversation?: { npcId: string } | undefined;
  /** The answer to a pending "which one?", replayed with the same command. */
  forced?: ScopeEntry | undefined;
}

export const line = (text: string, kind: LineKind = 'plain'): Line => ({ text, kind });

const say = (text: string, kind: LineKind = 'plain'): Reply => ({
  lines: [line(text, kind)],
  effects: [],
  free: false,
});

const free = (lines: Line[]): Reply => ({ lines, effects: [], free: true });

const blocked = (text: string, failure: FailureCode = 'PRECONDITION'): Reply => ({
  lines: [line(text)],
  effects: [],
  free: false,
  failure,
});

/** Build steps that have not landed. Naming the step is more use than a shrug. */
const NOT_YET: Record<string, string> = {
  eat: 'Consumables land after combat.',
  drink: 'Consumables land after combat.',
  // Handing over an item is a real transfer of state, not narration, and the
  // economy it depends on lands with the shop — voicing "give" without
  // actually moving the item would be prose the world does not back up.
  give: 'Trading items lands with the shop.',
  show: 'Trading items lands with the shop.',
  buy: 'The shop opens once there is a reason to spend.',
  sell: 'The shop opens once there is a reason to spend.',
  deposit: 'The bank opens with the shop.',
  withdraw: 'The bank opens with the shop.',
  repair: 'Repair opens with the shop.',
  train: 'Training opens with the shop.',
  hire: 'Companions arrive after combat.',
  dismiss: 'Companions arrive after combat.',
  bench: 'Companions arrive after combat.',
  rest: 'Resting arrives with the Hub services.',
  search: 'Searching turns up nothing a look would not. Hidden things arrive with quests.',
};

export function execute(ctx: CommandContext, command: Command): Reply {
  // Flavour verbs (smell, listen, grope, …) carry no mechanical outcome; the
  // parser flags them and they always route to fresh narration, wherever they
  // land in the table.
  if (command.flavour) return flavour(ctx, command);
  switch (command.verb) {
    case 'go':
    case 'enter':
    case 'exit':
    case 'climb':
      return go(ctx, command);
    case 'look':
      return look(ctx);
    case 'examine':
      return examine(ctx, command);
    case 'take':
      return take(ctx, command);
    case 'drop':
      return drop(ctx, command);
    case 'put':
      return put(ctx, command);
    case 'open':
    case 'close':
      return openClose(ctx, command);
    case 'unlock':
    case 'lock':
      return lockUnlock(ctx, command);
    case 'light':
    case 'extinguish':
      return lightExtinguish(ctx, command);
    case 'wear':
    case 'remove':
      return wearRemove(ctx, command);
    case 'wield':
      return wield(ctx, command);
    case 'talk':
      return talk(ctx, command);
    case 'ask':
    case 'tell':
      return askOrTell(ctx, command);
    case 'say':
      return sayTo(ctx, command);
    case 'farewell':
      return farewell(ctx);
    case 'list':
      return wares(ctx, command);
    case 'recall':
      return recall(ctx, command);
    case 'attack':
      return attackOutOfCombat(ctx);
    case 'flee':
      return say('Nothing is chasing you.');
    case 'use':
      return useOutOfCombat(ctx, command);
    case 'search':
      return search(ctx);
    case 'quests':
      return questsJournal(ctx);
    case 'inventory':
      return inventory(ctx);
    case 'stats':
      return stats(ctx);
    case 'map':
      return mapOf(ctx);
    case 'save':
    case 'load':
      // The store is attached at the edge of the app, where async lives. The
      // turn loop stays synchronous, so it never awaits a disk.
      return {
        lines: [line('Saving and loading are handled at the prompt: SAVE <name>, LOAD <name>.', 'rule')],
        effects: [],
        free: true,
      };
    case 'wait':
      return say('You wait. The world does not.');
    case 'help':
      return help(ctx);
    case 'read':
    case 'push':
    case 'pull':
    case 'turn':
    case 'throw':
      // Not flavour-flagged (they may gain mechanical triggers later), but with
      // nothing to act on today they narrate the same way flavour verbs do.
      return flavour(ctx, command);
    default: {
      const note = NOT_YET[command.verb];
      if (note) return { lines: [line(note, 'rule')], effects: [], free: true };
      return blocked(`Nothing happens.`, 'WRONG_VERB');
    }
  }
}

// ── movement ────────────────────────────────────────────────────────

function go(ctx: CommandContext, command: Command): Reply {
  if (command.unsupportedDirection) {
    return blocked(`You cannot go ${command.unsupportedDirection} from here.`);
  }
  if (!command.direction) {
    // `go door`, `enter chest`. Movement is by direction; there is no travel
    // verb that takes a place, because the map is the travel system.
    return blocked('Go which way?', 'UNKNOWN_NOUN');
  }
  const direction = command.direction;
  const exit = ctx.world.exitsOf(ctx.room.id).find((candidate) => candidate.dir === direction);
  if (!exit) return blocked("You can't go that way.");

  // Darkness is a wall, not a penalty: you cannot step into a dark room, nor
  // through the mouth of a dark area, carrying nothing lit. Checked before the
  // door so a blocked step never half-opens one. A carried light travels with
  // you, so it is the only light that counts on the way in.
  const tooDark = 'It is too dark that way without a torch.';
  if (exit.toRoomId === null) {
    const def = exit.gateArchetype ? ctx.campaign.areas.get(exit.gateArchetype) : undefined;
    if (def?.areaTags.includes('dark') && !carriedLight(ctx.world)) return blocked(tooDark);
  } else {
    const dest = ctx.world.rooms.get(exit.toRoomId);
    if (dest && isDark(ctx.world, dest)) return blocked(tooDark);
  }

  const effects: Effect[] = [];
  const lines: Line[] = [];

  const door = exit.edge.doorId ? ctx.world.objects.get(exit.edge.doorId) : undefined;
  if (door?.flags.locked) return blocked(`The ${door.name} is locked.`);
  if (door && door.flags.open === false) {
    // An unlocked door that is merely shut opens on the way through, and says
    // so — the same courtesy as an implicit take.
    lines.push(line(`(first opening the ${door.name})`, 'rule'));
    effects.push({ kind: 'setObjectFlag', id: door.id, flag: 'open', value: true });
  }

  if (exit.toRoomId === null) {
    effects.push({ kind: 'enterGate', edgeId: exit.edge.id });
    return { lines, effects, free: false };
  }
  effects.push({ kind: 'movePlayer', roomId: exit.toRoomId });
  return { lines, effects, free: false };
}

// ── looking ─────────────────────────────────────────────────────────

export function roomLines(ctx: CommandContext, full: boolean): Line[] {
  const view = viewRoom(ctx.world, ctx.room);
  const lines = [line(view.name, 'ok')];
  if (full || view.dark) lines.push(line(view.desc));
  if (view.contents.length > 0) lines.push(line(`Here: ${sentenceList(view.contents)}.`));
  // Exits are shown on the map now (connectors, plus '?' for a way not yet
  // walked), so the log no longer restates them each turn.
  return lines;
}

const look = (ctx: CommandContext): Reply => ({
  lines: roomLines(ctx, true),
  effects: [],
  free: false,
});

function examine(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const entry = found.entry;

  if (entry.kind === 'self') {
    return { lines: sheetLines(ctx), effects: [], free: false };
  }
  if (entry.npc) {
    const npc = entry.npc;
    return {
      lines: [
        line(npc.name, 'ok'),
        line(npc.hostile ? 'It means you harm.' : 'It means you no harm.', npc.hostile ? 'warn' : 'plain'),
      ],
      effects: [{ kind: 'pronoun', ref: 'it', id: npc.id }],
      free: false,
      appearance: {
        npcId: npc.id,
        fallback: line(npc.persona || `${npc.role || 'someone'} out of ${npc.baseId}.`),
      },
    };
  }

  const object = entry.object as ObjectRecord;
  const values = itemValues(ctx.campaign, object);
  const detail = ['weight', 'price', 'penetration', 'reduction', 'penalty']
    .filter((key) => typeof values[key] === 'number' && values[key] !== 0)
    .map((key) => `${key} ${values[key]}`);
  return {
    lines: [
      line(describeObject(ctx.world, object), 'ok'),
      line(object.desc || `${object.quality} ${object.baseId}. Condition ${object.condition}.`),
      detail.length > 0 ? line(detail.join(' · '), 'rule') : line('', 'rule'),
    ].filter((entryLine) => entryLine.text.length > 0),
    effects: [{ kind: 'pronoun', ref: 'it', id: object.id }],
    free: false,
  };
}

function flavour(ctx: CommandContext, command: Command): Reply {
  // A target is nice to have but not required — `smell` with no object is the
  // air of the room. A bad object name still resolves to its failure reply.
  let target: string | undefined;
  if (command.object) {
    const found = resolve(ctx, command.object);
    if ('reply' in found) return found.reply;
    target = found.entry.name;
  }
  // No roll, no state change: the narrator writes a fresh line every time, and
  // the canned sentence is only the fallback when there is no narrator to ask.
  const fallback = target
    ? `You ${command.verb} the ${target}. Nothing comes of it.`
    : `You ${command.verb}. Nothing comes of it.`;
  return {
    lines: [],
    effects: [],
    free: false,
    express: { raw: command.raw, verb: command.verb, target, fallback: line(fallback) },
  };
}

// ── carrying ────────────────────────────────────────────────────────

function take(ctx: CommandContext, command: Command): Reply {
  const phrase = command.object;
  if (!phrase) return blocked('Take what?', 'UNKNOWN_NOUN');

  if (phrase.all) {
    const targets = matchPhrase(ctx.scope, phrase).filter(
      (entry) => entry.where === 'room' || entry.where === 'container',
    );
    if (targets.length === 0) return blocked('There is nothing here to take.', 'UNKNOWN_NOUN');
    const lines: Line[] = [];
    const effects: Effect[] = [];
    let load = carriedWeight(ctx);
    const limit = playerCarry(ctx.campaign, ctx.player);
    for (const entry of targets) {
      const object = entry.object as ObjectRecord;
      const weight = itemValues(ctx.campaign, object)['weight'] ?? 0;
      if (load + weight > limit) {
        lines.push(line(`${object.name} — too heavy for what you are already carrying.`, 'warn'));
        continue;
      }
      load += weight;
      lines.push(line(`Taken: ${object.name}.`));
      effects.push({ kind: 'moveObject', id: object.id, location: IN_PLAYER });
    }
    return { lines, effects, free: false };
  }

  const found = resolve(ctx, phrase);
  if ('reply' in found) return found.reply;
  const entry = found.entry;
  const object = entry.object;
  if (!object) return blocked(`You cannot carry ${entry.name} around.`, 'WRONG_VERB');
  if (entry.where === 'carried' || entry.where === 'worn') return blocked('You already have it.');
  if (!object.flags.takeable) return blocked(`The ${object.name} is not yours to take.`, 'WRONG_VERB');

  // `take key from chest` — the container has to be open, and has to be the
  // one it is actually in.
  if (command.indirect) {
    const holder = resolve(ctx, command.indirect);
    if ('reply' in holder) return holder.reply;
    const container = holder.entry.object;
    if (!container?.flags.container) return blocked(`The ${holder.entry.name} holds nothing.`, 'WRONG_VERB');
    if (!container.flags.open) return blocked(`The ${container.name} is shut.`);
    if (object.location !== inObject(container.id)) {
      return blocked(`The ${object.name} is not in the ${container.name}.`, 'NOT_IN_SCOPE');
    }
  }

  const weight = itemValues(ctx.campaign, object)['weight'] ?? 0;
  const limit = playerCarry(ctx.campaign, ctx.player);
  if (carriedWeight(ctx) + weight > limit) {
    return blocked(`You are carrying too much already. (${carriedWeight(ctx)}/${limit})`);
  }
  return {
    lines: [line('Taken.')],
    effects: [
      { kind: 'moveObject', id: object.id, location: IN_PLAYER },
      { kind: 'pronoun', ref: 'it', id: object.id },
    ],
    free: false,
  };
}

function drop(ctx: CommandContext, command: Command): Reply {
  const phrase = command.object;
  if (!phrase) return blocked('Drop what?', 'UNKNOWN_NOUN');

  const carried = ctx.scope.filter((entry) => entry.where === 'carried' || entry.where === 'worn');
  const targets = phrase.all ? matchPhrase(carried, phrase) : [];
  if (phrase.all) {
    if (targets.length === 0) return blocked('You are carrying nothing.', 'UNKNOWN_NOUN');
    return {
      lines: targets.map((entry) => line(`Dropped: ${entry.name}.`)),
      effects: targets.flatMap((entry) => dropEffects(ctx, entry.object as ObjectRecord)),
      free: false,
    };
  }

  const found = resolve(ctx, phrase, carried);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  if (!object) return blocked('You are not carrying that.', 'NOT_IN_SCOPE');
  return { lines: [line('Dropped.')], effects: dropEffects(ctx, object), free: false };
}

/**
 * Dropped player gear is flagged persistent, so repopulation never sweeps it
 * away — the one thing in a room the world must not tidy up.
 */
function dropEffects(ctx: CommandContext, object: ObjectRecord): Effect[] {
  const effects: Effect[] = [
    { kind: 'moveObject', id: object.id, location: inRoom(ctx.room.id) },
    { kind: 'setObjectFlag', id: object.id, flag: 'persistent', value: true },
  ];
  if (object.flags.worn) effects.push({ kind: 'wear', id: '' });
  if (ctx.player.weaponWielded === object.id) effects.push({ kind: 'wield', id: '' });
  return effects;
}

function put(ctx: CommandContext, command: Command): Reply {
  if (!command.object || !command.indirect) return blocked('Put what where?', 'UNKNOWN_NOUN');
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const holder = resolve(ctx, command.indirect);
  if ('reply' in holder) return holder.reply;

  const object = found.entry.object;
  const container = holder.entry.object;
  if (!object) return blocked('That is not a thing you can move.', 'WRONG_VERB');
  if (!container?.flags.container) return blocked(`The ${holder.entry.name} is not a container.`, 'WRONG_VERB');
  if (!container.flags.open) return blocked(`The ${container.name} is shut.`);
  if (object.id === container.id) return blocked('That is a trick nobody has managed.');

  return {
    lines: [line(`Put the ${object.name} in the ${container.name}.`)],
    effects: [
      { kind: 'moveObject', id: object.id, location: inObject(container.id) },
      { kind: 'setObjectFlag', id: object.id, flag: 'persistent', value: true },
    ],
    free: false,
  };
}

// ── doors, containers, lights, gear ─────────────────────────────────

function openClose(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  const wantOpen = command.verb === 'open';
  if (!object || (!object.flags.container && !object.tags.includes('door'))) {
    return blocked(`The ${found.entry.name} does not open.`, 'WRONG_VERB');
  }
  if (object.flags.locked) return blocked(`The ${object.name} is locked.`);
  if (Boolean(object.flags.open) === wantOpen) {
    return blocked(`The ${object.name} is already ${wantOpen ? 'open' : 'shut'}.`);
  }

  const lines = [line(`${wantOpen ? 'Opened' : 'Closed'} the ${object.name}.`)];
  if (wantOpen && object.flags.container) {
    const inside = ctx.world.contentsOfObject(object.id);
    lines.push(line(inside.length > 0 ? `Inside: ${sentenceList(inside.map((o) => o.name))}.` : 'It is empty.'));
  }
  return {
    lines,
    effects: [{ kind: 'setObjectFlag', id: object.id, flag: 'open', value: wantOpen }],
    free: false,
  };
}

function lockUnlock(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  if (!object) return blocked(`The ${found.entry.name} has no lock.`, 'WRONG_VERB');
  const wantLocked = command.verb === 'lock';
  if (Boolean(object.flags.locked) === wantLocked) {
    return blocked(`The ${object.name} is already ${wantLocked ? 'locked' : 'unlocked'}.`);
  }

  const keyId = object.flags.lockedById;
  if (!keyId) return blocked(`The ${object.name} has no keyhole.`, 'WRONG_VERB');

  const lines: Line[] = [];
  const effects: Effect[] = [];
  const key = ctx.world.objects.get(keyId);
  if (!key) return blocked(`Nothing you have fits the ${object.name}.`);

  if (command.indirect) {
    const offered = resolve(ctx, command.indirect);
    if ('reply' in offered) return offered.reply;
    if (offered.entry.id !== keyId) return blocked(`The ${offered.entry.name} does not fit.`);
  }

  // Implicit take, announced: `unlock door with brass key` should not fail
  // because the key is lying at your feet.
  if (key.location !== IN_PLAYER) {
    if (key.location !== inRoom(ctx.room.id)) {
      return blocked(`You do not have the key to the ${object.name}.`, 'NOT_IN_SCOPE');
    }
    lines.push(line(`(first taking the ${key.name})`, 'rule'));
    effects.push({ kind: 'moveObject', id: key.id, location: IN_PLAYER });
  }

  lines.push(line(`${wantLocked ? 'Locked' : 'Unlocked'} the ${object.name} with the ${key.name}.`));
  effects.push({ kind: 'setObjectFlag', id: object.id, flag: 'locked', value: wantLocked });
  return { lines, effects, free: false };
}

function lightExtinguish(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  if (!object?.flags.lightSource) return blocked(`The ${found.entry.name} gives no light.`, 'WRONG_VERB');
  const wantLit = command.verb === 'light';
  if (Boolean(object.flags.lit) === wantLit) {
    return blocked(`The ${object.name} is already ${wantLit ? 'lit' : 'out'}.`);
  }
  if (wantLit && object.burnRemaining <= 0) return blocked(`The ${object.name} is burnt out.`);
  return {
    lines: [
      line(
        wantLit
          ? `The ${object.name} catches. ${object.burnRemaining} turns of light.`
          : `You put out the ${object.name}.`,
      ),
    ],
    effects: [{ kind: 'setObjectFlag', id: object.id, flag: 'lit', value: wantLit }],
    free: false,
  };
}

function wearRemove(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  const wantWorn = command.verb === 'wear';
  if (!object?.flags.wearable) return blocked(`You cannot wear the ${found.entry.name}.`, 'WRONG_VERB');
  if (object.location !== IN_PLAYER) return blocked('You are not carrying it.', 'NOT_IN_SCOPE');
  if (Boolean(object.flags.worn) === wantWorn) {
    return blocked(`Already ${wantWorn ? 'worn' : 'off'}.`);
  }

  const effects: Effect[] = [
    { kind: 'setObjectFlag', id: object.id, flag: 'worn', value: wantWorn },
    { kind: 'wear', id: wantWorn && object.flags.armour ? object.id : '' },
  ];
  // One suit at a time: whatever was worn comes off first.
  const worn = ctx.player.armourWorn;
  if (wantWorn && worn && worn !== object.id) {
    effects.unshift({ kind: 'setObjectFlag', id: worn, flag: 'worn', value: false });
  }
  return { lines: [line(wantWorn ? `Worn: ${object.name}.` : `Removed: ${object.name}.`)], effects, free: false };
}

function wield(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const object = found.entry.object;
  if (!object?.flags.weapon) return blocked(`The ${found.entry.name} is not a weapon.`, 'WRONG_VERB');
  if (object.location !== IN_PLAYER) return blocked('You are not carrying it.', 'NOT_IN_SCOPE');
  return {
    lines: [line(`You take up the ${object.name}.`)],
    effects: [{ kind: 'wield', id: object.id }],
    free: false,
  };
}

// ── combat, out of a fight ──────────────────────────────────────────

/**
 * Swinging when nothing is fighting back. If a hostile is standing here a fight
 * begins on the world half; otherwise there is only air to hit. The fight
 * itself is resolved in `combat.ts`, reached from the turn loop, not here.
 */
function attackOutOfCombat(ctx: CommandContext): Reply {
  const hostiles = ctx.world.npcsIn(ctx.room.id).filter((npc) => npc.hostile && !npc.defeated);
  if (hostiles.length > 0) return say('You set yourself for the fight.', 'warn');
  return blocked('Nothing here to fight.');
}

/**
 * USE outside a fight. A combat ability needs a fight to spend it in; anything
 * else falls through to the plainer verbs (LIGHT a torch, and so on).
 */
function useOutOfCombat(ctx: CommandContext, command: Command): Reply {
  const name = (command.object?.words ?? []).join(' ').toLowerCase();
  const ability = ctx.campaign.abilities.table.find(
    (entry) => entry.id === name.replace(/\s+/g, '_') || entry.name.toLowerCase() === name,
  );
  if (ability || ['intimidate', 'taunt', 'seduce'].includes(name)) {
    return blocked('Save it for a fight — nothing here to use it on.');
  }
  return say('Nothing comes of it. Try the plainer verb — LIGHT, WIELD, WEAR.');
}

// ── quests ──────────────────────────────────────────────────────────

/**
 * Opening a conversation with someone, or continuing the one already open.
 *
 * The header line is the whole point of the distinction: greeting a person is
 * worth a beat, but printing "turns to hear you out" before every single line
 * of a five-line exchange reads as five separate cold approaches rather than
 * one conversation. So it fires on the turn the conversation opens and never
 * again, and the `converse` effect that opens it is what the ladder later
 * reads to route free speech to this person.
 */
function addressing(ctx: CommandContext, npc: NpcRecord, topic: string): Reply {
  const opening = ctx.conversation?.npcId !== npc.id;
  const header = line(`${npc.name} turns to hear you out.`, 'rule');
  const effects: Effect[] = [{ kind: 'pronoun', ref: 'it', id: npc.id }];
  if (opening) effects.push({ kind: 'converse', op: { t: 'open', npcId: npc.id } });
  return {
    lines: opening ? [header] : [],
    effects,
    free: false,
    // With no narrator, a continued turn has nothing else to show, so the
    // header stands in — which is exactly how a keyless game read before
    // conversations existed.
    voice: { npcId: npc.id, topic, ...(opening ? {} : { fallback: header }) },
  };
}

/**
 * Talk to someone. Quest work is the one thing a conversation still resolves
 * mechanically: an NPC with an offer hands it over, one whose work is
 * unfinished says so, and everything else is the narrator's. The numbers —
 * which band, which room — are the engine's, placed by the `acceptQuest`
 * effect at the write point; the lead is read out after.
 */
function talk(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const npc = found.entry.npc;
  if (!npc) return blocked(`There is no talking to the ${found.entry.name}.`, 'WRONG_VERB');

  const offered = ctx.world.offeredQuestsInRoom(ctx.room.id).find((quest) => quest.giverNpcId === npc.id);
  if (offered) {
    return {
      lines: [
        line(`${npc.name}:`, 'speak'),
        line(`"There's work, if you'll take it — ${questBlurb(offered.type)}."`, 'speak'),
        line('You take it on.', 'ok'),
      ],
      effects: [
        { kind: 'acceptQuest', questId: offered.id },
        { kind: 'pronoun', ref: 'it', id: npc.id },
      ],
      free: false,
    };
  }

  const active = ctx.world.activeQuests().find((quest) => quest.giverNpcId === npc.id);
  if (active) {
    return {
      lines: [line(`${npc.name} has nothing more for you until the ${active.type} is done.`, 'speak')],
      effects: [{ kind: 'pronoun', ref: 'it', id: npc.id }],
      free: false,
    };
  }
  return addressing(ctx, npc, '');
}

/**
 * `ask X about Y` and `tell X about/to Y` — both resolve the addressee the
 * same way `talk` does, then hand off to the narrator with whatever
 * followed as the topic. The engine decides nothing about the content of an
 * answer; it only picks who is being spoken to.
 */
function askOrTell(ctx: CommandContext, command: Command): Reply {
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  const npc = found.entry.npc;
  if (!npc) {
    const verb = command.verb === 'ask' ? 'asking' : 'telling';
    return blocked(`There is no ${verb} the ${found.entry.name} anything.`, 'WRONG_VERB');
  }
  return addressing(ctx, npc, command.indirect?.words.join(' ') ?? '');
}

/**
 * `say <words> to X` — the addressee sits after the preposition, unlike ask
 * and tell. Said with no one named, it lands on no one; the engine still
 * has nothing to add on top of that.
 */
function sayTo(ctx: CommandContext, command: Command): Reply {
  if (!command.indirect) {
    return say('You say it aloud. No one answers.');
  }
  const found = resolve(ctx, command.indirect);
  if ('reply' in found) return found.reply;
  const npc = found.entry.npc;
  if (!npc) {
    return blocked(`There is no saying anything to the ${found.entry.name}.`, 'WRONG_VERB');
  }
  return addressing(ctx, npc, command.object?.words.join(' ') ?? '');
}

/** Break off the conversation. Nothing else about the world changes. */
function farewell(ctx: CommandContext): Reply {
  const open = ctx.conversation?.npcId;
  const npc = open ? ctx.scope.find((entry) => entry.id === open)?.npc : undefined;
  if (!npc) return say('You are not talking to anyone.', 'rule');
  return {
    lines: [line(`You take your leave of ${npc.name}.`, 'rule')],
    effects: [{ kind: 'converse', op: { t: 'close' } }],
    free: false,
  };
}

/**
 * What a merchant has for sale — the mechanical half of "what are you
 * selling?", which the conversation router rewrites into this command.
 *
 * Stock is a query over `location`, like everything else a person holds, and
 * the prices are the ones EXAMINE already reads out of the item tables. Worn
 * gear is not stock, and neither is anything the rules say vendors refuse.
 *
 * Ask someone who is not a vendor and nothing mechanical happens, exactly as
 * asking a beggar for their stall would go — but the question still reaches
 * them, so they answer it in their own words rather than the scene going dead.
 */
function wares(ctx: CommandContext, command: Command): Reply {
  const npc = waresTarget(ctx, command);
  if ('reply' in npc) return npc.reply;
  const person = npc.npc;

  if (!person.isVendor) {
    return {
      lines: [],
      effects: [],
      free: false,
      voice: {
        npcId: person.id,
        topic: 'what they have for sale',
        fallback: line(`${person.name} has nothing to sell.`, 'rule'),
      },
    };
  }

  const refused = ruleStrings(ctx.campaign.rules, 'VENDORS.refusesTags');
  const stock = ctx.world
    .contentsOf(heldBy(person.id))
    .objects.filter((object) => !object.flags.worn && !object.flags.untradable)
    .filter((object) => !object.tags.some((tag) => refused.includes(tag)));

  if (stock.length === 0) {
    return {
      lines: [line(`${person.name} has nothing to sell just now.`, 'rule')],
      effects: [{ kind: 'pronoun', ref: 'it', id: person.id }],
      free: false,
      voice: { npcId: person.id, topic: 'what they have for sale' },
    };
  }

  const lines = [line(`${person.name} deals in:`, 'ok')];
  for (const object of stock) {
    const price = Math.max(1, Math.round((itemValues(ctx.campaign, object)['price'] ?? 0) * person.priceModifier));
    lines.push(line(`  ${describeObject(ctx.world, object)} — ${price} gold`, 'plain'));
  }
  return {
    lines,
    effects: [{ kind: 'pronoun', ref: 'it', id: person.id }],
    free: false,
  };
}

/**
 * Who is being asked. Named outright if the player named someone; otherwise
 * whoever they are already talking to, and failing that the one merchant in
 * the room — but never a guess between two of them.
 */
function waresTarget(ctx: CommandContext, command: Command): { npc: NpcRecord } | { reply: Reply } {
  if (command.object) {
    const found = resolve(ctx, command.object);
    if ('reply' in found) return found;
    const npc = found.entry.npc;
    if (!npc) return { reply: blocked(`The ${found.entry.name} is not selling anything.`, 'WRONG_VERB') };
    return { npc };
  }
  const open = ctx.conversation?.npcId;
  const partner = open ? ctx.scope.find((entry) => entry.id === open)?.npc : undefined;
  if (partner) return { npc: partner };

  const vendors = ctx.scope.filter((entry) => entry.npc?.isVendor && !entry.npc.defeated);
  const only = vendors.length === 1 ? vendors[0]?.npc : undefined;
  if (only) return { npc: only };
  if (vendors.length > 1) {
    return {
      reply: {
        lines: [line(`Ask whom: ${sentenceList(vendors.map((entry) => entry.name))}?`)],
        effects: [],
        free: true,
        failure: 'AMBIGUOUS',
        question: { candidateIds: vendors.map((entry) => entry.id) },
      },
    };
  }
  return { reply: blocked('There is no one here selling anything.', 'NOT_IN_SCOPE') };
}

// ── quick travel ────────────────────────────────────────────────────

/**
 * RECALL — quick travel from the Hub to a teleporter already found. Bare
 * RECALL lists what answers; `RECALL <place>` travels to one.
 *
 * The complement of the Hub-return consumable, not a substitute for it: that
 * gets the player out from anywhere, this gets them back in to a floor
 * already reached. Only ever usable from the Hub, and only ever to a Rung
 * whose teleporter has actually been walked to — descending itself is never
 * shortened by this, only the walk back down to somewhere already cleared.
 */
function recall(ctx: CommandContext, command: Command): Reply {
  if (ctx.room.areaId !== HUB_AREA_ID) {
    return blocked('The waygate only answers a call made from the Hub.', 'WRONG_VERB');
  }
  const unlocked = ctx.world.unlockedTeleporters();
  if (unlocked.length === 0) {
    return say('No waygate has answered you yet. Find one, first — walking there is the only way.');
  }
  if (!command.object) {
    const lines = [line('Waygates answer to:', 'ok')];
    for (const dest of unlocked) lines.push(line(`  ${dest.areaName} (Rung ${dest.depth})`));
    return free(lines);
  }

  const query = command.object.words.join(' ').toLowerCase();
  const matches = unlocked.filter((dest) => dest.areaName.toLowerCase().includes(query));
  if (matches.length === 0) return blocked(`No waygate answers to "${query}".`, 'UNKNOWN_NOUN');
  if (matches.length > 1) {
    return say(`Which one: ${sentenceList(matches.map((dest) => dest.areaName))}? Say more of the name.`);
  }
  const dest = matches[0] as { roomId: string; areaName: string };
  return {
    lines: [line(`The waygate takes you down to ${dest.areaName}.`, 'ok')],
    effects: [{ kind: 'movePlayer', roomId: dest.roomId }],
    free: false,
  };
}

/**
 * Search the room. Its one job at this step is the `investigate` objective: if
 * an active quest wants this room looked over, the search sets its flag and the
 * world half settles it. Everywhere else it turns up nothing a look would not.
 */
function search(ctx: CommandContext): Reply {
  for (const quest of ctx.world.activeQuests()) {
    for (const objective of ctx.world.objectivesOf(quest)) {
      if (
        objective.completedBy === 'flagSet' &&
        objective.targetRoomId === ctx.room.id &&
        !objective.done &&
        !ctx.world.flags.has(objective.completedByArg)
      ) {
        return {
          lines: [line('You search the place over, and find what you were sent to find.', 'ok')],
          effects: [{ kind: 'worldFlag', id: objective.completedByArg, value: true }],
          free: false,
        };
      }
    }
  }
  return say('You search, and turn up nothing a look would not.');
}

/** The journal: work in hand, and work on offer in this room. */
function questsJournal(ctx: CommandContext): Reply {
  const active = ctx.world.activeQuests();
  const offeredHere = ctx.world.offeredQuestsInRoom(ctx.room.id);
  if (active.length === 0 && offeredHere.length === 0) {
    return free([line('No work in hand, and none on offer here.', 'rule')]);
  }

  const lines: Line[] = [];
  if (active.length > 0) {
    lines.push(line('Work in hand:', 'ok'));
    for (const quest of active) {
      const objective = ctx.world.objectivesOf(quest)[0];
      const state = !objective ? 'no lead yet' : objective.done ? 'done — go be paid' : `it lies ${objective.hint}`;
      lines.push(line(`  ${questLabel(quest.type)} — ${state}`));
    }
  }
  if (offeredHere.length > 0) {
    lines.push(line('On offer here:', 'ok'));
    for (const quest of offeredHere) {
      const giver = ctx.world.npcs.get(quest.giverNpcId);
      lines.push(line(`  ${questLabel(quest.type)} — talk to ${giver?.name ?? 'someone here'} to take it on`, 'rule'));
    }
  }
  return free(lines);
}

const questLabel = (type: string): string => (type ? type[0]?.toUpperCase() + type.slice(1) : 'Work');

/** A placeholder line for the offer, until the narrator writes the real one. */
const questBlurb = (type: string): string =>
  ({
    fetch: 'something of mine needs bringing back',
    kill: 'a thing out there needs killing',
    deliver: 'this needs carrying somewhere for me',
    find: 'a place needs eyes on it',
    clear: 'somewhere needs emptying of what holds it',
    investigate: 'something needs looking into',
  })[type] ?? 'there is work to be done';

// ── the sheet, the pack, the help ───────────────────────────────────

function inventory(ctx: CommandContext): Reply {
  const carried = ctx.world.contentsOf(IN_PLAYER).objects;
  const limit = playerCarry(ctx.campaign, ctx.player);
  const lines = [
    line(`Carrying ${carriedWeight(ctx)}/${limit}, and ${ctx.player.purse} gold.`, 'ok'),
    ...carried.map((object) => {
      // `describeObject` already says "worn"; saying it twice reads as a bug.
      const wielded = object.id === ctx.player.weaponWielded ? ' [wielded]' : '';
      return line(`  ${describeObject(ctx.world, object)}${wielded}`);
    }),
  ];
  if (carried.length === 0) lines.push(line('  (nothing)'));
  return free(lines);
}

const stats = (ctx: CommandContext): Reply => free(sheetLines(ctx));

function mapOf(ctx: CommandContext): Reply {
  // The full floor is drawn by the UI overlay (same grid renderer as the
  // mini-map, larger). The engine only asks for it — a free, stateless query.
  const walked = ctx.world.roomsOf(ctx.room.areaId).filter((room) => room.visited).length;
  const area = ctx.world.areas.get(ctx.room.areaId);
  return {
    lines: [line(`${area?.name ?? ctx.room.areaId}: ${walked} room${walked === 1 ? '' : 's'} walked.`, 'rule')],
    effects: [],
    free: true,
    showMap: true,
  };
}

function sheetLines(ctx: CommandContext): Line[] {
  const { player, campaign } = ctx;
  const stat = Object.entries(player.stats)
    .map(([name, value]) => `${name.slice(0, 3).toUpperCase()} ${value}`)
    .join(' · ');
  const skills = Object.entries(player.weaponSkills)
    .map(([name, value]) => `${name} ${value}`)
    .join(' · ');
  const approaches = Object.entries(player.approachSkills)
    .map(([name, value]) => `${name} ${value}`)
    .join(' · ');
  return [
    line(`${player.name} — ${player.archetype}`, 'ok'),
    line(stat),
    line(
      `HP ${player.hp}/${playerMaxHp(campaign, player)} · Resolve ${player.resolve}/${playerMaxResolve(campaign, player)} · Libido ${player.libido}`,
    ),
    line(`Weapon skills: ${skills}`, 'rule'),
    line(`Approaches: ${approaches}`, 'rule'),
    line(`Purse ${player.purse} · Banked ${player.banked} · Turn ${ctx.turn}`, 'rule'),
  ];
}

function help(ctx: CommandContext): Reply {
  const words = ctx.campaign.verbs.verbs.map((verb) => verb.words[0] as string);
  return free([
    line('Move with n s e w u d. LOOK, EXAMINE, TAKE, DROP, OPEN, LIGHT, WEAR, WIELD, I, MAP, STATS.', 'ok'),
    line(`Every verb: ${words.join(' ')}`, 'rule'),
    line('SAVE <name>, LOAD <name>, and the autosave writes itself every turn.', 'rule'),
  ]);
}

// ── shared plumbing ─────────────────────────────────────────────────

/** Everything the player is carrying, container contents included. */
export function carriedWeight(ctx: CommandContext): number {
  const seen = new Set<string>();
  let total = 0;
  const walk = (location: string): void => {
    for (const object of ctx.world.contentsOf(location).objects) {
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      total += itemValues(ctx.campaign, object)['weight'] ?? 0;
      walk(inObject(object.id) as string);
    }
  };
  walk(IN_PLAYER as string);
  return total;
}

type Resolved = { entry: ScopeEntry } | { reply: Reply };

/**
 * One phrase to one thing. The interesting failure is `NOT_IN_SCOPE`: the
 * engine knows the lantern is in the cellar, so it can say something true
 * rather than pretending the word means nothing.
 */
export function resolve(
  ctx: CommandContext,
  phrase: Phrase | undefined,
  within?: ScopeEntry[],
): Resolved {
  if (!phrase || (phrase.words.length === 0 && !phrase.all)) {
    return { reply: blocked('What?', 'UNKNOWN_NOUN') };
  }
  const pool = within ?? ctx.scope;
  const matches = matchPhrase(pool, phrase);
  if (matches.length === 1) return { entry: matches[0] as ScopeEntry };
  if (matches.length > 1) {
    const forced = ctx.forced && matches.find((match) => match.id === ctx.forced?.id);
    if (forced) return { entry: forced };
    return {
      reply: {
        lines: [line(`Which do you mean: ${sentenceList(matches.map((entry) => entry.name))}?`)],
        effects: [],
        free: true,
        failure: 'AMBIGUOUS',
        question: { candidateIds: matches.map((match) => match.id) },
      },
    };
  }

  const elsewhere = elsewhereNamed(ctx, phrase);
  if (elsewhere) {
    return {
      reply: blocked(
        ctx.dark ? 'It is too dark to see anything here.' : `You don't see ${elsewhere} here.`,
        'NOT_IN_SCOPE',
      ),
    };
  }
  return { reply: blocked("You can't see any such thing.", 'UNKNOWN_NOUN') };
}

/**
 * Does the world hold something by that name somewhere else? The answer turns
 * "no such thing" into "not here", which is the difference between a parser
 * that feels blind and one that feels like it knows its own world.
 */
function elsewhereNamed(ctx: CommandContext, phrase: Phrase): string | undefined {
  const noun = phrase.words[phrase.words.length - 1];
  if (!noun) return undefined;
  const object = [...ctx.world.objects.values()].find((candidate) =>
    candidate.nouns.map((word) => word.toLowerCase()).includes(noun),
  );
  if (object) return `the ${object.name}`;
  const npc = [...ctx.world.npcs.values()].find((candidate) =>
    candidate.name.toLowerCase().split(/\s+/).includes(noun),
  );
  return npc ? npc.name : undefined;
}

/** The room the player is standing in, or a loud failure. */
export function roomOf(world: World, player: PlayerRecord): RoomRecord {
  const room = world.rooms.get(player.roomId);
  if (!room) throw new Error(`player is in room "${player.roomId}", which does not exist`);
  return room;
}

/** `warnAtTurnsLeft` from the light rules — read, never assumed. */
export const lightWarnAt = (campaign: ResolvedCampaign): number =>
  ruleNumber(campaign.rules, 'LIGHT.warnAtTurnsLeft');
