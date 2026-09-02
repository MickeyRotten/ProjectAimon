import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import type { ScopeEntry } from '../src/game/scope';
import type { ChatRequest, LlmClient } from '../src/narrator/llm';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { Translator } from '../src/narrator/translate';
import type { NpcRecord } from '../src/world/types';

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

const marda = {
  id: 'marda',
  name: 'Marda',
  isVendor: true,
} as unknown as NpcRecord;

const beggar = {
  id: 'beggar',
  name: 'The beggar',
  isVendor: false,
} as unknown as NpcRecord;

const scope: ScopeEntry[] = [
  { id: 'marda', kind: 'npc', name: 'Marda', nouns: ['marda'], adjectives: [], where: 'room' },
  { id: 'beggar', kind: 'npc', name: 'The beggar', nouns: ['beggar'], adjectives: [], where: 'room' },
];

const make = (replies: (string | Error)[]): { translator: Translator; client: ScriptedClient } => {
  const client = new ScriptedClient(replies);
  return { translator: new Translator({ campaign, client, settings }), client };
};

describe('the conversation router — one call, three outcomes', () => {
  it('routes a mechanical request back through the parser as a command', async () => {
    const { translator } = make(['{ "kind": "command", "command": "list marda" }']);
    const route = await translator.converse('what are you selling?', 'r1', scope, campaign.verbs, marda);
    expect(route.kind).toBe('command');
    if (route.kind !== 'command') throw new Error('unreachable');
    expect(route.command.verb).toBe('list');
  });

  it('routes an attempt through legalAttempt, keeping the engine-owned enum', async () => {
    const { translator } = make([
      '{ "kind": "attempt", "stat": "charisma", "band": "moderate", "target": "marda" }',
    ]);
    const route = await translator.converse('I try to charm her', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({
      kind: 'attempt',
      attempt: { stat: 'charisma', band: 'moderate', target: 'marda' },
    });
  });

  it('treats an ordinary remark as speech, which is the default', async () => {
    const { translator } = make(['{ "kind": "speech" }']);
    const route = await translator.converse('good morning', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({ kind: 'speech' });
  });

  it('discards a command the parser refuses rather than inventing a turn', async () => {
    const { translator } = make(['{ "kind": "command", "command": "flurgle the widget" }']);
    const route = await translator.converse('do the thing', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({ kind: 'speech' });
  });

  it('discards an attempt naming an id outside the scope it was sent — rule 3', async () => {
    const { translator } = make([
      '{ "kind": "attempt", "stat": "charisma", "band": "moderate", "target": "the_mayor" }',
      '{ "kind": "attempt", "stat": "charisma", "band": "moderate", "target": "the_mayor" }',
    ]);
    const route = await translator.converse('I lean on the mayor', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({ kind: 'speech' });
  });

  it('degrades to speech on malformed output, after one repair call', async () => {
    const { translator, client } = make(['I think they would say hello.', 'still not JSON']);
    const route = await translator.converse('hello there', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({ kind: 'speech' });
    expect(client.calls).toHaveLength(2); // the ask, then the one repair
  });

  it('degrades to speech when the call throws outright', async () => {
    const { translator } = make([new Error('network')]);
    const route = await translator.converse('hello there', 'r1', scope, campaign.verbs, marda);
    expect(route).toEqual({ kind: 'speech' });
  });

  it('never spends more than one call plus its repair on a turn', async () => {
    const { translator, client } = make(['{ "kind": "speech" }']);
    await translator.converse('hello there', 'r1', scope, campaign.verbs, marda);
    expect(client.calls).toHaveLength(1);
  });

  it('caches per partner, so the same line said to two people is asked twice', async () => {
    const { translator, client } = make([
      '{ "kind": "command", "command": "list marda" }',
      '{ "kind": "speech" }',
    ]);
    const toMarda = await translator.converse('what are you selling?', 'r1', scope, campaign.verbs, marda);
    const toBeggar = await translator.converse('what are you selling?', 'r1', scope, campaign.verbs, beggar);
    expect(toMarda.kind).toBe('command');
    expect(toBeggar.kind).toBe('speech');
    expect(client.calls).toHaveLength(2);

    // …and the same line to the same person in the same room is not re-asked.
    await translator.converse('what are you selling?', 'r1', scope, campaign.verbs, marda);
    expect(client.calls).toHaveLength(2);
  });

  it('tells the model whether the person it is routing for actually sells things', async () => {
    const { translator, client } = make(['{ "kind": "speech" }']);
    await translator.converse('anything for me?', 'r1', scope, campaign.verbs, marda);
    expect(client.calls[0]?.messages[1]?.content).toContain('who sells things');

    const plain = make(['{ "kind": "speech" }']);
    await plain.translator.converse('anything for me?', 'r1', scope, campaign.verbs, beggar);
    expect(plain.client.calls[0]?.messages[1]?.content).not.toContain('who sells things');
  });
});
