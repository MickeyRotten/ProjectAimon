/**
 * The turn loop.
 *
 * Player half — parse, resolve scope, check preconditions, roll if the action
 * can fail interestingly, then **apply player state change**. World half —
 * advance the clock, burn light, move what moves, evaluate the event deck,
 * then **apply world state change**.
 *
 * Those two applies are the only places state is ever written. Handlers return
 * effects and this file applies them; nothing else in the codebase may touch a
 * record. That is rule one, and it is enforced here rather than remembered.
 *
 * At this build step the world half advances the clock and burns light. Movers
 * and the event deck are named in the loop below and do nothing yet — they
 * arrive with combat and quests, and the slot they arrive into already exists.
 */

import type { ResolvedCampaign } from '../campaign/types';
import { parse, type Command, type ParseFailure } from '../engine/parser';
import { Rng } from '../engine/rng';
import { ruleArray, ruleNumber, ruleString } from '../engine/rules';
import { objectiveComplete, type QuestCheckContext } from '../world/quests';
import type { ObjectRecord, RoomRecord } from '../world/types';
import { IN_PLAYER, inObject, inRoom } from '../world/types';
import { World, type WorldSnapshot } from '../world/world';
import {
  carriedWeight,
  execute,
  line,
  lightWarnAt,
  roomLines,
  roomOf,
  type CommandContext,
  type Line,
  type Pending,
} from './commands';
import {
  combatReduce,
  emptyCombat,
  enemyRound,
  engageLines,
  hostilesIn,
  playerCombatAction,
  type CombatContext,
  type CombatState,
} from './combat';
import type { Effect } from './effects';
import { createPlayer, issueKit, playerMaxHp, playerMaxResolve, type PlayerRecord } from './player';
import { anyLight, isDark, scopeOf, type ScopeEntry } from './scope';
import { resolveAttempt, type Tier2Attempt } from './tier2';

export interface TranscriptEntry {
  turn: number;
  input: string;
  output: string;
}

export interface GameSnapshot {
  /** Bumped only when the shape changes in a way a loader must know about. */
  version: 1;
  campaignId: string;
  campaignVersion: string;
  turn: number;
  player: PlayerRecord;
  world: WorldSnapshot;
  transcript: TranscriptEntry[];
  /** The live fight, if any. Born and dies with an encounter. */
  combat?: CombatState;
}

export interface BeginOptions {
  campaign: ResolvedCampaign;
  seed: number | string;
  name: string;
  archetype?: string | undefined;
}

export interface TurnResult {
  lines: Line[];
  turn: number;
  /** True when the world half ran — i.e. the input cost a turn. */
  spent: boolean;
  /** Set when a handler named someone to voice. main.ts asks the narrator after. */
  voice?: { npcId: string; topic: string } | undefined;
  /** Set only by `resolveTier2` — the edge's cue to narrate this outcome, and what it was. */
  tier2?: 'success' | 'failure' | undefined;
}

/**
 * What step 2 of the loop decided, before anything is executed. `unparsed` is
 * the hook the Tier 2/3 ladder hangs off — the edge (main.ts) tries the
 * translator and classifier only when it sees this, and never otherwise.
 */
export type Plan =
  | { kind: 'command'; command: Command }
  | { kind: 'note'; lines: Line[] }
  | { kind: 'unparsed'; failure: ParseFailure };

export class Game {
  readonly campaign: ResolvedCampaign;
  readonly world: World;
  player: PlayerRecord;
  turn = 0;
  readonly transcript: TranscriptEntry[] = [];
  /** The live combat session. Inactive until something turns hostile. */
  combat: CombatState = emptyCombat();
  /** Counts combat turns, so each rolls its own seeded `(turn, action)` stream. */
  private combatSeq = 0;
  /** Set by a defeat during the world half, read out as narration after. */
  private pendingDefeat: string | undefined;

  private pending: { question: Pending; command: Command } | undefined;
  private lastCommand: Command | undefined;
  private forced: ScopeEntry | undefined;
  /** Turns the world half owes, from a forced retreat. */
  private owedTurns = 0;

