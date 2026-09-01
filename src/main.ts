/**
 * Boot.
 *
 * Steps 1 to 3 built the tables, the graph and the placement roller, and the
 * page showed a debug dump because there was nothing to play. This is step 4,
 * the honest checkpoint: a character, a world, movement across the room graph,
 * a map of what has been walked, an inventory that is a query over one field,
 * and an autosave written once per turn at the end of the world half.
 *
 * The text is placeholder on purpose. The narrator is step 7, and the question
 * this step exists to answer is whether walking a generated area is worth
 * doing before any prose exists at all.
 */

import './app.css';
import { loadCampaign } from './campaign/loader';
import { formatReport } from './campaign/validate';
import { line, type Line } from './game/commands';
import { Game, type TurnResult } from './game/game';
import {
  AUTOSAVE_ID,
  browserSaveStore,
  openSave,
  parseSaveCommand,
  recordOf,
  snapshotId,
  type SaveStore,
} from './game/save';
import { legalAttempt } from './game/tier2';
import { mountScreen, type Screen } from './ui/screen';
import { mountSettings } from './ui/settings';
import { openRouterClient } from './narrator/llm';
import { NpcNarrator } from './narrator/npcs';
import { OutcomeNarrator } from './narrator/outcome';
import { RoomNarrator } from './narrator/rooms';
import { loadSettings, saveSettings, type NarratorSettings } from './narrator/settings';
import { Translator } from './narrator/translate';
import { VoiceNarrator } from './narrator/voices';

