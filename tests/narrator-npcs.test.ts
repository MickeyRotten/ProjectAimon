import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game, type TranscriptEntry } from '../src/game/game';
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

/** One synthetic transcript entry, the shape `finish()` pushes on any command. */
const entry = (turn: number, input = 'examine', output = ''): TranscriptEntry => ({ turn, input, output });

describe('NpcNarrator.describeAppearance', () => {
  it('generates once, then stays free while the transcript does not grow', async () => {
    const game = Game.begin({ campaign, seed: 'appearance', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator, client } = narratorWith(['Lean and stooped, with a scar through one eyebrow.']);

    // "history" includes this EXAMINE's own just-pushed entry, as it would
    // by the time main.ts's fire-and-forget follow-up actually runs.
    const history1 = [entry(1)];
    const first = await narrator.describeAppearance(game.world, npc, history1);
    expect(first).toBe('Lean and stooped, with a scar through one eyebrow.');
    expect(client.calls).toHaveLength(1);
    expect(npc.description).toBe(first);
    expect(npc.descriptionSeen).toBe(1);

    // A second EXAMINE, nothing else happening: one more entry (its own),
    // still free.
    const history2 = [...history1, entry(2)];
    const second = await narrator.describeAppearance(game.world, npc, history2);
    expect(second).toBe(first);
    expect(client.calls).toHaveLength(1);

    // And a third — this is the case a turn-number clock would get wrong,
    // since each EXAMINE costs a turn and the turn count keeps climbing.
    const history3 = [...history2, entry(3)];
    const third = await narrator.describeAppearance(game.world, npc, history3);
    expect(third).toBe(first);
    expect(client.calls).toHaveLength(1);
  });

  it('rechecks once something happens in between, and reports no change', async () => {
    const game = Game.begin({ campaign, seed: 'nochange', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator, client } = narratorWith(['Broad-shouldered, quiet.', 'CHANGED: no']);

    const history1 = [entry(1)];
    const first = await narrator.describeAppearance(game.world, npc, history1);
    expect(first).toBe('Broad-shouldered, quiet.');

    // Something else happens (not an EXAMINE), then EXAMINE again.
    const history2 = [...history1, entry(2, 'go north'), entry(3, 'examine')];
    const second = await narrator.describeAppearance(game.world, npc, history2);
    expect(second).toBe(first);
    expect(client.calls).toHaveLength(2);
    expect(npc.descriptionSeen).toBe(3);

    // The window sent to the judge excludes the current EXAMINE's own entry.
    const sent = client.calls[1]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sent).toContain('go north');
    expect(sent).not.toContain('examine');

    // Next EXAMINE right away: free again, no third call.
    const history3 = [...history2, entry(4)];
    const third = await narrator.describeAppearance(game.world, npc, history3);
    expect(third).toBe(first);
    expect(client.calls).toHaveLength(2);
  });

  it('rewrites the description when the recheck reports a change', async () => {
    const game = Game.begin({ campaign, seed: 'change', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const item = game.world.contentsOf('player' as never).objects[0];
    if (!item) throw new Error('the starter kit is empty');
    game.world.moveTo(item.id, heldBy(npc.id));
    item.flags.weapon = true;

    const { narrator, client } = narratorWith([
      'Broad-shouldered, quiet.',
      `CHANGED: yes\nDESCRIPTION: Broad-shouldered, quiet, a ${item.name} close to hand.`,
    ]);

    await narrator.describeAppearance(game.world, npc, [entry(1)]);
    const history = [entry(1), entry(2, 'take up the weapon'), entry(3)];
    const rendered = await narrator.describeAppearance(game.world, npc, history);

    expect(rendered).toContain(item.name);
    expect(npc.description).toBe(rendered);
    const sent = client.calls[1]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(sent).toContain(item.name);
  });

  it('seeds description from a legacy physiqueDesc with no call, and stays free', async () => {
    const game = Game.begin({ campaign, seed: 'migrate', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    npc.physiqueDesc = 'A gaunt figure, one sleeve pinned up empty.';
    const { narrator, client } = narratorWith(['should never be reached']);

    const history1 = [entry(5)];
    const seeded = await narrator.describeAppearance(game.world, npc, history1);
    expect(seeded).toBe('A gaunt figure, one sleeve pinned up empty.');
    expect(client.calls).toHaveLength(0);
    expect(npc.description).toBe(seeded);
    expect(npc.descriptionSeen).toBe(1);

    const history2 = [...history1, entry(6)];
    const again = await narrator.describeAppearance(game.world, npc, history2);
    expect(again).toBe(seeded);
    expect(client.calls).toHaveLength(0);
  });

  it('returns undefined on first generation when the model is unavailable', async () => {
    const game = Game.begin({ campaign, seed: 'nokey', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator } = narratorWith([new NoApiKeyError()]);

    const rendered = await narrator.describeAppearance(game.world, npc, [entry(1)]);
    expect(rendered).toBeUndefined();
  });

  it('returns undefined when the prompt templates are absent from the campaign', async () => {
    const game = Game.begin({ campaign, seed: 'notemplate', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const bareCampaign = { ...campaign, prompts: {} } as ResolvedCampaign;
    const client = new ScriptedClient(['should never be reached']);
    const narrator = new NpcNarrator({ campaign: bareCampaign, client, settings });

    const rendered = await narrator.describeAppearance(game.world, npc, [entry(1)]);
    expect(rendered).toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });

  it('falls back to the last-known-good text, not undefined, when a recheck call fails, and retries next time', async () => {
    const game = Game.begin({ campaign, seed: 'flaky', name: 'Vess', archetype: 'freebooter' });
    const npc = findAnyNpc(game);
    const { narrator, client } = narratorWith([
      'Broad-shouldered, quiet.',
      new Error('network blip'),
      'CHANGED: no',
    ]);

    const first = await narrator.describeAppearance(game.world, npc, [entry(1)]);
    const history = [entry(1), entry(2, 'go north'), entry(3)];
    const afterFailure = await narrator.describeAppearance(game.world, npc, history);

    expect(afterFailure).toBe(first);
    expect(npc.descriptionSeen).toBe(1); // unchanged — retried next EXAMINE, not marked seen

    // The retry on the next EXAMINE sees the same unseen window again
    // (still starting from entry index 1, "go north"), not a narrower one.
    const history2 = [...history, entry(4)];
    await narrator.describeAppearance(game.world, npc, history2);
    expect(client.calls).toHaveLength(3);
    const retrySent = client.calls[2]?.messages.map((m) => m.content).join('\n') ?? '';
    expect(retrySent).toContain('go north');
    expect(npc.descriptionSeen).toBe(4);
  });
});
