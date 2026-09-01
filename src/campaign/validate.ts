/**
 * Load-time validation.
 *
 * Two jobs, and the first one matters most:
 *
 *  1. **Every tag used anywhere must be in `tags.json`.** The vocabulary is
 *     closed. A typo in a `requires[]` produces a rule that never fires, in
 *     silence, forever — the most likely content bug in the project and the one
 *     least likely to be noticed in play. It already caught a real one during
 *     authoring: `town` carried the `cultivated` area tag, so every town room
 *     matched the farmer role and farmers appeared behind shop counters.
 *  2. **Cross-references resolve.** A gate pointing at an archetype that has no
 *     area file, a hub edge naming a room that does not exist, a starter kit
 *     listing an item base that was renamed.
 *
 * Unknown *keys* are reported and ignored rather than rejected, because a
 * campaign written against a newer build should degrade, not fail. Unknown
 * *tags* are errors, because they cannot degrade — they simply stop working.
 */

import { ruleAt } from '../engine/rules';
import { parseRequires, TagVocabulary } from '../engine/tags';
import { PLACE_KINDS, PREDICATE_KINDS, REWARD_KINDS } from '../world/quests';
import { SHAPES, SHAPE_RULES, isShape } from '../world/shapes';
import { directionBetween, isDirection, opposite } from '../world/types';
import type { Json, JsonObject, MergeIssue } from './merge';
import type { CompositionDef, Cube, ResolvedCampaign } from './types';

export type IssueLevel = 'error' | 'warning';

export interface ValidationIssue {
  readonly level: IssueLevel;
  readonly path: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly campaignId: string;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  /** Tag names the vocabulary knows about. Useful in a debug dump. */
  readonly vocabularySize: number;
  /** Which files came from where, for "what did this campaign change". */
  readonly baseFiles: readonly string[];
  readonly overlayFiles: readonly string[];
  readonly overlayLabel?: string | undefined;
}

export interface ValidateContext {
  mergeIssues?: readonly MergeIssue[];
  basePaths?: readonly string[];
  overlayPaths?: readonly string[];
  overlayLabel?: string | undefined;
}

/** Where a tag was found and what it is allowed to be. */
type TagKind = 'room' | 'creature' | 'object' | 'any';

