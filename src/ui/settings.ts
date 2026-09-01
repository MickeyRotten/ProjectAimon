/**
 * The settings overlay: the API key and the two model slots.
 *
 * The key is the player's own and lives only on this device, so it is entered
 * through a password field and never printed to the log — a secret must not
 * scroll past in the transcript. Saving normalises through `settings.ts` and
 * hands the result back, so the running game can rebuild its narrator without a
 * reload.
 *
 * Presentation only. It writes to `localStorage` (through the callback's owner)
 * and to nothing else in the game.
 */

import { DEFAULT_SETTINGS, type NarratorSettings } from '../narrator/settings';

export interface SettingsPanel {
  open(): void;
}

export function mountSettings(
  root: HTMLElement,
  current: () => NarratorSettings,
  onSave: (settings: NarratorSettings) => void,
): SettingsPanel {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <form class="settings-box" novalidate>
      <h2>Narrator</h2>
      <p class="settings-note">Your OpenRouter API key stays on this device. It is
        sent only to OpenRouter, and never appears in the log or a save.</p>
      <label>OpenRouter API key
        <input type="password" name="apiKey" autocomplete="off" spellcheck="false"
               placeholder="sk-or-…"></label>
      <label>Narrator model <span class="settings-hint">prose quality</span>
        <input type="text" name="narratorModel" autocomplete="off" spellcheck="false"></label>
      <label>Translator model <span class="settings-hint">cheap and fast</span>
        <input type="text" name="translatorModel" autocomplete="off" spellcheck="false"></label>
      <label>Temperature
        <input type="number" name="temperature" min="0" max="2" step="0.1"></label>
      <label>Reply cap (tokens)
        <input type="number" name="maxTokens" min="1" max="4000" step="50"></label>
      <div class="settings-actions">
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" data-act="save">Save</button>
      </div>
    </form>`;
  root.appendChild(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const field = (name: keyof NarratorSettings): HTMLInputElement =>
    form.elements.namedItem(name) as HTMLInputElement;

  const load = (): void => {
    const settings = current();
    field('apiKey').value = settings.apiKey;
    field('narratorModel').value = settings.narratorModel;
    field('translatorModel').value = settings.translatorModel;
    field('temperature').value = String(settings.temperature);
    field('maxTokens').value = String(settings.maxTokens);
  };

  const close = (): void => {
    overlay.hidden = true;
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('[data-act="cancel"]') as HTMLElement).addEventListener('click', close);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    onSave({
      apiKey: field('apiKey').value,
      narratorModel: field('narratorModel').value || DEFAULT_SETTINGS.narratorModel,
      translatorModel: field('translatorModel').value || DEFAULT_SETTINGS.translatorModel,
      temperature: Number(field('temperature').value),
      maxTokens: Number(field('maxTokens').value),
    });
    close();
  });

  return {
    open() {
      load();
      overlay.hidden = false;
      field('apiKey').focus();
    },
  };
}
