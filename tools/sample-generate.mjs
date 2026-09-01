// Reference generator — proves the tables produce sane output.
// Not production code; it is the shape the engine follows.
import fs from 'fs';
const J = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const rules = J('rules.json'), items = J('content/items.json'),
      mons = J('content/monsters.json'), npcs = J('content/npcs.json'),
      abil = J('content/abilities.json'),
      place = J('content/placement.json');

// Seeds MUST be avalanched before use. A raw LCG fed sequential seeds
// produces correlated first outputs, so the first roll of each run comes
// out nearly identical — the same class of bug as the FNV-1a parity trap
// documented in the gameplay rules. murmur3 finalizer fixes it.
const mix = h => { h = Math.imul(h ^ (h >>> 16), 2246822507);
                   h = Math.imul(h ^ (h >>> 13), 3266489909);
                   return (h ^ (h >>> 16)) >>> 0; };
let seed = mix(Number(process.argv[3] ?? 20260831));
const rnd = () => (seed = mix((seed * 1664525 + 1013904223) >>> 0)) / 4294967296;
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => { const t = arr.reduce((s, o) => s + (o.w ?? 1), 0); let r = rnd() * t;
  for (const o of arr) { r -= (o.w ?? 1); if (r <= 0) return o; } return arr.at(-1); };
const pickObj = obj => pick(Object.entries(obj).map(([id, v]) => ({ id, ...v })));
// sex resolves area -> base -> default. `sexOverrideRespects` keeps
// sexless things (undead, constructs) out of an area override.
const rollSex = (areaDef, base, defaults) => {
  const own = base.sex ?? defaults;
  const keys = Object.keys(own);
  const respected = areaDef.sexOverrideRespects ?? [];
  if (areaDef.sexOverride && !keys.some(k => respected.includes(k)))
    return pick(Object.entries(areaDef.sexOverride).map(([id, w]) => ({ id, w }))).id;
  return pick(Object.entries(own).map(([id, w]) => ({ id, w }))).id;
};
const PRON = { m: 'he', f: 'she', none: 'it' };

const die = s => { const [n, f] = s.split('d').map(Number); let t = 0; for (let i = 0; i < n; i++) t += ri(1, f); return t; };

// tag matching: "a|b" any, "!a" not, "a" must
const has = (tags, req) => req.every(r =>
  r.startsWith('!') ? !tags.includes(r.slice(1))
  : r.includes('|') ? r.split('|').some(x => tags.includes(x))
  : tags.includes(r));

// ── TIER ────────────────────────────────────────────────────────────
// Difficulty follows distance from the Hub, in steps, with jitter so the
// curve is not a straight line. Rolled once and stored: an area never
// changes tier, so walking back through is always safe.
function rollTier(areaDef, depth) {
  const D = rules.DEPTH_TIER;
  let t = D.base + Math.floor(depth / D.step);
  t += pick(D.jitter.map(([v, w]) => ({ id: v, w }))).id;
  if (rnd() < D.spikeChance) t += D.spikeBonus;
  return Math.max(areaDef.tierFloor, Math.min(areaDef.tierCeil, Math.min(D.max, t)));
}

// ── AREA ────────────────────────────────────────────────────────────
function genArea(id, depth = 0) {
  const a = J(`areas/${id}.json`);
  const runId = Math.floor(rnd() * 0xfffff).toString(16).padStart(5, '0');
  a.tier = rollTier(a, depth);
  const n = ri(...a.size), shape = a.shapes[ri(0, a.shapes.length - 1)];
  const rooms = [], edges = [];
  for (let i = 0; i < n; i++) {
    const t = pickObj(a.roomTypes);
    // NOTE: rooms hold NO contents array. Contents are a query over
    // everything whose `location` points at this room — objects and NPCs
    // alike. One pointer, one source of truth.
    // Ids are GLOBALLY unique. `r0, r1, r2` per area collides the moment a
    // second area exists, and would corrupt saves rather than crash.
    rooms.push({ id: `${a.id}_${runId}:r${String(i).padStart(2,'0')}`,
                 type: t.id, tags: [...t.tags, ...a.areaTags] });
  }
  const dirs = ['n', 's', 'e', 'w'];
  for (let i = 1; i < n; i++) {
    const back = shape === 'warren' ? ri(Math.max(0, i - 4), i - 1)
              : shape === 'hub'    ? (i < 5 ? 0 : ri(0, 4))
              : ri(Math.max(0, i - 2), i - 1);
    edges.push([`r${back}`, dirs[ri(0, 3)], `r${i}`]);
  }
  if (shape === 'loop') edges.push([`r${n - 1}`, 'e', 'r0']);
  const tokens = [...a.themeTokens].sort(() => rnd() - .5).slice(0, 2);
  return { a, n, shape, rooms, edges, tokens, runId };
}

