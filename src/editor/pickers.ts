/**
 * Which closed vocabulary a field belongs to, keyed by the field's path.
 *
 * The tag pickers key off the JSON key name alone (`tags`, `requires`, `kind`),
 * which is fine for tags because those key names mean "a tag" wherever they
 * appear — but it does not generalise. `type`, `use`, `when`, `place` and
 * `kind` are ordinary words that mean different things in different files:
 * `fixture.kind` in placement is an object tag, while `objective.kind` in a
 * quest is the quest's own type and not a tag at all. Keying on the field's
 * full path instead — the same path string the validator reports issues at —
 * says exactly which field is meant, and nothing else.
 *
 * Every vocabulary here is one the engine already closes and `validate.ts`
 * already rejects a stray value against. Offering the list is Nielsen's
 * error-prevention heuristic applied to a rule that exists either way: the
 * editor is not inventing a constraint, it is refusing to let one be broken.
 */

import { REQUIRES_KEYS, SINGLE_TAG_KEYS, TAG_LIST_KEYS } from './tagfile';

/** A closed vocabulary a field draws from. */
export type Vocabulary =
  /** A tag from `tags.json`. */
  | 'tag'
  /** A `requires[]` term — a tag, with `!` and `|` allowed. */
  | 'requires'
  /** Explicitly not a picker, overriding the key-name fallback. */
  | 'none'
  | 'questPlace'
  | 'questPredicate'
  | 'questReward'
  | 'abilityType'
  | 'abilityId'
  | 'primerId'
  | 'gambitCondition'
  | 'shape'
  | 'direction'
  | 'archetype'
  /** An area archetype, or the literal "hub" — the one field that allows it. */
  | 'archetypeOrHub'
  | 'hubRoom';

/**
 * Vocabularies whose entries are patterns rather than literal values —
 * `self.hp<N` stands for `self.hp<40`. These get an assisted text input, not a
 * closed dropdown, because the valid set is infinite.
 */
export const TEMPLATED: ReadonlySet<Vocabulary> = new Set<Vocabulary>(['gambitCondition', 'requires']);

/**
 * A path glob. `*` matches one path segment (no dots, no brackets); `#` matches
 * one array index. Everything else is literal — including the `.json` inside a
 * file name, which is why this is a glob rather than a segment walk.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\#]/g, (ch) => (ch === '*' || ch === '#' ? ch : `\\${ch}`))
    .replace(/\*/g, '[^.[\\]]+')
    .replace(/#/g, '\\[\\d+\\]');
  return new RegExp(`^${source}$`);
}

/**
 * Path glob -> vocabulary, first match wins. Paths are rooted where the
 * validator roots them: `quests/kill.json.objective.place`.
 */
const FIELD_VOCABULARIES: ReadonlyArray<readonly [string, Vocabulary]> = [
  // Quests. `objective.kind` is the quest type echoed back, not a tag — it is
  // listed only to stop the key-name fallback from offering tags for it.
  ['quests/*.json.objective.place', 'questPlace'],
  ['quests/*.json.objective.completedBy', 'questPredicate'],
  ['quests/*.json.objective.kind', 'none'],
  ['quests/*.json.rewards#', 'questReward'],
  // Abilities, gambits and primers.
  ['content/abilities.json.table#.type', 'abilityType'],
  ['content/abilities.json.table#.applies', 'primerId'],
  ['content/abilities.json.gambitsByRole.*#.when', 'gambitCondition'],
  ['content/abilities.json.gambitsByRole.*#.use', 'abilityId'],
  // Areas and the hub's ways out.
  ['areas/*.json.shapes#', 'shape'],
  ['campaign.json.startingArea', 'archetypeOrHub'],
  ['campaign.json.gatewayArchetypes#', 'archetype'],
  ['campaign.json.hub.gates#.archetype', 'archetype'],
  ['campaign.json.hub.gates#.dir', 'direction'],
  ['campaign.json.hub.gates#.fromRoom', 'hubRoom'],
  ['campaign.json.hub.npcs#.room', 'hubRoom'],
];

const COMPILED = FIELD_VOCABULARIES.map(([pattern, vocabulary]) => ({
  matches: globToRegExp(pattern),
  vocabulary,
}));

/** The closed vocabulary this exact field draws from, if any. */
export function vocabularyForPath(path: string): Vocabulary | undefined {
  return COMPILED.find((entry) => entry.matches.test(path))?.vocabulary;
}

/**
 * The vocabulary a field draws from: its path if the path is registered above,
 * otherwise the key-name fallback that covers tags wherever they appear.
 */
export function vocabularyFor(path: string, key: string): Vocabulary | undefined {
  const byPath = vocabularyForPath(path);
  if (byPath) return byPath === 'none' ? undefined : byPath;
  if (TAG_LIST_KEYS.has(key) || SINGLE_TAG_KEYS.has(key)) return 'tag';
  if (REQUIRES_KEYS.has(key)) return 'requires';
  return undefined;
}

/** The key a path ends in — `roomTypes.taproom.tags[0]` is still a `tags` field. */
export function keyOf(path: string): string {
  const withoutIndices = path.replace(/\[\d+\]$/, '');
  const dot = withoutIndices.lastIndexOf('.');
  return dot === -1 ? withoutIndices : withoutIndices.slice(dot + 1);
}
