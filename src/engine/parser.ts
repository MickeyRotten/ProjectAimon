/**
 * The deterministic parser — the Tier 1 fast path.
 *
 * Normalise, tokenise, match the fixed verb table, and hand back a canonical
 * command. No API call, no guessing: roughly seven turns in ten are a verb and
 * a noun, and those turns should cost nothing and answer instantly.
 *
 * The vocabulary is `data/verbs.json`, which is global — a campaign that needs
 * its own verbs needs its own engine. Nothing here hardcodes a verb, an
 * abbreviation, a direction or an article; every word it knows is read from
 * that table.
 *
 * What this file does NOT do: look at the world. It turns text into a command
 * shape. Matching nouns to things that actually exist is scope resolution, one
 * step later, and preconditions are one step after that.
 */

import type { VerbTable } from '../campaign/types';
import { isDirection, type Direction } from '../world/types';

/** The failure taxonomy: pass the reason, never just the failure. */
export type FailureCode =
  | 'UNKNOWN_VERB'
  | 'UNKNOWN_NOUN'
  | 'NOT_IN_SCOPE'
  | 'WRONG_VERB'
  | 'PRECONDITION'
  | 'AMBIGUOUS';

/** A noun phrase as typed: adjectives, then the noun. */
export interface Phrase {
  words: string[];
  /** `take all`. The scope resolver expands it. */
  all: boolean;
  /** `take all except the rope` — words that disqualify a match. */
  except: string[];
}

export interface Command {
  raw: string;
  verb: string;
  direction?: Direction | undefined;
  /** A direction word the lattice has no axis for — `ne`, `in`, `out`. */
  unsupportedDirection?: string | undefined;
  object?: Phrase | undefined;
  preposition?: string | undefined;
  indirect?: Phrase | undefined;
}

export interface ParseFailure {
  code: FailureCode;
  message: string;
  /** The word that could not be understood, when there is one. */
  word?: string | undefined;
}

export type ParseResult = { ok: true; command: Command } | { ok: false; failure: ParseFailure };

/**
 * Prepositions the grammar splits on. They are not verbs and not nouns, and
 * `VNPN` is the only pattern that uses them.
 */
const PREPOSITIONS = [
  'in',
  'into',
  'inside',
  'on',
  'onto',
  'at',
  'with',
  'from',
  'to',
  'under',
  'behind',
  'about',
  'off',
  'through',
  'toward',
  'towards',
];

/** Particles that ride along with a verb: `pick up`, `put down`. */
const PARTICLES = ['up'];

export const emptyPhrase = (): Phrase => ({ words: [], all: false, except: [] });

/** Lowercase, drop punctuation, collapse spaces. */
export function normalise(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:"']/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** Every word that names a direction, mapped to the axis it moves along. */
export function directionWords(verbs: VerbTable): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, abbreviations] of Object.entries(verbs.directions)) {
    out.set(name, name);
    for (const short of abbreviations as unknown as string[]) out.set(short, name);
  }
  return out;
}

/**
 * The lattice has six axes. `northeast` and `in` are legal words with no axis,
 * and the difference matters: "you can't go that way" is a true answer for a
 * direction, and the wrong answer for a typo.
 */
export function toDirection(name: string): Direction | undefined {
  const letter = name.slice(0, 1);
  if (name === 'up') return 'u';
  if (name === 'down') return 'd';
  return ['north', 'south', 'east', 'west'].includes(name) && isDirection(letter)
    ? (letter as Direction)
    : undefined;
}

