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
import { ruleNumber } from '../engine/rules';
import type { ObjectRecord, RoomRecord } from '../world/types';
import { IN_PLAYER, inObject, inRoom } from '../world/types';
import type { World } from '../world/world';
import { renderPlayerMap } from '../world/map';
import { describeObject, sentenceList, viewRoom } from './describe';
import type { Effect } from './effects';
import { playerCarry, playerMaxHp, playerMaxResolve, type PlayerRecord } from './player';
import { matchPhrase, type ScopeEntry } from './scope';

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
}

export interface CommandContext {
  campaign: ResolvedCampaign;
  world: World;
  player: PlayerRecord;
  room: RoomRecord;
  dark: boolean;
  scope: ScopeEntry[];
  turn: number;
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
  attack: 'Combat lands at build step 6.',
  flee: 'Combat lands at build step 6.',
  use: 'Abilities land with combat, at build step 6.',
  eat: 'Consumables land with combat, at build step 6.',
  drink: 'Consumables land with combat, at build step 6.',
  ask: 'The narrator voices people at build step 7.',
  tell: 'The narrator voices people at build step 7.',
  say: 'The narrator voices people at build step 7.',
  give: 'The narrator voices people at build step 7.',
  show: 'The narrator voices people at build step 7.',
  buy: 'The shop opens once there is a reason to spend.',
  sell: 'The shop opens once there is a reason to spend.',
  list: 'The shop opens once there is a reason to spend.',
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
    case 'brief':
      return {
        lines: [line(ctx.player.brief ? 'Verbose descriptions.' : 'Brief descriptions.')],
        effects: [{ kind: 'brief', value: !ctx.player.brief }],
        free: true,
      };
    case 'help':
      return help(ctx);
    case 'read':
    case 'listen':
    case 'smell':
    case 'touch':
    case 'push':
    case 'pull':
    case 'turn':
    case 'throw':
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
  if (view.exits.length > 0) lines.push(line(`Exits: ${view.exits.join(' · ')}`, 'rule'));
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
        line(npc.persona || `${npc.role || 'someone'} out of ${npc.baseId}.`),
        line(npc.hostile ? 'It means you harm.' : 'It means you no harm.', npc.hostile ? 'warn' : 'plain'),
      ],
      effects: [{ kind: 'pronoun', ref: 'it', id: npc.id }],
      free: false,
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
  const found = resolve(ctx, command.object);
  if ('reply' in found) return found.reply;
  // Tier 3: expression, no roll, no state change, no cost beyond the turn.
  return say(`You ${command.verb} the ${found.entry.name}. Nothing comes of it.`);
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

// ── quests ──────────────────────────────────────────────────────────

/**
 * Talk to someone. Until the narrator voices people at step 7, the only thing
 * a conversation resolves is quest work: an NPC with an offer hands it over,
 * one whose work is unfinished says so, and everyone else waits for the
 * narrator. The numbers — which band, which room — are the engine's, placed by
 * the `acceptQuest` effect at the write point; the lead is read out after.
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
  return {
    lines: [line('The narrator voices people at build step 7. For now, they only offer work.', 'rule')],
    effects: [],
    free: true,
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
  const drawn = renderPlayerMap(ctx.world, ctx.room.id);
  const walked = ctx.world.roomsOf(ctx.room.areaId).filter((room) => room.visited).length;
  const area = ctx.world.areas.get(ctx.room.areaId);
  return free([
    line(area?.name ?? ctx.room.areaId, 'ok'),
    line(drawn || '(nothing walked yet)'),
    line(`${walked} room${walked === 1 ? '' : 's'} walked here.`, 'rule'),
  ]);
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