export function validateCampaign(
  campaign: ResolvedCampaign,
  context: ValidateContext = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const vocabulary = new TagVocabulary(campaign.tags);

  const error = (path: string, message: string) =>
    issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ level: 'warning', path, message });

  for (const issue of context.mergeIssues ?? []) {
    warn(issue.path, issue.message);
  }

  if (vocabulary.size() === 0) {
    error('tags.json', 'the tag vocabulary is empty, so nothing can be validated against it');
  }

  /** Check a literal list of tags. */
  const checkTags = (path: string, tags: unknown, kind: TagKind): void => {
    if (tags === undefined || tags === null) return;
    if (!Array.isArray(tags)) {
      error(path, 'expected an array of tags');
      return;
    }
    tags.forEach((tag, i) => checkTag(`${path}[${i}]`, tag, kind));
  };

  const checkTag = (path: string, tag: unknown, kind: TagKind): void => {
    if (typeof tag !== 'string') {
      error(path, `expected a tag name, found ${JSON.stringify(tag)}`);
      return;
    }
    if (vocabulary.has(tag)) {
      if (kind !== 'any') {
        const namespace = vocabulary.namespaceOf(tag) ?? '';
        if (!namespace.startsWith(kind)) {
          warn(
            path,
            `"${tag}" is a ${namespace.split('.')[0]} tag used where a ${kind} tag is expected`,
          );
        }
      }
      return;
    }
    const suggestions = vocabulary.suggest(tag);
    error(
      path,
      `"${tag}" is not in the tag vocabulary` +
        (suggestions.length ? ` — did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ''),
    );
  };

  /**
   * Check a `requires[]`. Every alternative inside every term has to be a real
   * tag; an unknown one on either side of a `|` is still a rule that half
   * works, which is worse than one that plainly does not.
   */
  const checkRequires = (path: string, requires: unknown, kind: TagKind): void => {
    if (requires === undefined || requires === null) return;
    if (!Array.isArray(requires)) {
      error(path, 'expected an array of requirements');
      return;
    }
    const parsed = parseRequires(requires as string[]);
    parsed.forEach((requirement, i) => {
      if (requirement.alternatives.length === 0) {
        error(`${path}[${i}]`, `"${requirement.source}" names no tags`);
        return;
      }
      for (const alternative of requirement.alternatives) {
        checkTag(`${path}[${i}]`, alternative.tag, kind);
      }
    });
  };

  // ── campaign.json ─────────────────────────────────────────────────

  const { manifest } = campaign;
  const hub = manifest.hub;
  const hubRoomIds = new Set<string>();

  if (!hub) {
    error('campaign.json.hub', 'the hub is hand-authored and required');
  } else {
    for (const [i, room] of (hub.rooms ?? []).entries()) {
      if (hubRoomIds.has(room.id)) {
        error(`campaign.json.hub.rooms[${i}]`, `duplicate room id "${room.id}"`);
      }
      hubRoomIds.add(room.id);
      checkTags(`campaign.json.hub.rooms[${i}].tags`, room.tags, 'room');
    }

    const coordinates = new Set<string>();
    for (const [i, room] of (hub.rooms ?? []).entries()) {
      const key = `${room.x},${room.y},${room.z}`;
      if (coordinates.has(key)) {
        error(`campaign.json.hub.rooms[${i}]`, `two hub rooms occupy ${key}`);
      }
      coordinates.add(key);
      if (hub.cube && !inCube(room, hub.cube)) {
        error(`campaign.json.hub.rooms[${i}]`, `"${room.id}" at ${key} sits outside the hub cube`);
      }
    }

    if (hub.entryRoomId && !hubRoomIds.has(hub.entryRoomId)) {
      error('campaign.json.hub.entryRoomId', `"${hub.entryRoomId}" is not a hub room`);
    }

    const hubRoomsById = new Map((hub.rooms ?? []).map((room) => [room.id, room]));
    for (const [i, edge] of (hub.edges ?? []).entries()) {
      const [from, dir, to] = edge;
      if (!hubRoomIds.has(from)) {
        error(`campaign.json.hub.edges[${i}]`, `"${from}" is not a hub room`);
      }
      if (!hubRoomIds.has(to)) {
        error(`campaign.json.hub.edges[${i}]`, `"${to}" is not a hub room`);
      }
      if (!isDirection(dir)) {
        error(`campaign.json.hub.edges[${i}]`, `"${dir}" is not a direction`);
        continue;
      }
      // Connection implies adjacency, in the Hub as everywhere else: the map
      // draws a connector between the two slots, and it can only do that when
      // they are one step apart in the direction the edge claims.
      const a = hubRoomsById.get(from);
      const b = hubRoomsById.get(to);
      if (a && b && directionBetween(a, b) !== dir) {
        error(
          `campaign.json.hub.edges[${i}]`,
          `"${from}" ${dir} "${to}" does not match their coordinates`,
        );
      }
    }

    // Every hub room must be reachable from the entry, or a hand-authored typo
    // strands the shop behind nothing.
    if (hub.entryRoomId && hubRoomIds.has(hub.entryRoomId)) {
      const reached = reachable(hub.entryRoomId, hub.edges ?? []);
      for (const id of hubRoomIds) {
        if (!reached.has(id)) {
          error('campaign.json.hub.edges', `"${id}" is not reachable from "${hub.entryRoomId}"`);
        }
      }
    }

    // Which directions each hub room has already spent. An edge is walkable
    // from both ends, so it spends a direction at both ends.
    const usedDirections = new Map<string, Set<string>>();
    const spend = (roomId: string, dir: string, path: string): void => {
      const used = usedDirections.get(roomId) ?? new Set<string>();
      if (used.has(dir)) {
        error(path, `"${roomId}" already has a way out going ${dir} — one of them is unwalkable`);
      }
      used.add(dir);
      usedDirections.set(roomId, used);
    };
    for (const [i, edge] of (hub.edges ?? []).entries()) {
      const [from, dir, to] = edge;
      if (!isDirection(dir)) continue;
      spend(from, dir, `campaign.json.hub.edges[${i}]`);
      spend(to, opposite(dir), `campaign.json.hub.edges[${i}]`);
    }

    for (const [i, gate] of (hub.gates ?? []).entries()) {
      if (!isDirection(gate.dir)) {
        error(`campaign.json.hub.gates[${i}].dir`, `"${gate.dir}" is not a direction`);
      } else {
        spend(gate.fromRoom, gate.dir, `campaign.json.hub.gates[${i}].dir`);
      }
      if (!hubRoomIds.has(gate.fromRoom)) {
        error(`campaign.json.hub.gates[${i}].fromRoom`, `"${gate.fromRoom}" is not a hub room`);
      }
      if (!campaign.areas.has(gate.archetype)) {
        error(
          `campaign.json.hub.gates[${i}].archetype`,
          `no area archetype "${gate.archetype}" — the gate would lead nowhere`,
        );
      }
    }

    for (const [i, npc] of (hub.npcs ?? []).entries()) {
      checkTags(`campaign.json.hub.npcs[${i}].tags`, npc.tags, 'creature');
      const location = npc.location ?? '';
      if (location.startsWith('room:')) {
        const roomId = location.slice('room:'.length);
        if (!hubRoomIds.has(roomId)) {
          error(`campaign.json.hub.npcs[${i}].location`, `"${roomId}" is not a hub room`);
        }
      } else if (location !== 'player' && location !== '') {
        warn(`campaign.json.hub.npcs[${i}].location`, `unrecognised location pointer "${location}"`);
      }
    }
  }

  for (const archetype of manifest.gatewayArchetypes ?? []) {
    if (!campaign.areas.has(archetype)) {
      error('campaign.json.gatewayArchetypes', `no area archetype "${archetype}"`);
    }
  }

  const itemBaseIds = new Set((campaign.items.bases ?? []).map((base) => base.id));
  for (const [i, id] of (manifest.starterKit?.items ?? []).entries()) {
    if (!itemBaseIds.has(id)) {
      error(`campaign.json.starterKit.items[${i}]`, `no item base "${id}"`);
    }
  }
  checkTags('campaign.json.starterKit.tags', manifest.starterKit?.tags, 'object');

  const statAttributes = readStringArray(campaign.rules, ['STAT_ROLL', 'attributes']);
  for (const [i, archetype] of (manifest.characterCreation?.archetypes ?? []).entries()) {
    for (const favoured of archetype.favours ?? []) {
      if (statAttributes.length > 0 && !statAttributes.includes(favoured)) {
        error(
          `campaign.json.characterCreation.archetypes[${i}].favours`,
          `"${favoured}" is not one of STAT_ROLL.attributes`,
        );
      }
    }
    for (const id of archetype.kit ?? []) {
      if (!itemBaseIds.has(id)) {
        error(`campaign.json.characterCreation.archetypes[${i}].kit`, `no item base "${id}"`);
      }
    }
  }

  // ── areas ─────────────────────────────────────────────────────────

  for (const [id, area] of campaign.areas) {
    const at = `areas/${id}.json`;
    checkTags(`${at}.areaTags`, area.areaTags, 'room');

    if (!Array.isArray(area.size) || area.size.length !== 2) {
      error(`${at}.size`, 'expected [min, max] room count');
    } else if ((area.size[0] ?? 0) > (area.size[1] ?? 0)) {
      error(`${at}.size`, `min ${area.size[0]} is above max ${area.size[1]}`);
    }

    if (area.tierFloor > area.tierCeil) {
      error(`${at}`, `tierFloor ${area.tierFloor} is above tierCeil ${area.tierCeil}`);
    }

    if (!area.shapes?.length) error(`${at}.shapes`, 'an area must allow at least one graph shape');
    for (const [i, shape] of (area.shapes ?? []).entries()) {
      if (!isShape(shape)) {
        error(
          `${at}.shapes[${i}]`,
          `"${shape}" is not a graph shape the generator builds (${SHAPES.join(', ')})`,
        );
        continue;
      }
      for (const path of SHAPE_RULES[shape]) {
        if (ruleAt(campaign.rules, path) === undefined) {
          error(`rules.json.${path}`, `missing, and "${shape}" areas cannot be generated without it`);
        }
      }
    }
    if (!area.themeTokens?.length) {
      warn(`${at}.themeTokens`, 'no theme tokens, so every generated area here reads the same');
    }

    const roomTypes = Object.entries(area.roomTypes ?? {}).filter(([key]) => !key.startsWith('_'));
    if (roomTypes.length === 0) error(`${at}.roomTypes`, 'an area needs at least one room type');
    let totalWeight = 0;
    for (const [typeId, def] of roomTypes) {
      checkTags(`${at}.roomTypes.${typeId}.tags`, def.tags, 'room');
      totalWeight += def.w ?? 1;
    }
    if (totalWeight <= 0) error(`${at}.roomTypes`, 'every room type has zero weight');

    for (const target of Object.keys(area.gates ?? {})) {
      if (target.startsWith('_')) continue;
      if (!campaign.areas.has(target)) {
        error(`${at}.gates.${target}`, `no area archetype "${target}"`);
      }
    }

    if (area.sexOverride) {
      const total = Object.values(area.sexOverride).reduce((sum, w) => sum + w, 0);
      if (total <= 0) error(`${at}.sexOverride`, 'weights sum to zero');
    }
  }

  if (manifest.startingArea && manifest.startingArea !== 'hub') {
    if (!campaign.areas.has(manifest.startingArea)) {
      error('campaign.json.startingArea', `no area archetype "${manifest.startingArea}"`);
    }
  }

  // ── placement ─────────────────────────────────────────────────────

  for (const [key, rule] of Object.entries(campaign.placement ?? {})) {
    if (key.startsWith('_') || key === 'guarantees') continue;
    const at = `content/placement.json.${key}`;
    const value = rule as {
      chance?: unknown;
      requires?: unknown;
      itemKind?: unknown;
      keyBand?: unknown;
      fixture?: { kind?: unknown; nouns?: unknown; adjectives?: unknown; tags?: unknown };
    };
    if (typeof value.chance !== 'number') {
      error(`${at}.chance`, 'expected a number');
    } else if (value.chance < 0 || value.chance > 1) {
      error(`${at}.chance`, `${value.chance} is outside 0..1`);
    }
    checkRequires(`${at}.requires`, value.requires, 'room');

    // A rule places either an item of some kind or a fixture built from its
    // own vocabulary. Either way the words come from the table, so the table
    // is where a missing one has to be caught.
    if (typeof value.itemKind === 'string' && value.itemKind !== 'any') {
      checkTag(`${at}.itemKind`, value.itemKind, 'object');
    }
    if (value.fixture) {
      const fixtureAt = `${at}.fixture`;
      checkTag(`${fixtureAt}.kind`, value.fixture.kind, 'object');
      checkTags(`${fixtureAt}.tags`, value.fixture.tags as string[] | undefined, 'object');
      if (!Array.isArray(value.fixture.nouns) || value.fixture.nouns.length === 0) {
        error(`${fixtureAt}.nouns`, 'at least one noun, or the parser cannot name it');
      }
      if (!Array.isArray(value.fixture.adjectives) || value.fixture.adjectives.length === 0) {
        error(`${fixtureAt}.adjectives`, 'at least one adjective');
      }
    }
    if (typeof value.keyBand === 'string') {
      const bands = readObject(campaign.rules, ['DISTANCE_BANDS']);
      if (!(value.keyBand in bands)) {
        error(`${at}.keyBand`, `no distance band "${value.keyBand}" in rules.json`);
      }
    }
  }

  // ── items ─────────────────────────────────────────────────────────

  const qualityTags = new Set<string>();
  for (const [i, quality] of (campaign.items.qualities ?? []).entries()) {
    checkTags(`content/items.json.qualities[${i}].tags`, quality.tags, 'object');
    for (const tag of quality.tags ?? []) qualityTags.add(tag);
  }

  const kinds = new Set<string>();
  for (const [i, base] of (campaign.items.bases ?? []).entries()) {
    checkTag(`content/items.json.bases[${i}].kind`, base.kind, 'object');
    kinds.add(base.kind);
    if (!base.nouns?.length) error(`content/items.json.bases[${i}].nouns`, 'at least one noun');
    if (!base.adjectives?.length) {
      error(`content/items.json.bases[${i}].adjectives`, 'at least one adjective');
    }
  }

  // Affixes filter on `[base.kind, ...quality.tags]`, so their requires[] can
  // only ever mention those. An affix requiring a room tag never lands.
  const affixTagUniverse = new Set([...kinds, ...qualityTags]);
  for (const slot of ['prefix', 'suffix'] as const) {
    const affixes = campaign.items.affixes?.[slot] ?? [];
    for (const [i, affix] of affixes.entries()) {
      const at = `content/items.json.affixes.${slot}[${i}]`;
      checkRequires(`${at}.requires`, affix.requires, 'object');
      for (const requirement of parseRequires(affix.requires)) {
        for (const alternative of requirement.alternatives) {
          if (!affixTagUniverse.has(alternative.tag)) {
            warn(
              `${at}.requires`,
              `"${alternative.tag}" is never on an item's kind or quality tags, so this affix can never roll`,
            );
          }
        }
      }
      for (const stat of Object.keys(affix.mods ?? {})) {
        if (!ALLOWED_MODS.has(stat)) {
          error(
            `${at}.mods.${stat}`,
            'an affix may only modify a value the engine already has — no affix introduces a mechanic',
          );
        }
      }
    }
  }

  // ── monsters ──────────────────────────────────────────────────────

  const roleIds = new Set((campaign.monsters.roles ?? []).map((role) => role.id));
  const gambitSets = new Set(
    Object.keys(campaign.abilities.gambitsByRole ?? {}).filter((key) => !key.startsWith('_')),
  );
  const abilityIds = new Set((campaign.abilities.table ?? []).map((ability) => ability.id));
  const primerIds = new Set(
    Object.keys(campaign.abilities.primers ?? {}).filter((key) => !key.startsWith('_')),
  );

  for (const [i, base] of (campaign.monsters.bases ?? []).entries()) {
    const at = `content/monsters.json.bases[${i}]`;
    checkTags(`${at}.tags`, base.tags, 'creature');
    checkRequires(`${at}.requires`, base.requires, 'room');
    for (const areaId of base.areas ?? []) {
      if (!campaign.areas.has(areaId)) {
        error(`${at}.areas`, `no area archetype "${areaId}"`);
      }
    }
    if (!campaign.monsters.statCurve?.[String(base.tier)]) {
      error(`${at}.tier`, `no statCurve entry for tier ${base.tier}`);
    }
  }

  for (const [i, role] of (campaign.monsters.roles ?? []).entries()) {
    const at = `content/monsters.json.roles[${i}]`;
    checkTags(`${at}.tags`, role.tags, 'creature');
    checkTags(`${at}.excludeTags`, role.excludeTags, 'creature');
    if (role.gambits && !gambitSets.has(role.gambits)) {
      error(`${at}.gambits`, `no gambit list "${role.gambits}" in abilities.json`);
    }
  }

  for (const [i, elite] of (campaign.monsters.elites?.table ?? []).entries()) {
    checkTags(`content/monsters.json.elites.table[${i}].tags`, elite.tags, 'creature');
  }

  for (const tag of Object.keys(campaign.monsters.groupSize?.byTag ?? {})) {
    if (tag.startsWith('_')) continue;
    checkTag('content/monsters.json.groupSize.byTag', tag, 'creature');
  }

  for (const [i, composition] of (campaign.monsters.compositions?.table ?? []).entries()) {
    const at = `content/monsters.json.compositions.table[${i}]`;
    checkRequires(`${at}.requires`, composition.requires, 'room');
    for (const [want] of (composition as CompositionDef).parts ?? []) {
      if (want !== 'any' && !roleIds.has(want)) {
        error(`${at}.parts`, `no monster role "${want}"`);
      }
    }
  }

  for (const tag of Object.keys(readObject(campaign.rules, ['TAXONOMY']))) {
    if (tag.startsWith('_')) continue;
    checkTag('rules.json.TAXONOMY', tag, 'creature');
  }

  // ── npcs ──────────────────────────────────────────────────────────

  for (const [i, role] of (campaign.npcs.roles ?? []).entries()) {
    const at = `content/npcs.json.roles[${i}]`;
    checkRequires(`${at}.requires`, role.requires, 'room');
    checkTags(`${at}.tags`, role.tags, 'creature');
    if (!role.quests?.length) {
      warn(`${at}.quests`, 'no quest types, so this role can never give work');
    }
  }

  const template = campaign.npcs.personaTemplate ?? '';
  for (const token of ['{role}', '{traitA}', '{traitB}', '{want}']) {
    if (!template.includes(token)) {
      error('content/npcs.json.personaTemplate', `missing ${token}`);
    }
  }

  // ── quests ────────────────────────────────────────────────────────
  // A role naming a quest type with no template rolls nothing, in silence —
  // exactly the kind of quiet miss the tag check exists to catch.
  const questTypes = new Set(campaign.quests.keys());
  for (const [i, role] of (campaign.npcs.roles ?? []).entries()) {
    for (const type of role.quests ?? []) {
      if (!questTypes.has(type)) {
        warn(
          `content/npcs.json.roles[${i}].quests`,
          `"${type}" has no template in quests/, so this role offers it never`,
        );
      }
    }
  }

  const bandNames = new Set(Object.keys(readObject(campaign.rules, ['DISTANCE_BANDS'])));
  for (const [type, quest] of campaign.quests) {
    const at = `quests/${type}.json`;
    checkRequires(`${at}.targetTags`, quest.targetTags, 'room');
    for (const band of Object.keys(quest.bands ?? {})) {
      if (band.startsWith('_')) continue;
      // `distant` is the one band that is not a hop range: it means another
      // area, and reserves a coordinate rather than reading DISTANCE_BANDS.
      if (band !== 'distant' && !bandNames.has(band)) {
        error(`${at}.bands.${band}`, `no distance band "${band}" in rules.json, and it is not "distant"`);
      }
    }
    if (Object.values(quest.bands ?? {}).every((w) => (w ?? 0) <= 0)) {
      error(`${at}.bands`, 'every band has zero weight, so no objective can ever be placed');
    }
    const objective = quest.objective ?? ({} as typeof quest.objective);
    if (!PLACE_KINDS.has(objective.place)) {
      error(`${at}.objective.place`, `"${objective.place}" is not one of ${[...PLACE_KINDS].join(', ')}`);
    }
    if (!PREDICATE_KINDS.has(objective.completedBy)) {
      error(
        `${at}.objective.completedBy`,
        `"${objective.completedBy}" is not one of ${[...PREDICATE_KINDS].join(', ')}`,
      );
    }
    if (objective.itemKind && objective.itemKind !== 'any') {
      checkTag(`${at}.objective.itemKind`, objective.itemKind, 'object');
    }
    for (const reward of quest.rewards ?? []) {
      if (!REWARD_KINDS.has(reward)) {
        error(`${at}.rewards`, `"${reward}" is not one of ${[...REWARD_KINDS].join(', ')}`);
      }
    }
  }

  // ── abilities ─────────────────────────────────────────────────────

  const abilityTypes = new Set(
    Object.keys(campaign.abilities.types ?? {}).filter((key) => !key.startsWith('_')),
  );
  for (const [i, ability] of (campaign.abilities.table ?? []).entries()) {
    const at = `content/abilities.json.table[${i}]`;
    if (ability.type && !abilityTypes.has(ability.type)) {
      error(`${at}.type`, `"${ability.type}" is not one of ${[...abilityTypes].join(', ')}`);
    }
    if (ability.applies && !primerIds.has(ability.applies)) {
      error(`${at}.applies`, `no primer "${ability.applies}"`);
    }
    for (const primer of ability.triggers ?? []) {
      if (!primerIds.has(primer)) error(`${at}.triggers`, `no primer "${primer}"`);
    }
  }

  const abilityCap = readNumber(campaign.rules, ['ABILITIES', 'baseAbilityCap']);
  if (abilityCap !== undefined && (campaign.abilities.table ?? []).length > abilityCap) {
    error(
      'content/abilities.json.table',
      `${campaign.abilities.table.length} abilities exceeds the hard cap of ${abilityCap}`,
    );
  }

  const gambitConditions = campaign.abilities.gambitConditions ?? [];
  for (const [roleId, gambits] of Object.entries(campaign.abilities.gambitsByRole ?? {})) {
    if (roleId.startsWith('_')) continue;
    for (const [i, gambit] of (gambits ?? []).entries()) {
      const at = `content/abilities.json.gambitsByRole.${roleId}[${i}]`;
      if (!abilityIds.has(gambit.use)) error(`${at}.use`, `no ability "${gambit.use}"`);
      if (!matchesCondition(gambit.when, gambitConditions)) {
        error(`${at}.when`, `"${gambit.when}" is not one of the closed gambit conditions`);
      }
    }
  }

  // ── verbs — global, and a campaign must never shadow them ─────────

  for (const path of context.overlayPaths ?? []) {
    if (path === 'verbs.json' || path.endsWith('/verbs.json')) {
      warn(
        `${context.overlayLabel ?? 'campaign'}:${path}`,
        'verbs are global and this file is ignored — a campaign needing its own verbs needs its own engine',
      );
    }
  }

  const verbPatterns = new Set(
    Object.keys(campaign.verbs.patterns ?? {}).filter((key) => !key.startsWith('_')),
  );
  const seenWords = new Map<string, string>();
  for (const [i, verb] of (campaign.verbs.verbs ?? []).entries()) {
    const at = `data/verbs.json.verbs[${i}]`;
    for (const pattern of verb.patterns ?? []) {
      if (!verbPatterns.has(pattern)) error(`${at}.patterns`, `no grammar pattern "${pattern}"`);
    }
    for (const word of verb.words ?? []) {
      const owner = seenWords.get(word);
      if (owner && owner !== verb.id) {
        error(`${at}.words`, `"${word}" is already claimed by verb "${owner}"`);
      }
      seenWords.set(word, verb.id);
    }
  }

  return {
    campaignId: campaign.id,
    errors: issues.filter((issue) => issue.level === 'error'),
    warnings: issues.filter((issue) => issue.level === 'warning'),
    vocabularySize: vocabulary.size(),
    baseFiles: context.basePaths ?? [],
    overlayFiles: context.overlayPaths ?? [],
    overlayLabel: context.overlayLabel,
  };
}

