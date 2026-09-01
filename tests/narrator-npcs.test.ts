import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { NoApiKeyError, type ChatRequest, type LlmClient } from '../src/narrator/llm';
import { NpcNarrator } from '../src/narrator/npcs';
import { DEFAULT_SETTINGS } from '../src/narrator/settings';
import { heldBy } from '../src/world/types';

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

const narratorWith = (replies: (string | Error)[]): { narrator: NpcNarrator; client: ScriptedClient } => {
  const client = new ScriptedClient(replies);
  return { narrator: new NpcNarrator({ campaign, client, settings }), client };
};

const findAnyNpc = (game: Game) => {
  const npc = [...game.world.npcs.values()][0];
  if (!npc) throw new Error('no NPC in a freshly begun game');
  return npc;
};

describe('NpcNarrator.describeAppearance', () => {
  it('generates physique once, then weaves the woven render, both cached', async () => {
    const game = Game.begin({ campaign, seed: 'appearance', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator, client } = narratorWith([
      'Lean and stooped, with a scar through one eyebrow.',
      'Lean and stooped, dressed plainly, watching you closely.',
    ]);

    const first = await narrator.describeAppearance(game.world, npc);
    expect(first).toBe('Lean and stooped, dressed plainly, watching you closely.');
    expect(client.calls).toHaveLength(2); // physique, then the woven render
    expect(npc.physiqueDesc).toBe('Lean and stooped, with a scar through one eyebrow.');

    const second = await narrator.describeAppearance(game.world, npc);
    expect(second).toBe(first);
    expect(client.calls).toHaveLength(2); // unchanged gear, unchanged physique — free
  });

  it('mentions a weapon the NPC is carrying, and re-weaves once it changes', async () => {
    const game = Game.begin({ campaign, seed: 'gear', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const item = game.world.contentsOf('player' as never).objects[0];
    if (!item) throw new Error('the starter kit is empty');
    game.world.moveTo(item.id, heldBy(npc.id));
    item.flags.weapon = true;

    const { narrator, client } = narratorWith([
      'Broad-shouldered, quiet.',
      `Broad-shouldered, quiet, a ${item.name} close to hand.`,
    ]);

    const rendered = await narrator.describeAppearance(game.world, npc);
    expect(rendered).toContain(item.name);
    expect(client.calls).toHaveLength(2);
    const sentToWeave = client.calls[1]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sentToWeave).toContain(item.name);
  });

  it('returns undefined, never throws, when the model is unavailable', async () => {
    const game = Game.begin({ campaign, seed: 'nokey', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator } = narratorWith([new NoApiKeyError()]);

    const rendered = await narrator.describeAppearance(game.world, npc);
    expect(rendered).toBeUndefined();
  });

  it('returns undefined when the prompt templates are absent from the campaign', async () => {
    const game = Game.begin({ campaign, seed: 'notemplate', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const bareCampaign = { ...campaign, prompts: {} } as ResolvedCampaign;
    const client = new ScriptedClient(['should never be reached']);
    const narrator = new NpcNarrator({ campaign: bareCampaign, client, settings });

    const rendered = await narrator.describeAppearance(game.world, npc);
    expect(rendered).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });
});
