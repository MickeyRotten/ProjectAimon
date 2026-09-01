import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import { parse, toDirection } from '../src/engine/parser';

const { campaign } = await loadCampaign();
const verbs = campaign.verbs;

const ok = (raw: string) => {
  const result = parse(raw, verbs);
  if (!result.ok) throw new Error(`"${raw}" failed: ${result.failure.code}`);
  return result.command;
};

const failure = (raw: string) => {
  const result = parse(raw, verbs);
  if (result.ok) throw new Error(`"${raw}" parsed, and should not have`);
  return result.failure;
};

describe('the parser', () => {
  it('reads a bare direction as movement', () => {
    expect(ok('n')).toMatchObject({ verb: 'go', direction: 'n' });
    expect(ok('north')).toMatchObject({ verb: 'go', direction: 'n' });
    expect(ok('go west')).toMatchObject({ verb: 'go', direction: 'w' });
    expect(ok('d')).toMatchObject({ verb: 'go', direction: 'd' });
  });

  it('keeps legal-but-axisless directions apart from typos', () => {
    expect(ok('ne').unsupportedDirection).toBe('northeast');
    expect(failure('nrth').code).toBe('UNKNOWN_VERB');
  });

  it('strips articles and reads adjectives before the noun', () => {
    expect(ok('take the rusty sword').object).toMatchObject({ words: ['rusty', 'sword'] });
  });

  it('expands the abbreviations a player actually types', () => {
    expect(ok('x chest').verb).toBe('examine');
    expect(ok('i').verb).toBe('inventory');
    expect(ok('l').verb).toBe('look');
    expect(ok('z').verb).toBe('wait');
    expect(ok('g').verb).toBe('again');
  });

  it('reads look at X as examine, which is what people type', () => {
    expect(ok('look at the chest')).toMatchObject({ verb: 'examine' });
    expect(ok('look under the bed')).toMatchObject({ verb: 'examine', object: { words: ['bed'] } });
    expect(ok('look in the chest')).toMatchObject({ verb: 'examine', object: { words: ['chest'] } });
  });

  it('promotes a leading preposition into the direct object for verbs that absorb it', () => {
    expect(ok('talk to marda')).toMatchObject({ verb: 'talk', object: { words: ['marda'] } });
    expect(ok('talk with marda')).toMatchObject({ verb: 'talk', object: { words: ['marda'] } });
    expect(ok('greet marda')).toMatchObject({ verb: 'talk', object: { words: ['marda'] } });
    expect(ok('listen to the door')).toMatchObject({ verb: 'listen', object: { words: ['door'] } });
  });

  it('only matches a solo-word abbreviation when it is the whole input', () => {
    expect(ok('i').verb).toBe('inventory');
    expect(failure('i say hi to marda').code).toBe('UNKNOWN_VERB');
  });

  it('names the verb, not the typed word, in its own error messages', () => {
    expect(failure('head').message).toBe('Go what?');
    expect(failure('wait sword').message).toBe('Wait does not take an object.');
  });

  it('splits on a preposition into a VNPN command', () => {
    const command = ok('unlock door with brass key');
    expect(command.verb).toBe('unlock');
    expect(command.preposition).toBe('with');
    expect(command.indirect?.words).toEqual(['brass', 'key']);
  });

  it('handles take all, and take all except', () => {
    expect(ok('take all').object?.all).toBe(true);
    expect(ok('take all except rope').object).toMatchObject({ all: true, except: ['rope'] });
  });

  it('drops the particle in pick up', () => {
    expect(ok('pick up lantern').object?.words).toEqual(['lantern']);
  });

  it('reports the reason rather than just the failure', () => {
    expect(failure('xyzzy').code).toBe('UNKNOWN_VERB');
    expect(failure('take').code).toBe('UNKNOWN_NOUN');
    expect(failure('drop sword in chest').code).toBe('WRONG_VERB');
    expect(failure('wait here').code).toBe('WRONG_VERB');
  });

  it('knows which direction words the lattice has an axis for', () => {
    expect(toDirection('north')).toBe('n');
    expect(toDirection('up')).toBe('u');
    expect(toDirection('northeast')).toBeUndefined();
    expect(toDirection('in')).toBeUndefined();
  });
});
