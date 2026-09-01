# World and generation

*Campaigns, tables, tags, the world lattice, area generation, procedural content, quests.*

*Part of Project Aimon. Root spec: [CLAUDE.md](../CLAUDE.md)*

---

## Campaigns

**A campaign is a content pack.** Everything in the next section lives inside
one, so a different campaign is a different setting, a different tone, and a
different set of tables — with no code change.

```
campaigns/
  saltmere/
    campaign.json        id, name, author, version, startingArea, hub
    rules.json           overrides only, never the full set
    areas/*.json
    content/*.json       objects, monsters, npcs, lore, events, placement
    quests/*.json
    prompts/*.md         narrator, examine, npc dialogue, room description
```

### Layering — a campaign overrides, it never redefines

There is a **base** campaign shipping every table and every prompt. A campaign
supplies only what it changes, and the two are merged on read.

```
resolved = merge(base, campaign)     per file, per key, campaign wins
```

**Merge semantics, which must be explicit or the loader guesses:**

| Kind | Rule |
|---|---|
| Primitives | Campaign wins |
| Objects | Deep merge |
| **Arrays** | **Replace entirely** |
| Arrays, to append | `"+affixes": [...]` |

Arrays replace by default because appending would mean a campaign could never
*remove* a base entry — it could only ever add. The `+key` prefix covers the
common case of extending a list without restating it.

Without this, making a second setting means restating every rule and prompt you
did not want to change, and the two drift apart the first time you tune
anything. Same normalize-on-read discipline as the settings layer.

### Campaigns are importable

A campaign exports as one JSON bundle and imports the same way. That is how a
setting gets shared or backed up, and it is why there is no editor — authoring a
campaign means writing JSON, and sharing one means sending a file.

**Validate on import**: unknown keys are reported and ignored rather than
rejected, missing keys fall through to base, and a campaign referencing a room
type or tag that no table defines fails loudly at import rather than silently at
generation.

### Every generated record is campaign-scoped

`campaignId` on areas, rooms, edges, objects, npcs, quests and triggers. Two
campaigns can be part-played at once and their worlds can never mix.


---

## Content tables — the authoring surface

There is no editor. There are JSON files inside a campaign, merged over base at
boot and overridable from a settings screen for tuning. **Changing the world
means changing a number.**

```jsonc
// areas/farmland.json
{
  "id": "farmland",
  "size": [8, 14],                       // room count range
  "shapes": ["sprawl", "loop", "hub"],   // graph shapes it may roll
  "roomTypes": {
    "field":     { "w": 30, "tags": ["outdoor","open","wild"] },
    "lane":      { "w": 20, "tags": ["outdoor","open","path"] },
    "farmhouse": { "w": 10, "tags": ["indoor","dwelling"] },
    "barn":      { "w":  8, "tags": ["indoor","dark","storage"] },
    "well":      { "w":  5, "tags": ["outdoor","water","landmark"] },
    "shrine":    { "w":  4, "tags": ["outdoor","landmark","quiet"] }
  },
  "themeTokens": ["harvest", "debt", "crows"]
}
```

```jsonc
// content/placement.json — what appears in a room, and how often
{
  "container": { "chance": 0.30, "requires": ["indoor"] },
  "hostile":   { "chance": 0.20, "requires": ["dark|wild"] },
  "npc":       { "chance": 0.25, "requires": ["dwelling|path"] },
  "loot":      { "chance": 0.15 },
  "curiosity": { "chance": 0.20, "requires": ["landmark"] }
}
```

Other tables: `campaign.json` (identity, the hand-authored Hub, starter kit,
character creation), `data/verbs.json` (the parser's whole vocabulary — **global,
not per-campaign**, and so it lives outside `campaigns/` entirely),
`content/items.json`, `content/monsters.json`,
`content/npcs.json`, `content/abilities.json`, `content/placement.json`,
`content/lore.json`,
`quests/*.json`, `prompts/*.md`, `rules.json`, and `tags.json` — the closed tag
vocabulary everything validates against.

**A complete base campaign ships in `base/`**, with four area archetypes, the
item/monster/NPC tables, default rules, and `sample-generate.mjs` — a reference
generator that runs against the real files.

**`themeTokens` is the highest-leverage knob in the project.** Two random tokens
are handed to the narrator when an area is generated, and they are what stop
every generated place reading like the same damp field. Add to the list over
time.


