import { describe, expect, it } from 'vitest';
import { PLACE_KINDS, PREDICATE_KINDS, REWARD_KINDS } from '../src/world/quests';
import { bundledSource } from '../src/campaign/source';
import { globToRegExp, keyOf, vocabularyFor, vocabularyForPath, TEMPLATED } from '../src/editor/pickers';

/**
 * The picker registry addresses fields by the validator's own path strings.
 * These tests pin the glob, the fields it claims, and — the part that matters —
 * that the paths it claims are paths that really occur in the base tables.
 */

describe('the path glob', () => {
  it('matches a segment with * and an index with #', () => {
    const re = globToRegExp('quests/*.json.rewards#');
    expect(re.test('quests/kill.json.rewards[0]')).toBe(true);
    expect(re.test('quests/deliver.json.rewards[12]')).toBe(true);
    expect(re.test('quests/kill.json.rewards')).toBe(false);
    expect(re.test('quests/kill.json.targetTags[0]')).toBe(false);
  });

  it('treats a dot inside a file name as a literal, not a separator', () => {
    const re = globToRegExp('content/abilities.json.table#.type');
    expect(re.test('content/abilities.json.table[3].type')).toBe(true);
    expect(re.test('content/abilitiesXjson.table[3].type')).toBe(false);
  });

  it('does not let * cross a segment boundary', () => {
    const re = globToRegExp('areas/*.json.shapes#');
    expect(re.test('areas/town.json.shapes[0]')).toBe(true);
    expect(re.test('areas/town.json.roomTypes.shapes[0]')).toBe(false);
  });
});

describe('which vocabulary a field draws from', () => {
  it('claims the quest fields the validator closes', () => {
    expect(vocabularyForPath('quests/kill.json.objective.place')).toBe('questPlace');
    expect(vocabularyForPath('quests/kill.json.objective.completedBy')).toBe('questPredicate');
    expect(vocabularyForPath('quests/kill.json.rewards[1]')).toBe('questReward');
  });

  it('claims the ability and gambit fields', () => {
    expect(vocabularyForPath('content/abilities.json.table[0].type')).toBe('abilityType');
    expect(vocabularyForPath('content/abilities.json.table[0].applies')).toBe('primerId');
    expect(vocabularyForPath('content/abilities.json.gambitsByRole.skirmisher[2].when')).toBe('gambitCondition');
    expect(vocabularyForPath('content/abilities.json.gambitsByRole.skirmisher[2].use')).toBe('abilityId');
  });

  it('claims shapes, gate directions and archetype references', () => {
    expect(vocabularyForPath('areas/town.json.shapes[0]')).toBe('shape');
    expect(vocabularyForPath('campaign.json.hub.gates[0].dir')).toBe('direction');
    expect(vocabularyForPath('campaign.json.hub.gates[0].archetype')).toBe('archetype');
    expect(vocabularyForPath('campaign.json.gatewayArchetypes[0]')).toBe('archetype');
    expect(vocabularyForPath('campaign.json.hub.gates[0].fromRoom')).toBe('hubRoom');
  });

  it('lets startingArea say "hub", which no other archetype field may', () => {
    // The validator exempts exactly this field; a plain archetype list here
    // would flag the base campaign's own correct value as invalid.
    expect(vocabularyForPath('campaign.json.startingArea')).toBe('archetypeOrHub');
    expect(vocabularyForPath('campaign.json.hub.gates[0].archetype')).toBe('archetype');
  });

  it('falls back to the key name for tags, wherever they appear', () => {
    expect(vocabularyFor('areas/town.json.roomTypes.taproom.tags[0]', 'tags')).toBe('tag');
    expect(vocabularyFor('areas/town.json.gates.ruin.requires[0]', 'requires')).toBe('requires');
    expect(vocabularyFor('content/placement.json.fixtures[0].kind', 'kind')).toBe('tag');
  });

  it('stops the key-name fallback where the key is not a tag', () => {
    // A quest objective's `kind` is the quest type, not an object tag — the
    // key-name fallback would happily offer tags for it.
    expect(vocabularyFor('quests/kill.json.objective.kind', 'kind')).toBeUndefined();
  });

  it('leaves ordinary fields to the generic renderer', () => {
    expect(vocabularyFor('areas/town.json.name', 'name')).toBeUndefined();
    expect(vocabularyFor('content/abilities.json.table[0].id', 'id')).toBeUndefined();
  });

  it('reads the key off a path, indices and all', () => {
    expect(keyOf('quests/kill.json.rewards[0]')).toBe('rewards');
    expect(keyOf('quests/kill.json.objective.place')).toBe('place');
    expect(keyOf('campaign.json')).toBe('json');
  });

  it('marks only the vocabularies whose entries are patterns', () => {
    expect(TEMPLATED.has('gambitCondition')).toBe(true);
    expect(TEMPLATED.has('questPlace')).toBe(false);
  });
});

describe('the registered paths address fields that really exist', () => {
  it('finds a claimed vocabulary for every closed field in the base tables', async () => {
    const source = bundledSource('base');
    const files = new Map<string, unknown>();
    for (const path of await source.list()) files.set(path, await source.read(path));

    const quest = files.get('quests/kill.json') as {
      objective: { place: string; completedBy: string };
      rewards: string[];
    };
    // The registry claims it, and the value there is one the engine allows.
    expect(vocabularyForPath('quests/kill.json.objective.place')).toBe('questPlace');
    expect(PLACE_KINDS.has(quest.objective.place)).toBe(true);
    expect(PREDICATE_KINDS.has(quest.objective.completedBy)).toBe(true);
    for (const [i, reward] of quest.rewards.entries()) {
      expect(vocabularyForPath(`quests/kill.json.rewards[${i}]`)).toBe('questReward');
      expect(REWARD_KINDS.has(reward)).toBe(true);
    }

    const abilities = files.get('content/abilities.json') as {
      types: Record<string, unknown>;
      table: { type?: string }[];
      gambitsByRole: Record<string, unknown>;
    };
    const types = new Set(Object.keys(abilities.types).filter((k) => !k.startsWith('_')));
    abilities.table.forEach((ability, i) => {
      if (ability.type === undefined) return;
      expect(vocabularyForPath(`content/abilities.json.table[${i}].type`)).toBe('abilityType');
      expect(types.has(ability.type)).toBe(true);
    });
    const role = Object.keys(abilities.gambitsByRole).find((k) => !k.startsWith('_'));
    expect(vocabularyForPath(`content/abilities.json.gambitsByRole.${role}[0].when`)).toBe('gambitCondition');

    const town = files.get('areas/town.json') as { shapes: string[] };
    town.shapes.forEach((_, i) => {
      expect(vocabularyForPath(`areas/town.json.shapes[${i}]`)).toBe('shape');
    });
  });
});
