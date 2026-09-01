# CLAUDE.md

Project: **Aimon** *(Eamon, with the AI folded in)*

Status: **design locked. Build order steps 1–6 are built** — campaign and table
loading, the graph generator, the placement roller, movement/map/inventory/
autosave, quests (six templates, distance-band placement, the Distant reservation,
a predicate registry and a journal), and now combat: the two-track resolver, the
Presence route with break-by-friendliness, the ability/gambit/primer/stance
engine, crits and fumbles, skill growth, and the corpse run. The game is walkable,
has work to do in it, and fights back. Step 7, the Narrator, is now under way:
**part one is built** — the OpenRouter client, on-device settings with the two
model slots, and the room narrator (two-layer descriptions: batch-generated
`baseDesc` plus the content-signature-cached woven render), degrading to
placeholder text whenever there is no key. Part two — outcome narration, NPC
voicing, and the Tier 2/3 input side — is next, over the same seam.

---

## What this is

A solo-play, browser-based text adventure with an LLM narrator. Terminal
aesthetic, character-based map, adults-only, single player, runs on PC and
Android.

**Design reference: Eamon (1980)** — a text adventure crossed with an RPG.
Persistent character, a hub you return to, dice-roll combat, a shop.

**The world is generated, not authored.** There is no world editor. Content
lives in a handful of JSON tables; the engine builds each area the moment you
walk into it, and it never changes afterwards.

### The correction this document was rebuilt around

An earlier version of this design had a full authoring application — map
painter, entity forms, an LLM "Creator", a twelve-pass generation pipeline with
a lock-and-key dependency chain, a solver, a linter, and a blind-review mode.

All of it is gone. The reasoning was sound and the conclusion was wrong: it
answered "there's no point building the game before there's a world" with *build
a tool to hand-craft worlds* instead of *generate them*. That is a month of
tooling before a minute of play, which is exactly how the predecessor project
died.

**What replaces it: tables, tags, and probability.** Tuning a number in a JSON
file is the authoring interface.


---

## Hard constraints

| Constraint | Consequence |
|---|---|
| No Node.js server available | No backend. Fully client-side static site. |
| PC and Android | PWA, packaged to APK via PWABuilder (cloud build, nothing installed locally). |
| LLM via OpenRouter | Called directly from the browser — OpenRouter permits this via CORS. |
| API key is the user's own | Entered at runtime, stored on-device, never in source. |
| The predecessor bloated and stopped being fun | **Scope discipline is a first-class requirement.** |

Storage: IndexedDB via Dexie. One JSON export/import for backup and PC↔phone
transfer.

Hosting: static (Cloudflare Pages or GitHub Pages).


---

## The core architectural rule

**Code owns truth. The LLM owns prose.**

The model is never asked what happened. It is *told* what happened and writes it
up. Every number, every state change, every roll, every price, every room
connection is decided by deterministic code.

The LLM does exactly three things:

1. Names and describes a room the first time you enter it
2. Voices NPCs
3. Narrates the outcome of resolved actions

It never touches structure. No prose ever feeds back into state.


---

## Where everything is

This file is read every session, so it holds only what is always relevant. The
rest is read on demand.

| File | Contents | Read it when |
|---|---|---|
| [docs/gameplay-rules.md](docs/gameplay-rules.md) | **Single source of truth** for every formula, table and threshold | Touching combat, stats, checks, abilities, defeat |
| [docs/world-and-generation.md](docs/world-and-generation.md) | Campaigns, tables, tags, the lattice, area generation, procgen, quests | Touching generation or content tables |
| [docs/data-model.md](docs/data-model.md) | Every table, the `location` pointer, saving | Touching storage or schema |
| [docs/narration-and-input.md](docs/narration-and-input.md) | Input tiers, parser, turn loop, world clock, companions, descriptions | Touching the parser, the turn loop or any LLM call |
| [docs/decisions-and-history.md](docs/decisions-and-history.md) | Settled decisions, superseded rules, port manifest, attribution | Wondering why something is the way it is |

Runtime data lives in `campaigns/base/` — fourteen JSON files, loaded at boot.
`tools/sample-generate.mjs` is a reference generator that runs against the real
tables; the engine must produce the same shapes.

---

## Systems — closed list for v1

- Movement across the room graph
- **Three-tier player input** — canonical parse, free action with stakes, pure
  expression
- **World turn** — clock, light burning down, pursuers moving, event deck firing
- **Area generation on entry** — tables, tags, weighted rolls, graph shapes
- **Micro-quests** — six templates, distance bands, one objective each
- **Companions** — standing ladder, cap of four, engine-owned recruitment
- Inventory (generous carry limit)
- **Abilities, gambits, stances, primers and triggers** — one stance slot, one
  primer slot, no durations
- Containers, doors, keys — as flavour, never load-bearing
- Light and darkness, with a consequence
- Character stats, two defeat tracks, Presence combat, Libido, skill growth,
  checks and combat — **as defined in the gameplay rules section**, which is the
  only place any of it is written down
- **Defeat and the corpse run** — one defeat, two triggers, configurable cost
- Shop and bank (Hub only — the bank is defeat insurance)
- Repair, training, hiring, and the Hub-return consumable — the gold sinks
- Attribute growth via rare items and a Hub trainer
- Dialogue: LLM voices NPCs, code owns every number
- ASCII map derived from the room graph
- **Campaigns** — content packs merged over base, importable as one JSON bundle
- **Saving and loading** — autosave slot plus unlimited named snapshots
- Settings screen for table tuning and model slots

### Not in v1