---

## The tag system

Tags are the entire intelligence layer, and the only one.

A room is a bag of tags. Every table filters on tags and rolls. Nothing else
decides what goes where.

```
requires: ["indoor"]              must have
requires: ["dark|wild"]           must have at least one
requires: ["outdoor","!water"]    must have, must not have
```

Room tags come from the room type. Objects, monsters, NPCs, quests, lore entries
and events all declare tag requirements and are rolled against candidate rooms.

**This is the extension point.** A new content type needs no new engine code —
it needs a table with `chance`, `requires`, and whatever payload it carries.


---

## World structure

**The Hub** — hand-authored, permanent, five or six rooms defined in the
campaign's `campaign.json`, written once by hand. Character creation, the shop, the bank, the way out. No
tool needed to make six rooms.

**Areas** — generated whole on first entry, then fixed forever. An area is a
graph of rooms with an archetype (`farmland`, `warren`, `ruin`, `town`),
its own tag mix and theme tokens.

Areas connect to each other and to the Hub through **gates**: an edge whose far
side does not exist yet, tagged with the archetype of the area behind it.
Walking through one generates that area.

Both rooms and areas sit in **one world coordinate lattice** — see The world
lattice. Coordinates give every room a stable slot and a readable code, and let a
quest name a room inside an area that has not been generated yet. Adjacency
remains edge-defined and distance remains hops.

There are no "adventures" with goals and endings. There is a world you walk
around in, and things to do in it.


---

## The world lattice

A single X/Y/Z coordinate space for the whole campaign. **Z is depth** —
negative underground, positive above — so a warren can sit beneath farmland
without either knowing about the other.

### Coordinates are identity, hops are distance

This is the rule that makes coordinates safe to reintroduce.

Coordinates were removed earlier because a geometric lattice made distance
geometric: two rooms "four apart" needed four rooms between them, which meant
authoring corridors nobody wanted to walk.

**A coordinate is a slot and a name. An edge is the connection.**
`DISTANCE_BANDS` stays on hop count and must never become euclidean distance —
that is the single change that would reintroduce the filler-corridor problem.

The rule runs **one direction only**:

- **Adjacency does not imply connection.** Two rooms side by side with no edge
  between them are two rooms with a wall between them. This is wanted: the rooms
  along an inn corridor are adjacent and share no doors.
- **Within an area, connection *does* imply adjacency.** The layout walk must
  place every room orthogonally adjacent to at least one room it has an edge to.
  With 40% cube slack this almost always resolves; when it cannot, see **Layout
  failure** below — the edge may only be dropped if it is not a bridge.

Gaps between connected rooms therefore only occur **across gates**, where the map
is already showing an area boundary and nothing looks stranded.

### Rooms never store their connections

"What does this room connect to" is a **query** over `edges` — every row where
`roomA` or `roomB` is this room, with both columns indexed. Exactly like
inventory being a query over `location`.

A room storing its own exits is the bug the `edges` table exists to prevent: two
records describing one fact, so unlocking a door from one side leaves it locked
from the other. **The absence of an edge is the wall.** Nothing stores "not
connected".

### Areas get a cube, sized to their room count

```
slots     = ceil(rooms × 1.4)     40% slack for the layout walk
footprint = ceil(sqrt(slots))     square-ish in X/Y
zSpan     = 3 for warrens, 2 for ruins, 1 otherwise
```

| Rooms | Cube | Filled |
|---|---|---|
| 9 | 4×4×1 | 56% |
| 12 | 5×5×1 | 48% |
| 15 | 5×5×1 | 60% |
| 20 | 6×6×1 | 56% |

Sizing the cube to the room count is the other half of avoiding filler. Around
half-filled is right for a dungeon map: solid enough to read as a place, open
enough that the layout walk can resolve a collision by stepping sideways.

### Allocation happens at gate creation, not area generation

**The entry room must occupy the slot immediately adjacent to the incoming gate
coordinate**, so a one-hop crossing is one lattice step. Without that constraint
the entry room can land at the far side of its cube and a single hop spans half
an area, which distorts the world map and makes the crossing read as a journey.

When a gate is made, its cube is reserved immediately — adjacent to the source
area's cube along the gate's direction, offset in Z by archetype (a warren gate
drops two levels). Collisions slide outward along the gate axis; after 60
attempts it takes the nearest free cube and logs a long road.