  private constructor(campaign: ResolvedCampaign, world: World, player: PlayerRecord) {
    this.campaign = campaign;
    this.world = world;
    this.player = player;
  }

  /** A new game: build the world, roll a character, hand them the kit. */
  static begin(options: BeginOptions): Game {
    const world = World.create({ campaign: options.campaign, seed: options.seed });
    const rng = new Rng(`${options.seed}:character`);
    const start = options.campaign.manifest.hub.entryRoomId;
    const created = createPlayer({
      campaign: options.campaign,
      rng,
      name: options.name,
      archetype: options.archetype,
      roomId: start,
    });
    for (const item of created.kit) world.objects.set(item.id, item);
    const game = new Game(options.campaign, world, created.player);
    const room = world.rooms.get(start);
    if (room) room.visited = true;
    return game;
  }

  /** Everything worth saving, deep-copied. */
  snapshot(): GameSnapshot {
    const snapshot: GameSnapshot = {
      version: 1,
      campaignId: this.campaign.id,
      campaignVersion: this.campaign.manifest.version,
      turn: this.turn,
      player: structuredClone(this.player),
      world: this.world.snapshot(),
      transcript: structuredClone(this.transcript),
    };
    // A dead fight is not worth saving; a live one rides along with the world.
    if (this.combat.active) snapshot.combat = structuredClone(this.combat);
    return snapshot;
  }

  /**
   * Load a save. The world comes back out of the payload exactly as it was
   * written; nothing is regenerated, because regenerating on load is the one
   * operation that would destroy the world the player has been walking around
   * in.
   */
  static restore(campaign: ResolvedCampaign, snapshot: GameSnapshot): Game {
    const world = World.restore(campaign, snapshot.world);
    const game = new Game(campaign, world, structuredClone(snapshot.player));
    game.turn = snapshot.turn;
    game.transcript.push(...structuredClone(snapshot.transcript));
    if (snapshot.combat) game.combat = structuredClone(snapshot.combat);
    return game;
  }

  get room(): RoomRecord {
    return roomOf(this.world, this.player);
  }

  get dark(): boolean {
    return isDark(this.world, this.room);
  }

  context(): CommandContext {
    const room = this.room;
    const dark = isDark(this.world, room);
    return {
      campaign: this.campaign,
      world: this.world,
      player: this.player,
      room,
      dark,
      scope: scopeOf({ world: this.world, room, dark, playerName: this.player.name }),
      turn: this.turn,
    };
  }

  /** The room description as the player would see it now. */
  describeHere(full: boolean): Line[] {
    return roomLines(this.context(), full);
  }

  /** True while a live fight is holding the loop, whatever the player types. */
  inCombat(): boolean {
    return this.combat.active && hostilesIn(this.world, this.player.roomId).length > 0;
  }

  /**
   * One player input, all the way through the loop.
   *
   * 1 submit · 2 parse · 3 (translator, step 7) · 4 scope · 5 preconditions ·
   * 6 roll · 7 apply player state · 8-12 the world half · 13-16 narration,
   * which at this step is the lines already assembled.
   */
  submit(raw: string): TurnResult {
    const lines: Line[] = [line(raw, 'echo')];

    // A live fight takes over the loop: a command is a combat action, and the
    // world half runs the enemy round rather than only the clock.
    if (this.inCombat()) {
      return this.combatTurn(raw, lines);
    }
    if (this.combat.active) this.combat = emptyCombat(); // hostiles all gone

    return this.respond(raw, this.plan(raw), lines);
  }

  /**
   * The rest of `submit` once a `Plan` exists. Split out so main.ts's Tier
   * 2/3 ladder can call `plan()` exactly once — `plan()` consumes a pending
   * disambiguation question the moment it runs, so calling it twice for the
   * same input would silently drop the answer the second time.
   */
  respond(raw: string, plan: Plan, lines: Line[] = [line(raw, 'echo')]): TurnResult {
    if (plan.kind === 'unparsed') {
      // Tier 2 classification and the Tier 3 flavour reply are the
      // narrator's — main.ts tries them first when there is a key. This is
      // the no-key path: the engine says what it actually knows.
      lines.push(line(plan.failure.message, 'rule'));
      return this.finish(raw, lines, false);
    }
    if (plan.kind === 'note') {
      lines.push(...plan.lines);
      return this.finish(raw, lines, false);
    }
    return this.run(raw, plan.command, lines);
  }

