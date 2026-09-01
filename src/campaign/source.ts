/**
 * Where table files come from.
 *
 * Two sources exist and both answer the same two questions — what files are
 * there, and what is in one. The loader knows nothing else about storage, so
 * a campaign shipped in the build and a campaign the player imported as a
 * single JSON bundle load through exactly the same path.
 *
 * Paths are campaign-relative and always use forward slashes:
 * `rules.json`, `areas/farmland.json`, `content/items.json`.
 */

import type { Json } from './merge';

export interface TableSource {
  /** For error messages: "base", "saltmere (imported)". */
  readonly label: string;
  /** Every file this source can supply, campaign-relative. */
  list(): Promise<string[]>;
  /** Parsed JSON, or undefined when the source has no such file. */
  read(path: string): Promise<Json | undefined>;
  /** Prompt files (`prompts/*.md`) this source can supply, campaign-relative. */
  listPrompts(): Promise<string[]>;
  /** Raw prompt text, or undefined when the source has no such prompt. */
  readPrompt(path: string): Promise<string | undefined>;
}

/**
 * The campaigns that ship with the build, pulled straight out of
 * `campaigns/` at repo root — the location the design docs name. Vite resolves
 * the glob at build time, so the tables are bundled and there is no fetch path,
 * no public directory and no copy step to keep in sync.
 */
const bundledFiles = import.meta.glob<Json>('/campaigns/**/*.json', { import: 'default' });

/** Prompt fragments — Markdown, read as raw text, never parsed as data. */
const bundledPrompts = import.meta.glob<string>('/campaigns/**/*.md', {
  query: '?raw',
  import: 'default',
});

/** The global verb list. Deliberately outside every campaign folder. */
const globalFiles = import.meta.glob<Json>('/data/*.json', { import: 'default' });

const prefixOf = (campaignId: string) => `/campaigns/${campaignId}/`;

/** Every campaign id present in the build. */
export function bundledCampaignIds(): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(bundledFiles)) {
    const rest = key.slice('/campaigns/'.length);
    const slash = rest.indexOf('/');
    if (slash > 0) ids.add(rest.slice(0, slash));
  }
  return [...ids].sort();
}

export function bundledSource(campaignId: string): TableSource {
  const prefix = prefixOf(campaignId);
  return {
    label: campaignId,
    async list() {
      return Object.keys(bundledFiles)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
    async read(path) {
      const loader = bundledFiles[prefix + path];
      return loader ? await loader() : undefined;
    },
    async listPrompts() {
      return Object.keys(bundledPrompts)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    },
    async readPrompt(path) {
      const loader = bundledPrompts[prefix + path];
      return loader ? await loader() : undefined;
    },
  };
}

/**
 * A campaign the player imported: one JSON bundle, keyed by campaign-relative
 * path. This is the whole of campaign sharing — write JSON, send a file.
 */
export type CampaignBundle = Record<string, Json>;

export function bundleSource(bundle: CampaignBundle, label = 'imported'): TableSource {
  const normalised: CampaignBundle = {};
  for (const [path, value] of Object.entries(bundle)) {
    normalised[path.replace(/^\.?\//, '')] = value;
  }
  return {
    label,
    async list() {
      return Object.keys(normalised)
        .filter((path) => !path.endsWith('.md'))
        .sort();
    },
    async read(path) {
      return path.endsWith('.md') ? undefined : normalised[path];
    },
    async listPrompts() {
      return Object.keys(normalised)
        .filter((path) => path.endsWith('.md') && typeof normalised[path] === 'string')
        .sort();
    },
    async readPrompt(path) {
      const value = normalised[path];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

/** The global tables, which no campaign may override. */
export async function readGlobal(path: string): Promise<Json | undefined> {
  const loader = globalFiles[`/data/${path}`];
  return loader ? await loader() : undefined;
}