**Reserving the cube before the area exists is the point.** It is what makes the
`Distant` quest band work, which had been an open question since quests could not
name a room that did not exist.

### Distant quests reserve a coordinate

1. Quest rolls `Distant`
2. Engine picks an unallocated coordinate inside a neighbouring area's reserved
   cube — the area itself may be nothing but a gate stub
3. `objectives.targetCoord` stores it
4. When that area is finally generated, **a room is guaranteed to land on each
   reserved coordinate**, carrying the objective

No special case at play time. The objective was always going to be there.

### What this does not change

- Room adjacency is still edge-defined, never inferred from coordinates
- The map renders rooms at their stored coordinates, so a room never moves
  between renders — but it must draw connections explicitly (see below), because
  adjacency no longer implies them
- Areas still generate whole, on first entry, and never regenerate

### Layout failure — never drop a bridge edge

Audit decision Q16 said "drop the offending edge and log it". That is unsafe:
**in a `sprawl` archetype, which is a tree, every edge is a bridge**, so dropping
any one of them permanently severs part of the area — potentially stranding a
`Distant` quest objective or the only way forward.

Order of attempts:

1. **Repack** the area with 30% more cube slack (up to twice)
2. Drop a **non-bridge** edge — one whose removal leaves the graph connected
3. **Grow the cube** and retry
4. Log and accept the overlap

An edge is a bridge if removing it raises the component count. Check before
dropping, always.

This matters more now than when Q16 was decided, because *connection implies
adjacency within an area* gives the layout walk more reason to fail.

### The map draws on a half-step grid

Because adjacent rooms may share no door, the map cannot leave connection
implicit. Render coordinate `(2x, 2y)` holds the room; `(2x+1, 2y)` and
`(2x, 2y+1)` hold the connector slots, drawn only where an edge exists.

```
□─□ □     two joined rooms, then one adjacent but walled off
│   │
□ □─□
```

Storage stays integer; the renderer doubles it. Half-stepping was rejected
earlier because it halved room capacity in a fixed grid — that objection is gone
now the cube is sized to the room count, so the cost is only render width.

### What it makes possible

- **A world map.** One glyph per visited area, positioned by cube, `@` for the
  current one. The orientation layer the design previously had no answer for.
- **Room codes.** `12.7.-3` is unique, readable, and directly usable as a debug
  handle, a quest reference, and a save-file anchor.
- **Z as real vertical.** A stair down from a ruin can land in a warren that was
  allocated beneath it, and the two areas can be drawn on the same world map at
  different levels.


---

## Area generation

One deterministic pass, no LLM, on first entry. Takes a few milliseconds.

0. **Depth** = the source area's depth + 1 (the Hub is 0), stored. The **cube was
   already reserved** when the gate was created.
1. **Archetype** from the gate's `gateArchetype`
2. **Roll size** from the archetype's range, and a **graph shape**
3. **Build the room graph** — connections first, then place rooms into free
   slots inside the area's cube. Adjacency stays edge-defined; the coordinate is
   a slot, not a distance. Any coordinate reserved by a `Distant` quest must
   receive a room.
4. **Assign a room type** to each room from the weighted table, which gives each
   room its tags
5. **Roll contents** per room against `placement.json`, filtered by tags
6. **Persist the whole area**

**The map exists immediately and is permanent.** Only prose is lazy — a room's
description is written by the LLM the first time you enter and saved forever.
That is what makes the world stick.

Generating whole also means the quest system has a real graph to aim at the
moment a quest is taken.

### Graph shapes

| Shape | Feel |
|---|---|
| `sprawl` | Branching, dead ends, no loops. Feels wild. |
| `loop` | A ring with spurs. Feels walkable and knowable. |
| `hub` | A centre with arms. Feels like a settlement. |
| `warren` | Dense, many connections, easy to get turned around. |

Shape is rolled from the archetype's allowed list. It is the cheapest way to
make two areas of the same type feel different.

Shapes are built as connections only, and the parameters that make one branchy
or dense live in `WORLD.shapes`. Two structural limits are not tunable, because
they are properties of a grid rather than opinions: **degree** — four ways out
of a slot in a flat area, six where the cube has depth, fewer for the entry room
on its face — and **parity** — a lattice is bipartite, so an odd cycle cannot be
drawn at all. A `warren`'s density is therefore woven in *after* placement,
between rooms that ended up side by side. See *What building the graph generator
settled* in [decisions-and-history.md](decisions-and-history.md).


