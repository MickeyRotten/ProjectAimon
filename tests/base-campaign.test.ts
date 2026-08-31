import { describe, expect, it } from 'vitest';
import { loadCampaign } from '../src/campaign/loader';
import { formatReport } from '../src/campaign/validate';

/**
 * The base campaign is the reference content. It must load clean, because
 * every campaign is merged over it — a broken base is a broken everything.
 */
describe('the base campaign', () => {
  it('loads with no validation errors', async () => {
    const { report } = await loadCampaign({ tolerateErrors: true });
    if (report.errors.length > 0) {
      throw new Error(`base campaign has validation errors:\n${formatReport(report)}`);
    }
    expect(report.errors).toEqual([]);
  });

  it('has no validation warnings', async () => {
    const { report } = await loadCampaign({ tolerateErrors: true });
    if (report.warnings.length > 0) {
      throw new Error(`base campaign has warnings:\n${formatReport(report)}`);
    }
    expect(report.warnings).toEqual([]);
  });

  it('resolves every table', async () => {
    const { campaign } = await loadCampaign();
    expect(campaign.id).toBe('base');
    expect(campaign.manifest.hub.rooms.length).toBeGreaterThan(0);
    expect(campaign.areas.size).toBe(5);
    expect([...campaign.areas.keys()].sort()).toEqual([
      'coven',
      'farmland',
      'ruin',
      'town',
      'warren',
    ]);
    expect(campaign.items.bases.length).toBeGreaterThan(0);
    expect(campaign.monsters.bases.length).toBeGreaterThan(0);
    expect(campaign.npcs.roles.length).toBeGreaterThan(0);
    expect(campaign.abilities.table.length).toBeGreaterThan(0);
    expect(campaign.verbs.verbs.length).toBeGreaterThan(0);
  });

  it('strips annotation keys from the content tables', async () => {
    const { campaign } = await loadCampaign();
    expect(Object.keys(campaign.placement)).not.toContain('_note');
    expect(Object.keys(campaign.monsters)).not.toContain('_note');
  });

  it('keeps rules.json intact, because it is read by key and never enumerated', async () => {
    const { campaign } = await loadCampaign();
    expect(campaign.rules.WEAPON_TABLE).toBeDefined();
    expect(campaign.rules.DEPTH_TIER).toBeDefined();
  });

  it('loads verbs from outside the campaign folder', async () => {
    const { campaign } = await loadCampaign();
    expect(campaign.verbs.verbs.some((verb) => verb.id === 'use')).toBe(true);
  });

  it('has a tag vocabulary every table validates against', async () => {
    const { report } = await loadCampaign();
    expect(report.vocabularySize).toBeGreaterThan(40);
  });
});