  /**
   * Steps 4 through 16 for an already-resolved command — whether it came
   * from `plan()` untouched, or from the translator's canonical re-entry
   * after a Tier 1 failure. Never used for a combat action; combat has its
   * own resolver and its own write point in `combatTurn`.
   */
  run(raw: string, command: Command, lines: Line[] = [line(raw, 'echo')]): TurnResult {
    const ctx = this.context();
    const reply = execute(this.forced ? { ...ctx, forced: this.forced } : ctx, command);
    this.forced = undefined;
    lines.push(...reply.lines);

    this.pending = reply.question ? { question: reply.question, command } : undefined;
    if (!reply.question && reply.failure === undefined) this.lastCommand = command;

    if (reply.free) return this.finish(raw, lines, false);

    const before = this.player.roomId;
    // ── step 7: the player half's one write point ────────────────────
    this.apply(reply.effects);
    // Taking on a quest places its objective at apply time, so the lead it
    // leaves can only be read out once the write has happened.
    for (const effect of reply.effects) {
      if (effect.kind !== 'acceptQuest') continue;
      const quest = this.world.quests.get(effect.questId);
      const objective = quest ? this.world.objectivesOf(quest)[0] : undefined;
      if (objective) lines.push(line(`It lies ${objective.hint}`, 'rule'));
    }
    // ── steps 8-12: the world half, which runs whatever the player did
    lines.push(...this.worldHalf());

    if (this.player.roomId !== before) {
      const room = this.room;
      const first = !room.visited;
      // ── the second write point covers the visit mark as well ───────
      this.apply([{ kind: 'visit', roomId: room.id }]);
      lines.push(...this.describeHere(first || !this.player.brief));
    }
    // Walking into a room that holds hostiles starts a fight — announced now,
    // fought from the next turn, so the entry itself is never a free hit.
    lines.push(...this.maybeBeginCombat());
    return this.finish(raw, lines, true, { voice: reply.voice });
  }

  /**
   * Tier 3 — pure expression. No canonical command, no legal Tier 2 attempt:
   * just prose, over an unparsed input that cost nothing. No roll, no state
   * change, no write point touched.
   */
  tier3(raw: string): TurnResult {
    return this.finish(raw, [line(raw, 'echo')], false);
  }

  /**
   * Tier 2 — a validated attempt only; `legalAttempt` in tier2.ts is what
   * validates. Resolution rolls and picks the effect the same way any other
   * handler would, then lands at this file's one write point like every
   * other command.
   */
  resolveTier2(raw: string, attempt: Tier2Attempt): TurnResult {
    const lines: Line[] = [line(raw, 'echo')];
    const ctx = this.context();
    const rng = this.world.combatRng(`tier2:${this.turn}`);
    const reply = resolveAttempt(ctx, attempt, rng);
    lines.push(...reply.lines);

    // ── step 7: the player half's one write point ────────────────────
    this.apply(reply.effects);
    lines.push(...this.worldHalf());
    lines.push(...this.maybeBeginCombat());
    return this.finish(raw, lines, true, { tier2: reply.outcome });
  }

  /**
   * One combat turn: the player's action lands at the player-half write point,
   * then the world half runs the enemy round. Defeat, if it comes, is narrated
   * after — the corpse run has already moved the player to the Hub.
   */
  private combatTurn(raw: string, lines: Line[]): TurnResult {
    const command = this.commandForCombat(raw, lines);
    if (!command) return this.finish(raw, lines, false);

    const reply = playerCombatAction(this.combatContext(), command);
    this.forced = undefined;
    lines.push(...reply.lines);
    if (!reply.free) this.lastCommand = command;
    if (reply.free) return this.finish(raw, lines, false);

    const before = this.player.roomId;
    // ── step 7: the player half's one write point ────────────────────
    this.apply(reply.effects);
    // ── steps 8-12: the world half — enemy round, then clock and light ─
    lines.push(...this.worldHalf());

    if (this.pendingDefeat) {
      lines.push(...this.defeatLines(this.pendingDefeat));
      this.pendingDefeat = undefined;
      lines.push(...this.describeHere(!this.player.brief));
    } else if (this.player.roomId !== before) {
      const room = this.room;
      const first = !room.visited;
      this.apply([{ kind: 'visit', roomId: room.id }]);
      lines.push(...this.describeHere(first || !this.player.brief));
      lines.push(...this.maybeBeginCombat());
    }
    return this.finish(raw, lines, true);
  }