---

## Procedural content — items, monsters, NPCs

All three use the same shape: **a small base table, multiplied by modifier
tables.** Twenty item bases and twenty-two affixes produce thousands of distinct
results from a page of JSON. That ratio is the entire reason there is no editor.

Five area archetypes ship in `base/areas/` — `farmland`, `town`, `warren`,
`ruin`, and `coven` as a worked example of an area-level override.

Reference implementation: `base/sample-generate.mjs`. It is not production code,
but it is the order the engine follows, and it runs against the real tables.

### Items — base × quality × affixes

```
item = base + quality + up to 2 affixes
```

| Quality | Weight | Stat mult | Price mult | Affixes |
|---|---|---|---|---|
| crude | 30 | 0.7 | 0.4 | 0 |
| plain | 45 | 1.0 | 1.0 | 0 |
| fine | 20 | 1.2 | 3.0 | 1 |
| masterwork | 5 | 1.4 | 9.0 | 2 |

Affixes carry a `requires[]` filtered on the base's kind and quality tags, so
*Reinforced* only lands on armour and *Hooded* only on lights. The name is
assembled prefix-quality-noun-suffix: **"Hooded masterwork brand of Long
Roads"**.

**The hard rule: an affix may only modify a value the engine already has.**
`damage`, `penetration`, `accuracy`, `reduction`, `penalty`, `hp`, `evasion`,
`presence`, `composure`, `allure`, `rapport`, `threat`, `critChance`, `carry`,
`burn`, `libidoDrift`, `priceMult`. No affix introduces a mechanic. This is what
keeps the item system from becoming a second rules engine.

Area tier shifts the quality roll upward via `lootTiers.qualityBias`.

### Monsters — base × role × elite

```
monster = base + role + (elite, by tier chance)
```

Fifteen bases, five roles, six elites. Stats are **never authored per monster** —
they derive from `statCurve[tier]` with a ±3 roll, then role and elite modifiers,
then taxonomy tag multipliers.

Roles are `skirmisher · brute · lurker · leader · wretch`. `leader` carries an
`escort` range, so a leader roll pulls 1–3 more creatures into the room.

Elites fire at 8/12/18% by tier and add a title, a tag and a stat lift —
*Hungering*, *Ironbound*, *Beguiling*. One roll turns a routine encounter into
one worth remembering.

**Tier gating:** a base may appear if `base.tier <= area.tier + 1`, and over-tier
bases have their weight cut to 35%. Without this a tier-1 farm can roll a barrow
wight, which is a real bug the reference generator surfaced on its first run.

**Taxonomy comes from tags, not fields.** `mindless` sets no Resolve track at
all, so the generator prints `res —` and Presence attacks have nothing to target.

### NPCs — role × two traits × one want

```
npc = role + traitA + traitB + want
```

Twelve roles, fifteen traits, twelve wants — 12 × 105 × 12 ≈ **15,000 personas**
from three short lists.

The engine assembles a persona *string* and nothing else:

> *"fence. grieving and wheedling. Wants a debt paid."*

The Narrator writes every line of dialogue from that. **No dialogue is
authored, ever.** Roles carry a `quests[]` list, so a fence offers deliver and
fetch work while a scholar offers investigate.

Roles filter on room tags, which is what stops a smith appearing in a field.

### Difficulty by distance, not by archetype

Tier was originally a fixed property of an archetype, which meant farmland was
always tier 1 however deep you went. **Difficulty now follows distance from the
Hub**, in steps, with jitter so the curve is not a straight line.

```
tier = base + floor(areaDepth / step)
     + jitter   (-1 15% · 0 55% · +1 25% · +2 5%)
     + spike    (5% chance of +2)
clamped to the archetype's tierFloor..tierCeil, and to DEPTH_TIER.max
```

**Rolled once at generation and stored.** An area never changes tier, so
backtracking through somewhere you cleared is always safe — the same rule that
says areas never regenerate.

Measured curve for the warren, forty rolls per depth:

| Depth | 2 | 3 | 4 | 5 |
|---|---|---|---|---|
| 0 | 37 | 3 | | |
| 2 | 28 | 9 | 3 | |
| 4 | 5 | 23 | 9 | 3 |
| 6 | | 5 | 23 | 12 |
| 8 | | | 5 | 35 |

