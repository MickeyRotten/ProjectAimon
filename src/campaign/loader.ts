/**
 * Campaign and table loader.
 *
 * Loads the base campaign, merges a campaign's overrides over it file by file,
 * applies any settings-screen tuning on top, validates the result against the
 * closed tag vocabulary, and hands back one resolved set of tables.
 *
 * Three rules from the design shape all of it:
 *
 *  - **A campaign supplies overrides only.** Never require a campaign to
 *    restate a value it does not change. Base is always loaded first, and the
 *    campaign layer is merged over it.
 *  - **Verbs are global.** `verbs.json` lives outside every campaign folder.
 *    A campaign needing its own verbs needs its own engine.
 *  - **Validation fails loudly.** An unknown tag is a rule that quietly never
 *    fires, so it stops the load rather than reaching generation.
 */

import { mergeLayers, withoutNotes, type Json, type JsonObject, type MergeIssue } from './merge';
import { bundledSource, readGlobal, type TableSource } from './source';
import { validateCampaign, type ValidationReport } from './validate';
import type {
  AbilityTable,
  AreaDef,
  CampaignManifest,
  ItemTable,
  MonsterTable,
  NpcTable,
  PlacementTable,
  QuestTemplate,
  ResolvedCampaign,
  RulesTable,
  VerbTable,
} from './types';

export const BASE_CAMPAIGN_ID = 'base';

/** Files every campaign layer resolves to. Missing from base is fatal. */
const CORE_FILES = [
  'campaign.json',
  'rules.json',
  'tags.json',
  'content/items.json',
  'content/monsters.json',
  'content/npcs.json',
  'content/abilities.json',
  'content/placement.json',
] as const;

/** Loaded from `data/`, never from a campaign. */
const GLOBAL_FILES = ['verbs.json'] as const;

export interface LoadOptions {
  /** Defaults to `base`. */
  campaignId?: string;
  /** Override the base layer — tests and imported bundles. */
  baseSource?: TableSource;
  /** Override the campaign layer. Defaults to the bundled campaign. */
  campaignSource?: TableSource;
  /**
   * Settings-screen tuning, applied over everything, keyed by campaign-relative
   * path. This is the seam that makes "changing the world means changing a
   * number" reachable from inside the game.
   */
  overrides?: Record<string, Json>;
  /** Load anyway when validation finds errors. For authoring tools only. */
  tolerateErrors?: boolean;
}

export interface LoadedCampaign {
  readonly campaign: ResolvedCampaign;
  readonly report: ValidationReport;
}

export class CampaignLoadError extends Error {
  constructor(
    message: string,
    readonly report?: ValidationReport,
  ) {
    super(message);
    this.name = 'CampaignLoadError';
  }
}

export async function loadCampaign(options: LoadOptions = {}): Promise<LoadedCampaign> {
  const campaignId = options.campaignId ?? BASE_CAMPAIGN_ID;
  const base = options.baseSource ?? bundledSource(BASE_CAMPAIGN_ID);
  const overlay =
    campaignId === BASE_CAMPAIGN_ID
      ? undefined
      : (options.campaignSource ?? bundledSource(campaignId));

  const basePaths = await base.list();
  const overlayPaths = overlay ? await overlay.list() : [];
  const mergeIssues: MergeIssue[] = [];

  const resolveFile = async (path: string): Promise<Json | undefined> => {
    const layers: Json[] = [];
    const fromBase = await base.read(path);
    if (fromBase !== undefined) layers.push(fromBase);
    if (overlay) {
      const fromOverlay = await overlay.read(path);
      if (fromOverlay !== undefined) layers.push(fromOverlay);
    }
    const fromSettings = options.overrides?.[path];
    if (fromSettings !== undefined) layers.push(fromSettings);
    if (layers.length === 0) return undefined;

    const { value, issues } = mergeLayers(...layers);
    for (const issue of issues) {
      mergeIssues.push({ path: `${path}:${issue.path}`, message: issue.message });
    }
    return value;
  };

  const files = new Map<string, Json>();
  for (const path of CORE_FILES) {
    const value = await resolveFile(path);
    if (value === undefined) {
      throw new CampaignLoadError(
        `campaign "${campaignId}" is missing ${path}, and neither is base "${base.label}"`,
      );
    }
    files.set(path, value);
  }

  // Areas are the union of both layers: a campaign may retune an existing
  // archetype or add one of its own, and does not have to restate the rest.
  const areaPaths = [...new Set([...basePaths, ...overlayPaths])]
    .filter((path) => path.startsWith('areas/') && path.endsWith('.json'))
    .sort();
  const areas = new Map<string, AreaDef>();
  for (const path of areaPaths) {
    const value = await resolveFile(path);
    if (value === undefined) continue;
    const area = withoutNotes(value) as unknown as AreaDef;
    const id = area.id ?? path.slice('areas/'.length, -'.json'.length);
    areas.set(id, { ...area, id });
  }

  // Quests are the union of both layers, exactly like areas: a campaign may add
  // a quest type or retune one, and never has to restate the rest.
  const questPaths = [...new Set([...basePaths, ...overlayPaths])]
    .filter((path) => path.startsWith('quests/') && path.endsWith('.json'))
    .sort();
  const quests = new Map<string, QuestTemplate>();
  for (const path of questPaths) {
    const value = await resolveFile(path);
    if (value === undefined) continue;
    const template = withoutNotes(value) as unknown as QuestTemplate;
    const type = template.type ?? path.slice('quests/'.length, -'.json'.length);
    quests.set(type, { ...template, type });
  }

  const globals = new Map<string, Json>();
  for (const path of GLOBAL_FILES) {
    const value = await readGlobal(path);
    if (value === undefined) {
      throw new CampaignLoadError(`global table data/${path} is missing`);
    }
    globals.set(path, value);
  }

  const strip = <T>(path: string): T => withoutNotes(files.get(path) as Json) as unknown as T;

  const campaign: ResolvedCampaign = {
    id: campaignId,
    manifest: strip<CampaignManifest>('campaign.json'),
    // `rules.json` is passed through with its notes intact. It is read by key
    // at runtime and never enumerated, so stripping buys nothing and the notes
    // are useful in a debug dump.
    rules: files.get('rules.json') as RulesTable,
    tags: files.get('tags.json') as JsonObject,
    areas,
    items: strip<ItemTable>('content/items.json'),
    monsters: strip<MonsterTable>('content/monsters.json'),
    npcs: strip<NpcTable>('content/npcs.json'),
    abilities: strip<AbilityTable>('content/abilities.json'),
    placement: withoutNotes(files.get('content/placement.json') as Json) as unknown as PlacementTable,
    quests,
    verbs: withoutNotes(globals.get('verbs.json') as Json) as unknown as VerbTable,
  };

  const report = validateCampaign(campaign, {
    mergeIssues,
    basePaths,
    overlayPaths,
    overlayLabel: overlay?.label,
  });

  if (report.errors.length > 0 && !options.tolerateErrors) {
    throw new CampaignLoadError(
      `campaign "${campaignId}" failed validation with ${report.errors.length} error(s):\n` +
        report.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      report,
    );
  }

  return { campaign, report };
}
