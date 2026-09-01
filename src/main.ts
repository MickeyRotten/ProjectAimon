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
import { Game } from './game/game';
import {
  AUTOSAVE_ID,
  browserSaveStore,
  openSave,
  parseSaveCommand,
  recordOf,
  snapshotId,
  type SaveStore,
} from './game/save';
import { mountScreen, type Screen } from './ui/screen';
import { mountSettings } from './ui/settings';
import { openRouterClient } from './narrator/llm';
import { loadSettings, saveSettings, type NarratorSettings } from './narrator/settings';
import { RoomNarrator } from './narrator/rooms';

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

  // The narrator: rebuilt whenever the key or a model changes. Absent until a
  // key is set, and the game runs on placeholder text until then.
  let settings = loadSettings();
  let narrator = makeNarrator();

  function makeNarrator(): RoomNarrator | undefined {
    if (!settings.apiKey) return undefined;
    const client = openRouterClient({
      apiKey: settings.apiKey,
      appTitle: 'Aimon',
      ...(typeof location !== 'undefined' ? { appUrl: location.origin } : {}),
    });
    return new RoomNarrator({ campaign, client, settings });
  }

  const screen: Screen = mountScreen(root, (raw) => handle(raw), {
    onSettings: () => settingsPanel.open(),
  });
  const settingsPanel = mountSettings(
    document.body,
    () => settings,
    (next: NarratorSettings) => {
      settings = saveSettings(next);
      narrator = makeNarrator();
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

    const result = game.submit(raw);
    screen.print(result.lines);
    screen.refresh(game);
    // Step 15: persist. One write point, once per turn that was actually spent.
    if (result.spent) await store.put(recordOf(game, 'auto', 'autosave'));
    // Steps 13-14 for the room: the narrator writes prose over the world the
    // turn already resolved. It changes no state the engine reads, so it runs
    // after the mechanical turn is done and saved, never inside it.
    void narrateHere();
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
