#TODO

This file contains various tasks, issues, bugs and changes that the user wants to implement. The newest task added is always at the bottom. When the user asks you to do the tasks in TODO, start with the topmost open task (unless otherwise specified). When the task is done, mark the checkbox and write a brief summary on what was done.

Task types:

- FIX: A bug, usability issue. High priority.
- NEW: A new feature or extension of a feature.
- ITERATE: A change to an existing feature.

---

1. [x] SPIKE: Very first area generated beyond the hub featured many unfair fights. Tier 1 enemies in the first area should have less HP and Resolve. The difficulty feels too high.

   Done, but the stated lever turned out not to be the main cause. Measured with
   an average starting character (13 in every attribute, starter kit) against real
   rolled encounters: **tier-1 win rate went 65-73% -> 93%**. Five changes, four of
   them table-only:

   - **`DEPTH_TIER.tierCeilByDepth`** (`rules.json`) — the big one. `rollTier`'s
     jitter and spike meant a third of first areas were tier 2+ and one in eleven
     tier 3+, where a fresh character loses. Depth 1 is now capped at tier 1,
     depth 2 at tier 2, and past that the curve resumes untouched. Read by
     `rollTier` in `src/world/area.ts` *and* by `tierIn` in
     `src/world/placement.ts`, or the far-room `roomDepthBonus` and the
     guaranteed deep-room elite would climb straight back over it. Shared helper
     `depthTierCeil()` in `src/engine/rules.ts`.
   - **`monsters.encounterCap`** — every hostile acts every round, uncapped, so
     count *is* difficulty. Capped at 2 creatures at tier 1, rising to 6 at
     tier 5, clamped inside `add()` in `rollEncounter`.
   - **Percentage gambit thresholds** — `self.hp<40` etc. were absolute, and a
     tier-1 creature has ~18 max HP, so it sat permanently under every threshold:
     leaders spammed `call_help` (more enemies), wretches and lurkers fled on
     round one. `gambitHolds` now reads a trailing `%` against the combatant's
     own maximum; `abilities.json` rewritten to use it. Bare numbers still work.
   - **`statCurve.hpMult` / `resolveMult`** — the literal ask. Tier 1 set to 0.75.
     A new field because `mean` drives all six attributes, so lowering it would
     have gutted accuracy, evasion and presence too — a different creature, not
     a weaker one.
   - **`tests/combat-balance.test.ts`** — nothing anywhere asserted a fight was
     winnable. Plays real encounters out and asserts a win-rate floor, a median
     round count, and the encounter cap.

   Not changed, flagged only: the uncapped `enemyRound` loop (the cap bounds it
   from the data side), the dead `attacksPerRound` field, and `flee`'s parting
   hit bypassing the to-hit roll. Tier 2 is now ~40% for a *starting* character,
   which is intended — by depth 2 the player should have gear and skills.

