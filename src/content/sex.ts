/**
 * Sex — a field rolled per instance, never a tag and never a variant.
 *
 * It drives pronouns for the Narrator, pronoun resolution in the parser, and
 * one line of the narration packet. Nothing mechanical reads it, and nothing
 * mechanical may: taxonomy tags are the resistance axis, and a creature that
 * was harder to Seduce because of its sex would be punishing a roll the player
 * never made and cannot see coming.
 *
 * Resolution order, exactly as the design states it:
 *
 *   sex = area.sexOverride ?? room.sexOverride ?? base.sex ?? default
 *
 * `sexOverrideRespects` keeps sexless things sexless, or a themed area forces
 * a gender onto skeletons and clay sentries.
 */

import type { AreaDef, SexWeights } from '../campaign/types';
import type { Rng } from '../engine/rng';

export interface SexOptions {
  rng: Rng;
  /** Absent in the hand-authored Hub, which has no archetype to override from. */
  areaDef?: AreaDef | undefined;
  /** The base's own weights, when it declares any. */
  own?: SexWeights | undefined;
  /** The table default, for a base that declares nothing. */
  fallback: SexWeights;
  /** Accepted by the loader, unused in v1 — the seam is here, not the feature. */
  roomOverride?: SexWeights | undefined;
}

export function rollSex(options: SexOptions): string {
  const { rng, areaDef, own, fallback } = options;
  const declared = own ?? fallback;
  const keys = Object.keys(declared);
  const respected = areaDef?.sexOverrideRespects ?? [];

  // An area override applies unless the thing declares a sex the override
  // respects — which is how `{ "none": 100 }` survives an all-female coven.
  const override = areaDef?.sexOverride ?? options.roomOverride;
  if (override && !keys.some((key) => respected.includes(key))) {
    return pickWeighted(rng, override) ?? pickWeighted(rng, declared) ?? 'none';
  }
  return pickWeighted(rng, declared) ?? 'none';
}

function pickWeighted(rng: Rng, weights: SexWeights): string | undefined {
  const entries = Object.entries(weights)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, w]) => ({ id, w }));
  return rng.maybeWeighted(entries)?.id;
}

/** The pronoun a sex resolves to. The Narrator gets this, not the raw field. */
export const PRONOUNS: Record<string, string> = { m: 'he', f: 'she', none: 'it' };

export const pronounOf = (sex: string): string => PRONOUNS[sex] ?? 'they';