async function boot(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const { campaign, report } = await loadCampaign({ tolerateErrors: true });
  const store: SaveStore = browserSaveStore();
  const params = new URLSearchParams(location.search);

  let game: Game;
  const banner: Line[] = [
    line(`Aimon — ${campaign.manifest.name} v${campaign.manifest.version}`, 'ok'),
  ];
  if (report.errors.length > 0) {
    banner.push(line(formatReport(report), 'warn'));
  }

  // The autosave is the active slot, so returning to the tab returns to the
  // game. `?new=1` starts a fresh one, `?seed=` names the world.
  const existing = params.has('new') ? undefined : await store.get(AUTOSAVE_ID(campaign.id));
  if (existing) {
    const opened = openSave(campaign, existing);
    game = opened.game;
    for (const note of opened.notes) banner.push(line(note, 'warn'));
    banner.push(line(`Resumed at turn ${game.turn}.`, 'rule'));
  } else {
    const seed = params.get('seed') ?? `saltmere-${Date.now().toString(36)}`;
    game = Game.begin({
      campaign,
      seed,
      name: params.get('name') ?? 'Adventurer',
      ...(params.get('archetype') ? { archetype: params.get('archetype') as string } : {}),
    });
    banner.push(line(`New world, seed ${seed}.`, 'rule'));
    banner.push(line('HELP lists the verbs. Move with n s e w u d.', 'rule'));
  }

  // The narrator's jobs, all built from the same client and rebuilt together
  // whenever the key or a model changes. Absent until a key is set, and the
  // game runs on placeholder text and the bare Tier 1 parser error until then.
  let settings = loadSettings();
  let narrator: RoomNarrator | undefined;
  let translator: Translator | undefined;
  let voices: VoiceNarrator | undefined;
  let outcome: OutcomeNarrator | undefined;
  let npcAppearance: NpcNarrator | undefined;
  makeNarrators();

  function makeNarrators(): void {
    if (!settings.apiKey) {
      narrator = undefined;
      translator = undefined;
      voices = undefined;
      outcome = undefined;
      npcAppearance = undefined;
      return;
    }
    const client = openRouterClient({
      apiKey: settings.apiKey,
      appTitle: 'Aimon',
      ...(typeof location !== 'undefined' ? { appUrl: location.origin } : {}),
    });
    const deps = { campaign, client, settings };
    narrator = new RoomNarrator(deps);
    translator = new Translator(deps);
    voices = new VoiceNarrator(deps);
    outcome = new OutcomeNarrator(deps);
    npcAppearance = new NpcNarrator(deps);
  }

  // Locks input only while the just-typed command is still being resolved —
  // the Tier 2/3 translation that decides what the command *was*. Voicing,
  // outcome prose and room prose are cosmetic follow-ups printed after the
  // mechanical turn already finished and is on screen; they run alongside
  // whatever the player types next rather than blocking it. (A network stall
  // during one of those used to freeze the whole input box for up to a
  // minute — narrateHere already tolerates the player moving on before its
  // prose arrives, so there is no correctness reason to lock for it.)
  let pendingLlmCalls = 0;
  function track<T>(work: Promise<T>): Promise<T> {
    pendingLlmCalls += 1;
    if (pendingLlmCalls === 1) screen.setBusy(true);
    return work.finally(() => {
      pendingLlmCalls -= 1;
      if (pendingLlmCalls === 0) screen.setBusy(false);
    });
  }

  const screen: Screen = mountScreen(root, (raw) => handle(raw), {
    onSettings: () => settingsPanel.open(),
  });
  const settingsPanel = mountSettings(
    document.body,
    () => settings,
    (next: NarratorSettings) => {
      settings = saveSettings(next);
      makeNarrators();
      screen.print([line(narrator ? 'Narrator on.' : 'Narrator off — no API key set.', 'rule')]);
      void narrateHere();
    },
  );

  screen.print(banner);
  if (!settings.apiKey) {
    screen.print([line('No narrator yet — open ⚙ to add an OpenRouter key. The world plays without one.', 'rule')]);
  }
  screen.print(game.describeHere(true));
  screen.refresh(game);
  screen.focus();
  void narrateHere();

  async function handle(raw: string): Promise<void> {
    // Storage is asynchronous and the turn loop is not, so saving is answered
    // here, at the edge, rather than from inside a command handler.
    const saveCommand = parseSaveCommand(raw, campaign.verbs);
    if (saveCommand) {
      screen.print([line(raw, 'echo'), ...(await runSave(saveCommand.verb, saveCommand.label))]);
      screen.refresh(game);
      return;
    }

    // Step 2, then step 3: the ladder only ever runs outside combat, and
    // `plan()` is called exactly once — calling it twice would silently drop
    // a pending disambiguation answer the second time.
    const result = game.inCombat() ? game.submit(raw) : await track(stepThrough(raw));

    screen.print(result.lines);
    screen.refresh(game);
    // Step 15: persist. One write point, once per turn that was actually spent.
    if (result.spent) await store.put(recordOf(game, 'auto', 'autosave'));

    // Steps 13-14: prose over the world the turn already resolved. Neither
    // changes state the engine reads, so both run after the mechanical turn
    // is done and saved, never inside it.
    if (result.voice) void narrateVoice(raw, result.voice);
    else if (result.tier2) void narrateOutcome(raw, result.lines, result.tier2);
    if (result.appearance) void narrateAppearance(result.appearance);
    void narrateHere();
  }

  /** Step 3: on a Tier 1 miss, try the translator, then Tier 2, then Tier 3. */
  async function stepThrough(raw: string): Promise<TurnResult> {
    const plan = game.plan(raw);
    if (plan.kind !== 'unparsed' || !translator) return game.respond(raw, plan);

    const ctx = game.context();
    const roomId = game.room.id;

    const translated = await translator.toCommand(raw, roomId, ctx.scope, campaign.verbs);
    if (translated) return game.run(raw, translated);

    const classified = await translator.classify(raw, roomId, ctx.scope);
    const attempt = classified ? legalAttempt(campaign.rules, ctx.scope, classified) : undefined;
    if (attempt) return game.resolveTier2(raw, attempt);

    return game.tier3(raw);
  }

  /**
   * The NPC's spoken reply to `talk`, `ask`, `tell` or `say`. Fire-and-forget
   * from `handle()`, so the player is free to type on before this resolves —
   * drop the reply if they've left the room by the time it lands, the same
   * staleness guard `narrateHere` uses, so a late line never turns up out of
   * context.
   */
  async function narrateVoice(raw: string, target: { npcId: string; topic: string }): Promise<void> {
    if (!voices) return;
    const npc = game.world.npcs.get(target.npcId);
    if (!npc) return;
    const roomId = game.room.id;
    const turn = game.turn; // finish() already wrote this turn's stub entry
    try {
      const reply = await voices.speak(npc, raw, target.topic, game.transcript);
      game.appendVoiceLine(turn, reply);
      if (game.room.id !== roomId) return; // moved while we waited
      screen.print([line(`"${reply}"`, 'speak')]);
    } catch {
      // A voicing failure never breaks play; the mechanical lines already stand.
    }
  }

  /**
   * A physique/outfit line for an NPC just EXAMINEd. Fire-and-forget, same
   * staleness guard as `narrateVoice` and `narrateHere`: dropped if the NPC
   * is no longer in scope by the time it lands.
   */
  async function narrateAppearance(target: { npcId: string }): Promise<void> {
    if (!npcAppearance) return;
    const npc = game.world.npcs.get(target.npcId);
    if (!npc) return;
    const roomId = game.room.id;
    try {
      const prose = await npcAppearance.describeAppearance(game.world, npc);
      if (!prose) return;
      if (game.room.id !== roomId) return; // moved while we waited
      screen.print([line(prose)]);
    } catch {
      // A failure here never breaks play; the persona line already stands.
    }
  }

  /**
   * Prose over a Tier 2 outcome — the roll and effect already happened.
   * `outcome.narrate` always resolves to some truthful line (it degrades
   * internally the same way the room and voice narrators do), so the player
   * is never left with just the roll number.
   */
  async function narrateOutcome(raw: string, mechanicalLines: Line[], result: 'success' | 'failure'): Promise<void> {
    if (!outcome) return;
    const area = game.world.areas.get(game.room.areaId);
    const roomId = game.room.id;
    try {
      const prose = await outcome.narrate({
        areaName: area?.name ?? game.room.areaId,
        areaTone: area?.themeTokens.join(', ') ?? '',
        history: game.transcript,
        roomName: game.room.name,
        roomDesc: game.room.baseDesc,
        facts: mechanicalLines.filter((entry) => entry.kind === 'roll').map((entry) => entry.text),
        raw,
        outcome: result,
      });
      if (game.room.id !== roomId) return; // moved while we waited
      screen.print([line(prose)]);
    } catch {
      // Belt-and-braces: narrate() degrades internally and should not throw,
      // but the mechanical roll line already stands regardless.
    }
  }

  /**
   * Ask the narrator to describe the room the player is in, and show it. Never
   * blocks the turn loop; captures the room first and drops the result if the
   * player has moved on by the time prose comes back. A baseDesc written on
   * first entry is persisted, so it is generated once and never again.
   */
  async function narrateHere(): Promise<void> {
    if (!narrator) return;
    const room = game.room;
    try {
      const rendered = await narrator.describe(game.world, room);
      if (!rendered) return;
      if (game.room.id !== room.id) return; // moved while we waited
      screen.setRoomProse(room.id, rendered.name, rendered.prose);
      await store.put(recordOf(game, 'auto', 'autosave'));
    } catch {
      // A narrator failure never breaks play; the placeholder text stands.
    }
  }

  async function runSave(verb: 'save' | 'load', label: string): Promise<Line[]> {
    if (verb === 'save') {
      if (!label) return [line('SAVE <name> — name the snapshot.', 'rule')];
      await store.put(recordOf(game, 'snapshot', label));
      return [line(`Saved as "${label}".`, 'ok')];
    }
    const record = label
      ? await store.get(snapshotId(label))
      : await store.get(AUTOSAVE_ID(campaign.id));
    if (!record) return [line(`No save called "${label || 'autosave'}".`, 'warn')];
    const opened = openSave(campaign, record);
    game = opened.game;
    return [
      ...opened.notes.map((note) => line(note, 'warn')),
      line(`Loaded "${record.label}" at turn ${game.turn}.`, 'ok'),
      ...game.describeHere(true),
    ];
  }
}

void boot().catch((error: unknown) => {
  const root = document.getElementById('app') as HTMLElement;
  root.innerHTML = `<pre class="err">boot failed\n${String(error)}</pre>`;
});
