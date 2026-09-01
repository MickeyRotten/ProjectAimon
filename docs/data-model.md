# Data model

*Every table, the single location pointer, and how saving works.*

*Part of Project Aimon. Root spec: [CLAUDE.md](../CLAUDE.md)*

---

## Data model

### The one idea that simplifies everything

**Every object has a single `location` field, and nothing else records position.**

```
"room:warren_7f3:r04"   lying in a room
"player"                carried
"obj:chest_oak"         inside a container
"npc:marda"             held by an NPC (this is also vendor stock)
null                    out of play
```

**`location` points at ids, never at coordinates.** Most locations have no
coordinate: a sword inside a chest carried by a shopkeeper is three pointers deep
and nowhere on the map, and neither is anything in your pocket. Coordinates
address rooms; `location` addresses everything.

Inventory is a query, not a list: *all objects where location = "player"*. Room
contents, chest contents, shop stock — all queries. Move something by writing one
field. There is no second place to update, so there is no second place to forget.

**This answers "does the NPC know its room, or the room know its NPCs?"** — the
NPC holds the pointer and **the room holds nothing**. There is no `contents`
field on `rooms`, and there must never be one. "What is in this room" is a query
across everything whose `location` points at it, objects and NPCs alike.

A room storing its own contents is the same bug as a node storing its own exits:
two records describing one fact, drifting apart the first time one is updated
without the other.

### Tables

**`campaigns`** — `id, name, author, version, permadeath, startingArea,
installedAt`
The tables themselves are files, not rows. This is the registry.

**`saves`** — `id, campaignId, campaignVersion, kind("auto"|"snapshot"),
label, characterName, turn, areaId, savedAt, payload`
`payload` is the whole world state. One row is one restorable game.

**`areas`** — `campaignId, id, archetype, shape, themeTokens[], depth, tier,
cube{x0,y0,z0,x1,y1,z1}, generated, entryRoomId`
`cube` is the area's reserved block in the world lattice, **allocated when its
gate is created — before the area itself exists**. `depth` is gate crossings from
the Hub. `tier` is rolled from `depth` at generation and stored, so an area never
changes difficulty afterwards.

**`rooms`** — `campaignId, id, areaId, x, y, z, type, tags[], name, glyph,
visited, baseDesc`

**`id` is globally unique and is the key**, minted as `<areaId>:r<n>`. Generating
ids per area as `r0, r1, r2` collides the moment a second area exists, and it
would corrupt saves rather than crash — the worst failure mode there is.

**`(x, y, z)` carries a uniqueness constraint and is indexed**, so coordinate
lookup works for the map, quest targeting and debugging. It is deliberately *not*
the primary key: a key that encodes data is a key that can become wrong, and
pointers should survive anything that ever moves a room.

**Names are free to collide.** Two towns may both hold a Fish Market. Only ids
and coordinates must be unique.

**No contents array** — see below. `baseDesc` is written once when the area is
generated.

**`roomRenders`** — `roomId, signature, text, lastUsed`
The woven descriptions, cached per content state. Capped at 8 per room, evicted
least-recently-used.

**`edges`** — `id, roomA, roomB, dirFromA, doorId?, oneWay, gateArchetype?`
Connections are their own records. A door shared between two rooms has **one**
state — storing exits on each room means unlocking from one side leaves it
locked from the other. Room exits are derived from edges at runtime.

**A gate is an edge with `roomB = null` and a `gateArchetype`.** That is the
entire representation — no gates table, no second system. "Walking through an
ungenerated gate triggers generation" is literally "`roomB` is null": generate
the area at `depth + 1`, then set `roomB` to its `entryRoomId`. The edge becomes
an ordinary connection and never needs special handling again.

**`objects`** — one table for items, doors, scenery, containers. Behaviour comes
from flags, not subtypes.
```
id, name, nouns[], adjectives[], location, desc, tags[]
baseId, quality, affixes[]          ← what it was generated from
flags: takeable, scenery, container, open, locked, lockedById,
       lightSource, lit, wearable, worn, edible, weapon, armour, untradable
condition (0-100), burnRemaining, gold?
```

`gold` is the one exception to the line below, and only for coin: a purse's
value is not recoverable from a base and a quality, so it is rolled once from
the loot tier and written down.

**Combat values are derived, never stored.** `damage`, `penetration`,
`reduction`, `penalty` and `price` all compute from `baseId` + `quality` +
`affixes[]` against `WEAPON_TABLE` and `ARMOUR_TABLE`. Storing them too would
mean retuning a weapon in `rules.json` silently failed to affect every sword
already in the world.

`armourValue` was a leftover from flat absorption and is gone — armour is a
percentage now.

`condition` starts at 100 and drops on a fumble. It is what `repair` repairs;
without it the gold sink had nothing to act on.

