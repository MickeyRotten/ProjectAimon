/**
 * The OpenRouter model catalogue.
 *
 * The settings screen offers the two model slots as dropdowns rather than as
 * free text, so a typo cannot silently disable the narrator. The list is read
 * from OpenRouter's public `/models` endpoint, which needs no key — the player
 * can pick a model before they have pasted one in.
 *
 * Everything here is presentation data. No id fetched from the network is ever
 * trusted as anything but a string the player may choose; the engine reads the
 * slot back out of settings, normalised, exactly as before.
 */

export interface ModelInfo {
  /** The id handed to the chat endpoint, e.g. `anthropic/claude-3.5-sonnet`. */
  id: string;
  /** Human label for the dropdown. Falls back to the id. */
  name: string;
  /** Vendor prefix, used to group the dropdown. */
  vendor: string;
  /** Prompt price per token, as a number, when OpenRouter reports one. */
  promptPrice: number | undefined;
}

export interface ModelListOptions {
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the live endpoint. */
  endpoint?: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/models';

/**
 * Fetch the catalogue, sorted by vendor then name. Throws on a failed call —
 * the caller falls back to a plain text field, which is never worse than what
 * was there before.
 */
export async function fetchModels(options: ModelListOptions = {}): Promise<ModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.endpoint ?? ENDPOINT);
  if (!response.ok) throw new Error(`OpenRouter models ${response.status}`);
  const payload: unknown = await response.json();
  const rows = (payload as { data?: unknown }).data;
  if (!Array.isArray(rows)) throw new Error('OpenRouter returned no model list');

  const models: ModelInfo[] = [];
  for (const row of rows) {
    const record = (row ?? {}) as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const name = typeof record['name'] === 'string' && record['name'] ? record['name'] : id;
    const pricing = (record['pricing'] ?? {}) as Record<string, unknown>;
    const prompt = Number(pricing['prompt']);
    models.push({
      id,
      name,
      vendor: id.includes('/') ? (id.split('/')[0] as string) : 'other',
      promptPrice: Number.isFinite(prompt) ? prompt : undefined,
    });
  }
  models.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
  return models;
}

/** A short price tag for the option label — dollars per million prompt tokens. */
export function priceLabel(model: ModelInfo): string {
  if (model.promptPrice === undefined) return '';
  if (model.promptPrice === 0) return ' (free)';
  const perMillion = model.promptPrice * 1_000_000;
  return ` ($${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(1)}/M)`;
}
