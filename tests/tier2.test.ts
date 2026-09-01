import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import type { ResolvedCampaign } from '../src/campaign/types';
import { ruleNumber } from '../src/engine/rules';
import { Game } from '../src/game/game';
import { legalAttempt, resolveAttempt } from '../src/game/tier2';
import { inRoom, type NpcRecord } from '../src/world/types';

const campaign: ResolvedCampaign = (await loadCampaign()).campaign;

const start = (seed = 'tier2') => Game.begin({ campaign, seed, name: 'Vess', archetype: 'freebooter' });

function friendlyNpc(game: Game, over: Partial<NpcRecord> = {}): NpcRecord {
  const npc: NpcRecord = {
    campaignId: campaign.id,
    id: 'marda',
    name: 'Marda',
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
    ...over,
  };
  game.world.npcs.set(npc.id, npc);
  return npc;
}

describe('legalAttempt — never trust an id the model returns', () => {
  it('accepts a well-formed attempt with a target in scope', () => {
    const game = start();
    friendlyNpc(game);
    const scope = game.context().scope;
    const attempt = legalAttempt(campaign.rules, scope, { stat: 'charisma', band: 'moderate', target: 'marda' });
    expect(attempt).toEqual({ stat: 'charisma', band: 'moderate', target: 'marda' });
  });

  it('accepts a null target — self or nobody in particular', () => {
    const game = start();
    const scope = game.context().scope;
    const attempt = legalAttempt(campaign.rules, scope, { stat: 'wits', band: 'easy', target: null });
    expect(attempt).toEqual({ stat: 'wits', band: 'easy', target: null });
  });

  it('rejects a target id that was never in the sent scope', () => {
    const game = start();
    const scope = game.context().scope;
    expect(
      legalAttempt(campaign.rules, scope, { stat: 'charisma', band: 'moderate', target: 'a-quest-that-never-existed' }),
    ).toBeUndefined();
  });

  it('rejects a stat outside STAT_ROLL.attributes', () => {
    const game = start();
    const scope = game.context().scope;
    expect(legalAttempt(campaign.rules, scope, { stat: 'luck', band: 'moderate', target: null })).toBeUndefined();
  });

  it('rejects a band outside DIFFICULTY_BASE', () => {
    const game = start();
    const scope = game.context().scope;
    expect(legalAttempt(campaign.rules, scope, { stat: 'charisma', band: 'impossible', target: null })).toBeUndefined();
  });

  it('rejects a malformed or missing shape entirely', () => {
    const game = start();
    const scope = game.context().scope;
    expect(legalAttempt(campaign.rules, scope, null)).toBeUndefined();
    expect(legalAttempt(campaign.rules, scope, 'charisma')).toBeUndefined();
    expect(legalAttempt(campaign.rules, scope, { stat: 'charisma' })).toBeUndefined();
  });
});

describe('resolveAttempt — the engine picks the effect, never the model', () => {
  it('never returns a spawn, move, quest or goal effect', () => {
    const game = start();
    const npc = friendlyNpc(game);
    const ctx = game.context();
    for (let i = 0; i < 30; i++) {
      const rng = game.world.combatRng(`test:${i}`);
      const reply = resolveAttempt(ctx, { stat: 'charisma', band: 'moderate', target: npc.id }, rng);
      for (const effect of reply.effects) {
        expect(['npcDisposition', 'resolve', 'hp', 'purse', 'libido']).toContain(effect.kind);
      }
    }
  });

  it('moves disposition on a non-hostile target, up on success and down on failure', () => {
    const game = start();
    const npc = friendlyNpc(game);
    const ctx = game.context();
    // A trivially easy attempt at high Charisma succeeds; find one success and
    // one failure across a small seeded spread rather than assume either roll.
    let sawSuccess = false;
    let sawFailure = false;
    for (let i = 0; i < 50 && (!sawSuccess || !sawFailure); i++) {
      const rng = game.world.combatRng(`spread:${i}`);
      const reply = resolveAttempt(ctx, { stat: 'charisma', band: 'moderate', target: npc.id }, rng);
      const delta = reply.effects.find((e) => e.kind === 'npcDisposition');
      if (reply.outcome === 'success') {
        sawSuccess = true;
        expect(delta).toMatchObject({ kind: 'npcDisposition', delta: 2 });
      } else {
        sawFailure = true;
        expect(delta).toMatchObject({ kind: 'npcDisposition', delta: -2 });
      }
    }
    expect(sawSuccess && sawFailure).toBe(true);
  });

  it('never moves disposition on a hostile target; a failure costs Resolve instead', () => {
    const game = start();
    const npc = friendlyNpc(game, { hostile: true, id: 'hostile-one' });
    const ctx = game.context();
    for (let i = 0; i < 30; i++) {
      const rng = game.world.combatRng(`hostile:${i}`);
      const reply = resolveAttempt(ctx, { stat: 'charisma', band: 'severe', target: npc.id }, rng);
      expect(reply.effects.some((e) => e.kind === 'npcDisposition')).toBe(false);
      if (reply.outcome === 'failure') {
        expect(reply.effects).toEqual([{ kind: 'resolve', delta: -1 }]);
      } else {
        expect(reply.effects).toEqual([]);
      }
    }
  });

  it('a failed attempt with no target costs Resolve; a success changes nothing mechanical', () => {
    const game = start();
    const ctx = game.context();
    for (let i = 0; i < 30; i++) {
      const rng = game.world.combatRng(`notarget:${i}`);
      const reply = resolveAttempt(ctx, { stat: 'wits', band: 'severe', target: null }, rng);
      if (reply.outcome === 'failure') {
        expect(reply.effects).toEqual([{ kind: 'resolve', delta: -1 }]);
      } else {
        expect(reply.effects).toEqual([]);
      }
    }
  });

  it('reads the chance from DIFFICULTY_BASE and CLAMP, not from a literal', () => {
    const game = start();
    const ctx = game.context();
    const rng = game.world.combatRng('chance-check');
    const reply = resolveAttempt(ctx, { stat: 'charisma', band: 'easy', target: null }, rng);
    // 3 * charisma + DIFFICULTY_BASE.easy, clamped — read the rules table
    // directly rather than assume a number, so a retune is what this checks.
    const easyBase = ruleNumber(campaign.rules, 'DIFFICULTY_BASE.easy');
    const expectedChance = Math.max(5, Math.min(95, Math.round(3 * game.player.stats.charisma + easyBase)));
    expect(reply.lines[0]).toBeDefined();
    expect(reply.lines[0]?.text ?? '').toContain(`${expectedChance}%`);
  });
});

describe('Game.resolveTier2 — writes at the one write point, like any other command', () => {
  it('spends the turn and applies effects through Game.apply', () => {
    const game = start();
    const npc = friendlyNpc(game);
    const before = game.turn;
    const attempt = { stat: 'charisma' as const, band: 'moderate' as const, target: npc.id };
    const result = game.resolveTier2('i ask marda about her day', attempt);
    expect(result.spent).toBe(true);
    expect(game.turn).toBe(before + 1);
  });
});