A world editor · in-app campaign editing (campaigns are hand-written JSON) ·
authored adventures · lock-and-key dependency chains · a
solver · a linter · quest chains and prerequisites · spells · crafting ·
factions · reputation · time of day · weather · hunger · XP and levelling ·
status effects · initiative order · multiplayer

These earn their way in by being **missed during play**, not by sounding good
during planning.


---

## Build order

1. **Campaign loader, table loader and the tag system** — base plus overrides
   merged on read, tag matching, weighted rolls. Campaign layering is cheap now
   and expensive to retrofit, so it goes in at step one.
2. **Graph generator** — shapes, sizes, room types, edges.
3. **Placement roller** — contents into rooms by tag.
4. **Movement, map, inventory, autosave** — playable with placeholder text.
5. **Quests** — templates, distance bands, objective placement.
6. **Combat.** *(built)*
7. **The Narrator** — prose over a world that already works. *(part one built:
   LLM plumbing, settings, room descriptions)*

**Step 4 is the honest checkpoint,** and it should arrive in a fortnight rather
than a month. If walking a generated area with placeholder text is not
interesting, no amount of generated prose will fix it.

Step 4 is built. The turn loop, the parser, scope resolution, the player record,
light burning down, and one autosave per turn all live in `src/game/`; the
screen lives in `src/ui/`. Room text is the room's own structure — type, tags,
contents, exits — until the narrator replaces it at step 7.

Step 5 is built. Quest templates live in `campaigns/base/quests/`; the records,
the band roll, the hint prose and the completion predicate registry live in
`src/world/quests.ts`; placement and the two write points live in `World`
(`acceptQuest`, `completeQuest`, and binding a Distant objective to its room the
turn its area generates) and in the turn loop (`talk` to accept, `search` to
resolve an investigation, the journal, and completion checked every world half).
An NPC that rolls a quest carries an `offered` quest; accepting places one
objective into the graph that already exists, so it is always reachable. Kill and
clear objectives place their targets now but can only be finished once combat
lands at step 6.

Step 6 is built. The resolver lives in `src/game/combat.ts`; it returns effects
like every other handler and never writes state itself. A fight begins the turn
the player walks into a room holding a hostile, and the enemy round is the world
half's mover step (`enemyRound`), so both halves keep their single write point.
One formula, read from `rules.json`, serves both routes: a **weapon** attack rolls
Accuracy against Evasion and takes HP; a **Presence** approach
(`USE intimidate|taunt|seduce ON <foe>`) rolls Presence against Composure and
takes Resolve, and at zero Resolve the creature breaks the way its rolled
`friendliness` says — flee, surrender or join, against `PRESENCE_BREAK`. Abilities
are data: the player types `USE <ability> ON <foe>`, enemies choose off their
gambit list (`gambitsByRole`, first match wins), and primers, stances and
recharge counters live in the volatile `CombatState` that rides along in the save
only while a fight is live. Crits and fumbles roll their outcome off `CRIT_TABLE`
and `FUMBLE_TABLE`; weapon, approach and armour skills grow on a hit or on damage
absorbed, at `SKILL_GROWTH`. Defeat by either track costs the same: the corpse run
strips the player, parks their purse and carried gear on the victor where they
fell, wakes them at the Hub, and issues the crude kit — losses moved, never
deleted. Consumables and companions-in-combat stay out; they land after.


---

## Rules for the coding agent

1. **Game state is written in exactly two places: step 7 (player half) and step
   12 (world half) of the turn loop.** Nowhere else, ever. Writing state from
   inside a narration handler is the bug that ate the predecessor project.
2. **Never let an LLM response determine a state change.** It may only propose a
   canonical command or a Tier 2 classification, validated then executed by the
   engine.
3. **Never trust an ID returned by the model.** Validate against the scope list
   that was sent.
4. **The gameplay rules section is the only place rules are written down.** No
   formula, table, threshold or constant may be restated elsewhere in this
   document or hardcoded in the codebase. Read them at runtime.
5. **Content goes in a JSON table, not in code.** If adding a thing means
   touching the engine, the table design is wrong.
6. **No prose ever feeds back into state.** The narrator's output is read by the
   player and by nobody else.
7. **Areas are generated once and never regenerate.** A room's structure is
   fixed the moment the area is created.
8. **Every generated record carries `campaignId`.** Two campaigns must never
   share a world.
9. **A campaign file supplies overrides only.** Merge over base on read; never
   require a campaign to restate a value it does not change.
10. **Never regenerate anything when loading a save.** The world lives in the
   save, not in the tables. Regenerating on load destroys the player's world.
11. Ask before adding anything to the closed lists above.


---

## Open questions

- Whether areas should ever connect back to each other, or only to the Hub. A
  web is more explorable; a wheel is much easier to reason about. Cube allocation
  supports either, but a web will collide more often and lean on the slide rule.
- Whether to build the world map now that cubes make it trivial, or leave the
  player with only local orientation.
- ~~Whether `Distant` band quests should force early generation of that area.~~
  **Answered by the world lattice**: the cube is reserved at gate creation, so a
  coordinate can be named before the area exists. Generation stays deferred.
- Spells. Eamon had four. Cut for v1 with no table and no schema.
- How many theme tokens before generated areas stop repeating themselves. This
  is measurable once there is something to play.
- ~~Whether a campaign can override the parser's verb list.~~ **Settled: verbs
  are global.** `verbs.json` sits outside the campaign folder, at `data/verbs.json`.
  A campaign needing
  its own verbs needs its own engine, which is the road back to complexity.
- Whether the event deck earns its place at this scope, or whether wandering
  monsters plus light depletion already carry the world-turn on their own.