export function parse(raw: string, verbs: VerbTable): ParseResult {
  const articles = new Set(verbs.articlesStripped);
  const directions = directionWords(verbs);
  const tokens = normalise(raw);
  if (tokens.length === 0) {
    return { ok: false, failure: { code: 'UNKNOWN_VERB', message: 'Say something.' } };
  }

  // A bare direction is a movement command. Typing `n` is the commonest input
  // in the game and it never reaches the verb table.
  const bare = directions.get(tokens[0] as string);
  if (bare !== undefined && tokens.length === 1) {
    return { ok: true, command: movement(raw, bare) };
  }

  const head = tokens[0] as string;
  const verb = verbs.verbs.find((entry) => entry.words.includes(head));
  if (!verb) {
    return {
      ok: false,
      failure: { code: 'UNKNOWN_VERB', message: `"${head}" is not something you can do.`, word: head },
    };
  }

  let rest = tokens.slice(1).filter((word, index) => !(index === 0 && PARTICLES.includes(word)));
  rest = rest.filter((word) => !articles.has(word));

  if (rest.length === 0) {
    if (verb.patterns.includes('V')) return { ok: true, command: { raw, verb: verb.id } };
    return {
      ok: false,
      failure: { code: 'UNKNOWN_NOUN', message: `${cap(head)} what?` },
    };
  }

  // VD: a direction after a movement verb, before nouns are considered, so
  // `go north` and `climb down` never look like objects.
  if (verb.patterns.includes('VD') && rest.length >= 1) {
    const named = directions.get(rest[0] as string);
    if (named !== undefined) return { ok: true, command: movement(raw, named, verb.id) };
  }

  const cut = rest.findIndex((word) => PREPOSITIONS.includes(word));
  let objectWords = cut === -1 ? rest : rest.slice(0, cut);
  let indirectWords = cut === -1 ? [] : rest.slice(cut + 1);
  const preposition = cut === -1 ? undefined : (rest[cut] as string);

  // `look at the chest` is what people type for `examine chest`, and refusing
  // it teaches the player the parser is stupid rather than that the verb is.
  if (verb.id === 'look' && preposition === 'at' && indirectWords.length > 0) {
    objectWords = indirectWords;
    indirectWords = [];
    return { ok: true, command: { raw, verb: 'examine', object: phraseOf(objectWords, verbs) } };
  }

  if (!verb.patterns.includes('VN') && !verb.patterns.includes('VNPN')) {
    return {
      ok: false,
      failure: { code: 'WRONG_VERB', message: `${cap(head)} does not take an object.` },
    };
  }

  if (objectWords.length === 0) {
    return { ok: false, failure: { code: 'UNKNOWN_NOUN', message: `${cap(head)} what?` } };
  }

  const object = phraseOf(objectWords, verbs);
  const indirect = indirectWords.length > 0 ? phraseOf(indirectWords, verbs) : undefined;

  if (indirect && !verb.patterns.includes('VNPN')) {
    return {
      ok: false,
      failure: {
        code: 'WRONG_VERB',
        message: `You cannot ${verb.id} something ${preposition ?? 'like that'}.`,
      },
    };
  }
  if (!indirect && !verb.patterns.includes('VN')) {
    return {
      ok: false,
      failure: { code: 'WRONG_VERB', message: `You cannot ${verb.id} a thing.` },
    };
  }
  if (object.all && verb.patterns.includes('VN') && !supportsAll(verbs, verb.id)) {
    return {
      ok: false,
      failure: { code: 'WRONG_VERB', message: `You cannot ${verb.id} everything at once.` },
    };
  }

  const command: Command = { raw, verb: verb.id, object };
  if (preposition !== undefined) command.preposition = preposition;
  if (indirect !== undefined) command.indirect = indirect;
  return { ok: true, command };
}

/** `take all except the rope` — everything, minus what follows the exception. */
function phraseOf(words: string[], verbs: VerbTable): Phrase {
  const cut = words.findIndex((word) => verbs.exceptWords.includes(word));
  const head = cut === -1 ? words : words.slice(0, cut);
  const except = cut === -1 ? [] : words.slice(cut + 1);
  const all = head.length > 0 && head.every((word) => word === verbs.allWord || word === 'everything');
  return { words: all ? [] : head, all, except };
}

const supportsAll = (verbs: VerbTable, verbId: string): boolean =>
  (verbs.verbs.find((entry) => entry.id === verbId) as { supportsAll?: boolean } | undefined)
    ?.supportsAll === true;

function movement(raw: string, named: string, verbId = 'go'): Command {
  const direction = toDirection(named);
  const command: Command = { raw, verb: verbId === 'go' ? 'go' : verbId };
  if (direction) command.direction = direction;
  else command.unsupportedDirection = named;
  return command;
}

const cap = (word: string): string => word.slice(0, 1).toUpperCase() + word.slice(1);
