/**
 * The one wire out of the app.
 *
 * The design is emphatic that this project is fully client-side: there is no
 * backend, and the LLM is reached straight from the browser through OpenRouter,
 * which permits it via CORS. The API key is the player's own, entered at
 * runtime and stored on-device — it never ships in source and never leaves for
 * anywhere but OpenRouter.
 *
 * Nothing above this file knows it is talking to OpenRouter. Everything speaks
 * to the `LlmClient` interface, so a test hands the narrator a fake that
 * answers from a script, and the engine — which must never depend on a live
 * network — is tested exactly as before.
 *
 * This is plumbing, ported in spirit from Loom's `openrouter.ts`: a single
 * chat call, a small retry with backoff, and no game logic whatsoever.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  /** Hard ceiling on the reply. The classifier's is tiny; the narrator's isn't. */
  maxTokens?: number | undefined;
  /**
   * Per-call abort timeout, overriding the client default. A batch that writes
   * a whole area at once is far slower than a single line and sets its own.
   */
  timeoutMs?: number | undefined;
}

export interface LlmClient {
  /** One completion, the assistant's text only. Throws on a failed call. */
  complete(request: ChatRequest): Promise<string>;
}

/** Thrown when there is no key to call with, so the caller can fall back to placeholder text. */
export class NoApiKeyError extends Error {
  constructor() {
    super('no OpenRouter API key set');
    this.name = 'NoApiKeyError';
  }
}

/** Thrown when the call reached OpenRouter but came back wrong. */
export class LlmCallError extends Error {}

export interface OpenRouterOptions {
  apiKey: string;
  /** Sent as `HTTP-Referer`/`X-Title` so OpenRouter can attribute the traffic. */
  appUrl?: string;
  appTitle?: string;
  /** Total attempts, including the first. Backoff is 2^n seconds between them. */
  attempts?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests, so backoff is instant off the wire. */
  sleep?: (ms: number) => Promise<void>;
  /** A stalled connection is aborted after this long and retried like any other failure. */
  timeoutMs?: number;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real client. `complete` posts one chat request and returns the assistant
 * message. A network failure or a 5xx is retried with exponential backoff; a
 * 4xx is not — a bad key or a bad model will not fix itself on a second try.
 */
export function openRouterClient(options: OpenRouterOptions): LlmClient {
  const attempts = Math.max(1, options.attempts ?? 2);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const timeoutMs = options.timeoutMs ?? 10000;

  return {
    async complete(request) {
      if (!options.apiKey) throw new NoApiKeyError();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      };
      if (options.appUrl) headers['HTTP-Referer'] = options.appUrl;
      if (options.appTitle) headers['X-Title'] = options.appTitle;

      const body = JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      });

      const perCallTimeout = request.timeoutMs ?? timeoutMs;
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(2 ** attempt * 1000);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), perCallTimeout);
        try {
          const response = await fetchImpl(ENDPOINT, { method: 'POST', headers, body, signal: controller.signal });
          if (!response.ok) {
            // A client error is terminal; a server error is worth another go.
            if (response.status >= 400 && response.status < 500) {
              throw new LlmCallError(`OpenRouter ${response.status}: ${await safeText(response)}`);
            }
            lastError = new LlmCallError(`OpenRouter ${response.status}`);
            continue;
          }
          return extractContent(await response.json());
        } catch (error) {
          if (error instanceof LlmCallError && error.message.includes('OpenRouter 4')) throw error;
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error ? lastError : new LlmCallError(String(lastError));
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/** OpenRouter mirrors the OpenAI shape: `choices[0].message.content`. */
function extractContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== 'string') throw new LlmCallError('OpenRouter returned no message content');
  return content;
}