// ── ITEM ────────────────────────────────────────────────────────────
function genItem(tier = 1, kindFilter = null) {
  const pool = kindFilter ? items.bases.filter(b => b.kind === kindFilter) : items.bases;
  const base = pick(pool);
  const q = pick(items.qualities);
  const kindTags = [base.kind, ...q.tags];
  const chosen = [];
  const pools = [items.affixes.prefix, items.affixes.suffix];
  for (let i = 0; i < q.affixes; i++) {
    const ok = pools[i % 2].filter(x => has(kindTags, x.requires));
    if (ok.length) chosen.push(pick(ok));
  }
  const mods = {};
  chosen.forEach(x => Object.entries(x.mods).forEach(([k, v]) =>
    mods[k] = k === 'priceMult' ? (mods[k] ?? 1) * v : (mods[k] ?? 0) + v));
  const pre = chosen.find(c => items.affixes.prefix.includes(c));
  const suf = chosen.find(c => items.affixes.suffix.includes(c));
  const adj = base.adjectives[ri(0, base.adjectives.length - 1)];
  const noun = base.nouns[ri(0, base.nouns.length - 1)];
  const name = [pre?.name, q.id === 'plain' ? adj : q.id, noun, suf?.name].filter(Boolean).join(' ');
  const stat = rules.WEAPON_TABLE[base.id] ?? rules.ARMOUR_TABLE[base.id] ?? {};
  const price = Math.round(((stat.price ?? 10) * q.priceMult * (mods.priceMult ?? 1)) || 1);
  return { name, kind: base.kind, price, mods: Object.keys(mods).length ? mods : undefined };
}

// ── MONSTER ─────────────────────────────────────────────────────────
function genMonster(areaId, roomTags, tier, areaDef, wantRole) {
  const ok = mons.bases.filter(b => b.areas.includes(areaId) && b.tier <= tier + 1 &&
    (!b.requires || has(roomTags, b.requires)));
  if (!ok.length) return null;
  const base = pick(ok);
  // A role is refused if the base carries any of its excludeTags — a
  // mindless skeleton must never be a leader, because leader gambits use
  // Presence abilities it can never land.
  const okRoles = mons.roles.filter(r =>
    !(r.excludeTags ?? []).some(t => base.tags.includes(t)));
  const role = wantRole
    ? (okRoles.find(r => r.id === wantRole) ?? pick(okRoles.length ? okRoles : mons.roles))
    : pick(okRoles.length ? okRoles : mons.roles);
  // The AREA's tier drives the curve; the base's tier only gates where it may
  // appear. Keyed on the base, the tier 4 and 5 curves were unreachable.
  const curve = mons.statCurve[String(tier)] ?? mons.statCurve['1'];
  const S = {};
  const spread = mons.statRoll.spread;
  for (const k of rules.STAT_ROLL.attributes) S[k] = curve.mean + ri(-spread, spread) + (role.mods[k] ?? 0);
  base.tags.forEach(t => { const x = rules.TAXONOMY[t]; if (x?.hp) S.toughness = Math.round(S.toughness * x.hp); });
  let title = '', tags = [...base.tags, ...(role.tags ?? [])];
  if (rnd() < (mons.elites.chance[String(tier)] ?? 0)) {
    const e = pick(mons.elites.table);
    title = e.title + ' '; tags = [...tags, ...(e.tags ?? [])];
    Object.entries(e.mods).forEach(([k, v]) => { if (S[k] != null) S[k] += v; });
  }
  const [lo, hi] = mons.groupSize.byTag[base.tags.find(t => mons.groupSize.byTag[t])] ?? mons.groupSize.default;
  const presImmune = tags.some(t => rules.TAXONOMY[t]?.presenceImmune);
  const sex = rollSex(areaDef, base, mons.sexDefault);
  const gambits = abil.gambitsByRole[role.gambits ?? role.id] ?? [];
  const kit = [...new Set(gambits.map(g => g.use))];
  return { name: title + role.name + base.name, count: ri(lo, hi), tags, sex,
    gambits, kit,
    hp: S.toughness * 2, resolve: presImmune ? '—' : S.willpower * 2,
    damage: curve.damage, reduction: curve.reduction };
}

