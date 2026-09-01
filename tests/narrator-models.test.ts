import { describe, expect, it, vi } from 'vitest';
import { fetchModels, priceLabel } from '../src/narrator/models';

const listing = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;

describe('the OpenRouter model catalogue', () => {
  it('reads ids, names and vendors, sorted by vendor then name', async () => {
    const fetchImpl = vi.fn(async () =>
      listing([
        { id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.0000025' } },
        { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', pricing: { prompt: '0.000003' } },
        { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku', pricing: { prompt: '0.0000008' } },
      ]),
    );
    const models = await fetchModels({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(models.map((model) => model.id)).toEqual([
      'anthropic/claude-3.5-haiku',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
    ]);
    expect(models[0]?.vendor).toBe('anthropic');
    expect(models[0]?.name).toBe('Claude 3.5 Haiku');
  });

  it('skips rows with no id and falls back to the id for a missing name', async () => {
    const fetchImpl = vi.fn(async () => listing([{ name: 'nameless' }, { id: 'x/y' }]));
    const models = await fetchModels({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'x/y', name: 'x/y', vendor: 'x' });
  });

  it('throws on a failed call, so the panel can fall back to a text field', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    await expect(fetchModels({ fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow();
  });

  it('labels price per million prompt tokens, and marks free models', () => {
    expect(priceLabel({ id: 'a/b', name: 'b', vendor: 'a', promptPrice: 0.000003 })).toBe(' ($3.0/M)');
    expect(priceLabel({ id: 'a/b', name: 'b', vendor: 'a', promptPrice: 0 })).toBe(' (free)');
    expect(priceLabel({ id: 'a/b', name: 'b', vendor: 'a', promptPrice: undefined })).toBe('');
  });
});
