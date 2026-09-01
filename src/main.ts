/**
 * Boot.
 *
 * Step 1 was the loader, step 2 the graph generator; this is step 3, the
 * placement roller. There is still nothing to play — movement, the map and
 * inventory arrive at step 4 — so the screen shows exactly what the generator
 * can honestly show: a world built from the real tables, a few areas walked
 * out from the Hub, the map of each one drawn from its rooms and edges, and
 * now what is standing in those rooms.
 *
 * The seed is fixed, so this page is the same world every reload. Reload with
 * `?seed=whatever` to see a different one.
 */

import './boot.css';
import { loadCampaign } from './campaign/loader';
import { formatReport } from './campaign/validate';
import { itemValues } from './content/items';
import { describeArea, levelsOf, renderAreaMap } from './world/map';
import { World } from './world/world';
import type { ObjectRecord, RoomRecord } from './world/types';

const el = document.getElementById('boot') as HTMLElement;

const escape = (text: string) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

/** Walk through gates, entry-first, until `wanted` areas have been generated. */
function explore(world: World, wanted: number): void {
  for (let i = 0; i < wanted; i++) {
    const gate = [...world.edges.values()].find((edge) => edge.roomB === null);
    if (!gate) return;
    world.enterGate(gate.id);
  }
}

async function boot(): Promise<void> {
  try {
    const { campaign, report } = await loadCampaign({ tolerateErrors: true });
    const status =
      report.errors.length > 0
        ? `<span class="err">${report.errors.length} error(s)</span>`
        : report.warnings.length > 0
          ? `<span class="warn">${report.warnings.length} warning(s)</span>`
          : '<span class="ok">clean</span>';

    const seed = new URLSearchParams(location.search).get('seed') ?? 'saltmere-0001';
    const world = World.create({ campaign, seed });
    explore(world, 3);

    const walked = [...world.areas.values()].filter((area) => area.generated && area.id !== 'hub');
    const stubs = [...world.areas.values()].filter((area) => !area.generated);

    /** What is in a room, read the only way anything reads it: by pointer. */
    const contentsOf = (room: RoomRecord): string => {
      const label = (object: ObjectRecord): string => {
        const held = world.contentsOfObject(object.id);
        const inside = held.length > 0 ? ` {${held.map((entry) => entry.name).join(', ')}}` : '';
        const worth = object.gold !== undefined ? ` ${object.gold}g` : '';
        const price =
          object.flags.takeable && object.gold === undefined
            ? ` ${itemValues(campaign, object)['price']}g`
            : '';
        return `${object.name}${worth}${price}${inside}`;
      };
      const loose = world.objectsIn(room.id).map(label);
      const people = world
        .npcsIn(room.id)
        .map((npc) => `${npc.hostile ? '!' : '@'}${npc.name}`);
      return [...loose, ...people].join(' · ');
    };

    const areaBlocks = walked.flatMap((area) => {
      const rooms = world.roomsOf(area.id);
      const maps = levelsOf(world, area.id).map((z) => {
        const level = renderAreaMap(world, area.id, { z, here: area.entryRoomId ?? undefined });
        const label = levelsOf(world, area.id).length > 1 ? `  <span class="dim">z ${z}</span>\n` : '';
        return `${label}${escape(level)}`;
      });
      const filled = rooms
        .map((room) => ({ room, line: contentsOf(room) }))
        .filter((entry) => entry.line.length > 0)
        .map(
          (entry) =>
            `  ${escape((entry.room.id.split(':').pop() as string).padEnd(4))}${escape(entry.room.type.padEnd(12))}${escape(entry.line)}`,
        );

      return [
        '',
        `<span class="ok">${escape(area.name)}</span> <span class="dim">${escape(area.archetype)} · ${escape(area.shape)} · depth ${area.depth} · tier ${area.tier} · ${rooms.length} rooms · ${escape(area.themeTokens.join(' + '))}</span>`,
        '',
        ...maps,
        '',
        `<span class="dim">${escape(describeArea(world, area.id))}</span>`,
        '',
        ...filled,
      ];
    });

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
      `world seed <span class="ok">${escape(seed)}</span> — ${world.rooms.size} rooms, ${world.edges.size} edges, ${walked.length} areas walked, ${stubs.length} cubes reserved behind gates`,
      `${world.objects.size} objects and ${world.npcs.size} people placed, ${[...world.npcs.values()].filter((npc) => npc.hostile).length} of them hostile`,
      '',
      `<span class="dim">${escape(renderAreaMap(world, 'hub', { here: campaign.manifest.hub.entryRoomId }))}</span>`,
      ...areaBlocks,
      '',
      world.notes.length > 0
        ? `<span class="warn">${escape(world.notes.join('\n'))}</span>`
        : '<span class="dim">generation logged nothing: no repacks, no dropped edges, no long roads.</span>',
      '',
      '<span class="dim">Next: movement, the map and inventory — the honest checkpoint. Still nothing to play.</span>',
    ].join('\n');
  } catch (error) {
    el.innerHTML = `<h1 class="err">boot failed</h1>${escape(String(error))}`;
  }
}

void boot();