// ── NPC ─────────────────────────────────────────────────────────────
function genNpc(roomTags, areaDef) {
  const ok = npcs.roles.filter(r => has(roomTags, r.requires));
  if (!ok.length) return null;
  const role = pick(ok);
  const [a, b] = [pick(npcs.traits), pick(npcs.traits)];
  const want = pick(npcs.wants);
  const sex = rollSex(areaDef, role, npcs.sexDefault);
  return { role: role.id, vendor: role.vendor, sex,
    persona: npcs.personaTemplate.replace('{role}', role.id.replace('_', ' '))
      .replace('{traitA}', a.id).replace('{traitB}', b.id === a.id ? 'watchful' : b.id)
      .replace('{want}', want.id),
    quest: role.quests[ri(0, role.quests.length - 1)] };
}

// ── ENCOUNTER ───────────────────────────────────────────────────────
// A composition is picked first, then each part is filled by a base that
// fits the area and room. Role is expressed through behaviours, not only
// stat weights, so a brute and a lurker no longer play identically.
function genEncounter(areaId, roomTags, tier, areaDef) {
  const comps = mons.compositions.table.filter(c => !c.requires || has(roomTags, c.requires));
  const comp = pick(comps);
  const group = [];
  for (const [want, lo, hi] of comp.parts) {
    const n = ri(lo, hi);
    const mk = genMonster(areaId, roomTags, tier, areaDef, want === 'any' ? null : want);
    if (mk) group.push({ ...mk, count: want === 'any' ? n : 1 });
  }
  return group.length ? { name: comp.name, group } : null;
}

// ── RUN ─────────────────────────────────────────────────────────────
const areaId = process.argv[2] ?? 'warren';
const depth = Number(process.argv[4] ?? 0);
const { a, n, shape, rooms, tokens } = genArea(areaId, depth);
console.log(`\n=== ${a.name.toUpperCase()} — ${n} rooms, shape "${shape}", depth ${depth} -> TIER ${a.tier} (range ${a.tierFloor}-${a.tierCeil})`);
console.log(`    theme tokens: ${tokens.join(' + ')}\n`);

let hostiles = 0, loot = 0, people = 0;
rooms.forEach(r => {
  const out = [];
  for (const [key, p] of Object.entries(place)) {
    if (key.startsWith('_') || key === 'guarantees') continue;
    if (p.requires && !has(r.tags, p.requires)) continue;
    if (rnd() > p.chance) continue;
    if (key === 'hostile') { const e = genEncounter(areaId, r.tags, a.tier, a);
      if (e) { hostiles++; out.push(e.name + ': ' + e.group.map(m =>
        `${m.count}x ${m.name} [hp ${m.hp}] {${m.kit.join(' ')}}`).join(' + ')); } }
    else if (key === 'npc') { const p2 = genNpc(r.tags, a);
      if (p2) { people++; out.push(`NPC ${p2.persona} (${PRON[p2.sex]})${p2.vendor ? ' [vendor]' : ''} -> ${p2.quest} quest`); } }
    else if (key === 'loot' || key === 'container' || key === 'corpse') {
      loot++; out.push(`${key}: ${genItem(a.tier).name}`); }
    else out.push(key);
  }
  console.log(` ${r.id.split(":").pop().padEnd(4)} ${r.type.padEnd(11)} ${out.length ? out.join(' | ') : '—'}`);
});
console.log(`\n    ${hostiles} hostile rooms, ${loot} loot rooms, ${people} NPCs`);
console.log(`    guarantees: hostiles>=${place.guarantees.minHostiles} ${hostiles >= 3 ? 'ok' : 'TOP UP'}, npcs>=1 ${people >= 1 ? 'ok' : 'TOP UP'}\n`);
console.log('=== SAMPLE GAMBIT LIST (brute)');
abil.gambitsByRole.brute.forEach(g => console.log(`  ${g.when.padEnd(26)} -> ${g.use}`));
console.log('\n=== PRIMER / TRIGGER PAIRS');
abil.table.filter(a => a.applies).forEach(a => {
  const t = abil.table.filter(x => (x.triggers ?? []).includes(a.applies));
  console.log(`  ${a.name.padEnd(14)} applies ${a.applies.padEnd(12)} -> cashed by ${t.map(x => x.name).join(', ') || '—'}`);
});
console.log('\n=== SAMPLE LOOT ROLLS');
for (let i = 0; i < 8; i++) { const it = genItem(a.tier);
  console.log(`  ${String(it.price + 'g').padStart(6)}  ${it.name}${it.mods ? '   ' + JSON.stringify(it.mods) : ''}`); }
