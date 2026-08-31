# Narration and input

*The three input tiers, the parser, the turn loop, the world clock, companions, room descriptions, structured output.*

*Part of Project Aimon. Root spec: [CLAUDE.md](../CLAUDE.md)*

---

## Player input: the three tiers

**Structure lives in the world, not in the input.** The player may type anything.
What stops the game dissolving is that the world is rigid — geography makes things
unreachable, resources deplete, and the narrator owns nothing.

Every input falls into one of three tiers. The engine decides which.

**Latency is two calls and stays two calls.** Classification then narration runs
around 2.3 seconds if both use a full-sized model. The fix is a **tiny model with
a hard 100-token cap** for classification — not merging the two calls, which is
impossible: the engine must roll *between* them, or the model is deciding
outcomes and the core rule collapses.

### Tier 1 — Canonical actions

Movement, take, drop, open, unlock, attack, buy, examine. Matched by the
deterministic parser below.

**No API call, instant response.** This is roughly 70% of turns in a text
adventure, and keeping them instant is a real feel win on mobile — walking north
should not take three seconds or cost a token.

### Tier 2 — Free actions with stakes

*"I tell the innkeeper about my brother and ask if he knew him."*

No canonical command covers this. Rather than dismissing it as flavour, the
engine resolves it:

1. The **Translator** classifies the attempt into a small engine-owned enum:

```
{ stat:   <one of the stats defined in the gameplay rules>,
  band:   <one of DIFFICULTY_BANDS>,
  target: <id from the scope list, or null> }
```

**The classifier does not declare an effect.** It says *what kind of attempt this
was and against whom* — nothing more. The engine looks up whether that target has
a valid handler for that kind of attempt, rolls, and decides the state change.

Without this, a player can invent a premise the world does not contain — *"I ask
the guard about his missing daughter"* — and the classifier, which cannot see the
guard's actual state, returns a flag change for an objective that never existed.
The model must never name the consequence, only the attempt.

2. The engine validates every field, rolls, and applies the result.
3. The Narrator is told the outcome and writes it up.

**The model classifies; it never resolves.** Choosing "this was a moderate
Charisma attempt on the innkeeper" is safe — it is a pick from a fixed enum that
the engine checks. Deciding whether it worked is not, and it never gets to.

**Tier 2 state changes come from a closed vocabulary the ENGINE selects from:**
disposition, HP, gold, time, a condition, a flag. **Never** a new object, never a
new exit, never a new NPC, never a goal — and never chosen by the model.

This is the missing middle. Without it, everything expressive becomes noise and
the game punishes you for talking like a person.

### Tier 3 — Pure expression

*"I sit by the fire and think about my brother."*

No roll, no state change, no cost. Just prose. This should exist and should be
free — not every sentence needs to be a move.


---

## The parser

The fast path for Tier 1. Deterministic first; the LLM is a **translator**,
never a parser.

### Pipeline

```
raw input
  → normalise      lowercase, strip articles, expand abbreviations
  → tokenise       verb / noun phrase / preposition / noun phrase
  → grammar match  against the fixed verb table
  → [on failure]   LLM translation attempt → re-enter grammar match ONCE
  → scope resolve  match nouns to objects the player can actually see
  → disambiguate   ask "which one?" on multiple matches
  → preconditions  takeable? locked? dark? affordable?
  → execute        deterministic state change
```

Canonical command shape: `{ verb, directObject, preposition, indirectObject }`

### Scope — the most important robustness rule

An object is matchable only if the player can reach or see it:

1. Carried or worn
2. Present in the current node
3. Inside an **open** container that is itself in scope
4. Doors on any edge touching the current node
5. Globals (sky, ground, self)

`take sword` never matches a sword in another room. This single rule eliminates
most parser weirdness, with no special-case code.

### Also required

- **Vocabulary per object** — `nouns[]` narrowed by `adjectives[]`, so "rusty
  blade" and "iron sword" both resolve
- **Disambiguation** with a pending-question state; next input is checked against
  it first, then dropped if it doesn't answer
- **Pronouns** updated after every successful command
- **Implicit takes** — `unlock door with brass key` auto-takes the key and says
  `(first taking the brass key)`
- **Abbreviations** — `n s e w ne nw se sw u d`, `x` `i` `l` `g` `z`, `take all`,
  `take all from chest`