**`npcs`** — `campaignId, id, name, aliases[], location, persona, tags[], sex,
stats{brawn, agility, toughness, charisma, willpower, wits}, hp, maxHp,
resolve, maxResolve, armourReduction, penetration, weaponDamage, damageBonus,
attacksPerRound, threat, friendliness, bribeThreshold, disposition, standing,
sensed, isVendor, priceModifier, imageBlob, hostile, baseId, role, gambits,
abilities[], presenceImmune`
**One table holds everyone who is not the player**, and `hostile` is a flag on
the record rather than a second table: a bribed footpad and a hired sword are
the same row with a different disposition. `baseId` and `role` are what it was
generated from, which is what repopulation reads. `sex` is rolled per instance
and drives pronouns only. `damageBonus` is stored because a creature has no
Brawn-derived maths to run, and `presenceImmune` is the taxonomy lookup
resolved once at generation.
`location` uses **the same pointer as objects** — `"room:r_barn"`, `"player"`
for an active companion, `null` when out of play. NPCs were previously given a
`roomId`, which was an inconsistency: two position systems means two places to
forget to update. There is now one.
`tags[]` carries the taxonomy, so resistances are a lookup rather than a field.
`courage` is retired — Resolve does that job now.
`aliases[]` holds **every former name**. Renaming in place keeps the id but the
transcript and any matcher keeps saying the old one, so matchers read name
**plus** aliases, never `name` alone.
`imageBlob` is **upload-only**; nothing generates it.
Monsters skip weapon-skill and armour-expertise maths entirely — they store
final values.

**`quests`** — `id, type, giverNpcId, state, objectiveIds[],
prerequisiteQuestIds[], rewardRoll`

**`objectives`** — `id, questId, kind, targetId, targetRoomId, targetCoord,
band, completedBy, done`
`targetCoord` is what makes `Distant` quests work: a coordinate can be reserved
inside an area that has not been generated yet. **Once that area generates,
`targetRoomId` is filled in from the coordinate index and `targetCoord` becomes a
record of how it was chosen.** Everything downstream reads the id.

**`player`** — `campaignId, name, archetype, roomId, hp, resolve, libido,
purse, banked, stats{brawn, agility, toughness, charisma, willpower, wits},
weaponSkills{axe, bow, club, spear, sword},
approachSkills{intimidate, taunt, seduce}, armourExpertise, armourWorn,
weaponWielded, pronounRefs{it, him, her, them}, brief`
`armourWorn` and `weaponWielded` are object ids, so gear is a pointer like
everything else. `archetype` chooses the starting kit and nothing else —
attributes are 3d8 straight, and weighting them by archetype would be a rule
living in the engine rather than in a table. `brief` is the description mode.
Max HP, max Resolve, carry capacity and every combat value are **derived** from
stats per the gameplay rules, never stored — so they can never drift. `libido`
is stored, because the world moves it.

**`lorebook`** — `id, name, keywords[], content, priority, alwaysOn`

**`triggers`** — see The world clock and the event deck.

**`transcript`** — `id, turn, input, output, timestamp`

**`settings`** — API key, temperature, token budgets, and **two model slots**:

| Slot | Wants |
|---|---|
| Narrator | prose quality |
| Translator | cheap and fast — Tier 1 fallback and Tier 2 classification |


---

## Saving and loading

### What a save contains

Everything the engine generated plus everything the player did: character,
areas, rooms, edges, objects, npcs, quests, objectives, triggers, flags, clock,
transcript. Plus `campaignId` and the campaign `version` it was created against.

Because generated areas are **persisted in the save**, tuning a table never
breaks an existing game. Changed weights apply only to areas generated after the
change. This is a direct consequence of generating whole rather than lazily, and
it is worth protecting.

### Slots

- **Autosave** — the active slot, written every turn at the end of the world
  half. There is exactly one write point, so this is trivial.
- **Named snapshots** — the player's deliberate saves, unlimited.
- Each slot records campaign, character name, turn count, area, and timestamp.

Snapshots are the unit that syncs to the cloud, if sync is ever ported. The
autosave stays local; per-turn network cost is zero.

### Version drift

A save stamped against an older campaign version still loads. The engine reports
what changed and carries on, because the world is in the save, not in the
tables. **Never migrate a save by regenerating anything** — that is the one
operation which would destroy the world the player has been walking around in.

If a campaign is missing entirely, the save lists what it needs and refuses to
load rather than half-loading against base.

### Permadeath is a campaign setting, not a global

`campaign.json` carries `permadeath: true | false`.

Worth being explicit about the tension: **seeded rolls stop regenerate-scumming,
but save slots reopen it.** Reloading before a bad fight is exactly the fishing
the seeding was meant to prevent. With permadeath on, death deletes the
character's slots and snapshots are disabled mid-adventure. With it off, the
player is trusted to make their own game.

Do not try to have both at once with a clever compromise. Pick per campaign.
