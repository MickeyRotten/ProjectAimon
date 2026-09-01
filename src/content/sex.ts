/**
 * Sex resolution — area override, then the thing's own weights, then the
 * table default.
 *
 * It is **narration only**. Nothing downstream of this reads it, exactly like
 * `defeatBy`, and it must stay that way: let an area's override correlate with
 * `lustful` and sex has become a covert difficulty modifier through the back
 * door. Keep the two axes independent.
 */

import type { AreaDef, SexWeights } from '../campaign/types';
import type { Rng } from '../engine/rng';

/**
 * An area override applies unless the thing's own weights name a key the area
 * respects — which is how undead and constructs stay sexless inside an
 * all-female coven.
 */
export function rollSex(
  rng: Rng,
  areaDef: AreaDef | undefined,
  own: SexWeights | undefined,
  fallback: SexWeights,
): string {
  const weights = own ?? fallback;
  const respected = areaDef?.sexOverrideRespects ?? [];
  const override = areaDef?.sexOverride;
  const exempt = Object.keys(weights).some((key) => respected.includes(key));
  return pick(rng, override && !exempt ? override : weights);
}

function pick(rng: Rng, weights: SexWeights): string {
  const entries = Object.entries(weights)
    .filter(([id]) => !id.startsWith('_'))
    .map(([id, w]) => ({ id, w }));
  return rng.maybeWeighted(entries)?.id ?? 'none';
}
