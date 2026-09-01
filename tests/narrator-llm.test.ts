import { describe, expect, it, vi } from 'vitest';
import { LlmCallError, NoApiKeyError, openRouterClient } from '../src/narrator/llm';

const ok = (content: string): Response =>
  ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as Response;

const bad = (status: number): Response =>
  ({ ok: false, status, text: async () => `error ${status}` }) as Response;

const noSleep = async (): Promise<void> => {};

describe('the OpenRouter client', () => {
  it('refuses to call with no key, so the caller can fall back', async () => {
    const client = openRouterClient({ apiKey: '', fetchImpl: vi.fn() });
    await expect(client.complete({ model: 'm', messages: [] })).rejects.toBeInstanceOf(NoApiKeyError);
  });

  it('returns the assistant content on success', async () => {
    const fetchImpl = vi.fn(async () => ok('a lantern gutters in the corner'));
    const client = openRouterClient({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    const reply = await client.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(reply).toBe('a lantern gutters in the corner');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a server error with backoff, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bad(503))
      .mockResolvedValueOnce(ok('through on the second try'));
    const client = openRouterClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await client.complete({ model: 'm', messages: [] })).toBe('through on the second try');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error — a bad key will not fix itself', async () => {
    const fetchImpl = vi.fn(async () => bad(401));
    const client = openRouterClient({
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.complete({ model: 'm', messages: [] })).rejects.toBeInstanceOf(LlmCallError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget on repeated failures', async () => {
    const fetchImpl = vi.fn(async () => bad(500));
    const client = openRouterClient({
      apiKey: 'k',
      attempts: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.complete({ model: 'm', messages: [] })).rejects.toBeInstanceOf(Error);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('aborts a stalled connection instead of hanging forever', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const client = openRouterClient({
      apiKey: 'k',
      attempts: 1,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.complete({ model: 'm', messages: [] })).rejects.toBeInstanceOf(Error);
  });

  it('retries a stall like any other transient failure', async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return Promise.resolve(ok('recovered after a stall'));
    });
    const client = openRouterClient({
      apiKey: 'k',
      attempts: 2,
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await client.complete({ model: 'm', messages: [] })).toBe('recovered after a stall');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