Archetype bounds keep the theme honest — farmland tops out at 4, the coven
starts at 3 — while depth decides where inside that range you land.

**Within an area**, rooms further from the entrance lean one tier harder, reusing
`DISTANCE_BANDS`, and the deepest room is guaranteed an elite. Exploration has a
gradient rather than a flat field.

**Signposting is mandatory.** Every gate carries a prose hint of what is behind
it. A spike area is genuinely dangerous and the player must be able to read that
before walking in — flee always works and defeat is a setback, but neither
excuses an unreadable world.

**A bug worth recording:** the first version rolled almost the same tier every
run. A raw LCG fed sequential seeds produces correlated first outputs, so the
first roll of each generation came out nearly identical — the same class of
failure as the FNV-1a parity trap in the gameplay rules. Seeds must be
avalanched through a murmur3 finalizer before use. Any roll that happens *early*
in a generation is where this shows up.

### Encounter compositions

Encounters pick a **shape** first, then fill each slot with a base that fits the
area and room:

| Composition | Shape |
|---|---|
| `lone` | one creature |
| `pack` | 2–4 of a kind |
| `warband` | a leader plus 2–4 others |
| `pair` | a brute and one or two lurkers |
| `ambush` | 2–3 lurkers, concealment rooms only |

CoC2 publishes explicit compositions this way — five imps; four imps and a lord;
a lord with shankers and warlocks — and it is better than relying on a leader
role to pull escorts, because it controls *which* variants appear together.

### Abilities and gambits

Roles that only shift stats play identically to each other. Abilities fix that,
and done as **data** they are cheaper than the hardcoded behaviour list they
replace.

**Enemies choose with gambits** — FFXII-style, an ordered list of
condition→action pairs, first match wins:

```jsonc
"brute": [
  { "when": "self.hp<40",                 "use": "guarded_stance" },
  { "when": "target.primer==off_balance", "use": "fury_strike" },
  { "when": "round==1",                   "use": "trip" },
  { "when": "always",                     "use": "attack" }
]
```

Nine closed conditions: `self.hp<N` · `self.resolve<N` · `ally.hp<N` ·
`target.hp<N` · `target.resolve<N` · `target.primer==X` · `round==N` ·
`allies>N` · `always`. A ~40-line evaluator.

**Players type `USE <ability> ON <target>`**, which fits the existing parser
grammar exactly — verb, noun, preposition, noun. `use` is added to the verb
list, and per rule 5 that is honest: this *is* a system.

**Abilities come from equipment and approach skills**, never from a class or
perk tree. A spear grants Set Spear, an axe grants Cleave, intimidate at 20+
grants Cow. No new progression system.

**Roles are tag-gated.** A role is refused if the base carries any of its
`excludeTags` — a mindless skeleton must never roll `leader`, because leader
gambits use Presence abilities it can never land. The reference generator
produced exactly that bug before the gate went in.

### The stance rule — what keeps this off the cliff

The moment an ability lasts "3 turns" you need timers, stacking rules, expiry
ordering and a UI showing what is active. That is why status effects were
excluded in the first place.

**One stance slot per combatant. No stacking, no timers.** A stance lasts until
replaced or combat ends. Everything else resolves instantly. One field, no
bookkeeping, most of the tactical feel.

Use limits come from CoC2's three-tier tagging: `atwill`, `recharge` (locked for
N rounds), `encounter` (once per fight). One integer per ability, ticked down.
No resource bar.

### Primers and triggers

Some abilities attach a **primer** to a target. **A primer has no duration and
does nothing on its own** — it is pure potential. Another ability *triggers* it,
consuming it for a much larger effect.

**One primer slot per combatant**, same as stances. A new primer overwrites the
old. No timers, so no cliff.

| Primer | Applied by | Cashed by |
|---|---|---|
| `exposed` | Sunder | Pierce — ignores armour, ×1.5 |
| `off_balance` | Trip | Fury Strike — ×2.0 and accuracy swings positive |
| `charmed` | Allure | Promise — ×2.2 pressure, ignores Composure |
| `rattled` | Cow, Jeer | Browbeat — ×2.0 pressure and a flee check |
| `marked` | Mark | Exploit — ×1.8 and +25 crit |

