/**
 * The screen: a status line, a map panel, and a log with the prompt in it.
 *
 * Terminal aesthetic, one column, thumb-reachable on a phone. The prompt sits
 * at the end of the log and scrolls with it rather than being pinned to the
 * bottom of the viewport, which is how a terminal behaves and how the mockup
 * in `reference/` reads.
 *
 * The screen knows how to draw a game. It does not know how to play one: it
 * hands input to a callback and prints what comes back. No state is written
 * here, ever.
 */

import type { Line, LineKind } from '../game/commands';
import type { Game } from '../game/game';
import { mapModel } from '../world/map';
import { viewRoom } from '../game/describe';

const CLASSES: Record<LineKind, string> = {
  plain: 'b',
  echo: 'b echo',
  roll: 'b roll',
  warn: 'b warnline',
  ok: 'b ok',
  rule: 'b rule',
  speak: 'b speak',
};

/**
 * Fill an element with one `<span>` per character, each tagged with its index
 * so the CSS can stagger a bounce across the word. They are real characters, so
 * a screen reader still reads the aria-live label as plain text — the motion is
 * decorative only, and never re-announced frame by frame.
 */
function bounceInto(element: HTMLElement, text: string): void {
  element.textContent = '';
  let i = 0;
  for (const ch of text) {
    const span = document.createElement('span');
    // A real space would collapse; a non-breaking one keeps its slot in the wave.
    span.textContent = ch === ' ' ? ' ' : ch;
    span.style.setProperty('--i', String(i));
    element.append(span);
    i += 1;
  }
}

/** Track sizes for the map grid: room cells on odd indices, connectors between. */
function mapTracks(count: number): string {
  return Array.from({ length: count }, (_, i) => (i % 2 === 1 ? 'var(--mroom)' : 'var(--mconn)')).join(' ');
}

/** A placeholder log line, printed while a cosmetic narrator call is in flight. */
export interface PendingLine {
  /** Replace the placeholder with the real line, once narration resolves. */
  resolve(line: Line): void;
  /** Remove the placeholder outright — no narration is coming after all. */
  clear(): void;
}

export interface Screen {
  print(lines: readonly Line[]): void;
  /** Print a dim, unsettled placeholder line the caller can later fill in or drop. */
  printPending(line: Line): PendingLine;
  refresh(game: Game): void;
  focus(): void;
  /** Show the narrator's name and woven prose for a room, until the room changes. */
  setRoomProse(roomId: string, name: string, prose: string): void;
  /**
   * Show a bouncing pending label in the room panel while the room's prose is
   * being generated — the "Generating new area" beat when crossing a gate.
   * Replaced by the next `setRoomProse` or `refresh`.
   */
  setRoomPending(roomId: string, label: string): void;
  /** Lock or unlock input while an LLM call for the current turn is in flight. */
  setBusy(active: boolean): void;
}

export interface ScreenHooks {
  onSettings?: () => void;
}

