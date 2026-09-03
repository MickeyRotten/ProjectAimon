#TODO

This file contains various tasks, issues, bugs and changes that the user wants to implement. The newest task added is always at the bottom. When the user asks you to do the tasks in TODO, start with the topmost open task (unless otherwise specified). When the task is done, mark the checkbox and write a brief summary on what was done.

Task types:

- FIX: A bug, usability issue. High priority.
- NEW: A new feature or extension of a feature.
- ITERATE: A change to an existing feature.

**IMPORTANT:**
- Whenever a task adds new things, or changes how a thing works, or deletes a thing, make a new task in TASK_EDITOR.md to update the editor's functionality in relation to that thing.

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
4. [~] NEW:

I want a Game Designer's tool for adjusting tags, rules, areas, difficulty, creating new content (tags, areas, enemies, npcs, etc.), adjusting various prompt instructions, etc. It should be frictionless to use, with user friendly design that makes it easy and understandable to use for a non-programmer. This means that information should be categorised clearly, dependencies should be marked clearly as well, and some automation should also be in place for more complex actions and dependency-fixes.

UX Heuristics are key.
Especially ERROR PREVENTION & RECOVERY are to be kept in mind.

**THIS TASK HAS BEEN MOVED TO TODO_EDITOR.md as TASK 1.**

---
4B. [ ] ITERATE: DEPENDENT ON TASK 4. Areas should have premade layout templates, where the Designer can adjust per-slot weights for different rooms. So I can create a premade layout for the Forest, and set the main path as one type of room, while brancing paths can then have a more randomised set of rooms. Treasure value caps could also then carry over to the Layouts.

In the Designer Editor, I can visually create layouts on a grid, and draw connections between those rooms. If I have set a room that does not allow multiple connections (and then draw multiple connections), that should be raised as an error.

UX Heuristics are key.
Especially ERROR PREVENTION & RECOVERY are to be kept in mind.

**THIS TASK HAS BEEN MOVED TO TODO_EDITOR.md as TASK 2.**

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
10. [x] NEW: Each tag and value used by procedural generation should also have a description field. A very short, one-line description of what the tag means, how it's used, etc.

   Done. `campaigns/base/tags.json`'s leaf categories went from bare arrays
   (`"feature": ["landmark", ...]`) to objects mapping tag -> one-line
   description (`"feature": {"landmark": "...", ...}`), all 85 tags across
   `room`/`creature`/`object` written for real, grounded in what each tag
   actually gates (checked against every `requires[]`/`roomRequires` use
   rather than guessed). `TagVocabulary.collect()` (`src/engine/tags.ts`)
   now detects a leaf category as "a plain object whose values are all
   strings" instead of "an array of strings," and gained `descriptionOf()`
   alongside the existing `namespaceOf()`. `validateCampaign` fails a tag
   with a missing or blank description the same way it fails an unknown
   tag, so the description can't silently rot. Nothing downstream changed:
   every consumer of a tag (`RoomRecord.tags`, `requires[]`, `matches()`)
   still reads plain tag-id strings from generated records, never from
   `tags.json` itself. Side effect: a campaign extending a tag category no
   longer needs the `+key` array-append trick — object categories merge
   key-by-key like every other object-shaped table. See
   `src/engine/tags.ts`, `src/campaign/validate.ts`, `tests/tags.test.ts`,
   `tests/loader.test.ts`, `docs/world-and-generation.md`. Editor follow-up
   filed as TODO_EDITOR.md task 3 (the generic renderer still displays the
   new shape, just not with a purpose-built tag+description row editor).

