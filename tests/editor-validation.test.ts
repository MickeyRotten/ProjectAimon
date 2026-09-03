import { describe, expect, it } from 'vitest';
import type { Json } from '../src/campaign/merge';
import { bundledSource } from '../src/campaign/source';
import {
  bundleKeyFor,
  issueBelongsTo,
  issueRoot,
  pathIsUnder,
  validateFiles,
} from '../src/editor/validation';

/**
 * The editor's live validator is a thin adapter over the engine's own checker.
 * These tests pin the path bookkeeping (which is what anchors an issue to a
 * field) and prove the adapter reproduces the loader's verdict — clean base,
 * and a real error the moment a cross-reference is broken.
 */

/** Load the base tables the way the editor holds them: keyed by repo path. */
async function baseFiles(): Promise<Map<string, Json>> {
  const source = bundledSource('base');
  const files = new Map<string, Json>();
  for (const path of await source.list()) {
    const value = await source.read(path);
    if (value !== undefined) files.set(`campaigns/base/${path}`, value);
  }
  return files;
}

describe('editor path bookkeeping', () => {
  it('maps editor paths to campaign-relative bundle keys, dropping globals', () => {
    expect(bundleKeyFor('campaigns/base/areas/town.json')).toBe('areas/town.json');
    expect(bundleKeyFor('campaigns/base/rules.json')).toBe('rules.json');
    expect(bundleKeyFor('data/verbs.json')).toBeNull();
  });

  it('roots issue paths where the validator does', () => {
    expect(issueRoot('campaigns/base/areas/town.json')).toBe('areas/town.json');
    expect(issueRoot('data/verbs.json')).toBe('data/verbs.json');
  });

  it('nests paths on field boundaries, not raw prefixes', () => {
    expect(pathIsUnder('areas/town.json.roomTypes', 'areas/town.json')).toBe(true);
    expect(pathIsUnder('areas/town.json.roomTypes.taproom.tags[0]', 'areas/town.json.roomTypes')).toBe(true);
    // A shared prefix that is not a real boundary must not match.
    expect(pathIsUnder('areas/townhall.json', 'areas/town.json')).toBe(false);
    expect(pathIsUnder('roomTypesExtra', 'roomTypes')).toBe(false);
  });
});

describe('validateFiles over the base campaign', () => {
  it('agrees with the loader: the base is clean', async () => {
    const report = await validateFiles(await baseFiles());
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('catches a broken tag reference and anchors it to the field', async () => {
    const files = await baseFiles();
    const town = structuredClone(files.get('campaigns/base/areas/town.json')) as {
      areaTags: string[];
    };
    town.areaTags = [...(town.areaTags ?? []), 'definitely-not-a-real-tag'];
    files.set('campaigns/base/areas/town.json', town as unknown as Json);

    const report = await validateFiles(files);
    const broken = report.errors.find((i) => i.message.includes('definitely-not-a-real-tag'));
    expect(broken).toBeDefined();
    expect(issueBelongsTo(broken!, 'campaigns/base/areas/town.json')).toBe(true);
    expect(broken!.path.startsWith('areas/town.json.areaTags')).toBe(true);
  });

  it('does not throw on content errors — it tolerates the half-fixed state', async () => {
    const files = await baseFiles();
    files.set('campaigns/base/tags.json', {} as unknown as Json);
    await expect(validateFiles(files)).resolves.toBeDefined();
  });
});