**Exploit is the cross-axis trigger**, and it is the important one: it cashes a
*Presence* primer with a *weapon* attack. That makes a hybrid build worth
building, and stops Presence being dead weight in a Brawn character's hands.

Combat becomes a two-beat rhythm — set up, cash in — which is also the best
possible shape for an LLM narrator, because the trigger moment is inherently
dramatic prose.

**Companions gain real purpose from this.** A companion primes, the player
triggers. That is worth more than their damage contribution and costs nothing
extra.

### Sensing becomes worth the turn

With gambits, Sense reveals the enemy's **decision list**, not just stats. You
learn the hag binds wounds below 40% and rallies when she has allies, so you know
to burst her or strip her escort first.

That turns Sense from an information tax into a tactical choice, and it is why
FFXII's system was fun to watch: the logic is legible.

### Caps

- **24 abilities in base, hard.** CoC2 has hundreds; that is a decade of content.
- **5 abilities per combatant.**
- **No ability may introduce a value the engine does not already have** — the
  same rule as item affixes, and the same reason: it stops the ability table
  becoming a second rules engine.

### World state changes what spawns

```jsonc
"spawnUpgrades": [
  { "ifFlag": "smugglers_unbeaten", "replace": { "footpad": "cutthroat" } }
]
```

Nearly free with the flag system, and the best long-term texture available — the
world visibly answers what the player did, with no quest chain behind it.

### Conditional stats — the best idea in CoC2's enemy design

Their Imp Blackguard gets **+40 Attack Power and +25 to three defences** if the
player never dealt with a weapons shipment in a different area, and a **−20
penalty** if they did. An eighty-point swing on a boss, decided hours earlier
somewhere else.

```jsonc
"conditionalStats": [
  { "ifFlag": "smugglers_unbeaten", "appliesTo": ["humanoid"],
    "mods": { "damage": 2, "reduction": 15 }, "title": "well-armed " }
]
```

One conditional block, enormous payoff, and the flag system already exists.

### Likes and dislikes — schema only

CoC2 modifies Tease damage by 10% per matching body tag. **Accepted in the
schema, disabled in v1**, because it needs a player appearance-tag system that
does not exist.

This is a correction to an earlier absolute rule in this document. What must be
avoided is **immunity, or a large swing tied to something the player cannot see
coming**. A ±10% modifier keyed to body tags rather than sex is different: it is
small, it is texture, and Sensing reveals it. When it lands: keep it off sex, cap
it near ±15%, and make Sensing show it.

### Sex — a field, never a tag or a variant

Rolled **per instance** and stored on the record. It drives pronouns for the
Narrator, pronoun resolution in the parser (`attack her` has to resolve), and
one line of the narration packet. Nothing mechanical.

**Not a variant** — two bases per creature doubles the table for no mechanical
difference, and every future creature would need both forever.

**Not a tag** — `tags.json` is the closed vocabulary that drives `TAXONOMY`
lookups and `requires[]` filters, and everything in it answers *how does this
behave in combat?* Sex does not. Putting it in that namespace lets a room filter
or a resistance rule match on it by accident.

Resolution order, one line:

```
sex = area.sexOverride ?? room.sexOverride ?? base.sex ?? { m: 50, f: 50 }
```

Omit `sex` on a base and it rolls 50/50, so most bases need no entry. Undead,
constructs and plants declare `{ "none": 100 }`.

**Area overrides** are how a themed area works, and they apply to NPCs as well
as monsters — an area with only female spawns but mixed shopkeepers reads as a
bug.

```jsonc
"sexOverride": { "f": 85, "m": 15 },
"sexOverrideRespects": ["none"]
```

`sexOverrideRespects` keeps sexless things sexless, or the area forces a gender
onto skeletons and clay sentries.

**Weighted, not binary, on purpose.** 85/15 beats 100/0 because the exception
carries meaning — a lone man in the coven is a hook, while an absolute rule is
just a setting. `base/areas/coven.json` is the worked example.

Room-level `sexOverride` is accepted by the loader and unused in v1, in the same
spirit as `prerequisiteQuestIds`.

**Sex does not affect Seduce, and must not.** If creatures had preferences that
modified Presence pressure, a Charisma build would be randomly weaker against
half of all spawns, punished for a roll it never made and cannot see coming —
the same failure as the unwinnable armour matchup that percentage reduction was
brought in to delete. Taxonomy tags already provide the meaningful resistance
axis, and the player can read those off a Sense.