---
2. [x] SPIKE: Areas need an identity. I think when an Area is generated, there needs to also be some area-level information about the area, e.g. a Town should have an identity, a main form of trade, a leader, etc. An area can also not have an identity (or rather, it's identity is that there's nothing of interest). We also need some cap on the wealth of that area, so that we don't end up with an Area with every room having things to pick up and hundreds of gold. We could consider gamifying it a bit, and say that within this Area we can have X Containers, and each Container (whether chest, corpse or other) has a chance to yield a low, medium, high, or ultra rare reward, with the ultra rare reward's chance increasing based on the difficulty of the area... As a thought. Other items can also exist in rooms, but their value should be low.

   Done, both halves.

   **Identity.** `AreaDef.identity` is a `chance` plus named traits, each a
   weighted option list, authored per archetype in `campaigns/base/areas/*.json` —
   a town has `trade`/`leader`/`trouble`, a ruin has `whoFell`/`whatRemains`, a
   coven has `rite`/`matriarch`. Rolled once in `generateArea` beside the theme
   tokens and stored on `AreaRecord.identity`, fixed as hard as the tier.
   **`null` is a real outcome** — somewhere nothing of note happens — and the
   prompt is told so rather than left to invent a mystery. Nothing mechanical
   reads it: it reaches `prompts/room-base.md` as `{{identity}}`. The same batch
   call now also names the area on a leading `AREA :: ...` line, so a town is
   "The Salt Road Reach" rather than every town being "Crossroads Town" — no
   extra call, and it degrades to the archetype name if the model skips it.

   **Wealth.** There was no area-level budget of any kind; placement was
   independent per-room rolls, and one chest could roll a masterwork heirloom
   plate worth ~7000 gold. New `placement.wealth` block: `containersPerArea`
   [2,4] counted across chests and corpses alike, four value `bands`
   (low/medium/high/ultra) that filter item bases by price and carry their own
   quality bias, `bandByTier` rolling one band per container with ultra climbing
   with difficulty, `looseItemBand: low` pinning room items cheap, and
   `goldBudgetByTier` as one purse per area drawn down by every spill and purse.
   Measured over 96 areas: containers 11 -> 4 at worst, total area worth
   3508 -> 1749, priciest single item 2340 -> 1080. `generateItem` gained an
   optional `band`; base price reuses the existing `priceOf` via a new exported
   `basePrice()` rather than restating any price. See `src/world/placement.ts`,
   `src/content/items.ts`, `src/world/area.ts`, `src/narrator/rooms.ts`,
   `src/campaign/validate.ts`, `tests/area-wealth.test.ts`.

---
3. [x] SPIKE: The world generation needs more rule-driven procedural generation. The likelihood of a Coven being right next to a Town should be low or zero, etc. Same as Minecraft, the biomes need to also consider adjacent biomes.

   Done. First finding: **`coven` never spawned at all** — no area's `gates` table
   named it — so "a coven should not neighbour a town" was true only by accident.
   It is now reachable from `ruin` and `warren`, behind a depth gate.

   Two layers, both applying. The existing per-area `gates` map stays as the
   directional rule (what a kind of place opens onto). New
   `campaigns/base/content/adjacency.json` adds the spatial one: `radius`,
   `depthGate` (archetype -> minDepth/maxDepth in gates from the Hub), and
   `affinity[candidate][neighbour]` weight multipliers where 0 forbids. The
   spatial layer is the case `gates` cannot express — two areas become neighbours
   through a *third* one's allocation without either table naming the other.

   `WorldLattice.allocate` was split into a pure `probe` (the same slide walk,
   reserving nothing) plus a committing `allocate`, because the cube depends on
   the archetype, so what a candidate would stand beside cannot be known until
   the archetype is proposed. `pickArchetype` in `src/world/area.ts` probes each
   candidate, multiplies its gate weight by its affinity with every kind near
   that cube, applies the depth gate, and picks **once** — deliberately not
   roll-and-reject, which would burn the candidate room and strand areas.
   Everything scoring zero falls back to the unfiltered roll with a note.
   `archetypeOf` is threaded from `World` rather than stored in the lattice, so
   the save format is untouched; stubs reserved earlier in the same pass are
   chained locally so the second gate out of a room sees the first.

   Measured over 20 seeds x 12 areas: coven+town **4 -> 0**, town+town 49 -> 18,
   farmland+town 132 -> 204. Hub gates stay hand-authored and skip all of it.
   See `src/world/lattice.ts`, `src/world/area.ts`, `src/world/world.ts`,
   `src/campaign/{loader,types,validate}.ts`, `tests/adjacency.test.ts`.

---
4. [ ] NEW:

I want a Game Designer's tool for adjusting tags, rules, areas, difficulty, creating new content (tags, areas, enemies, npcs, etc.), adjusting various prompt instructions, etc. It should be frictionless to use, with user friendly design that makes it easy and understandable to use for a non-programmer. This means that information should be categorised clearly, dependencies should be marked clearly as well, and some automation should also be in place for more complex actions and dependency-fixes.