- **Brief/verbose mode** — full description on first visit, room name only
  afterwards, `look` to expand

### Failure taxonomy — pass the reason, not just the failure

| Code | Meaning | Narrator instruction |
|---|---|---|
| `UNKNOWN_VERB` | No such action | Refuse in world-voice, no state change |
| `UNKNOWN_NOUN` | Matches nothing anywhere | "You can't see any such thing." |
| `NOT_IN_SCOPE` | Exists, but elsewhere | "You don't see the lantern here." |
| `WRONG_VERB` | Exists, action doesn't apply | "That's not something you can eat." |
| `PRECONDITION` | Valid but blocked | Explain the block |
| `AMBIGUOUS` | Multiple matches | Ask which one |

`NOT_IN_SCOPE` is the valuable one — the engine *knows* the lantern is in the
cellar, so the narrator says something true instead of improvising.

### The LLM translator

Runs only after deterministic parsing fails, **once** per turn.

- **Input:** raw text, full verb list, IDs and names of everything in scope
- **Output:** a canonical command using only IDs from the supplied scope list, or
  `null`
- **Validation:** if a returned ID isn't in the list you sent, discard it and
  treat as `null`. The model cannot conjure objects.
- **On `null`:** flavour-only narration, no state change, ever
- **Caching:** store `raw text → canonical command` per node; repeats are free
- Use a cheap fast model. This is translation, not creativity.


---

## The turn loop

**Player half**

1. Player submits input
2. Parse (Tier 1 pipeline above)
3. On parse failure → Translator attempts a canonical command, then a Tier 2
   classification, then falls to Tier 3
4. Resolve scope, disambiguate if needed
5. Check preconditions
6. Roll if the action can fail interestingly
7. **Apply player state change** — one of only two places state is written

**World half — runs every turn, whatever the player did**

8. Advance the clock by one turn
9. Burn light sources; expire timed effects
10. Move anything that moves — pursuers, wanderers, rivals
11. Evaluate the event deck; fire whatever is due
12. **Apply world state change** — the second and last place state is written

**Narration**

13. Assemble the narration packet (player outcome + any world events)
14. Stream narration from the LLM
15. Persist state, transcript, any newly generated description
16. Re-render text pane, map, status line

The world half is what makes the place feel inhabited rather than laid out. Most
turns it does nothing visible. Occasionally something happens that the player did
not cause, and that is where stakes come from — a situation can get worse while
you are deciding what to do.

This is only possible because there is a map. A game with no geography has no
off-screen, so nothing can change while you are not looking at it.

### The narration packet — assembled in tiers

Not a bag of blocks. An **ordered** prompt, oldest-and-general first,
newest-and-specific last. Loom accreted eleven blocks into eleven positions with
no stated order and the seams showed, so this arrives already fixed.

| Tier | Contents |
|---|---|
| 1 · **Standing context** | Narrator fragment · base setting · area tone and facts. One stable prefix that rarely changes. |
| 2 · **Turn context** | Keyword-gated blocks: lorebook entries, NPC detail. One message, **skipped entirely on a quiet turn**. |
| 3 · **History** | The recent transcript window. |
| 4 · **State of play** | Node description · contents · adjacent room names and one-liners · inventory · condition. |
| 5 · **This turn's facts** | The mechanical outcome. ("Persuade: hard failure. Guard now hostile.") |
| 6 · **Protocol and action** | Output contract, then the player's input. |

**Two rules hold it together:**

1. **Every fact is stated exactly once.** Loom printed conditions twice — once in
   the roster block, once in the conditions block — and the lesson was that *a
   fact shown twice is a fact the narrator re-states*, which then becomes a state
   op and a line of transcript. Anything appearing in two tiers is a bug.
2. **Anything the history can contradict is stated after the history.** This is
   why state of play sits at tier 4 and not up top: the transcript will disagree
   with it, and the later statement is the one that wins.

**Adjacent rooms carry names and one-line descriptions only** — never the
contents of neighbours. It leaks upcoming content and burns tokens.

**One scan window.** Every keyword-gated block reads the same number of recent
turns, scanned once and passed down. Loom had three matchers sharing a keyword
helper and then disagreeing about how much text to look at, so "mentioned" quietly
meant three different things.


---

## The world clock and the event deck

