import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import type { ChatRequest, LlmClient } from '../src/narrator/llm';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { VoiceNarrator } from '../src/narrator/voices';
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

const marda: NpcRecord = {
  campaignId: campaign.id,
  id: 'marda',
  name: 'Marda',
  aliases: [],
  location: null,
  persona: 'quartermaster. blunt and watchful.',
  tags: [],
  sex: 'none',
  stats: { brawn: 8, agility: 8, toughness: 8, charisma: 8, willpower: 8, wits: 8 },
  hp: 10,
  maxHp: 10,
  resolve: 10,
  maxResolve: 10,
  armourReduction: 0,
  penetration: 0,
  weaponDamage: '1d4',
  damageBonus: 0,
  attacksPerRound: 1,
  threat: 0,
  friendliness: 70,
  bribeThreshold: 0,
  disposition: 0,
  standing: 0,
  sensed: false,
  isVendor: true,
  priceModifier: 1,
  hostile: false,
  baseId: 'quartermaster',
  role: 'vendor',
  gambits: '',
  abilities: [],
  presenceImmune: false,
};

describe('VoiceNarrator.speak — never touches state', () => {
  it('returns the reply text as-is when the model answers cleanly', async () => {
    const client = new ScriptedClient(['"Fair prices, if you have coin."']);
    const narrator = new VoiceNarrator({ campaign, client, settings });
    const reply = await narrator.speak(marda, 'i say hi to marda', '', []);
    expect(reply).toBe('Fair prices, if you have coin.');
  });

  it('falls back to a truthful in-character line when the model throws', async () => {
    const client = new ScriptedClient([new Error('down')]);
    const narrator = new VoiceNarrator({ campaign, client, settings });
    const reply = await narrator.speak(marda, 'i ask marda about the ruins', 'the ruins', []);
    expect(reply).toContain('Marda');
  });

  it('falls back when the model returns nothing', async () => {
    const client = new ScriptedClient(['']);
    const narrator = new VoiceNarrator({ campaign, client, settings });
    const reply = await narrator.speak(marda, 'talk to marda', '', []);
    expect(reply.length).toBeGreaterThan(0);
  });

  it('folds recent transcript history into the prompt, so the model sees its own prior line', async () => {
    const client = new ScriptedClient(['"Selling mostly, if you have coin."']);
    const narrator = new VoiceNarrator({ campaign, client, settings });
    const history = [
      { turn: 1, input: 'talk to marda', output: 'Marda turns to hear you out.\n"Buying or selling?"' },
    ];
    await narrator.speak(marda, 'what are you selling?', '', history);
    const sent = client.calls[0]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sent).toContain('Buying or selling?');
  });
});
