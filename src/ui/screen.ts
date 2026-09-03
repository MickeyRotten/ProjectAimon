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
import { mapModel, type MapModel } from '../world/map';
import { sentenceList, viewRoom } from '../game/describe';

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

/**
 * Paint a map model into a grid element — room cells on the odd tracks,
 * connectors on the even ones. Shared by the always-on mini-map and the full
 * MAP overlay; the two differ only in cell size, set by CSS on the element.
 */
function paintGrid(grid: HTMLElement, model: MapModel): void {
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
    el.className = `mconn m-${connector.dir}${connector.stub ? ' stub' : ''}${connector.crossesArea ? ' area-gate' : ''}`;
    el.style.gridColumn = String(connector.gc + 1);
    el.style.gridRow = String(connector.gr + 1);
    children.push(el);
  }
  grid.replaceChildren(...children);
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
  /**
   * The full-screen "entering a new area" loader, shown over the one batch call
   * that writes the area's descriptions so nothing pops in. `showAreaLoader`
   * reveals it, `setAreaLoaderStage` advances the bar and status text, and
   * `hideAreaLoader` dismisses it.
   */
  showAreaLoader(title: string): void;
  setAreaLoaderStage(pct: number, status: string): void;
  hideAreaLoader(): void;
  /** Open the full-floor map overlay for the given model (or an empty state). */
  showMapOverlay(model: MapModel | undefined): void;
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
    </div>
    <div class="map-overlay" id="mapoverlay" role="dialog" aria-label="Map" aria-modal="true" hidden>
      <div class="map-panel" id="mappanel" tabindex="-1">
        <div class="map-head">
          <span class="map-title" id="maptitle"></span>
          <button class="map-close" id="mapclose" aria-label="Close map">✕</button>
        </div>
        <div class="map-scroll"><div class="gridmap big" id="mapfull"></div></div>
        <div class="map-legend">
          <span><i class="mcell m-here">▣</i> here</span>
          <span><i class="mcell m-visited">□</i> walked</span>
          <span><i class="mcell m-frontier">?</i> unexplored</span>
          <span><i class="mcell m-gate">▨</i> way out</span>
          <span><i class="mswatch area-gate"></i> area gate</span>
        </div>
      </div>
    </div>
    <div class="area-loader" id="arealoader" role="status" aria-live="polite" hidden>
      <div class="area-loader-panel">
        <p class="area-loader-title" id="loadtitle"></p>
        <div class="area-loader-track"><div class="area-loader-bar" id="loadbar"></div></div>
        <p class="area-loader-status" id="loadstatus"></p>
      </div>
    </div>`;

  const log = root.querySelector('#log') as HTMLElement;
  const prompt = root.querySelector('#promptline') as HTMLElement;
  const input = root.querySelector('#in') as HTMLInputElement;
  const history: string[] = [];
  let cursor = 0;
  // True while an LLM call for the current turn is in flight. Blocks new
  // input so a second command can't land while the first is still resolving.
  let busy = false;

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
    // The top pane is the one place the description lives: the room's baseDesc
    // (authored for the Hub, batch-generated for the rest, or the structural
    // placeholder until then), plus a plain line for whatever is standing here
    // now. Contents change turn to turn, so they are listed rather than woven.
    const here = !view.dark && view.contents.length > 0 ? ` Here: ${sentenceList(view.contents)}.` : '';
    const rdesc = root.querySelector('#rdesc') as HTMLElement;
    rdesc.className = 'rdesc'; // clear any bouncing pending state
    (root.querySelector('#rname') as HTMLElement).textContent = view.name;
    rdesc.textContent = `${view.desc}${here}`;
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
    paintGrid(grid, model);
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

  // The full-floor MAP overlay: the same grid renderer at a larger scale, over
  // a backdrop. Dismissed by the close button, a backdrop click, or Escape.
  const mapOverlay = root.querySelector('#mapoverlay') as HTMLElement;
  const closeMap = (): void => {
    mapOverlay.hidden = true;
    input.focus();
  };
  (root.querySelector('#mapclose') as HTMLElement).addEventListener('click', closeMap);
  mapOverlay.addEventListener('click', (event) => {
    if (event.target === mapOverlay) closeMap();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !mapOverlay.hidden) closeMap();
  });

  const showMapOverlay = (model: MapModel | undefined): void => {
    const title = root.querySelector('#maptitle') as HTMLElement;
    const grid = root.querySelector('#mapfull') as HTMLElement;
    if (!model) {
      title.textContent = 'Map — nothing walked yet';
      grid.replaceChildren();
    } else {
      title.textContent = `${model.areaName} (${model.floorLabel})`;
      paintGrid(grid, model);
    }
    mapOverlay.hidden = false;
    // Focus the dialog itself, not the close button: the same Enter keypress
    // that ran MAP would land its keyup on a focused button and fire it,
    // closing the overlay the instant it opened. A div never activates.
    (root.querySelector('#mappanel') as HTMLElement).focus();
  };

  // The full-screen "entering a new area" loader. It sits over the single batch
  // call that writes the area's descriptions, so the player is briefly at the
  // threshold rather than dropped into blank rooms that then pop in. A lone
  // OpenRouter call is opaque, so the bar moves through named stages rather than
  // a true percentage — enough to read as progress.
  const loader = root.querySelector('#arealoader') as HTMLElement;
  const loadBar = root.querySelector('#loadbar') as HTMLElement;
  const setAreaLoaderStage = (pct: number, status: string): void => {
    loadBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    (root.querySelector('#loadstatus') as HTMLElement).textContent = status;
  };
  const showAreaLoader = (title: string): void => {
    (root.querySelector('#loadtitle') as HTMLElement).textContent = title;
    setAreaLoaderStage(10, 'Mapping the area…');
    loader.hidden = false;
  };
  const hideAreaLoader = (): void => {
    loader.hidden = true;
  };

  const setBusy = (active: boolean): void => {
    busy = active;
    input.disabled = active;
    (root.querySelector('#caret') as HTMLElement).textContent = active ? '…' : '>';
    prompt.classList.toggle('busy', active);
  };

  return {
    print,
    printPending,
    refresh,
    focus: () => input.focus(),
    showAreaLoader,
    setAreaLoaderStage,
    hideAreaLoader,
    showMapOverlay,
    setBusy,
  };
}