  /** Begin a fight if the current room holds hostiles and none is under way. */
  private maybeBeginCombat(): Line[] {
    if (this.combat.active) return [];
    if (hostilesIn(this.world, this.player.roomId).length === 0) return [];
    this.apply([{ kind: 'combat', op: { t: 'begin' } }]);
    return engageLines(this.combatContext());
  }

  /** The context combat handlers read: the command context plus dice and session. */
  private combatContext(): CombatContext {
    return { ...this.context(), rng: this.world.combatRng(`combat:${this.turn}:${this.combatSeq++}`), combat: this.combat };
  }

  /** What a defeat reads out. The mechanics already ran; this is only the telling. */
  private defeatLines(by: string): Line[] {
    const how = by === 'resolve' ? 'Your nerve breaks before your body does.' : 'You go down under the blows.';
    return [
      line(how, 'warn'),
      line('You wake at the Hub, stripped to a crude kit. Your goods lie where you fell — go and take them back.', 'warn'),
    ];
  }

  // ── parsing, disambiguation, AGAIN ────────────────────────────────

  /**
   * Step 2: turn raw input into a command, or say why not. The only place
   * `this.pending` and `AGAIN` are resolved, so it is the single entry point
   * both `submit` and combat go through — main.ts's Tier 2/3 ladder calls it
   * directly to decide whether the translator is worth trying at all.
   */
  plan(raw: string): Plan {
    // A pending "which one?" gets first refusal on the next input, and is
    // dropped rather than argued with when the answer does not answer it.
    if (this.pending) {
      const answer = this.answerPending(raw);
      this.pending = undefined;
      if (answer) return { kind: 'command', command: answer };
    }

    const parsed = parse(raw, this.campaign.verbs);
    if (!parsed.ok) {
      return { kind: 'unparsed', failure: parsed.failure };
    }
    if (parsed.command.verb === 'again') {
      if (!this.lastCommand) {
        return { kind: 'note', lines: [line('Nothing to repeat.', 'rule')] };
      }
      return { kind: 'command', command: this.lastCommand };
    }
    return { kind: 'command', command: parsed.command };
  }

  private commandForCombat(raw: string, lines: Line[]): Command | undefined {
    const result = this.plan(raw);
    if (result.kind === 'command') return result.command;
    if (result.kind === 'note') lines.push(...result.lines);
    else lines.push(line(result.failure.message, 'rule'));
    return undefined;
  }

