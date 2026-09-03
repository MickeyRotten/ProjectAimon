/**
 * Live validation for the data editor.
 *
 * The whole point of this file: the engine already ships a full cross-reference
 * checker (`validateCampaign`) that knows every dependency in the game — every
 * tag, gate, gambit, primer, band and predicate. It runs once, at campaign
 * load, into a console log. This adapter runs the *same* checker against the
 * editor's live, unsaved edits, so a bad value is caught the moment it is typed
 * instead of the next time the game boots. No new rules are invented here; this
 * is purely a second caller of the existing validator.
 *
 * The editor holds each file as parsed JSON keyed by its repo-relative path
 * (`campaigns/base/areas/town.json`, `data/verbs.json`). The loader wants a
 * campaign-relative bundle (`areas/town.json`) plus the global verbs read from
 * the build. So the adapter strips the campaign prefix, drops the global files
 * (which the loader sources itself), and asks the loader to validate the rest.
 */

import type { Json } from '../campaign/merge';
import { loadCampaign } from '../campaign/loader';
import { bundleSource, type CampaignBundle } from '../campaign/source';
import type { ValidationIssue, ValidationReport } from '../campaign/validate';

export type { ValidationIssue, ValidationReport } from '../campaign/validate';

const BASE_PREFIX = 'campaigns/base/';

/**
 * The bundle key an editor file maps to, or `null` when the file is not part of
 * the campaign bundle (the global `data/verbs.json`, which the loader reads from
 * the build on its own — so live edits to it are not reflected in validation).
 */
export function bundleKeyFor(editorPath: string): string | null {
  return editorPath.startsWith(BASE_PREFIX) ? editorPath.slice(BASE_PREFIX.length) : null;
}

/**
 * The prefix `validateCampaign` roots this file's issue paths at. Area issues
 * come back as `areas/town.json.…`, placement as `content/placement.json.…`,
 * verbs as `data/verbs.json.…` — always the campaign-relative path, except the
 * global verbs which keep their `data/` prefix.
 */
export function issueRoot(editorPath: string): string {
  return bundleKeyFor(editorPath) ?? editorPath;
}

/** Does this issue belong to this file? (Its path is rooted at the file.) */
export function issueBelongsTo(issue: ValidationIssue, editorPath: string): boolean {
  return pathIsUnder(issue.path, issueRoot(editorPath));
}

/**
 * Is `path` at, or nested under, `base`? Field paths nest with `.key` and
 * `[index]`, so "under" means an exact match or a boundary-respecting prefix —
 * `roomTypes` must not swallow `roomTypesExtra`.
 */
export function pathIsUnder(path: string, base: string): boolean {
  if (path === base) return true;
  if (!path.startsWith(base)) return false;
  const next = path[base.length];
  return next === '.' || next === '[';
}

/**
 * Run the real validator over the editor's live files. Never throws for content
 * errors — `tolerateErrors` keeps the loader from rejecting a campaign the
 * designer is still fixing, which is exactly the state the editor lives in.
 */
export async function validateFiles(
  files: ReadonlyMap<string, Json>,
): Promise<ValidationReport> {
  const bundle: CampaignBundle = {};
  for (const [path, value] of files) {
    const key = bundleKeyFor(path);
    // Clone so the validator can never reach back into the editor's live state,
    // and so a half-typed value cannot be mutated out from under it mid-run.
    if (key) bundle[key] = structuredClone(value);
  }
  const { report } = await loadCampaign({
    baseSource: bundleSource(bundle, 'editor'),
    tolerateErrors: true,
  });
  return report;
}
