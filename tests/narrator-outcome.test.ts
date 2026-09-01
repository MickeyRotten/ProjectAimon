import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import type { ChatRequest, LlmClient } from '../src/narrator/llm';
import { OutcomeNarrator } from '../src/narrator/outcome';
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
  facts: ['(charisma, moderate: 62% — rolled 40, a success)'],
  raw: 'i ask marda about the ruins',
  outcome: 'success' as const,
};

describe('OutcomeNarrator.narrate', () => {
  it('returns the model reply, cleaned', async () => {
    const client = new ScriptedClient(['"Marda relaxes a little at the question."']);
    const narrator = new OutcomeNarrator({ campaign, client, settings });
    const prose = await narrator.narrate(baseInput);
    expect(prose).toBe('Marda relaxes a little at the question.');
  });

  it('degrades to a truthful fallback line on a client failure, never throwing', async () => {
    const client = new ScriptedClient([new Error('down')]);
    const narrator = new OutcomeNarrator({ campaign, client, settings });
    const prose = await narrator.narrate(baseInput);
    expect(prose).toBe('It goes over about as well as you hoped.');
  });

  it('degrades to a truthful fallback line when the model returns nothing', async () => {
    const client = new ScriptedClient(['']);
    const narrator = new OutcomeNarrator({ campaign, client, settings });
    const prose = await narrator.narrate(baseInput);
    expect(prose).toBe('It goes over about as well as you hoped.');
  });

  it('degrades to the failure fallback line when the outcome was a failure', async () => {
    const client = new ScriptedClient([new Error('down')]);
    const narrator = new OutcomeNarrator({ campaign, client, settings });
    const prose = await narrator.narrate({ ...baseInput, outcome: 'failure' });
    expect(prose).toBe("It doesn't land the way you hoped.");
  });

  it('folds the engine facts into the prompt untouched, so they cannot be contradicted', async () => {
    const client = new ScriptedClient(['ok']);
    const narrator = new OutcomeNarrator({ campaign, client, settings });
    await narrator.narrate(baseInput);
    const sent = client.calls[0]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sent).toContain(baseInput.facts[0]);
  });
});