  /** Match an answer against the candidates the question offered. */
  private answerPending(raw: string): Command | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    const ctx = this.context();
    const candidates = ctx.scope.filter((entry) => pending.question.candidateIds.includes(entry.id));
    const words = raw.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
    const match = candidates.find((entry) =>
      words.every((word) =>
        [...entry.nouns, ...entry.adjectives, ...entry.name.toLowerCase().split(/\s+/)]
          .map((candidate) => candidate.toLowerCase())
          .includes(word),
      ),
    );
    if (!match || words.length === 0) return undefined;
    this.forced = match;
    return pending.command;
  }

  // ── the two write points ──────────────────────────────────────────

  private apply(effects: readonly Effect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'movePlayer':
          this.player.roomId = effect.roomId;
          break;
        case 'enterGate': {
          // Generation happens here and nowhere else: an area is generated
          // once, on the turn someone walks into it, and never again.
          const area = this.world.enterGate(effect.edgeId);
          if (area.entryRoomId) this.player.roomId = area.entryRoomId;
          break;
        }
        case 'moveObject':
          this.world.moveTo(effect.id, effect.location);
          break;
        case 'setObjectFlag': {
          const object = this.world.objects.get(effect.id);
          if (object) (object.flags as Record<string, unknown>)[effect.flag] = effect.value;
          break;
        }
        case 'setBurn': {
          const object = this.world.objects.get(effect.id);
          if (object) object.burnRemaining = Math.max(0, effect.turns);
          break;
        }
        case 'wield':
          this.player.weaponWielded = effect.id;
          break;
        case 'wear':
          this.player.armourWorn = effect.id;
          break;
        case 'purse':
          this.player.purse = Math.max(0, this.player.purse + effect.delta);
          break;
        case 'hp':
          this.player.hp += effect.delta;
          break;
        case 'resolve':
          this.player.resolve += effect.delta;
          break;
        case 'libido':
          this.player.libido += effect.delta;
          break;
        case 'visit': {
          const room = this.world.rooms.get(effect.roomId);
          if (room) room.visited = true;
          break;
        }
        case 'brief':
          this.player.brief = effect.value;
          break;
        case 'pronoun':
          this.player.pronounRefs[effect.ref] = effect.id;
          break;
        case 'worldFlag':
          if (effect.value) this.world.flags.add(effect.id);
          else this.world.flags.delete(effect.id);
          break;
        case 'npcDisposition': {
          const npc = this.world.npcs.get(effect.id);
          if (npc) npc.disposition += effect.delta;
          break;
        }
        case 'extraTurns':
          this.owedTurns += effect.turns;
          break;
        case 'acceptQuest':
          // Placement rolls and writes world records, so it lives behind an
          // effect and happens here, at the write point — never in a handler.
          this.world.acceptQuest(effect.questId);
          break;
        case 'completeQuest': {
          const { gold } = this.world.completeQuest(effect.questId);
          this.player.purse = Math.max(0, this.player.purse + gold);
          break;
        }
        case 'failQuest':
          this.world.failQuest(effect.questId);
          break;
        case 'npcHp': {
          const npc = this.world.npcs.get(effect.id);
          if (npc) npc.hp = Math.min(npc.maxHp, npc.hp + effect.delta);
          break;
        }
        case 'npcResolve': {
          const npc = this.world.npcs.get(effect.id);
          if (npc) npc.resolve = Math.min(npc.maxResolve, npc.resolve + effect.delta);
          break;
        }
        case 'npcDead':
          this.killNpc(effect.id);
          break;
        case 'npcBreak':
          this.breakNpc(effect.id, effect.outcome);
          break;
        case 'spawnCreature':
          this.world.npcs.set(effect.record.id, effect.record);
          break;
        case 'growSkill':
          this.growSkill(effect.axis, effect.id, effect.delta);
          break;
        case 'defeatPlayer':
          this.defeatPlayer(effect.victorId, effect.by);
          break;
        case 'combat':
          if (effect.op.t === 'sense') {
            const npc = this.world.npcs.get(effect.op.id);
            if (npc) npc.sensed = true;
          } else {
            combatReduce(this.combat, effect.op);
          }
          break;
      }
    }
  }

  // ── combat state writes ───────────────────────────────────────────

  /** A killed creature: a corpse now, its purse spilled into the room's floor. */
  private killNpc(id: string): void {
    const npc = this.world.npcs.get(id);
    if (!npc) return;
    npc.hp = 0;
    npc.hostile = false;
    npc.defeated = true;
    // Its held gear falls where it stood. Killing pays; routing does not.
    for (const object of this.world.contentsOf(`npc:${id}`).objects) {
      this.world.moveTo(object.id, inRoom(this.player.roomId));
    }
  }

  /**
   * A broken creature leaves the fight the way its friendliness said it would:
   * the fled vanish with their loot, the surrendered and won-over stay as
   * people. Only structure this loop never touches — a room's rooms and edges.
   */
  private breakNpc(id: string, outcome: string): void {
    const npc = this.world.npcs.get(id);
    if (!npc) return;
    npc.resolve = 0;
    npc.hostile = false;
    npc.broke = outcome;
    if (outcome === 'flee') {
      npc.location = null; // gone, taking what it carried
    } else if (outcome === 'surrender') {
      for (const object of this.world.contentsOf(`npc:${id}`).objects) {
        this.world.moveTo(object.id, inRoom(this.player.roomId));
      }
    }
    // `join` keeps its gear and stands in the room as a now-friendly face.
  }

  private growSkill(axis: 'weapon' | 'approach' | 'armour', id: string, delta: number): void {
    if (axis === 'weapon') this.player.weaponSkills[id] = (this.player.weaponSkills[id] ?? 0) + delta;
    else if (axis === 'approach') this.player.approachSkills[id] = (this.player.approachSkills[id] ?? 0) + delta;
    else this.player.armourExpertise += delta;
  }

  /**
   * The corpse run. A defeat — HP or Resolve, the two cost the same — strips the
   * player, moves their purse and carried gear onto the victor in the room it
   * happened, wakes them at the Hub, and hands them the free crude kit so the
   * run back is never attempted naked. Losses are moved, never deleted.
   */
  private defeatPlayer(victorId: string, by: string): void {
    const rules = this.campaign.rules;
    const lose = ruleStrings(rules, 'DEFEAT.lose');
    const victor = this.world.npcs.get(victorId);
    const victorHold = victor && !victor.defeated ? `npc:${victorId}` : inRoom(this.player.roomId);

    if (lose.includes('purse')) {
      if (victor) victor.gold = (victor.gold ?? 0) + this.player.purse;
      this.player.purse = 0;
    }
    if (lose.includes('carried')) {
      for (const object of this.world.contentsOf(IN_PLAYER).objects) {
        this.world.moveTo(object.id, victorHold);
        (object.flags as Record<string, unknown>)['persistent'] = true;
        (object.flags as Record<string, unknown>)['worn'] = false;
      }
      this.player.weaponWielded = '';
      this.player.armourWorn = '';
    }

    const skillLoss = ruleNumber(rules, 'DEFEAT.skillLoss', 0);
    if (skillLoss > 0) {
      for (const key of Object.keys(this.player.weaponSkills)) {
        this.player.weaponSkills[key] = Math.max(0, (this.player.weaponSkills[key] ?? 0) - skillLoss);
      }
    }

    // Wake at the Hub, restored, and issue the standing crude kit.
    this.player.roomId = this.campaign.manifest.hub.entryRoomId;
    this.player.hp = playerMaxHp(this.campaign, this.player);
    this.player.resolve = playerMaxResolve(this.campaign, this.player);
    this.combat = emptyCombat();

    const kitBases = ruleStrings(rules, 'DEFEAT.hubStarterKit');
    const rng = this.world.combatRng(`defeat:${this.turn}:${victorId}`);
    const kit = issueKit(this.campaign, rng, kitBases);
    for (const item of kit) this.world.objects.set(item.id, item);
    const weapon = kit.find((item) => item.flags.weapon);
    const armour = kit.find((item) => item.flags.armour);
    if (weapon) this.player.weaponWielded = weapon.id;
    if (armour) {
      armour.flags.worn = true;
      this.player.armourWorn = armour.id;
    }
    this.pendingDefeat = by;
  }

  /**
   * Steps 8-12. Runs every turn, whatever the player did.
   *
   * Light is the only depletion in the world at this step, and it is the one
   * that makes exploration a budget: a torch is sixty turns of somewhere to be.
   */
  private worldHalf(): Line[] {
    const lines: Line[] = [];
    const ticks = 1 + this.owedTurns;
    this.owedTurns = 0;
    this.turn += ticks;

    const effects: Effect[] = [];
    const warnAt = lightWarnAt(this.campaign);

    // Lights burn where the player can see them burn: carried, or in the room
    // they are standing in. A torch left lit three rooms back is not the
    // world's problem until something is there to watch it.
    const burning = [
      ...this.world.contentsOf(IN_PLAYER).objects,
      ...this.world.objectsIn(this.player.roomId),
    ].filter((object) => object.flags.lit && object.burnRemaining > 0);

    for (const object of burning) {
      const left = Math.max(0, object.burnRemaining - ticks);
      effects.push({ kind: 'setBurn', id: object.id, turns: left });
      if (left === 0) {
        effects.push({ kind: 'setObjectFlag', id: object.id, flag: 'lit', value: false });
        lines.push(line(`The ${object.name} gutters out.`, 'warn'));
      } else if (left <= warnAt && object.burnRemaining > warnAt) {
        lines.push(line(`Your ${object.name} is guttering. ${left} turns of light left.`, 'warn'));
      }
    }

    // Movers — the enemy round. The creatures the player is fighting act here,
    // in the world half, because that is where everything that is not the
    // player has always moved. Their effects land at the write point below.
    if (this.combat.active && hostilesIn(this.world, this.player.roomId).length > 0) {
      const round = enemyRound(this.combatContext());
      lines.push(...round.lines);
      effects.push(...round.effects);
    }

    // Quests settle in the world half: an objective the player just satisfied
    // becomes a completed quest and a paid reward, and a giver who has died
    // takes their unfinished work down with them.
    const quests = this.questEffects();
    effects.push(...quests.effects);
    lines.push(...quests.lines);

    // ── step 12: the world half's one write point ────────────────────
    this.apply(effects);

    // A fight is over the moment the last hostile is down or gone. End it here,
    // once the writes have landed, so the next turn is an ordinary one.
    if (this.combat.active && !this.pendingDefeat && hostilesIn(this.world, this.player.roomId).length === 0) {
      this.apply([{ kind: 'combat', op: { t: 'end' } }]);
      lines.push(line('The way is clear.', 'ok'));
    }

    lines.push(...this.lightFailure());
    return lines;
  }

  /**
   * Evaluate every active quest against the world as it now stands. Pure — it
   * only reads — and returns the effects the write point will apply, so the two
   * write points stay the only places state changes.
   */
  private questEffects(): { lines: Line[]; effects: Effect[] } {
    const lines: Line[] = [];
    const effects: Effect[] = [];
    const ctx: QuestCheckContext = {
      playerRoomId: this.player.roomId,
      carriedIds: this.carriedIds(),
      npcs: this.world.npcs,
      flags: this.world.flags,
    };
    for (const quest of this.world.activeQuests()) {
      const giver = this.world.npcs.get(quest.giverNpcId);
      if (!giver || giver.location === null) {
        effects.push({ kind: 'failQuest', questId: quest.id });
        lines.push(line(`With the one who asked now gone, the ${quest.type} will go unpaid.`, 'warn'));
        continue;
      }
      const objectives = this.world.objectivesOf(quest);
      if (objectives.length > 0 && objectives.every((objective) => objectiveComplete(ctx, objective))) {
        effects.push({ kind: 'completeQuest', questId: quest.id });
        lines.push(line(`Quest done: the ${quest.type}. Your reward is in hand.`, 'ok'));
      }
    }
    return { lines, effects };
  }

  /** Every object the player carries, pockets and the containers in them alike. */
  private carriedIds(): Set<string> {
    const seen = new Set<string>();
    const walk = (location: string): void => {
      for (const object of this.world.contentsOf(location).objects) {
        if (seen.has(object.id)) continue;
        seen.add(object.id);
        walk(inObject(object.id) as string);
      }
    };
    walk(IN_PLAYER as string);
    return seen;
  }

  /**
   * Running out of light is not a softlock, it is a forced retreat. The rules
   * name the target and the cost; nothing about it is decided here.
   */
  private lightFailure(): Line[] {
    const room = this.room;
    if (!room.tags.includes('dark') || anyLight(this.world, room.id)) return [];
    if (ruleString(this.campaign.rules, 'LIGHT.onExhausted') !== 'retreatToLit') return [];

    const target = this.retreatTarget(room);
    if (!target || target.id === room.id) {
      return [line('The dark closes in, and there is nowhere lit to fall back to.', 'warn')];
    }

    const cost = ruleNumber(this.campaign.rules, 'LIGHT.retreatCostTurns');
    const goldShare = ruleNumber(this.campaign.rules, 'LIGHT.retreatPenalty.dropsCarriedGold');
    const effects: Effect[] = [
      { kind: 'movePlayer', roomId: target.id },
      { kind: 'visit', roomId: target.id },
      { kind: 'extraTurns', turns: cost },
      { kind: 'hp', delta: -ruleNumber(this.campaign.rules, 'LIGHT.retreatPenalty.hp') },
      { kind: 'libido', delta: ruleNumber(this.campaign.rules, 'LIGHT.retreatPenalty.libido') },
    ];
    const dropped = Math.floor(this.player.purse * goldShare);
    if (dropped > 0) effects.push({ kind: 'purse', delta: -dropped });

    // Still the world half's write point: the retreat is the world acting on
    // the player, not the player acting.
    this.apply(effects);
    const lines = [
      line('You back out of the dark the way you came in, hands on stone.', 'warn'),
      line(`${cost} turns spent getting clear.`, 'rule'),
    ];
    if (dropped > 0) lines.push(line(`${dropped} gold lost in the scramble.`, 'warn'));
    lines.push(...this.describeHere(true));
    return lines;
  }

  /** The nearest lit room by hops, or the area's entrance. Never coordinates. */
  private retreatTarget(from: RoomRecord): RoomRecord | undefined {
    const hops = [...this.world.hopsFrom(from.id).entries()].sort((a, b) => a[1] - b[1]);
    for (const [roomId] of hops) {
      const room = this.world.rooms.get(roomId);
      if (room && room.id !== from.id && !room.tags.includes('dark')) return room;
    }
    const area = this.world.areas.get(from.areaId);
    return area?.entryRoomId ? this.world.rooms.get(area.entryRoomId) : undefined;
  }

  // ── bookkeeping ───────────────────────────────────────────────────

  private finish(
    raw: string,
    lines: Line[],
    spent: boolean,
    extra?: Pick<TurnResult, 'voice' | 'tier2'>,
  ): TurnResult {
    this.transcript.push({
      turn: this.turn,
      input: raw,
      output: lines
        .filter((entry) => entry.kind !== 'echo')
        .map((entry) => entry.text)
        .join('\n'),
    });
    return { lines, turn: this.turn, spent, ...extra };
  }

  /**
   * Fills in an NPC's spoken reply once the async voice call resolves, into
   * the transcript entry `finish()` already wrote with the generic stub line.
   * Called only from main.ts's narration edge, after the mechanical turn is
   * already done and saved — transcript is narration-only context (read by
   * no game logic, only by the next narrator prompt), never state the engine
   * reads, so this is not a third write point in the rule 1 sense.
   */
  appendVoiceLine(turn: number, text: string): void {
    for (let i = this.transcript.length - 1; i >= 0; i -= 1) {
      const entry = this.transcript[i];
      if (entry && entry.turn === turn) {
        entry.output = `${entry.output}\n"${text}"`;
        return;
      }
    }
  }

  /** The status line's numbers, in one place so the UI derives nothing. */
  status(): Record<string, string> {
    const ctx = this.context();
    const light = anyLight(this.world, this.player.roomId);
    const foes = this.combat.active ? hostilesIn(this.world, this.player.roomId).length : 0;
    return {
      name: this.player.name,
      hp: `${this.player.hp}/${playerMaxHp(this.campaign, this.player)}`,
      resolve: `${this.player.resolve}/${playerMaxResolve(this.campaign, this.player)}`,
      libido: String(this.player.libido),
      turn: String(this.turn),
      load: String(carriedWeight(ctx)),
      light: light ? `${light.burnRemaining}` : '—',
      where: this.room.id,
      gold: String(this.player.purse),
      foes: String(foes),
    };
  }
}

/** Objects the player is carrying. Used by the UI and by the tests alike. */
export const carriedObjects = (game: Game): ObjectRecord[] =>
  game.world.contentsOf(IN_PLAYER).objects;

export const objectsHere = (game: Game): ObjectRecord[] =>
  game.world.contentsOf(inRoom(game.player.roomId)).objects;

/** The string members of a rules array — `DEFEAT.lose`, the starter kit list. */
const ruleStrings = (rules: Parameters<typeof ruleArray>[0], path: string): string[] =>
  ruleArray(rules, path).filter((entry): entry is string => typeof entry === 'string');
