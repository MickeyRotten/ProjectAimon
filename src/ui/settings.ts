/**
 * The settings overlay: the API key and the two model slots.
 *
 * The key is the player's own and lives only on this device, so it is entered
 * through a password field and never printed to the log — a secret must not
 * scroll past in the transcript. Saving normalises through `settings.ts` and
 * hands the result back, so the running game can rebuild its narrator without a
 * reload.
 *
 * The two model slots are dropdowns filled from OpenRouter's public catalogue
 * (`narrator/models.ts`), so a typo cannot quietly disable the narrator. That
 * fetch needs no key and is allowed to fail: the slots fall back to plain text
 * fields holding whatever is already configured.
 *
 * Presentation only. It writes to `localStorage` (through the callback's owner)
 * and to nothing else in the game.
 */

import { DEFAULT_SETTINGS, type NarratorSettings } from '../narrator/settings';
import { fetchModels, priceLabel, type ModelInfo } from '../narrator/models';

export interface SettingsPanel {
  open(): void;
}

type Slot = 'narratorModel' | 'translatorModel';

const SLOTS: Slot[] = ['narratorModel', 'translatorModel'];

export function mountSettings(
  root: HTMLElement,
  current: () => NarratorSettings,
  onSave: (settings: NarratorSettings) => void,
  onRestart: () => void,
  options: { loadModels?: () => Promise<ModelInfo[]> } = {},
): SettingsPanel {
  const loadModels = options.loadModels ?? ((): Promise<ModelInfo[]> => fetchModels());

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
        <select name="narratorModel"></select>
        <input type="text" name="narratorModelText" autocomplete="off" spellcheck="false" hidden></label>
      <label>Translator model <span class="settings-hint">cheap and fast</span>
        <select name="translatorModel"></select>
        <input type="text" name="translatorModelText" autocomplete="off" spellcheck="false" hidden></label>
      <p class="settings-note" data-role="models"></p>
      <label>Temperature <span class="settings-hint" data-role="temp"></span>
        <input type="range" name="temperature" min="0" max="2" step="0.05"></label>
      <label>Reply cap (tokens)
        <input type="number" name="maxTokens" min="1" max="4000" step="50"></label>
      <div class="settings-actions">
        <button type="button" data-act="cancel">Cancel</button>
        <button type="submit" data-act="save">Save</button>
      </div>
      <hr class="settings-divider">
      <p class="settings-note">Restart Adventure wipes your save — the world, your
        character, every snapshot — and starts over. Your API key and model
        settings are kept.</p>
      <div class="settings-actions">
        <button type="button" data-act="restart">Restart Adventure</button>
      </div>
    </form>`;
  root.appendChild(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const el = <T extends HTMLElement>(name: string): T =>
    form.elements.namedItem(name) as unknown as T;
  const tempOut = overlay.querySelector('[data-role="temp"]') as HTMLElement;
  const modelNote = overlay.querySelector('[data-role="models"]') as HTMLElement;

  let models: ModelInfo[] | undefined;
  let fetching = false;

  el<HTMLInputElement>('temperature').addEventListener('input', () => {
    tempOut.textContent = Number(el<HTMLInputElement>('temperature').value).toFixed(2);
  });

  /** The value of a slot, read from whichever control is currently showing. */
  const slotValue = (slot: Slot): string => {
    const select = el<HTMLSelectElement>(slot);
    return select.hidden ? el<HTMLInputElement>(`${slot}Text`).value.trim() : select.value;
  };

  const setSlot = (slot: Slot, value: string): void => {
    el<HTMLInputElement>(`${slot}Text`).value = value;
    const select = el<HTMLSelectElement>(slot);
    select.innerHTML = '';
    if (!models) {
      // Before the catalogue arrives the dropdown still has to hold the saved
      // value, so a save made in that window keeps the model it was showing.
      if (value) select.append(new Option(value, value));
      select.value = value;
      return;
    }
    // A model configured on an older build, or since withdrawn, must stay
    // selectable — it is pinned to the top rather than silently swapped out.
    if (value && !models.some((model) => model.id === value)) {
      select.append(new Option(`${value} (not listed)`, value));
    }
    let group: HTMLOptGroupElement | undefined;
    for (const model of models) {
      if (!group || group.label !== model.vendor) {
        group = document.createElement('optgroup');
        group.label = model.vendor;
        select.append(group);
      }
      group.append(new Option(`${model.name}${priceLabel(model)}`, model.id));
    }
    select.value = value;
  };

  /** Swap both slots to plain text when the catalogue cannot be read. */
  const useTextSlots = (message: string): void => {
    for (const slot of SLOTS) {
      const value = slotValue(slot);
      el<HTMLSelectElement>(slot).hidden = true;
      const text = el<HTMLInputElement>(`${slot}Text`);
      text.hidden = false;
      text.value = value;
    }
    modelNote.textContent = message;
  };

  async function ensureModels(): Promise<void> {
    if (models || fetching) return;
    fetching = true;
    modelNote.textContent = 'Loading the model list from OpenRouter…';
    try {
      const fetched = await loadModels();
      models = fetched;
      modelNote.textContent = `${fetched.length} models listed by OpenRouter.`;
      for (const slot of SLOTS) {
        el<HTMLSelectElement>(slot).hidden = false;
        el<HTMLInputElement>(`${slot}Text`).hidden = true;
        setSlot(slot, slotValue(slot) || current()[slot]);
      }
    } catch {
      useTextSlots('Could not reach OpenRouter — type the model ids instead.');
    } finally {
      fetching = false; // a failure is retried the next time the panel opens
    }
  }

  const load = (): void => {
    const settings = current();
    el<HTMLInputElement>('apiKey').value = settings.apiKey;
    setSlot('narratorModel', settings.narratorModel);
    setSlot('translatorModel', settings.translatorModel);
    el<HTMLInputElement>('temperature').value = String(settings.temperature);
    tempOut.textContent = settings.temperature.toFixed(2);
    el<HTMLInputElement>('maxTokens').value = String(settings.maxTokens);
  };

  const close = (): void => {
    overlay.hidden = true;
  };

  const submit = (): void => {
    const settings: NarratorSettings = {
      apiKey: el<HTMLInputElement>('apiKey').value,
      narratorModel: slotValue('narratorModel') || DEFAULT_SETTINGS.narratorModel,
      translatorModel: slotValue('translatorModel') || DEFAULT_SETTINGS.translatorModel,
      temperature: Number(el<HTMLInputElement>('temperature').value),
      maxTokens: Number(el<HTMLInputElement>('maxTokens').value),
    };
    // The overlay closes first: a throw out of the game's own save handler must
    // never leave the player trapped behind a dialog that will not go away.
    close();
    onSave(settings);
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  (overlay.querySelector('[data-act="cancel"]') as HTMLElement).addEventListener('click', close);
  // Both paths, because a WebView that swallows implicit form submission still
  // delivers the click.
  (overlay.querySelector('[data-act="save"]') as HTMLElement).addEventListener('click', (event) => {
    event.preventDefault();
    submit();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  (overlay.querySelector('[data-act="restart"]') as HTMLElement).addEventListener('click', () => {
    if (!window.confirm('Wipe this save and start over? This cannot be undone.')) return;
    close();
    onRestart();
  });

  return {
    open() {
      load();
      overlay.hidden = false;
      void ensureModels();
      el<HTMLInputElement>('apiKey').focus();
    },
  };
}
