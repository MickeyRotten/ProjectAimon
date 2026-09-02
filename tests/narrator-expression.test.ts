import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import type { ChatRequest, LlmClient } from '../src/narrator/llm';
import { ExpressionNarrator } from '../src/narrator/expression';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const settings = { ...DEFAULT_SETTINGS, apiKey: 'k' };

class ScriptedClient implements LlmClient {
  readonly calls: ChatRequest[] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  async complete(request: ChatRequest): Promise<string> {
    this.calls.push(request);
    const reply = this.replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? '';
  }
}

const baseInput = {
  areaName: 'The Hub',
  areaTone: 'a lived-in guild yard',
  history: [],
  roomName: 'The Yard',
  roomDesc: 'Worn flagstones underfoot.',
  raw: 'smell the corpse',
  verb: 'smell',
  target: 'corpse',
};

describe('ExpressionNarrator.narrate', () => {
  it('returns the model reply, cleaned', async () => {
    const client = new ScriptedClient(['"The reek gets into the back of your throat."']);
    const narrator = new ExpressionNarrator({ campaign, client, settings });
    const prose = await narrator.narrate(baseInput);
    expect(prose).toBe('The reek gets into the back of your throat.');
  });

  it('returns an empty string on a client failure, so the caller can fall back', async () => {
    const client = new ScriptedClient([new Error('down')]);
    const narrator = new ExpressionNarrator({ campaign, client, settings });
    expect(await narrator.narrate(baseInput)).toBe('');
  });

  it('folds the action and the player words into the prompt', async () => {
    const client = new ScriptedClient(['ok']);
    const narrator = new ExpressionNarrator({ campaign, client, settings });
    await narrator.narrate(baseInput);
    const sent = client.calls[0]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sent).toContain('smell the corpse');
  });

  it('handles pure expression with no verb or target', async () => {
    const client = new ScriptedClient(['ok']);
    const narrator = new ExpressionNarrator({ campaign, client, settings });
    const prose = await narrator.narrate({ ...baseInput, raw: 'i think of home', verb: undefined, target: undefined });
    expect(prose).toBe('ok');
  });
});