/**
 * The closed list of values an affix may touch. Taken from the design rule
 * directly: an affix may only modify a value the engine already has. This is
 * what keeps the item system from becoming a second rules engine.
 */
const ALLOWED_MODS = new Set([
  'damage',
  'penetration',
  'accuracy',
  'reduction',
  'penalty',
  'hp',
  'evasion',
  'presence',
  'composure',
  'allure',
  'rapport',
  'threat',
  'critChance',
  'carry',
  'burn',
  'libidoDrift',
  'priceMult',
]);

/** `self.hp<N` in the closed list matches `self.hp<40` in a gambit. */
function matchesCondition(when: string, conditions: readonly string[]): boolean {
  if (!when) return false;
  return conditions.some((pattern) => {
    const source = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/N/g, '-?\\d+')
      .replace(/X/g, '[A-Za-z_][A-Za-z0-9_]*');
    return new RegExp(`^${source}$`).test(when);
  });
}

function inCube(room: { x: number; y: number; z: number }, cube: Cube): boolean {
  const within = (v: number, a: number | undefined, b: number | undefined) =>
    a === undefined || b === undefined || (v >= Math.min(a, b) && v <= Math.max(a, b));
  return (
    within(room.x, cube.x0, cube.x1) &&
    within(room.y, cube.y0, cube.y1) &&
    within(room.z, cube.z0, cube.z1)
  );
}