UX Heuristics are key.
Especially ERROR PREVENTION & RECOVERY are to be kept in mind.

   **RESEARCH & BRAINSTORM (task not started — no code changed).**

   **This collides with a closed decision, so it needs a yes before anything is
   built.** CLAUDE.md's "Not in v1" list names *"a world editor"* and *"in-app
   campaign editing"* by name, and the correction section at the top of the
   file exists specifically because the predecessor project built exactly this
   — "a full authoring application — map painter, entity forms, an LLM
   'Creator', a twelve-pass generation pipeline with a lock-and-key dependency
   chain, a solver, a linter, and a blind-review mode" — and that was a month
   of tooling before a minute of play, which is the stated cause of death.
   Rule 11 says ask before touching the closed lists. Consider this the ask:
   parts of this task are safe re-scopes of something already half-built;
   parts, as literally described ("automation... for dependency-fixes", a
   solver-shaped ask), are the exact thing that was cut. Recommend deciding
   which parts before building.

   **A version of this already exists, and it's smaller than it sounds.**
   `src/editor/editor.ts` + `editor.css` is a dev-only generic JSON-table
   editor, served at `/editor.html` by `npm run dev`, never shipped in the
   production build. It lists every campaign file grouped by category (Areas,
   Content, Quests, Rules, ...), renders each as generic form controls (plain
   text inputs for strings, number inputs, checkboxes, add/remove lists for
   arrays), and writes changes back to disk in place via the File System
   Access API (Chromium/PC only — read-only elsewhere). Its own doc-comment
   calls it "deliberately dumb: no schema awareness, no undo, no diffing. The
   JSON is the schema." That line is the whole gap between what exists and
   what's asked for: a non-programmer can't safely type `"outdoor|wild"` into
   a bare text box, or know that deleting a room type breaks three other
   files, or recover from a bad edit once it's written to disk.

   **The good news: the hard part — dependency-checking — is already built,
   just not surfaced.** `src/campaign/validate.ts` (`validateCampaign`)
   already walks every cross-reference in the game: unknown tags with
   fuzzy-match suggestions ("did you mean...?"), archetypes nothing gates to,
   gambit lists/ability ids/primer ids/distance bands/quest predicates that
   don't resolve, affixes that can never roll, room types with zero total
   weight, duplicate hub room ids, doors that spend a direction twice. It
   already caught the one real content bug this project has shipped with (a
   stray `cultivated` tag putting farmers behind shop counters). Every issue
   carries a `path` string that addresses the exact field. **This is the
   "dependencies marked clearly" and "error prevention" ask, already written
   — it just runs at campaign load, in a console log, instead of live in an
   editor UI next to the field that's wrong.** Wiring it into `editor.ts` (run
   `validateCampaign` on every edit, render each issue as an inline badge next
   to the input whose path matches) is the highest-value, lowest-risk single
   step here, and adds no new engine code.

   **Three tiers of ambition, ranked by how much they resemble the thing that
   already got cut:**

   - **Low risk — schema-aware surface over the existing editor.** Swap free
     text for closed-vocabulary pickers: a `requires[]` field becomes an
     AND/OR chip builder over `tags.json` instead of typed pipe-and-bang
     syntax; a `roomTypes` weight becomes a labelled slider; a gambit's
     `when` gets a dropdown of the closed condition list `validate.ts` already
     checks against. Live-run the validator on every change and show
     errors/warnings inline. Group by "what references this" as a read-only
     cross-reference view — computed from data `validate.ts` already builds
     (role→gambit-set, ability→primer, tag→every table that uses it), no new
     data structures. None of this adds a rule the engine doesn't already
     enforce; it just stops a bad value from being typeable in the first
     place, which is Nielsen's error-prevention heuristic applied literally.
   - **Medium risk — recovery, and maybe in-app.** The current editor writes
     straight to disk with **no undo**, which is fine for a programmer with
     git and bad for the target "non-programmer" user this task names. Cheap
     fix within the dev tool: it already keeps `original` vs `current` per
     file in memory — add a diff/review step and a per-file revert button
     before the write, rather than writing on blur. Whether any of this moves
     from the dev-only tool into the shipped app (true "in-app campaign
     editing") is the part that directly re-opens the closed list — the
     technical side is fine either way (client-side only, still fits "no
     backend"; a save's generated areas are already immune to later table
     edits per `docs/data-model.md`'s "tuning a table never breaks an
     existing game"), so this is a product decision, not an engineering one.
   - **High risk — do not build without a very narrow spec.** "Automation for
     complex actions and dependency-fixes" — an auto-solver, auto-rebalancer,
     or auto-rename-everywhere — is precisely the shape of the twelve-pass
     pipeline/solver/linter CLAUDE.md says is gone and explains why. If
     automation is wanted, keep it to specific, reversible, previewable
     actions: "rename this tag" = find every use via the existing tag-owner
     data, show a diff, one confirm — not a general solver. "Delete this room
     type" = **block** the delete and list every table location using it
     (error *prevention* by refusing the invalid state, not automatic
     *correction* of it) rather than trying to auto-patch every reference.

---
4B. [ ] ITERATE: DEPENDENT ON TASK 4. Areas should have premade layout templates, where the Designer can adjust per-slot weights for different rooms. So I can create a premade layout for the Forest, and set the main path as one type of room, while brancing paths can then have a more randomised set of rooms. Treasure value caps could also then carry over to the Layouts.

In the Designer Editor, I can visually create layouts on a grid, and draw connections between those rooms. If I have set a room that does not allow multiple connections (and then draw multiple connections), that should be raised as an error.

UX Heuristics are key.
Especially ERROR PREVENTION & RECOVERY are to be kept in mind.

   **RESEARCH & BRAINSTORM (task not started — no code changed).**

   **The data-model half is a small, natural extension of what's already
   built; the visual-canvas half is genuinely new work.** Worth splitting
   those two, because they carry very different risk and cost.

   **Where "layout" already lives, partially.** Today a room's *graph shape*
   (`sprawl`/`loop`/`hub`/`warren`, `src/world/shapes.ts`) is built from a
   handful of tunable parameters per shape (`branchWindow`, `ringFraction`,
   `arms`, `backWindow`) — not authored, purely generative. Room *type* per
   graph node is an independent weighted roll against the archetype's whole
   `roomTypes` table, with exactly two hand-carved exceptions already wired
   in: node 0 (the entry, narrowed by `WORLD.entry.roomRequires: ["!private"]`
   so it's never someone's shop) and, for `hub`-shaped areas only, node 1
   (`hubCentreNode()`, narrowed by `WORLD.shapes.hub.centreRequires:
   ["landmark"]` — the market square). **A "layout template" is this same
   mechanism generalised**: instead of two special-cased nodes, tag every
   node with a named slot (`main-path`, `branch`, `boss`), and give each slot
   its own weighted `roomTypes`-shaped pool, falling back to the archetype's
   general pool when a slot has none — matching the "degrades to an
   unfiltered roll" convention already used everywhere in this codebase
   (`WORLD.roomTypeFit`, `WORLD.gates.roomRequires`, both entry and centre
   filters). No new roll logic needed, just more named pools and a node→slot
   lookup.

   **"Treasure value caps could carry over to layouts" maps onto the existing
   wealth budget the same way.** `placement.wealth` already scopes budgets by
   area *tier* (`bandByTier`, `goldBudgetByTier`). Scoping a band or a purse
   share by *slot* instead of (or alongside) tier — "the boss-room slot always
   rolls the ultra band" — is one more axis on a mechanism that already
   exists, not a new one.

   **The grid/connection canvas is real, separate work — nothing today
   builds it.** `editor.ts` only renders generic forms (inputs, checkboxes,
   add/remove lists); there's no graph or grid UI in it at all. But the
   *player-facing* map already solves the closely-related rendering problem:
   `src/world/map.ts` / `src/ui/screen.ts` draw rooms and connectors on a
   half-step grid exactly because "adjacent rooms may share no door" (see
   *The map draws on a half-step grid*, decisions-and-history.md) — same
   shape of problem a layout-template canvas has (place nodes on a grid, draw
   only the edges that exist). That renderer is the strongest available
   reference, maybe reusable in part, rather than starting a canvas from
   nothing.

   **The named error case is real, and the codebase already has the check for
   it — it's just per-shape today, not per-room-type.** "A room that doesn't
   allow multiple connections, and I draw two" is exactly `shapes.ts`'s
   **degree cap** (`maxDegree`/`entryMaxDegree`, currently one number per
   shape/entry, would become one per room type or per slot). Live-validating
   a drawn connection against a per-slot degree cap while the designer is
   still drawing is a direct reuse of that existing concept, not new math.
   **There's a second, subtler error case in the same family that the task
   doesn't name but the codebase has already been bitten by**: the lattice is
   bipartite, so an odd cycle can never be drawn at all — the doc calls this
   "every single `loop` failure" during development. A layout author freely
   drawing connections on a grid can produce an odd cycle by accident just as
   easily as an over-connected room, and `shapes.ts` already has
   `isBridge`/`nonBridgeEdges`/degree-checking to validate against — worth
   surfacing both checks live in the canvas, not just the one asked for,
   since they're the same class of "this will fail to generate" mistake and
   the validation code already exists.

   **Sequencing and scope risk.** This is close in shape to the abandoned
   "map painter" CLAUDE.md's correction section calls out by name, so keep it
   narrow: a layout template should describe *topology + per-slot type
   weights + budget scoping* only — never hand-placing specific NPCs,
   monsters, or loot into a slot, which would break the "tables, tags,
   probability" model this design was rebuilt around. And this is worth
   sequencing strictly after task 4's schema-aware validated editing lands:
   a layout template is just another content table, needing the same
   closed-vocabulary tag pickers and inline validation as everything else —
   building the canvas first means re-inventing basic form validation a
   second time, inside a canvas.

---
5. [x] ITERATE: When I move to a new Area, the map should also show the prtaevious, connected Areas. In other words, it's one big Map that gets built, rather than separate ones (except for different floors). We can have a rule that up to X connections get rendered, but the map is still one big map. The connector between two areas can have a different color to indicate a gate between two areas.

   Done: rooms already lived in one shared X/Y/Z lattice across areas, but `mapModel()` filtered to only the current area before ever using those coordinates — so a crossed gate rendered as a dead end (no far-side room, and the "way out" ghost glyph disappears once a gate is crossed). `mapModel()` now walks outward from the player's area across *crossed* gates, up to `AREA_HOP_LIMIT` (1, overridable via a new `areaHops` option), and includes those areas' rooms on the same Z level — same floor only, per "except for different floors." The connector where two areas join is flagged `crossesArea` and rendered in the same amber used for the "way out" glyph, with a new "area gate" legend entry. See `src/world/map.ts`, `src/ui/screen.ts`, `src/app.css`, `tests/map-model.test.ts`.

---
6. [x] NEW: In Config, add a button for "Restart Adventure" which does a hard reset, wipes everything (except settings) and starts the adventure fresh.

   Done: `wipeSaves(store, campaignId)` in `src/game/save.ts` deletes every
   save row (autosave and every named snapshot) for the loaded campaign,
   reusing the existing `SaveStore.list()`/`delete()`. The settings overlay
   (`src/ui/settings.ts`) gained a danger-zone section below Cancel/Save — a
   warning line and a red "Restart Adventure" button, gated by a native
   `confirm()` since destroying a save can't be undone. `main.ts` wires it to
   a new `restartAdventure()` that wipes the save, calls `Game.begin()` with
   a fresh seed the same way `boot()` does for a brand-new game, and prints
   the same banner — no page reload, matching the settings panel's existing
   no-reload philosophy. Settings (API key, model slots) live in
   `localStorage`, entirely separate from the Dexie `saves` table, so they
   are untouched. See `src/game/save.ts`, `src/ui/settings.ts`, `src/main.ts`,
   `src/app.css`, `tests/game.test.ts`.

---
7. [x] ITERATE: Each area should have a pre-determined Entrance Room. Sometimes when the next Area is a town, the entry room is inside a shop, and that feels like a bug to a player.

   Done, folded into #8 below — same root cause, same fix.

---
8. [x] SPIKE: While many areas can be random, a Town shouldn't be completely random. Towns should have a logic to how they are built. Typically (in fantasy) towns have main entrance, and at the center is the Market Square. As an example. How could we impose better logic to some areas?

   Both #7 and #8 came from the same gap: `rollRoomType()` in `src/world/area.ts`
   rolled a room's type from pure weight, with no idea whether the node was the
   entry (graph node 0 — where the player lands crossing a gate) or, for the
   `hub` shape, its designated centre (node 1 — already commented as "you
   arrive at the edge of a town and walk in to the square", just never wired
   to room-type selection).

   New tag **`private`** (`room.feature` in `tags.json`) marks a room type as
   somebody's specific interior — a shop, a home, a cell — and is now on the
   business/dwelling-specific types in every archetype (`taproom`,
   `shopfront`, `farmhouse`, `solar`, `nest`, etc.), leaving public/outdoor/
   passage types alone. Two new rule paths read it: `WORLD.entry.roomRequires`
   (`["!private"]`) narrows the entry room's roll so it's never someone's
   shop or cell — that alone is #7. `WORLD.shapes.hub.centreRequires`
   (`["landmark"]`, reusing the existing `landmark` tag) narrows a
   `hub`-shaped area's centre room to a landmark type — for town that's
   `square` or `temple`, giving hub-shaped towns their market square. Both
   filters degrade gracefully to an unfiltered roll if nothing in the pool
   fits, same precedent as the existing `WORLD.roomTypeFit` degree filter and
   `WORLD.gates.roomRequires`. New `hubCentreNode(shape)` in `src/world/shapes.ts`
   names node 1 as the centre for `hub` and `null` for every other shape.

   `loop`-shaped towns (town allows both `hub` and `loop`) have no single
   centre node, so they don't get a forced market square — left open as a
   follow-up. See `src/world/area.ts`, `src/world/shapes.ts`,
   `campaigns/base/tags.json`, `campaigns/base/rules.json`,
   `campaigns/base/areas/*.json`, `tests/world.test.ts`,
   `tests/world-shapes.test.ts`.

---
9. [x] ITERATE: Set default font to VT323 https://fonts.google.com/specimen/VT323, font size 20.

   Done: self-hosted (no Google Fonts CDN dependency, since this is a
   fully client-side app packaged into an offline-capable APK). The latin
   subset `woff2` for VT323 lives at `src/assets/fonts/VT323-Regular.woff2`,
   declared via a new `@font-face` in `src/app.css` and referenced first in
   `body`'s font stack, ahead of the existing monospace fallback chain
   (kept for the `font-display: swap` gap and as a safety net). Base
   `font-size` went 15px -> 20px; the two responsive overrides that nudge it
   by exactly ±1px for small/wide viewports were rescaled to keep that same
   relationship (14/16 -> 19/21) rather than left as stale absolute values
   that would have made desktop text smaller than the new base. Scope is the
   player-facing screen only — the separate Designer/editor tool
   (`src/editor/editor.css`) keeps its own `var(--mono)` untouched.

---