If preference is wanted as flavour, add it as a **narration-only field** passed
to the Narrator and never to the resolver, exactly like `defeatBy`.

**Keep the two axes independent.** An area may be all-female *and* full of
`armoured` `proud` bruisers who are miserable to Seduce. Let `sexOverride`
correlate with `lustful` and sex has become a covert difficulty modifier through
the back door.

### Placement and guarantees

`placement.json` rolls each content type per room against a chance and a tag
filter. Then `guarantees` tops up:

```
minHostiles: 3    minLootRooms: 2    minNpcs: 1
lightSourceIfDarkArea: true          maxHostilesPerRoom: 1
```

**The guarantees are not optional.** A ten-room area rolled barren on the
reference generator's first farmland run — zero hostiles, zero NPCs, one loot
room. Small areas fall below expectation often enough that the top-up pass is
load-bearing, not a safety net.

Empty rooms are still wanted, though: the doc's slack rule asks for roughly a
third of rooms with nothing mechanical in them, because that is where atmosphere
lives.

### Tag validation

`tags.json` is the **closed vocabulary**. Every tag used anywhere in any table
must appear in it, and campaign import fails loudly on an unknown tag rather
than silently never matching.

This catches the most likely content bug by far — a typo in a `requires[]` that
makes a rule quietly never fire. It also caught a real one during authoring:
`town` carried the `cultivated` area tag, so every town room matched the farmer
role and farmers appeared behind shop counters.


---

## Quests

Simple now, extensible by design. No chains, no prerequisites, no state
machines, no branching. You can have a dozen running and never track anything
beyond "done or not".

### Templates

```jsonc
// quests/fetch.json
{
  "type": "fetch",
  "bands": { "near": 20, "quiteNear": 50, "far": 30 },
  "targetTags": ["indoor|landmark"],
  "hintFrom": ["tags", "direction", "band"],
  "rewards": ["gold", "item"]
}
```

Types for v1: `fetch`, `kill`, `deliver`, `find`, `clear`, `investigate`.

An NPC rolled into a room rolls a quest against the template table. That is the
whole quest generation system.

### Distance bands

The core mechanic, and it generalises further than quests.

```
Near        1–2 hops
Quite Near  3–5 hops
Far         6+ hops
Distant     another area
```

On accepting a quest: roll a band, collect every room at that hop-distance whose
tags satisfy `targetTags`, pick one, place the objective. If nothing matches,
widen the band by one and retry. If nothing matches at any band, reroll the
quest type.

Because the objective is placed into a graph that already exists, it is always
genuinely reachable. Nothing needs to prove it afterwards.

**Reuse the bands for everything else that needs a distance:** rumours,
wandering spawns, "you hear something to the north", where a fleeing enemy runs
to.

### Hints come free

The hint is generated from the target room's actual data, so it is always true
and never authored: tags `indoor, dark, storage`, four hops east, band
`quiteNear` becomes *"a dark store-place, a fair walk east."*

### The bones for extending later

Build these seams now even though nothing uses them yet. They cost almost
nothing at this size and retrofitting them costs a lot:

- **Objective is its own record**, not a field on the quest. A quest holds a
  list of objectives. v1 always creates exactly one.
- **Objectives have a `completedBy` predicate** drawn from a small registry
  (`hasItem`, `npcDead`, `roomCleared`, `flagSet`, `atRoom`). New quest types
  are new predicates, not new engine code.
- **Quests carry `prerequisiteQuestIds: []`**, always empty in v1. Chains later
  are a populated array, not a schema change.
- **Quest state is an enum** (`offered · active · complete · failed ·
  abandoned`), not a boolean.
- **Rewards are a table roll**, never hardcoded in the template.

That is the whole extension surface. Do not build anything else on it yet.


---

## Locks are flavour, not structure

Locked doors, stuck barn doors, and things needing a crowbar all still exist —
rolled from `placement.json` like anything else.

**But nothing is load-bearing.** No dependency chain, no key that gates
progression, so nothing needs proving solvable. A locked barn with the crowbar
three rooms away is a nice thirty seconds, and if the player never opens it,
nothing is lost.

This is the deliberate trade this design makes: **authored lock chains produce
better puzzles; generated worlds produce more world.** A generated fetch quest
four rooms east will never feel like working out that the key is inside the egg
inside the bird. The goal here is explorable and fun, and shipped.