---
---
11. [ ] SPIKE: **Engine changes required by TODO_EDITOR.md task 2 (layout
    templates + the visual layout canvas).** Research only — no code changed.
    Task 2 is written from the editor's side; this is the same feature costed
    from the engine's side, because most of the work is here, not in the tool.
    The editor cannot draw a layout the generator has no way to read.

    **What task 2 actually asks the engine for**, in engine terms: an authored
    topology as an alternative to a rolled one; a named slot per node; a
    per-slot room-type pool; and the wealth budget scoped by slot as well as
    by tier.

    ### A. A slot is a generalisation of something that already exists

    Today a node can be exactly two special things, both hardcoded as booleans
    in `RoomRoleOptions` (`src/world/area.ts`): `isEntry` (node 0) and
    `isCentre` (the `hub` shape's node 1, via `hubCentreNode()` in
    `src/world/shapes.ts`). Each narrows the room-type pool through its own
    rules path — `WORLD.entry.roomRequires` and
    `WORLD.shapes.hub.centreRequires`.

    **Those are already slots.** The change is to replace the two booleans with
    one `slot?: string` and make the two existing narrows the first two rows of
    a general slot table, rather than bolting a third mechanism beside them. If
    this lands any other way, the engine ends up with three ways to say "this
    node is special," which is the shape of the bloat the project keeps cutting.

    ### B. Per-slot room-type pools

    `rollRoomType()` (`src/world/area.ts:379`) rolls the archetype's whole
    `roomTypes` table, then narrows. A slot needs its own weighted pool,
    falling back to the archetype's when it has none — matching the
    "degrades to an unfiltered roll" convention used by every filter in the
    codebase (`WORLD.roomTypeFit`, `WORLD.entry.roomRequires`,
    `WORLD.gates.roomRequires`).

    **The ordering matters and is not obvious.** A slot pool is a *different*
    pool, not a narrower one, so it must still pass through
    `WORLD.roomTypeFit` afterwards — otherwise a slot pool containing a
    `dead-end` type puts one on a junction, and the degree/tag agreement that
    `roomTypeFit` exists to enforce is silently gone. Order should be: slot
    pool (or archetype pool) -> `roomTypeFit` -> any slot `requires[]`.

    ### C. An authored-topology path into graph building — the big one

    `buildGraph()` (`src/world/shapes.ts:128`) dispatches to one of four
    generative builders through a closed `BUILDERS` record, each with the
    signature `(rng, rules, n, options)`. There is **no** seam for a supplied
    graph, and a template is not a fifth shape: shapes are rolled from
    `areaDef.shapes[]` and take no template argument.

    The honest shape is a sibling path, not a fifth builder: `AreaDef` gains an
    optional weighted `layouts` table, and `generateArea()` either picks a
    layout *or* rolls a shape, supplying the graph directly in the first case.

    **Unresolved, and it blocks the work:** `roomCount` is rolled from
    `areaDef.size` (`area.ts:201`), but a template's node count is fixed. Either
    a template pins the area's room count (simple, and a template *is* a
    topology so the size roll arguably does not apply), or templates need
    optional nodes. Recommend the first and say so in the schema; the second is
    a second generator.

    ### D. Author coordinates, not just edges — and export the structural checks

    Task 2 says "visually create layouts on a grid, and draw connections."
    Drawing on a grid means the author places nodes at coordinates, which is
    strictly more than a graph: it is a graph *plus* an embedding. Taking the
    coordinates is the recommended framing, because it makes two of the three
    structural limits impossible to violate by construction:

    - **Degree cap.** Four ways out of a slot in a flat area, six where the
      cube has depth (`area.ts:210`). The entry is capped tighter still, by
      `sidesInside(cube, entryCoord)`, because it sits on the cube's face.
    - **Parity.** The lattice is bipartite, so an **odd cycle can never be
      embedded at all**. `shapes.ts` records this as the cause of "every single
      `loop` failure" during development. It is the error case task 2 does
      *not* name, and a hand-drawn layout hits it exactly as easily as the
      over-connected room it does name.
    - **Connectedness.**

    None of these are rules values — they are properties of a 3-D grid.

    **The gap:** `shapes.ts` exports `isConnected`, `isBridge`,
    `nonBridgeEdges`, `degrees`, `neighbourLists` and `hopsFrom`, but **no
    parity check and no single "can this be embedded" predicate**. The editor
    needs exactly that check live while the author draws. It must be one
    exported function with three callers — the canvas, `validateCampaign` at
    load, and generation — the same way the editor already reuses
    `validateCampaign` rather than reimplementing it. Written twice, the two
    copies drift and the tool starts blessing layouts the generator rejects.

    **One check the editor cannot have:** the tighter entry-node cap depends on
    where the entry lands in the cube, which is not known until layout. The
    canvas can enforce the general cap, parity and connectedness; the entry cap
    stays a generation-time check. Worth stating so the tool does not promise it.

    ### E. Fixed layouts vs. the `Distant` quest reservation — a real conflict

    `layoutArea()` (`src/world/layout.ts:396`) calls `stretchToDepth()` to
    lengthen a branch until it reaches a coordinate a `Distant` quest objective
    reserved before the area existed. **A fixed authored layout cannot
    stretch.** Something has to give, and the machinery for it already exists:
    `LayoutResult.unfilledReservations` is the "promised and could not be kept"
    channel, and the quest system re-places whatever was counting on it. So the
    answer is probably "a fixed layout releases the reservation, with a note"
    — but it is a decision, not a detail, and it should be written down before
    the canvas ships and starts producing layouts that quietly cost quests
    their objectives.

    Related: cube sizing currently derives from `areaDef.size[1]`
    (`lattice.grow(...)`). A template has a fixed bounding box, which has to
    feed cube allocation instead, or the layout will not fit the cube reserved
    for it.

    ### F. Wealth scoped by slot — and the ordering trap

    `placement.wealth` scopes budgets by area **tier** only: `bandByTier`,
    `goldBudgetByTier`, `containersPerArea` (`src/world/placement.ts:111-115`).
    Adding a slot axis is one more axis on an existing mechanism, not a new
    one — that part is cheap.

    **The trap is that the budget is spent down in room order.** The placement
    loop walks `for (const room of rooms)` and draws from a single shared purse
    (`drawGold`, `placement.ts:432`). So "the boss slot always rolls the ultra
    band" does not work by weighting alone: a boss room late in the list finds
    the purse already empty. A slot-scoped budget needs either a reserved
    allocation taken off the top before the general loop, or the loop ordered
    by slot priority. Either is fine; neither is free, and picking neither
    means the feature appears to work and quietly does not.

    ### G. Schema, validation, and what has to persist

    - `AreaDef` (`src/campaign/types.ts:125`) gains `layouts`. Note that a
      template is array-shaped (nodes, edges), so per rule 9 it merges
      wholesale in a campaign override rather than key-by-key — a campaign
      tweaking one node replaces the template.
    - `validateCampaign` needs new checks: every room type a slot pool names
      exists; every slot a layout names has a pool or falls back; the template
      passes the structural predicate from **D**; its bounding box fits the
      cube it would get. These are what the editor surfaces live, so they are
      the same work as the canvas's error panel.
    - **Does the slot persist onto `RoomRecord`?** Placement runs inside
      `generateArea()` (`area.ts:319`), generation-time only, so wealth does
      not need it afterwards. But rule 10 forbids regenerating on load, so
      anything *later* that wants to know a room's slot — narrator prose, a
      future respawn, an editor "show me this area's layout" view — can only
      have it if it was written into the save at generation. Cheap now
      (one string field on `RoomRecord`, `src/world/types.ts:179`), and not
      retrofittable onto worlds already generated. Recommend adding it.

    ### Sequencing and scope risk

    Split this in two and do them in order. **The data half** — slots, per-slot
    pools, slot-scoped budget, a template read from JSON — is a genuine
    extension of mechanisms that already exist, and is testable headless with
    no UI at all. **The canvas half** is new work and is the piece CLAUDE.md's
    correction section names by name ("map painter"), so it should not start
    until the engine can already read a hand-written template JSON and generate
    from it. Building the canvas first means authoring a format nothing
    consumes yet.

    Keep the template to **topology + per-slot type weights + budget scoping**.
    A slot naming a specific NPC, monster or item is the ingredients/outcomes
    line from `docs/decisions-and-history.md` being crossed, and breaks the
    "tables, tags, probability" model the design was rebuilt around.