The answer to "the narrator introduced a quest and resolved it in the same
beat". The narrator cannot introduce anything. Structural surprise comes from
the world containing things the player has not found yet.

### Generate more than you reveal

Everything surprising was authored during generation and validated by the
area generator. The player never saw it. A hidden door was rolled into `edges`
at generation. A creature was placed by `placement.json`. Nothing is improvised
at play time.

### One table, many faces

`triggers` is the whole mechanism. Area generation stocks it from
`content/events.json`, rolled against room tags like anything else.

```
id, adventureId
event      on_enter | on_take | on_examine | on_turn | on_unlock |
           on_attack | on_death | on_say | on_light_out
subject    node / object / npc id, or null for global
condition  flag · object-held · stat threshold · turn count · visit count
action     move_object · move_npc · set_flag · reveal_edge · seal_edge ·
           damage · spawn · set_disposition · narrate(seed)
once       true | false
```

Ten action types. **Capped at ten** — an eleventh needs a specific adventure
that is blocked without it.

The same table covers all of these, which feel like separate systems and are not:

- a wandering creature entering your node
- a rival who takes the treasure from room 9 before you reach it
- the NPC who turns on you once you are carrying the ledger
- a wall that gives way the third time you force it
- a door that shuts behind you
- the torch guttering with two turns left

### The clock

Turn-based, not narrated time. Triggers fire on turn counts, node entries and
visit counts — not on prose about how long something took.

**Depletion is what makes a cost real.** The narrator may spend resources; it
may never mint them.

- Light sources burn down in turns and go out
- Gold leaves the purse and does not come back on its own
- HP does not regenerate passively
- Weapons break on a fumble
- Pursuers with a `relentless` tag follow across rooms indefinitely

Once light is a countdown and the purse can hit zero, exploration is a budget,
and a budget is where decisions come from.

### The rule that keeps it safe

**The engine plays the cards. The narrator never asks for one.**

If the narrator could request an event it would request one every beat — the same
helpfulness reflex that resolves a quest the moment it opens. The Narrator is not
told the deck exists. It is handed outcomes, as always, and writes them up.

The surprise technically originates in the engine rather than the narrator. That
distinction is invisible from the player's seat, and the prepared version is
usually the better one.


---

## Companions

Ported from Loom in concept, rebuilt to fit. The problem both versions solve is
the same: companions become furniture — stat blocks that never speak — unless
something deliberately gives them a turn.

### Companions are NPCs, not a separate table

A companion is an `npcs` row with a `standing`. It reuses everything already
built: aliases, stats, combat, Resolve, and `location: "npc:<id>"` for whatever
it carries.

