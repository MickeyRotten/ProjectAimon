import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { Game } from '../src/game/game';
import { stepThrough } from '../src/game/ladder';
import type { ConverseRoute, Translator } from '../src/narrator/translate';
import { inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;
const start = (seed = 'talk') => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

function friendlyNpc(game: Game, id = 'marda', name = 'Marda'): NpcRecord {
  const npc: NpcRecord = {
    campaignId: campaign.id,
    id,
    name,
    aliases: [],
    location: inRoom(game.player.roomId),
    persona: 'quartermaster',
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
  game.world.npcs.set(npc.id, npc);
  return npc;
}

const said = (game: Game, raw: string): string[] => game.submit(raw).lines.map((entry) => entry.text);
const HEADER = 'Marda turns to hear you out.';

describe('conversation — opened once, closed by leaving it', () => {
  it('the header line fires on the turn it opens, and never again', () => {
    const game = start();
    friendlyNpc(game);

    expect(said(game, 'talk marda')).toContain(HEADER);
    expect(game.partner()?.id).toBe('marda');

    // The second and third lines of the same exchange are not fresh approaches.
    expect(said(game, 'talk marda')).not.toContain(HEADER);
    expect(said(game, 'ask marda about the ruins')).not.toContain(HEADER);
    expect(game.partner()?.id).toBe('marda');
  });

  it('a farewell closes it, and the next greeting opens fresh', () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');

    expect(said(game, 'bye')).toContain('You take your leave of Marda.');
    expect(game.partner()).toBeUndefined();
    expect(said(game, 'talk marda')).toContain(HEADER);
  });

  it('walking out closes it — you cannot keep talking to a room you have left', () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');
    const before = game.player.roomId;

    const exit = game.world.exitsOf(before)[0];
    if (!exit) throw new Error('the hub entry room has no exits');
    game.submit(exit.dir);
    expect(game.player.roomId).not.toBe(before);
    expect(game.partner()).toBeUndefined();
  });

  it('a partner who dies is no longer a partner, however the pointer stands', () => {
    const game = start();
    const npc = friendlyNpc(game);
    said(game, 'talk marda');

    npc.defeated = true;
    expect(game.partner()).toBeUndefined();
  });

  it('addressing someone else moves the conversation to them', () => {
    const game = start();
    friendlyNpc(game);
    friendlyNpc(game, 'joss', 'Joss');
    said(game, 'talk marda');

    expect(said(game, 'talk joss')).toContain('Joss turns to hear you out.');
    expect(game.partner()?.id).toBe('joss');
  });

  it('rides along in the save, and a save written without one loads clean', () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');

    const snapshot = game.snapshot();
    expect(snapshot.conversation?.npcId).toBe('marda');
    expect(Game.restore(campaign, snapshot).partner()?.id).toBe('marda');

    const { conversation: _dropped, ...older } = snapshot;
    expect(Game.restore(campaign, older).partner()).toBeUndefined();
  });
});

describe('the ladder — which tier a line belongs to', () => {
  /** A translator stub: the real one is exercised in narrator-converse.test.ts. */
  const stubTranslator = (route: ConverseRoute) => {
    const calls: string[] = [];
    const translator = {
      async converse(raw: string): Promise<ConverseRoute> {
        calls.push(`converse:${raw}`);
        return route;
      },
      async toCommand(raw: string): Promise<undefined> {
        calls.push(`toCommand:${raw}`);
        return undefined;
      },
      async classify(raw: string): Promise<undefined> {
        calls.push(`classify:${raw}`);
        return undefined;
      },
    } as unknown as Translator;
    return { translator, calls };
  };

  const deps = (game: Game, translator: Translator | undefined) => ({
    game,
    translator,
    verbs: campaign.verbs,
    rules: campaign.rules,
  });

  it('never reaches the translator when Tier 1 already parsed the line', async () => {
    const game = start();
    friendlyNpc(game);
    const { translator, calls } = stubTranslator({ kind: 'speech' });
    await stepThrough(deps(game, translator), 'look');
    expect(calls).toEqual([]);
  });

  it('in a conversation, unparsed speech is voiced rather than echoed into Tier 3', async () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');
    const { translator, calls } = stubTranslator({ kind: 'speech' });

    const result = await stepThrough(deps(game, translator), 'how long have you held this post?');
    expect(result.voice).toEqual({ npcId: 'marda', topic: '' });
    expect(result.spent).toBe(true);
    // One router call, leaving the second of the two-call budget for the voice.
    expect(calls).toEqual(['converse:how long have you held this post?']);
  });

  it('in a conversation, a routed command runs as an ordinary Tier 1 turn', async () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');
    const parsed = (await import('../src/engine/parser')).parse('list marda', campaign.verbs);
    if (!parsed.ok) throw new Error('did not parse');
    const { translator } = stubTranslator({ kind: 'command', command: parsed.command });

    const result = await stepThrough(deps(game, translator), 'what are you selling?');
    expect(result.lines.map((entry) => entry.text)).toContain('Marda has nothing to sell just now.');
  });

  it('in a conversation, a routed attempt resolves as Tier 2 with its roll', async () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');
    const { translator } = stubTranslator({
      kind: 'attempt',
      attempt: { stat: 'charisma', band: 'moderate', target: 'marda' },
    });

    const result = await stepThrough(deps(game, translator), 'I try to talk her round');
    expect(result.tier2).toBeDefined();
    expect(result.lines.some((entry) => entry.kind === 'roll')).toBe(true);
  });

  it('outside a conversation the old order stands: toCommand, then classify, then Tier 3', async () => {
    const game = start();
    const { translator, calls } = stubTranslator({ kind: 'speech' });

    const result = await stepThrough(deps(game, translator), 'ponder the nature of salt');
    expect(result.spent).toBe(false);
    expect(result.voice).toBeUndefined();
    expect(calls).toEqual([
      'toCommand:ponder the nature of salt',
      'classify:ponder the nature of salt',
    ]);
  });

  it('with no narrator at all, the ladder stops at Tier 1 and says why', async () => {
    const game = start();
    friendlyNpc(game);
    said(game, 'talk marda');

    const result = await stepThrough(deps(game, undefined), 'how long have you held this post?');
    expect(result.voice).toBeUndefined();
    expect(result.spent).toBe(false);
  });
});