export function mountScreen(
  root: HTMLElement,
  onInput: (raw: string) => void | Promise<void>,
  hooks: ScreenHooks = {},
): Screen {
  root.innerHTML = `
    <div class="status" role="status">
      <span id="statline">…</span>
      <button class="gear" id="gear" aria-label="Settings" title="Settings">⚙</button>
    </div>
    <div class="panel" id="panel">
      <div class="mapwrap">
        <div class="maplabel" id="maplabel"></div>
        <div class="gridmap" id="mini" role="img" aria-label="Map"></div>
      </div>
      <div class="where">
        <p class="rname" id="rname"></p>
        <p class="rdesc" id="rdesc"></p>
      </div>
    </div>
    <div class="log" id="log" aria-live="polite">
      <p id="promptline">
        <span class="caret" id="caret">&gt;</span>
        <input id="in" autocomplete="off" autocapitalize="off" spellcheck="false"
               aria-label="Enter a command">
        <span class="cursor" aria-hidden="true">█</span>
      </p>
    </div>
    <div class="mono" role="group" aria-label="Monitor">
      <button class="m1" data-m="cga" aria-pressed="true">CGA</button>
      <button class="m2" data-m="amber" aria-pressed="false">Amber</button>
      <button class="m3" data-m="green" aria-pressed="false">Green</button>
    </div>`;

  const log = root.querySelector('#log') as HTMLElement;
  const prompt = root.querySelector('#promptline') as HTMLElement;
  const input = root.querySelector('#in') as HTMLInputElement;
  const history: string[] = [];
  let cursor = 0;
  // True while an LLM call for the current turn is in flight. Blocks new
  // input so a second command can't land while the first is still resolving.
  let busy = false;
  // The narrator's render for the room the player is in. Held so a refresh does
  // not overwrite good prose with the structural placeholder every turn; it is
  // cleared implicitly by moving, when the room id no longer matches.
  let prose: { roomId: string; name: string; text: string } | undefined;

  const print = (lines: readonly Line[]): void => {
    for (const line of lines) {
      const element = document.createElement('p');
      element.className = CLASSES[line.kind] ?? 'b';
      // Map output is drawn text: it needs its whitespace and its own element.
      if (line.text.includes('\n')) element.classList.add('pre');
      element.textContent = line.text;
      log.insertBefore(element, prompt);
    }
    log.scrollTop = log.scrollHeight;
  };

  /**
   * A dim placeholder the caller can fill in or drop once an async narrator
   * call settles — so a cosmetic follow-up in flight reads as "more is
   * coming" rather than as a silent gap that looks like the finished answer.
   * The label's letters bounce (see `bounceInto`), so it reads as busy.
   */
  const printPending = (pendingLine: Line): PendingLine => {
    const element = document.createElement('p');
    element.className = `${CLASSES[pendingLine.kind] ?? 'b'} pending`;
    bounceInto(element, pendingLine.text);
    log.insertBefore(element, prompt);
    log.scrollTop = log.scrollHeight;
    return {
      resolve(finalLine: Line) {
        element.className = CLASSES[finalLine.kind] ?? 'b';
        element.textContent = finalLine.text;
        log.scrollTop = log.scrollHeight;
      },
      clear() {
        element.remove();
      },
    };
  };

  const refresh = (game: Game): void => {
    const status = game.status();
    (root.querySelector('#statline') as HTMLElement).textContent = [
      status['name'],
      `HP ${status['hp']}`,
      `RES ${status['resolve']}`,
      `LIB ${status['libido']}`,
      `GOLD ${status['gold']}`,
      `LOAD ${status['load']}`,
      `LIGHT ${status['light']}`,
      `T ${status['turn']}`,
      ...(status['foes'] && status['foes'] !== '0' ? [`FOES ${status['foes']}`] : []),
    ].join('   ');

    const view = viewRoom(game.world, game.room);
    // Narrator prose wins while it is for this room; otherwise the structural
    // placeholder stands, which is also what shows before narration arrives.
    const showProse = prose && prose.roomId === game.room.id && !view.dark;
    const rdesc = root.querySelector('#rdesc') as HTMLElement;
    rdesc.className = 'rdesc'; // clear any bouncing pending state
    (root.querySelector('#rname') as HTMLElement).textContent = showProse ? prose!.name : view.name;
    rdesc.textContent = showProse ? prose!.text : view.desc;
    renderMap(game);
  };

  /** Draw the mini-map: a small fixed window around the player, one floor. */
  const renderMap = (game: Game): void => {
    const label = root.querySelector('#maplabel') as HTMLElement;
    const grid = root.querySelector('#mini') as HTMLElement;
    const model = mapModel(game.world, game.player.roomId, { radius: 2 });
    if (!model) {
      label.textContent = '';
      grid.replaceChildren();
      return;
    }
    label.textContent = `${model.areaName} (${model.floorLabel})`;
    grid.style.gridTemplateColumns = mapTracks(model.gridCols);
    grid.style.gridTemplateRows = mapTracks(model.gridRows);
    const children: HTMLElement[] = [];
    for (const cell of model.cells) {
      const el = document.createElement('div');
      el.className = `mcell m-${cell.kind}`;
      el.textContent = cell.glyph;
      el.setAttribute('aria-label', cell.label);
      el.style.gridColumn = String(cell.gc + 1);
      el.style.gridRow = String(cell.gr + 1);
      children.push(el);
    }
    for (const connector of model.connectors) {
      const el = document.createElement('div');
      el.className = `mconn m-${connector.dir}${connector.stub ? ' stub' : ''}`;
      el.style.gridColumn = String(connector.gc + 1);
      el.style.gridRow = String(connector.gr + 1);
      children.push(el);
    }
    grid.replaceChildren(...children);
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (busy) return;
      const raw = input.value;
      input.value = '';
      if (raw.trim().length === 0) return;
      history.push(raw);
      cursor = history.length;
      void onInput(raw);
      return;
    }
    // Up and down walk the history, which on a phone is the difference between
    // playing and typing.
    if (event.key === 'ArrowUp' && cursor > 0) {
      cursor -= 1;
      input.value = history[cursor] ?? '';
      event.preventDefault();
    }
    if (event.key === 'ArrowDown' && cursor < history.length) {
      cursor += 1;
      input.value = history[cursor] ?? '';
      event.preventDefault();
    }
  });

  log.addEventListener('click', () => {
    if (!getSelection()?.toString()) input.focus();
  });

  (root.querySelector('#gear') as HTMLElement).addEventListener('click', () => {
    hooks.onSettings?.();
  });

  for (const button of root.querySelectorAll('.mono button')) {
    button.addEventListener('click', () => {
      document.body.dataset['mono'] = (button as HTMLElement).dataset['m'] ?? 'cga';
      for (const other of root.querySelectorAll('.mono button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      input.focus();
    });
  }

  const setRoomProse = (roomId: string, name: string, text: string): void => {
    prose = { roomId, name, text };
    (root.querySelector('#rname') as HTMLElement).textContent = name;
    const rdesc = root.querySelector('#rdesc') as HTMLElement;
    rdesc.className = 'rdesc'; // clears any bouncing pending state
    rdesc.textContent = text;
  };

  /**
   * The "Generating new area" beat: a bouncing label in the room panel while
   * the crossed-into area's prose is written. Dropping the held prose means the
   * next refresh won't flash stale text back over the loader.
   */
  const setRoomPending = (_roomId: string, label: string): void => {
    prose = undefined;
    const rdesc = root.querySelector('#rdesc') as HTMLElement;
    rdesc.className = 'rdesc pending';
    bounceInto(rdesc, label);
  };

  const setBusy = (active: boolean): void => {
    busy = active;
    input.disabled = active;
    (root.querySelector('#caret') as HTMLElement).textContent = active ? '…' : '>';
    prompt.classList.toggle('busy', active);
  };

  return { print, printPending, refresh, focus: () => input.focus(), setRoomProse, setRoomPending, setBusy };
}