**The standing ladder** (Loom's, kept whole — it is a good enum):

`none · npc · active · benched · departed · fallen`

- Only `active` is capped, at four
- The bench is unlimited; an over-cap recruit lands benched rather than nowhere
- **A benched recruit walks to the Hub over the world clock. It does not
  teleport.** Otherwise Presence becomes a free dungeon-clearing spell: recruit
  the thing blocking the corridor and it simply vanishes from the map
- Benched members get no sheet in the prompt and no gear scan
- `none` means out of the party but still in the world — no story stamp
- `departed` and `fallen` are remembered so the narrator stops voicing someone
  the history still recalls

### Recruitment is engine-owned

**The Narrator can never add, promote or remove a companion.** In Loom the
narrator emitted party ops, and that is upstream of most of the mess it later had
to defend against.

Here, standing changes come from the engine: a Charisma outcome, a resolved
Tier 2 action, or a trigger. Eamon's `friendliness` already supplies the hook —
a likeable adventurer finds creatures willing to travel with them.

### Companions speak when spoken to, act when told

**No spotlight system.** Loom scheduled companion moments because in a free-form
app they otherwise dissolve into furniture. Here they are addressed directly:
`tell <companion> to <action>`, or ask them something — both already covered by
the existing `tell` / `ask` / `talk` verbs, so no new verbs and no scheduler.

Companions fight every round automatically, engine-controlled, and Resolve
applies to them exactly as to any other creature — a companion can break and run.
**They have no Resolve track against enemy Presence**, though, which is why
Presence attacks always target the player instead.
Everything else is player-initiated.

**Consequence worth stating:** with the spotlight gone, **no prose ever feeds
back into the system.** The narrator's output is read by nobody but the player.
The rule that code owns truth now has zero exceptions.

### Companions may never be required

**Encounter scaling assumes the player is alone.**

Companions can die, break and flee at low Resolve, or depart. If a fight is only
survivable with one, losing them strands you. Companions raise the ceiling; they
never lower the floor.

Two supporting rules:

- **A chain key may never be placed on a companion.** Generation forbids it.
- **On death or departure, a companion drops everything into the node** — same
  rule as any NPC death, for the same reason.

---

`generatedDesc` starts empty. First entry generates it from `seed` + area
context and **saves it permanently**. Later visits print the saved text with no
API call. `examine <thing>` is where fresh generation happens.

The market has the same stalls every visit. Cost scales with rooms explored, not
turns played.


---

## Room descriptions — two layers

Contents used to be listed by code beneath a frozen description, which reads
exactly as machine-made as it is: *"You see: a rusted sword, a chest, a corpse."*
Instead, the narrator is **given** the contents as data and writes them into the
prose properly.

### The two layers

**`baseDesc`** — architecture, light, smell, wear, mood. Written once when the
area is generated, never regenerated. **It never names contents.** This is the
stable spine that keeps a room recognisable as the same place across every state
it passes through.

**The woven render** — `baseDesc` plus the room's current contents, written as
one paragraph. This is what the player reads.

### Cached by content signature, not by visit

```
key = roomId + hash(baseDesc) + sorted(notable content ids)
```

| Event | Cost |
|---|---|
| First entry | one call, cached |
| Return, nothing changed | free, and **identical prose** |
| Return after taking the sword | key changed → one call, cached |
| Drop the sword back | free — the earlier key matches again |

**Cost scales with the number of distinct content states, not with visits.** Most
rooms only ever see two or three: full, looted, repopulated. So this is roughly
2× the calls of a frozen description, not 20×.

It also removes prose drift entirely. Same room, same contents, same words —
because it is the same cache entry. Capped at 8 renders per room, evicted
least-recently-used.

**Notable** means anything that should change the prose: takeable items,
creatures, NPCs, and door open/closed state. Not scenery, not the contents of a
closed container. Otherwise the key churns and regenerates for nothing.

### Base descriptions are batch-generated

All of an area's rooms in **one call** at area creation, each getting two
sentences from its seed, tags and theme tokens.

Cheaper than fifteen lazy per-room calls, and the model sees the whole area at
once, so the rooms read as one place rather than fifteen unrelated ones. It
trades away lazy generation, but area creation is already a moment where the
player expects a beat.

### Validation flips direction

The old check rejected a description that named an object. The new one rejects a
render naming an object **that is not there** — a hallucination check, and an
easy one, because the content list was supplied in the prompt.

**Match against each object's `nouns[]` and `adjectives[]`, not its display
name.** "The blade" is a legal way to write "masterwork iron broadsword", and
strict name matching would reject it and fire a pointless repair call. Those
fields already exist for the parser, so validation and parsing stay in sync for
free — no separate alias list to drift.

### This revises audit decision Q1

Q1=A said descriptions must never mention contents. That still holds for
`baseDesc`. The **woven render** always mentions them, from the actual records.
Same problem, better solution: the desync is fixed by giving the narrator the
truth rather than by forbidding it the subject.


---

## Structured output: emit canonical, read lenient

Applies to **every** call that expects structured output — Tier 2 classification,
and Creator-style field generation if it ever returns. Weak models drop or mangle
the shape often enough that it is ordinary, not exceptional. Loom shipped with
the client surviving exactly one of the four ways it happens.

**Emit stays canonical.** One documented shape, one worked example.

**Ship a worked example, not just a schema.** This alone fixed two separate
classes of malformed output in Loom. A schema describes; an example demonstrates.

**Read leniently:**
- accept the alias keys models actually reach for
- accept nested *and* top-level placement of the same fields, merged in schema
  order with the nested answer winning
- accept wrapped, numbered, or single-string forms of a list
- with no marker at all, take the last brace-balanced object whose keys intersect
  the contract
- normalise at **read**, so replayed old records get the same treatment

**One repair call.** If every salvage path fails, re-send the call's own messages
plus the response it gave plus "emit the block". Fired only after salvage fails,
so a compliant model never pays for it. Runs before anything is applied, so a
repaired response takes the normal validation path. A failed repair is swallowed
rather than turned into an error.
