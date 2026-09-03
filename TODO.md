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
11. [ ] SPIKE: **THE VERTICAL WORLD — Rungs.** *(Decision record. Supersedes the
    earlier "engine changes for layout templates" research, which was costed
    against the wrong problem. Nothing is built yet; this is the design being
    settled before it is.)*

    ### The complaint this answers

    The map felt **claustrophobic and at times illogical**. The wanted feeling,
    in the user's own words: *"Ah, forest. That side trail probably leads down
    to something interesting. Going forward probably takes me out of the
    woods."* The player should be able to read a map and form a **correct**
    prediction from it.

    Three things blocked that, all measured against the current code:

    - **Every area in the game is a square.** `lattice.ts:97` computes
      `footprint = ceil(sqrt(slots))` and returns `{ w: footprint, h: footprint }`
      — `w === h`, always, for every archetype. With `cubeSizing.slotsPerRoom:
      1.4`, a flat area runs 56–64% filled (farmland 15 rooms in 5x5 = 60%;
      town 16 in 5x5 = 64%; coven 9 in 4x4 = 56%). A square packed that full
      has no long axis and no corridors — almost every room touches two or
      three others. **The claustrophobia is geometric and upstream of
      everything else.**
    - **The way out can be next door.** `WORLD.gates.minHopsFromEntry: 2`, in
      areas of 9–20 rooms, then a free pick among everything that qualifies.
      There is no representation of *forward* anywhere in the engine.
    - **Nothing makes a side trail worth taking.** `bandByTier` scopes loot by
      area tier only. Depth changes *danger* (`roomDepthBonus`) but never
      *reward*, so a dead end at the end of a long branch is a coin flip. A map
      that promises and does not pay teaches the player to stop reading it.

    ### The decision: the world runs downward, in Rungs

    Reference points: Diablo (descend, town at the top), Delicious in Dungeon
    (each floor its own ecology, the trip home is a real cost), Dungeon
    Encounters (the map *is* the game, floors are legible grids).

    **A Rung is one floor. A Rung is one area. A Rung is one biome.** The Hub
    is Rung 0. You descend.

    **This is chosen because it subtracts.** Every other option on the table
    added a system; this one retires several and gives the already-built Z axis
    a job.

    ### What it settles

    - **CLAUDE.md's open question** — *"whether areas should ever connect back
      to each other, or only to the Hub"* — is answered, but not as either
      option was framed. Neither wheel nor web at the area level: a **stack**.
      (Today it is in fact neither of those either — it is a **tree**. Every
      gate calls `lattice.allocate()`, which reserves a *fresh* cube and
      refuses any overlapping an existing one; there is no code path anywhere
      where a gate opens onto an area that already exists. So there is exactly
      one path between any two areas, always through their common ancestor.)
    - **Difficulty becomes spatial and legible.** Depth from the Hub *is* the
      Rung number. The gradient stops being a curve fighting against
      shortcuts and becomes a number on the screen.
    - **Directional coherence is free.** "Forward takes me out of the woods"
      becomes "down", on the one axis every player already understands.
    - **The Hub-return consumable and the corpse run become meaningful.**
      Both are already built and both are currently conveniences. Depth gives
      them a cost curve.

    ### It is already half-built

    - `Cube` carries `z0`/`z1`. `ALL_DIRECTIONS` includes `u`/`d`, and
      `FLAT_DIRECTIONS` exists as a *separate* constant — the code already
      distinguishes vertical from horizontal.
    - `cubeSizing.zSpanByArchetype` and `allocation.zOffsetByArchetype` exist;
      `warren: -2` already drops a warren two levels below farmland.
    - The map already renders **per floor**, with a `Saltmere (F1)` label, and
      task 5 deliberately limited the multi-area map to the same Z.

    The engine is already three-dimensional and already renders per floor. This
    commits to an axis that exists and is barely used. It is not a rewrite.

    ### What one-area-per-Rung retires

    Areas never compete for space if each one owns a whole plane. These are
    built systems losing their jobs, listed so the removal is deliberate rather
    than discovered:

    - **Cube allocation and collision handling.** `allocate`, `probe`,
      `nearestFreeCube`, `slideOutwardAlongGateAxis`,
      `allocation.maxSlideAttempts: 60`, `onExhausted`, and `cubeSizing.gap`.
    - **`content/adjacency.json` changes shape.** An affinity matrix for what
      may sit *beside* what has no "beside" any more. It becomes a **sequence**
      — which biome follows which as you descend. Easier to author and easier
      to reason about than a matrix, but it is a rewrite of that table, not a
      tuning of it.
    - **`WORLD.gates.perArea: [1,3]` collapses.** The only way onward is the
      descent. `areaDef.gates` (archetype -> weight) becomes "what is the next
      Rung", which is the same sequence question as adjacency.

    ### The spider web moves down one level

    The stated want was a web rather than *"a perfect compass structure, where
    each direction is a straight vector out from the middle without any
    inter-connectivity."* With one area per Rung there are no lateral **areas**
    to link, so the web becomes a property of the **room graph inside a Rung**:
    **rings are lateral room connections within the floor, spokes are
    descents.** Still a web, at room scale.

    This is already built and needs only exposing: `weaveChords` weaves extra
    connections *after* placement, between rooms that ended up side by side,
    and `chordFraction` reads `WORLD.shapes.<shape>.extraEdges` — today only
    `warren: 0.3` sets it. Make that a per-Rung value and the rings appear.

    ### Teleporter — a new universal room type

    **Quick travel between the Hub and a Rung, unlocked by finding it, spawning
    every nth Rung.**

    - **Structurally placed, never rolled.** `roomTypes` is per-archetype
      (`AreaDef.roomTypes`); there is no global room-type table, so "universal"
      is new schema either way. More importantly a weighted roll can *fail*,
      and a teleporter that does not spawn breaks quick travel silently. The
      engine already places rooms structurally — node 0 is always the entry,
      node 1 is always the hub centre — and a teleporter should be assigned the
      same way, with its own glyph so the map shows it.
    - **It is stateful, which is new.** "Unlocks" means the save remembers which
      teleporters are active: a data-model change, plus a travel verb in the
      global `data/verbs.json` (verbs are global — settled decision).
    - **Keep it distinct from the Hub-return consumable**, which is a listed
      gold sink and which a teleporter network would otherwise eat. The split:
      **the consumable gets you *out* from anywhere; the teleporter gets you
      *back in* to a known depth.** Escape versus re-entry. Both survive.
    - **Descending must never require finding it.** Missing a teleporter costs
      a long walk, never progress.

    ### The open numbers

    Three, and the first is the most load-bearing tunable in the design.

    - **`n` — Rungs between teleporters.** It sets three things at once: how
      long a delve is, how expensive the return trip is, and **how punishing
      death is** — because the corpse run walks you back from the Hub and
      teleporters shorten that walk. Keep it a single rules value so it moves
      in one place.
    - **Descents per Rung.** One makes finding the stairs the hunt (Dungeon
      Encounters). Several trade tension for freedom. It is a table value, but
      it sets the whole feel.
    - **How many Rungs.** Bounded run or open descent. Untouched so far.

    Also deferred by explicit decision: **Rung size.** Areas are 9–20 rooms
    today, which is small for a whole floor. Expanding them comes later.

    ### What survives the reframe unchanged

    The vertical world is a better *container* for these; it does not replace
    them. Both were the original complaint and neither is fixed by going
    vertical:

    - **Footprint shape.** A Rung of squares is still a square.
      `footprint = ceil(sqrt(slots))` does not care what floor it is on.
      Replace it with a per-archetype ratio: a forest Rung long and thin, a
      town Rung squarish, a warren blobby. **This is also a hard prerequisite
      for any hand-authored layout** — the cube is allocated by `sizeFor()`
      before a layout is drawn, so a 3x9 forest literally cannot be placed
      today.
    - **Reward must follow position.** Band and content scoped by depth and
      dead-endness alongside tier. This is what makes the side trail's promise
      *true*, and **no amount of authored layout can substitute for it**:
      a beautiful hand-drawn map whose trails are empty half the time teaches
      the player that the map lies, and then the shape is worse than useless
      because it promised.

    ### What this does to TODO_EDITOR.md task 2 (layout templates)

    It makes it **cheaper and more likely to happen**. One authored layout per
    Rung, and there are perhaps ten Rungs rather than forty forests — roughly a
    quarter of the authoring burden, aimed at a floor whose theme and role are
    already known. The engine research that was task 11 still holds where it
    described *mechanism* (no seam in `buildGraph` for a supplied graph; slot
    pools must still pass `roomTypeFit`; the wealth purse is spent in room
    order so a slot-scoped band needs a reserved allocation; `shapes.ts`
    exports no parity or embeddability predicate for an editor canvas to
    validate against). It no longer holds where it described *cost*, because
    the unit of authoring changed.

    ### Risk, stated plainly

    This is the fourth reframe in one design conversation, and CLAUDE.md's
    correction section exists because the predecessor project died of exactly
    that. The reason to accept it anyway: every other candidate **added** —
    layouts, a canvas, a world web, slot pools — while this one **subtracts**.
    It removes the need for a lateral-difficulty rule, removes the ambiguity
    about direction, and retires the cube-collision subsystem. That is the
    opposite of how the predecessor died. The risk is not that it is the wrong
    shape; it is that it is a fifth one.

    ### Closed-list amendments this needs (rule 11)

    Not made yet — CLAUDE.md still describes what is built, and none of this is.
    Recorded so they are not missed:

    - **Add:** quick travel / the teleporter network, as a system.
    - **Amend:** the open question about areas connecting to each other, now
      answered by the stack.
    - **Amend:** "Area generation on entry" and "Rule-driven adjacency", both of
      which change meaning under one-area-per-Rung.
    - **Note:** "Rung" would be the third *ladder* in the vocabulary, after the
      LLM tier ladder (`src/game/ladder.ts`) and `LAYOUT_FAILURE.order`.
      Different domains, but `rung` and `tier` will appear in the same sentence
      often — keep the two words clearly distinct in code and in prose.

    ### Suggested order

    1. **Footprint shape per archetype.** One formula, changes how every area
      in the game feels, and unblocks everything else. Do it first even if the
      rest waits.
    2. **Reward follows position.** Makes the map honest. Table-shaped.
    3. **The Rung frame** — Rung 0 = Hub, one area per Rung, descents, the
      difficulty gradient re-keyed to Rung number.
    4. **Room-scale web** — expose `extraEdges` per Rung.
    5. **Teleporter** — structural placement, unlock state, travel verb.
    6. **Authored Rung layouts**, onto a world that already reads correctly.

    Steps 1 and 2 are worth doing and *playing* before 3, because they are
    cheap, they are needed either way, and they will sharpen what the vertical
    frame actually has to deliver.
