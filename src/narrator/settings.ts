/**
 * Player settings — the API key and the two model slots.
 *
 * The data model names exactly two slots: a **Narrator**, chosen for prose, and
 * a **Translator**, chosen for being cheap and fast (the Tier 1 parse fallback
 * and the Tier 2 classifier land there in part two). The key is the player's
 * own, so it lives on the device and nowhere else.
 *
 * Ported from Loom in one respect only — the **normalise-on-read** pattern.
 * Settings written by an older build, or half-filled, or corrupted in storage,
 * come back as a complete valid record with defaults filling every gap, so no
 * reader ever has to guard a field. A bad value is repaired, never thrown.
 */

export interface NarratorSettings {
  /** OpenRouter key. Empty means "no narrator" — the game runs on placeholder text. */
  apiKey: string;
  /** Prose quality matters here. */
  narratorModel: string;
  /** Cheap and fast: Tier 1 fallback and Tier 2 classification. */
  translatorModel: string;
  /** 0–2, the sampling temperature handed to the narrator. */
  temperature: number;
  /** Ceiling on a narration reply, in tokens. */
  maxTokens: number;
}

export const DEFAULT_SETTINGS: NarratorSettings = {
  apiKey: '',
  narratorModel: 'anthropic/claude-3.5-sonnet',
  translatorModel: 'anthropic/claude-3.5-haiku',
  temperature: 0.8,
  maxTokens: 500,
};

const clamp = (value: number, low: number, high: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;

/**
 * Turn whatever is in storage into a complete, valid record. Every field is
 * defended: the point of normalise-on-read is that a caller never sees a
 * missing or malformed value.
 */
export function normaliseSettings(raw: unknown): NarratorSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    // The key is kept verbatim but for surrounding whitespace — it is a secret,
    // not a display string, and must never be "helpfully" altered.
    apiKey: typeof source['apiKey'] === 'string' ? source['apiKey'].trim() : DEFAULT_SETTINGS.apiKey,
    narratorModel: asString(source['narratorModel'], DEFAULT_SETTINGS.narratorModel),
    translatorModel: asString(source['translatorModel'], DEFAULT_SETTINGS.translatorModel),
    temperature: clamp(Number(source['temperature']), 0, 2, DEFAULT_SETTINGS.temperature),
    maxTokens: Math.round(clamp(Number(source['maxTokens']), 1, 4000, DEFAULT_SETTINGS.maxTokens)),
  };
}

const STORAGE_KEY = 'aimon.settings';

/** Read settings from `localStorage`, normalised. Safe everywhere — no store, defaults. */
export function loadSettings(store: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): NarratorSettings {
  if (!store) return { ...DEFAULT_SETTINGS };
  try {
    const text = store.getItem(STORAGE_KEY);
    return normaliseSettings(text ? JSON.parse(text) : {});
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings, normalised first so nothing invalid is ever written. */
export function saveSettings(
  settings: NarratorSettings,
  store: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): NarratorSettings {
  const clean = normaliseSettings(settings);
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // A private-mode browser with storage disabled is not a crash; the settings
    // simply do not persist past the session.
  }
  return clean;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}
