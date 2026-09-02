import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import { Game } from '../src/game/game';
import { parse } from '../src/engine/parser';

const campaign = (await loadCampaign()).campaign;
const verbs = campaign.verbs;

describe('flavour verbs', () => {
  it('the parser flags every flavour-only verb', () => {
    for (const raw of ['smell', 'listen', 'grope marda', 'fondle the statue', 'suck the stone']) {
      const result = parse(raw, verbs);
      expect(result.ok && result.command.flavour).toBe(true);
    }
  });

  it('a previously dead flavour verb now routes to flavour, not "Nothing happens"', () => {
    // grope/slap/fondle/squeeze/rub/stroke/suck used to fall to the default
    // handler; the flavour flag now carries them to the express seam.
    for (const id of ['grope', 'slap', 'fondle', 'squeeze', 'rub', 'stroke', 'suck']) {
      const result = parse(`${id} the thing`, verbs);
      expect(result.ok && result.command.flavour).toBe(true);
    }
  });

  it('routes to fresh narration with a canned fallback and no state effect', () => {
    const game = Game.begin({ campaign, seed: 'flavour', name: 'Vess', archetype: 'freebooter' });
    const result = game.submit('smell');
    expect(result.express).toBeDefined();
    expect(result.express!.verb).toBe('smell');
    expect(result.express!.fallback.text).toContain('Nothing comes of it');
    // A flavour turn is spent (the clock runs) but changes nothing.
    expect(result.spent).toBe(true);
  });

  it('Tier 3 pure expression also carries an express payload, and stays free', () => {
    const game = Game.begin({ campaign, seed: 'tier3', name: 'Vess', archetype: 'freebooter' });
    const result = game.tier3('i sit a while and think about my brother');
    expect(result.express).toBeDefined();
    expect(result.express!.verb).toBeUndefined();
    expect(result.spent).toBe(false);
  });
});
