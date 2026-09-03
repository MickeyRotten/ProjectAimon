import { describe, expect, it } from 'vitest';
import { CampaignLoadError, loadCampaign } from '../src/campaign/loader';
import { bundleSource, bundledCampaignIds, bundledSource } from '../src/campaign/source';
import type { CampaignBundle } from '../src/campaign/source';
import type { ValidationReport } from '../src/campaign/validate';

/** Load a synthetic campaign layered over the real base. */
const load = (bundle: CampaignBundle, tolerateErrors = true) =>
  loadCampaign({
    campaignId: 'saltmere',
    campaignSource: bundleSource(bundle, 'saltmere'),
    tolerateErrors,
  });

const messages = (report: ValidationReport) =>
  [...report.errors, ...report.warnings].map((issue) => `${issue.path}: ${issue.message}`);

describe('campaign sources', () => {
  it('finds the campaigns that ship with the build', () => {
    expect(bundledCampaignIds()).toContain('base');
  });

  it('lists a campaign relative to its own folder', async () => {
    const paths = await bundledSource('base').list();
    expect(paths).toContain('rules.json');
    expect(paths).toContain('areas/farmland.json');
    expect(paths.some((path) => path.startsWith('/'))).toBe(false);
  });

  it('does not serve verbs.json from inside a campaign', async () => {
    expect(await bundledSource('base').read('verbs.json')).toBeUndefined();
  });
});

describe('layering a campaign over base', () => {
  it('overrides only what it names and inherits the rest', async () => {
    const { campaign } = await load({
      'areas/farmland.json': { name: 'The Saltings', tierCeil: 3 },
    });
    const farmland = campaign.areas.get('farmland');
    expect(farmland?.name).toBe('The Saltings');
    expect(farmland?.tierCeil).toBe(3);
    // Never restated, so it must come through from base.
    expect(farmland?.roomTypes.barn).toBeDefined();
    expect(farmland?.themeTokens.length).toBeGreaterThan(0);
  });

  it('adds an area of its own without restating the others', async () => {
    const { campaign } = await load({
      'areas/saltflat.json': {
        id: 'saltflat',
        name: 'Salt Flats',
        size: [6, 10],
        shapes: ['loop'],
        areaTags: ['outdoor'],
        themeTokens: ['brine', 'glare'],
        roomTypes: { pan: { w: 10, tags: ['outdoor', 'open'] } },
        gates: { farmland: 100 },
        sexOverride: null,
        sexOverrideRespects: ['none'],
        tierFloor: 1,
        tierCeil: 3,
      },
    });
    expect(campaign.areas.size).toBe(6);
    expect(campaign.areas.get('saltflat')?.name).toBe('Salt Flats');
    expect(campaign.areas.get('warren')).toBeDefined();
  });

  it('appends to a base list with a + key', async () => {
    const base = await loadCampaign();
    const baseTokens = base.campaign.areas.get('farmland')?.themeTokens ?? [];
    const { campaign } = await load({
      'areas/farmland.json': { '+themeTokens': ['saltwind'] },
    });
    expect(campaign.areas.get('farmland')?.themeTokens).toEqual([...baseTokens, 'saltwind']);
  });

  it('replaces a base list outright without a + key', async () => {
    const { campaign } = await load({ 'areas/farmland.json': { shapes: ['loop'] } });
    expect(campaign.areas.get('farmland')?.shapes).toEqual(['loop']);
  });

  it('retunes a single rule without restating rules.json', async () => {
    const { campaign } = await load({ 'rules.json': { PARTY_LIMIT: 2 } });
    expect(campaign.rules.PARTY_LIMIT).toBe(2);
    expect(campaign.rules.WEAPON_TABLE).toBeDefined();
  });

  it('extends the tag vocabulary, which is what lets it use new tags', async () => {
    const { campaign, report } = await load({
      'tags.json': { room: { mood: { briny: 'a faint tang of brine and salt, common near the coast' } } },
      'areas/farmland.json': { '+areaTags': ['briny'] },
    });
    expect(report.errors).toEqual([]);
    expect(campaign.areas.get('farmland')?.areaTags).toContain('briny');
  });

  it('rejects a new tag with no description', async () => {
    const { report } = await load({
      'tags.json': { room: { mood: { briny: '' } } },
    });
    expect(messages(report)).toContain('tags.json.room.mood.briny: "briny" has no description');
  });

  it('applies settings-screen overrides on top of the campaign', async () => {
    const { campaign } = await loadCampaign({
      campaignId: 'saltmere',
      campaignSource: bundleSource({ 'content/placement.json': { loot: { chance: 0.5 } } }),
      overrides: { 'content/placement.json': { loot: { chance: 0.9 } } },
    });
    expect((campaign.placement.loot as { chance: number }).chance).toBe(0.9);
  });

  it('ignores a campaign verbs.json and says so, because verbs are global', async () => {
    const { campaign, report } = await load({
      'verbs.json': { verbs: [{ id: 'yodel', words: ['yodel'], patterns: ['V'] }] },
    });
    expect(campaign.verbs.verbs.some((verb) => verb.id === 'yodel')).toBe(false);
    expect(messages(report).join('\n')).toMatch(/verbs are global/);
  });
});

