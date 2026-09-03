#TODO

This file contains various tasks, issues, bugs and changes that the user wants to implement to the Editor. The newest task added is always at the bottom. When the user asks you to do the tasks in TODO, start with the topmost open task (unless otherwise specified). When the task is done, mark the checkbox and write a brief summary on what was done.

Task types:

- FIX: A bug, usability issue. High priority.
- NEW: A new feature or extension of a feature.
- ITERATE: A change to an existing feature.

---
1. [~] NEW:

I want a Game Designer's tool for adjusting tags, rules, areas, difficulty, creating new content (tags, areas, enemies, npcs, etc.), adjusting various prompt instructions, etc. It should be frictionless to use, with user friendly design that makes it easy and understandable to use for a non-programmer. This means that information should be categorised clearly, dependencies should be marked clearly as well, and some automation should also be in place for more complex actions and dependency-fixes.

UX Heuristics are key.
Especially ERROR PREVENTION & RECOVERY are to be kept in mind.

   **IN PROGRESS — the low-risk tier is built; the high-risk automation is
   still deliberately deferred.** What shipped this pass turns the existing
   dev-only JSON editor (`src/editor/`) from schema-blind into schema-aware,
   which is exactly the "dependencies marked clearly / error prevention &
   recovery" ask, and adds no engine code — it only surfaces checks the engine
   already runs. Nothing in the player-facing app or its build changed, so this
   stays clear of the closed "no world editor / in-app editing" list per the
   ingredients-vs-outcomes boundary in decisions-and-history.md.

   - **Live validation, anchored to the field.** `src/editor/validation.ts` is
     a thin adapter that feeds the editor's live, unsaved files back through the
     engine's own `validateCampaign` (the same checker that runs at campaign
     load). Every edit re-runs it, debounced. Each issue is stamped onto the
     exact control it names — the renderer now threads the validator's own path
     strings (`areas/town.json.roomTypes.taproom.tags[0]`) onto every input as a
     `data-path`, so an unknown tag lights up a red badge and border on that
     field, not just a console line. A new right-hand **issues sidebar** lists
     every error/warning with its path and message, each row clickable to jump
     to and flash the field; tabs whose file has an error go red.
   - **Closed-vocabulary tag pickers.** Tag fields (`tags`, `areaTags`,
     `excludeTags`, `requires`, `targetTags`, `kind`, `itemKind`) autocomplete
     against a `<datalist>` rebuilt live from `tags.json` (85 tags today,
     labelled by namespace), so a valid tag is offered rather than typed blind —
     Nielsen's error-prevention heuristic applied at the input. `requires` rows
     also carry an inline hint for the `!`/`|` operators.
   - **Recovery.** A per-file **Revert** discards unsaved edits back to the
     loaded copy, and **Save** now opens a **review-before-write diff** (a line
     diff of exactly what will be written to disk) with Cancel/confirm, instead
     of writing straight through on Ctrl+S. The editor still keeps `original`
     vs `current` per file, so revert is free.

   Verified: 378 tests pass incl. new `tests/editor-validation.test.ts` (path
   bookkeeping + "clean base / broken-tag error" parity with the loader), and a
   headless-Chromium smoke of the live UI (loads clean, datalist populated,
   typing a bad tag raises inline badge + sidebar error, no console errors).

   **UPDATE — the "natural next increment" named below has now landed too.**
   Closed-list dropdowns cover every remaining closed vocabulary, so the
   pickers are no longer tag-only:

   - **Fields are addressed by path, not by key name.** The tag pickers keyed
     off the JSON key (`tags`, `requires`, `kind`), which works for tags
     because those words mean "a tag" wherever they appear — but `type`,
     `use`, `when`, `place` and `kind` are ordinary words meaning different
     things in different files. `fixture.kind` in placement is an object tag;
     `objective.kind` in a quest is the quest's own type and not a tag at all,
     and the old heuristic was offering tags for it. `src/editor/pickers.ts`
     registers each field by the validator's own path string, through a tiny
     glob (`*` = one segment, `#` = one array index, so
     `content/abilities.json.gambitsByRole.*#.when`). The key-name rule stays
     as the fallback for tags; the registry overrides it where it was wrong.
   - **Ten vocabularies, all of them ones the engine already closes**: quest
     `objective.place`, `objective.completedBy` and `rewards[]`; ability
     `type` and `applies`; gambit `when` and `use`; area `shapes[]`; hub gate
     `dir`, `fromRoom` and `archetype`; `gatewayArchetypes[]`; and
     `startingArea`. The fixed ones read the engine's own constants
     (`PLACE_KINDS`, `SHAPES`, `ALL_DIRECTIONS`); the rest read the *live,
     unsaved* files, so an ability added in one tab is offered in the gambit
     tab immediately, with no save in between.
   - **A closed list becomes a `<select>`, so the invalid value is not
     typeable** — which is the whole point. But a value already on disk that
     is *not* in the list is still shown, offered as its own option and
     flagged red, never silently swapped for a legal one: substituting would
     hide the exact mistake the validator is complaining about.
   - **`gambit.when` is the one that is not a dropdown, deliberately.** Its
     vocabulary is patterns (`self.hp<N`, `target.primer==X`), so the valid
     set is infinite and a closed list would be a lie. It gets an assisted
     text input over its own datalist of the templates, each labelled with
     what to replace.
   - **`startingArea` accepts the literal `hub`, and only it does.** The
     smoke test caught this: a plain archetype list there flags the base
     campaign's own correct value as invalid — a false alarm being worse than
     no picker at all. It has its own vocabulary; the gate and gateway fields
     keep the strict one, matching `validate.ts` exactly.

   Verified: 412 tests pass (38 files) including
   `tests/editor-pickers.test.ts` (12 tests: the glob, every registered path,
   the `objective.kind` override, and a pass over the real base tables
   asserting each claimed path exists and its value is in the list claimed
   for it), typecheck clean, and a headless-Chromium sweep confirming every
   dropdown carries the right options and current value — and that **no file
   in the base campaign shows a single false "not allowed" flag** on any tab.

   **Still deferred, on purpose:** the **high-risk automation** — an
   auto-solver / auto-rebalancer / auto-rename-everywhere — is untouched; per
   the research below and rule 11 it needs a narrow, reversible, previewable
   spec before any of it is built (e.g. "rename this tag" = find-every-use +
   diff + one confirm, never a general solver). Task 2 (layout templates +
   visual canvas) remains sequenced after this, as it was always meant to be.

   **RESEARCH & BRAINSTORM (original notes below — kept for the reasoning).**

   **Guiding principle, settled in conversation and recorded in
   decisions-and-history.md: the Designer tool edits ingredients, never
   outcomes.** Ingredients are the tables — weights, price bands, tag lists,
   persona parts, and new rows added to any of them. Outcomes are what the
   procedural engine rolls from those tables at generation time — a specific
   generated room, a specific monster instance, a specific loot drop, a
   specific NPC placed in a specific slot. The tool gets full visibility and
   control over the first; the second stays the engine's job, on purpose,
   because surprise and discovery are the point of generating rather than
   authoring. The scope test for any feature request aimed at this tool:
   *does this set a probability, or does this place a specific thing?* The
   first is always in scope. The second is a hard no unless decided
   otherwise, deliberately, later. This is also what clears the closed-list
   collision below rather than just narrowing it — see that entry for why.

   **Second guiding constraint: the tool is a separate, PC-only application —
   not integrated into the main app, and never built for Android.** No APK.
   It runs on the developer's PC only, outside the player-facing game
   entirely — its own entry point, own build, own distribution, whatever
   that ends up being. This also matches the "Hard constraints" table in
   CLAUDE.md, which scopes PWA/APK packaging to the player-facing app; a
   Designer tool was never meant to ride along in that package. It also
   matches what already exists: `src/editor/editor.ts` (below) is already
   dev-only, PC-only (Chromium, via the File System Access API), and never
   part of the production build — so this constraint isn't new work, it's
   confirming the existing tool's shape is the right one to build on rather
   than fold the Designer tool into `src/ui/` or ship it in the APK.

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
2. [ ] ITERATE: DEPENDENT ON TASK 1. Areas should have premade layout templates, where the Designer can adjust per-slot weights for different rooms. So I can create a premade layout for the Forest, and set the main path as one type of room, while brancing paths can then have a more randomised set of rooms. Treasure value caps could also then carry over to the Layouts.

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
3. [x] ITERATE: TODO.md task 10 gave every tag in `tags.json` a required
   one-line description, changing each leaf category from a bare array
   (`"feature": ["landmark", ...]`) to an object mapping tag to description
   (`"feature": {"landmark": "...", ...}`). The engine and validator don't
   need the editor's help — `TagVocabulary` and `validateCampaign` read the
   new shape directly — but `editor.ts`'s own rendering of `tags.json` does
   change: `renderStringList`'s fast path (`editor.ts:245`, gated on "array
   of all strings") no longer matches a category, so it falls through to
   the generic `renderNested` object renderer — a labelled text input per
   tag, functional but not purpose-built, and with no add/remove-tag
   affordance the way the old string-list rows had.

   Two natural follow-ups, neither started:
   - A proper tag-name + description row editor for `tags.json` itself,
     with the same add/remove affordance `renderStringList` gave the old
     array shape.
   - Surface `TagVocabulary.descriptionOf()` as a `title` tooltip on the
     `<datalist>` options `rebuildVocabulary()` builds (`editor.ts:149`),
     so every other tag picker in the tool (the `tags`/`requires`/`kind`
     fields across every other file) shows what a tag means while typing
     it, not just its namespace label.

   **DONE — both follow-ups shipped, plus the delete guard they implied.**
   Nothing player-facing changed; this is still the dev-only PC tool.

   - **`tags.json` gets a purpose-built renderer.** Each category now draws as
     tag/description rows with `+ add tag` and a per-row `x`, so the tag name
     is data the designer edits rather than a structural key the generic object
     renderer treats as a label. The rule for what counts as a category --
     non-empty object, all values strings, `_`-noted keys and the top-level
     `operators` block skipped -- is deliberately the same rule
     `TagVocabulary` applies when the engine reads the file, and a test pins
     the two together: if they ever drift, the editor starts offering to edit
     tags the engine does not read. The new logic lives in
     `src/editor/tagfile.ts`, pure and DOM-free, so it is testable.
   - **Every guard refuses an invalid state rather than repairing one**, which
     is the line task 1 drew around automation. A rename is committed on blur,
     not per keystroke, and is rejected outright -- the field snapping back with
     a reason in the status bar -- when the name is blank, padded with spaces,
     carries a `requires[]` operator (`!`, `|`, a space), or collides with a
     tag already declared anywhere in the vocabulary; the message names the
     namespace the collision is in. A rename that *is* accepted says plainly in
     the status bar that every table still spelling the old name is now broken,
     and the live validator immediately lists all of them (23 errors, for
     `dim`). A tag declared in two namespaces is flagged red on both rows --
     an invisible bug otherwise, since `TagVocabulary` silently keeps the first
     and drops the rest.
   - **Deleting a used tag asks first, listing every use.** `findTagUsages`
     scans the loaded tables for the tag under any tag-bearing key
     (`tags`/`areaTags`/`excludeTags`/`requires`/`targetTags`/`kind`/`itemKind`),
     reading `!tag` and `a|b` the way the matcher does, and the confirm modal
     shows each one as `file - path = "term"` (20 of them, for `dark`). It does
     not auto-patch anything -- exactly the "block and list, never auto-correct"
     shape task 1 specified for `Delete this room type`. The modal itself is now
     a shared `openModal()` that the review-before-save diff also uses, so both
     get Escape-to-cancel and click-away-to-cancel for free.
   - **Descriptions travel with the tag everywhere it is picked.** The
     `<datalist>` options carry `namespace - description` in `label`, which is
     what Chromium actually renders beside the value in the dropdown (`title`
     is not rendered on a datalist option, so it is set as well but not relied
     on). Separately, every tag input's own `title` tracks what is typed into
     it, so a filled field explains itself on hover -- and a `requires[]` term
     explains each alternative on its own line, operators stripped.
   - **One engine change, and it is an address, not a rule.**
     `validate.ts` reported "X has no description" at the bare path
     `tags.json`, which no field could anchor. It now reports at
     `tags.json.room.light.X`, so the badge lands on the row it is about. Same
     error, same severity, better address.

   Verified: 399 tests pass (37 files) including the new
   `tests/editor-tagfile.test.ts` (19 tests: category detection matched against
   `TagVocabulary` over the real base file, rename guards, order-preserving
   rename, usage scanning over the real tables), `npm run typecheck` clean, and
   a headless-Chromium drive of the live editor covering every path above --
   85 rows across 14 categories, `operators` correctly not offered as one,
   collision refused, rename flagged, Revert recovering, the delete guard
   listing and cancelling, add-tag landing its own inline error badge.