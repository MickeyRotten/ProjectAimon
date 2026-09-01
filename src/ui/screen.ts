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
import { renderPlayerMap } from '../world/map';
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

export interface Screen {
  print(lines: readonly Line[]): void;
  refresh(game: Game): void;
  focus(): void;
}

export function mountScreen(
  root: HTMLElement,
  onInput: (raw: string) => void | Promise<void>,
): Screen {
  root.innerHTML = `
    <div class="status" role="status"><span id="statline">…</span></div>
    <div class="panel" id="panel">
      <pre class="map" id="mini" aria-label="Map"></pre>
      <div class="where">
        <p class="rname" id="rname"></p>
        <p class="rdesc" id="rdesc"></p>
      </div>
    </div>
    <div class="log" id="log" aria-live="polite">
      <p id="promptline">
        <span class="caret">&gt;</span>
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

  const refresh = (game: Game): void => {
    const status = game.status();
    (root.querySelector('#statline') as HTMLElement).textContent = [
      status['name'],
      `HP ${status['hp']}`,
      `GOLD ${status['gold']}`,
      `LOAD ${status['load']}`,
      `LIGHT ${status['light']}`,
      `T ${status['turn']}`,
    ].join('   ');

    const view = viewRoom(game.world, game.room);
    (root.querySelector('#rname') as HTMLElement).textContent = view.name;
    (root.querySelector('#rdesc') as HTMLElement).textContent = view.desc;
    (root.querySelector('#mini') as HTMLElement).textContent = renderPlayerMap(
      game.world,
      game.player.roomId,
      { radius: 3 },
    );
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
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

  for (const button of root.querySelectorAll('.mono button')) {
    button.addEventListener('click', () => {
      document.body.dataset['mono'] = (button as HTMLElement).dataset['m'] ?? 'cga';
      for (const other of root.querySelectorAll('.mono button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      input.focus();
    });
  }

  return { print, refresh, focus: () => input.focus() };
}
