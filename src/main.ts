/**
 * Boot.
 *
 * Step 1 of the build order is the campaign loader, the table loader and the
 * tag system. There is no game yet, so this screen is exactly what those three
 * can honestly show: the tables resolved, and what validation made of them.
 *
 * It is replaced by the real presentation layer at step 4.
 */

import './boot.css';
import { loadCampaign } from './campaign/loader';
import { formatReport } from './campaign/validate';

const el = document.getElementById('boot') as HTMLElement;

const escape = (text: string) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

async function boot(): Promise<void> {
  try {
    const { campaign, report } = await loadCampaign({ tolerateErrors: true });
    const status =
      report.errors.length > 0
        ? `<span class="err">${report.errors.length} error(s)</span>`
        : report.warnings.length > 0
          ? `<span class="warn">${report.warnings.length} warning(s)</span>`
          : '<span class="ok">clean</span>';

    el.innerHTML = [
      `<h1>Aimon — ${escape(campaign.manifest.name)} v${escape(campaign.manifest.version)}</h1>`,
      `tables loaded, validation ${status}`,
      '',
      `  areas       ${campaign.areas.size}  <span class="dim">${escape([...campaign.areas.keys()].join(' '))}</span>`,
      `  hub rooms   ${campaign.manifest.hub.rooms.length}`,
      `  item bases  ${campaign.items.bases.length} x ${campaign.items.qualities.length} qualities`,
      `  monsters    ${campaign.monsters.bases.length} bases, ${campaign.monsters.roles.length} roles`,
      `  npc roles   ${campaign.npcs.roles.length}`,
      `  abilities   ${campaign.abilities.table.length}`,
      `  verbs       ${campaign.verbs.verbs.length}`,
      `  tags        ${report.vocabularySize}`,
      '',
      `<span class="dim">${escape(formatReport(report))}</span>`,
      '',
      '<span class="dim">Next: the graph generator. Nothing is playable yet.</span>',
    ].join('\n');
  } catch (error) {
    el.innerHTML = `<h1 class="err">boot failed</h1>${escape(String(error))}`;
  }
}

void boot();