describe('validation catches content bugs', () => {
  it('rejects a tag that is not in the vocabulary, and suggests the near miss', async () => {
    const { report } = await load({ 'areas/farmland.json': { areaTags: ['cultivted'] } });
    expect(messages(report).join('\n')).toMatch(/"cultivted" is not in the tag vocabulary/);
    expect(messages(report).join('\n')).toMatch(/did you mean "cultivated"/);
  });

  it('rejects an unknown tag inside a requires[] alternative', async () => {
    const { report } = await load({
      'content/placement.json': { loot: { chance: 0.2, requires: ['indoor|celler'] } },
    });
    expect(messages(report).join('\n')).toMatch(/"celler" is not in the tag vocabulary/);
  });

  it('rejects a gate pointing at an archetype with no area', async () => {
    const { report } = await load({ 'areas/farmland.json': { gates: { atlantis: 20 } } });
    expect(messages(report).join('\n')).toMatch(/no area archetype "atlantis"/);
  });

  it('rejects a hub gate leading nowhere', async () => {
    const base = await loadCampaign();
    const hub = base.campaign.manifest.hub;
    const { report } = await load({
      'campaign.json': {
        hub: { gates: [{ fromRoom: hub.gates[0]!.fromRoom, dir: 'e', archetype: 'nowhere' }] },
      },
    });
    expect(messages(report).join('\n')).toMatch(/no area archetype "nowhere"/);
  });

  it('rejects a hub room stranded with no way to reach it', async () => {
    const { report } = await load({
      'campaign.json': { hub: { edges: [['hub_yard', 'n', 'hub_hall']] } },
    });
    expect(messages(report).join('\n')).toMatch(/is not reachable from "hub_yard"/);
  });

  it('rejects a starter kit item that no base defines', async () => {
    const { report } = await load({ 'campaign.json': { starterKit: { items: ['zweihander'] } } });
    expect(messages(report).join('\n')).toMatch(/no item base "zweihander"/);
  });

  it('rejects an affix that invents a mechanic the engine does not have', async () => {
    const { report } = await load({
      'content/items.json': {
        affixes: {
          prefix: [{ id: 'haunted', name: 'Haunted', requires: ['weapon'], mods: { fear: 3 } }],
        },
      },
    });
    expect(messages(report).join('\n')).toMatch(/may only modify a value the engine already has/);
  });

  it('warns about an affix whose requires can never match an item', async () => {
    const { report } = await load({
      'content/items.json': {
        affixes: {
          suffix: [{ id: 'of_caves', name: 'of Caves', requires: ['underground'], mods: {} }],
        },
      },
    });
    expect(messages(report).join('\n')).toMatch(/can never roll/);
  });

  it('rejects a gambit naming an ability that does not exist', async () => {
    const { report } = await load({
      'content/abilities.json': {
        gambitsByRole: { brute: [{ when: 'always', use: 'fireball' }] },
      },
    });
    expect(messages(report).join('\n')).toMatch(/no ability "fireball"/);
  });

  it('rejects a gambit condition outside the closed list', async () => {
    const { report } = await load({
      'content/abilities.json': {
        gambitsByRole: { brute: [{ when: 'moon.phase==full', use: 'attack' }] },
      },
    });
    expect(messages(report).join('\n')).toMatch(/not one of the closed gambit conditions/);
  });

  it('accepts the parameterised forms of a closed gambit condition', async () => {
    const { report } = await load({
      'content/abilities.json': {
        gambitsByRole: {
          brute: [
            { when: 'self.hp<40', use: 'attack' },
            { when: 'target.primer==off_balance', use: 'attack' },
            { when: 'round==1', use: 'attack' },
            { when: 'always', use: 'attack' },
          ],
        },
      },
    });
    expect(report.errors).toEqual([]);
  });

  it('rejects a monster role whose gambit list does not exist', async () => {
    const { report } = await load({
      'content/monsters.json': {
        roles: [{ id: 'sapper', w: 5, name: '', mods: {}, gambits: 'sapper', excludeTags: [] }],
      },
    });
    expect(messages(report).join('\n')).toMatch(/no gambit list "sapper"/);
  });

  it('rejects a monster placed in an area that does not exist', async () => {
    const { report } = await load({
      'content/monsters.json': {
        bases: [
          {
            id: 'kraken',
            name: 'kraken',
            w: 1,
            tier: 1,
            tags: ['beast'],
            areas: ['the_deep'],
          },
        ],
      },
    });
    expect(messages(report).join('\n')).toMatch(/no area archetype "the_deep"/);
  });

  it('rejects a composition asking for a role that does not exist', async () => {
    const { report } = await load({
      'content/monsters.json': {
        compositions: { table: [{ id: 'siege', name: 'siege', parts: [['sapper', 1, 2]] }] },
      },
    });
    expect(messages(report).join('\n')).toMatch(/no monster role "sapper"/);
  });

  it('rejects an ability table over the hard cap', async () => {
    const base = await loadCampaign();
    const cap = (base.campaign.rules.ABILITIES as { baseAbilityCap: number }).baseAbilityCap;
    const filler = Array.from({ length: cap + 1 }, (_, i) => ({
      id: `filler_${i}`,
      name: `Filler ${i}`,
      type: 'atwill',
      targets: 'enemy',
      grantedBy: 'always',
      effect: {},
    }));
    const { report } = await load({ 'content/abilities.json': { table: filler } });
    expect(messages(report).join('\n')).toMatch(/exceeds the hard cap/);
  });

  it('rejects an impossible area size range', async () => {
    const { report } = await load({ 'areas/farmland.json': { size: [20, 4] } });
    expect(messages(report).join('\n')).toMatch(/min 20 is above max 4/);
  });

  it('rejects a placement chance outside 0..1', async () => {
    const { report } = await load({ 'content/placement.json': { loot: { chance: 1.5 } } });
    expect(messages(report).join('\n')).toMatch(/outside 0\.\.1/);
  });

  it('warns when a creature tag is used where a room tag belongs', async () => {
    const { report } = await load({ 'areas/farmland.json': { '+areaTags': ['undead'] } });
    expect(messages(report).join('\n')).toMatch(/creature tag used where a room tag is expected/);
  });

  it('throws by default rather than loading a broken campaign', async () => {
    await expect(
      loadCampaign({
        campaignId: 'saltmere',
        campaignSource: bundleSource({ 'areas/farmland.json': { areaTags: ['nonsense'] } }),
      }),
    ).rejects.toBeInstanceOf(CampaignLoadError);
  });

  it('throws when a core table is missing from base', async () => {
    await expect(
      loadCampaign({ baseSource: bundleSource({ 'rules.json': {} }, 'stub') }),
    ).rejects.toThrow(/missing campaign\.json/);
  });
});