function reachable(from: string, edges: readonly [string, string, string][]): Set<string> {
  const neighbours = new Map<string, string[]>();
  for (const [a, , b] of edges) {
    if (!neighbours.has(a)) neighbours.set(a, []);
    if (!neighbours.has(b)) neighbours.set(b, []);
    neighbours.get(a)?.push(b);
    neighbours.get(b)?.push(a);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of neighbours.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function readAt(root: Json, path: readonly string[]): Json | undefined {
  let node: Json | undefined = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as JsonObject)[key];
  }
  return node;
}

function readStringArray(root: Json, path: readonly string[]): string[] {
  const value = readAt(root, path);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readNumber(root: Json, path: readonly string[]): number | undefined {
  const value = readAt(root, path);
  return typeof value === 'number' ? value : undefined;
}

function readObject(root: Json, path: readonly string[]): JsonObject {
  const value = readAt(root, path);
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** One-line summary for a boot log or a debug dump. */
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [
    `campaign "${report.campaignId}" — ${report.vocabularySize} tags, ` +
      `${report.baseFiles.length} base file(s)` +
      (report.overlayLabel ? `, ${report.overlayFiles.length} from "${report.overlayLabel}"` : ''),
  ];
  for (const issue of report.errors) lines.push(`  ERROR   ${issue.path}: ${issue.message}`);
  for (const issue of report.warnings) lines.push(`  warning ${issue.path}: ${issue.message}`);
  if (report.errors.length === 0 && report.warnings.length === 0) lines.push('  clean');
  return lines.join('\n');
}
