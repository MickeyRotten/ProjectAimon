# Gameplay rules

*THE single source of truth for every formula, table and threshold. Nothing here may be restated elsewhere.*

*Part of Project Aimon. Root spec: [CLAUDE.md](../CLAUDE.md)*

---

## Gameplay rules — the single source of truth

**Every rule, formula, table and threshold lives here and nowhere else.** Other
sections reference this one by name; they must never restate a value. These
numbers are expected to be tuned, and a value copied into a second place is a
value that will eventually disagree with itself.

These values load from `rules.json`, overridable per campaign, so **nothing in
the codebase may hardcode any of it** — including encounter scaling and quest
placement.

### Named tunables

| Name | Meaning |
|---|---|
| `STAT_ROLL` | How attributes are generated at character creation |
| `RANGE_BANDS` | Feeble / Ordinary / Notable thresholds |
| `LIBIDO_BANDS` | Cold / Even / Heated / Consumed thresholds and modifiers |
| `WEAPON_TABLE` | Starting skill, complexity, damage and penetration per weapon |
| `ARMOUR_TABLE` | Damage reduction and to-hit penalty per armour type |
| `APPROACH_TABLE` | Pressure die and starting skill per Presence approach |
| `CRIT_TABLE` / `FUMBLE_TABLE` | Outcome distributions on a critical or fumble |
| `TAXONOMY` | Creature tag → resistance profile |
| `SKILL_GROWTH` | Rate and cap for weapon, approach and armour skills |
| `DEPLETION_RATES` | How fast light burns and other resources drain |
| `DISTANCE_BANDS` | Hop ranges behind near / quite near / far |
| `DEPTH_TIER` | Tier by gates from the Hub — including `tierCeilByDepth`, the ceiling on the first steps out |
| `DEFEAT` | What a defeat costs — see Defeat below |

Two more live in the content tables rather than in `rules.json`, because they are
content and not rules: `monsters.statCurve` (every combat number a creature has,
by tier, including the `hpMult` / `resolveMult` that scale HP and Resolve without
touching the other four attributes) and `monsters.encounterCap` (the most
creatures one encounter may field at a tier).

---

### The six attributes

Rolled **3d8** each at character creation (3–24, average ~13). Attributes are
**fixed for life** — only skills rise. What you practise improves; what you are
does not. This keeps character power bounded, which the generator depends on.

Arranged as three mirrored pairs, so every attribute has an offensive job *and*
a defensive one. There is no dump stat and no attribute that only defends.

| Pair | | Attribute | Derives |
|---|---|---|---|
| **Physical** | offence | **Brawn** | Damage bonus · carry capacity · forcing |
| | defence | **Toughness** | **HP** · armour effectiveness |
| **Finesse** | both | **Agility** | Accuracy · Evasion |
| **Social** | offence | **Charisma** | Presence · Rapport |
| | defence | **Willpower** | **Resolve** · Composure |
| **Mental** | both | **Wits** | Pressure bonus · crit chance · sensing |

### Derived values

```
HP            = Toughness × 2
Resolve       = Willpower × 2
Carry         = Brawn × 10
Accuracy      = Agility × 2
Evasion       = Agility
Presence      = Charisma × 2
Composure     = Willpower
Rapport       = Charisma
Crit chance   = Wits            (percent)
Damage bonus  = floor((Brawn − 10) / 3)
Pressure bonus= floor((Wits  − 10) / 3)
```

**Why Toughness and Brawn are separate:** a seducer needs to survive without
being a bruiser. Merged, every build has to buy muscle.

**Why Composure comes from Willpower, not Charisma:** otherwise a Charisma build
would be immune to its own strategy. Social defence splits across two attributes
exactly as physical defence splits across Agility and Toughness.

---

### The two tracks

```
HP        from Toughness    weapons reduce it
Resolve   from Willpower    Presence reduces it
```

Both are real defeat conditions and **both cost exactly the same** (see Defeat).
Neither is the "real" health bar, so Toughness and Willpower are worth the same
and neither can be skimped.

CoC2 shipped a second track called Resolve and then folded it back into Health
because it was hard to balance. That is evidence two bars are **difficult**, not
that they are wrong. A game where Presence is a genuine route to victory needs a
track that Presence depletes, or Presence is just damage with different
adjectives.

**Courage is retired.** Eamon's morale field is replaced by Resolve, which does
the same job with a bar the player can see and attack.

---

### The resolution mechanic

One formula. Percentile, d100 roll-under, clamped 5–95.

```
chance = attack − defence + 40
```

| Attack type | Attack value | Defence | Pierced by | Reduces |
|---|---|---|---|---|
| **Weapon** | (Accuracy − effectiveArmourPenalty) + weaponSkill + complexity | Evasion | — | HP |
| **Presence** | Presence + approachSkill + Allure | Composure | Allure | Resolve |
| *(Arcane)* | *reserved for spells; not in v1* | *Ward* | *Focus* | *either* |

Sanity check at ordinary stats:

| Matchup | Chance |
|---|---|
| AGI 13, no skill, vs AGI 13 | 53% |
| AGI 13, sword skill 10, vs AGI 13 | 68% |
| AGI 13, sword skill 10, in plate untrained | 48% |
| CHA 16 vs WIL 8 | 64% |
| CHA 16 vs WIL 20 | 52% |
| CHA 6 vs WIL 13 | 39% |

Weak builds are bad, not hopeless.

**Stat checks** outside combat use the same shape against a flat difficulty:
`chance = 3 × attribute + base`, with `base` of 30 / 20 / 10 / 0 for easy /
moderate / hard / severe.

**A failed check never blocks, it costs.** Every obstacle has a deterministic way
through. Checks are shortcuts that skip work; failing one costs a resource and
never costs progress. A bad roll in a generated world is never the player's
fault, so it must never be their dead end.

---

### Rolls are seeded — no save-scumming by regenerate

Every roll is seeded on `(turn, action)`, so a regenerate re-tells the **same**
result rather than fishing for a better one.

**A warning paid for in a predecessor project:** FNV-1a's low bit is only the XOR
of the input bytes' low bits, and `h % sides` shares its parity when `sides` is
even. A raw hash fed to the modulo made a die's parity a function of the seed's
characters, and hashing `turn|action|i` for extra dice locked them into opposite
parities, so **2d6 could never roll 7.** Use one hash, avalanched through a
murmur3 finalizer, extra dice counting off that base. `% 100` has the same shape
of problem. Regression-test it.

---

### Weapons and armour

| Weapon | Start skill | Complexity | Damage | Penetration |
|---|---|---|---|---|
| Club | +20% | +10 | 1d4 | 5 |
| Axe | +5% | +10 | 1d6 | 15 |
| Spear | +10% | +5 | 1d6 | 20 |
| Sword | 0% | +5 | 1d8 | 10 |
| Bow | −10% | 0 | 1d8 | 25 |

Different starting skills make weapon choice a character commitment rather than
a shopping decision.

```
rawDamage   = max(1, weaponDie + damageBonus)
netArmour   = max(0, baseReduction × (1 + Toughness / 50) − penetration)
finalDamage = max(1, round(rawDamage × (1 − min(netArmour, 80) / 100)))
```

**Order of operations is part of the spec.** Toughness scales reduction *first*,
then penetration subtracts — the other order makes high-penetration weapons
useless against tough targets in light armour.

**`rawDamage` is floored at 1 before reduction.** Brawn 3 gives a damage bonus of
−3, so a 1d4 club would otherwise roll negative and heal. Use `Math.floor`, not
`Math.trunc`: `floor(-7/3)` is −3, `trunc(-7/3)` is −2.

**Percentage reduction, not flat absorption.** Eamon subtracted a flat number,
which creates immunity walls — a 1d6 weapon can never hurt 6-point armour — and
forces the generator to check for unwinnable fights. Percentages have no walls,
so that check disappears.

| Armour | Reduction | To-hit penalty |
|---|---|---|
| None | 0% | 0 |
| Leather | 15% | 5 |
| Chain | 30% | 12 |
| Plate | 45% | 20 |
| Shield | +10% | +4 |

Reduction caps at **80%**. Armour Expertise rises with use and cancels the
to-hit penalty, so plate is a burden until trained into.

```
effectiveArmourPenalty = max(0, penalty − armourExpertise)
```

This penalty **applies to the attack roll** — it was previously defined and never
used anywhere, so heavy armour cost nothing. In plate with no expertise, a sword
build at Agility 13 drops from 68% to 48%.

---

### Presence: the Charisma combat route

Three approaches, each a skill that rises with use exactly like a weapon skill.

| Approach | Pressure | Works on |
|---|---|---|
| **Intimidate** | 1d6 + pressureBonus | most things, including beasts |
| **Taunt** | 1d4 + pressureBonus, and draws Threat | thinking creatures |
| **Seduce** | 1d6 + pressureBonus | thinking creatures with appetites |

Pressure subtracts from Resolve. **At zero Resolve a creature breaks**, and how
it breaks is read from its `friendliness`:

- Low → **flees**, taking its gear with it
- Middle → **surrenders**, drops gear, answers questions
- High → **joins you**, subject to the party cap

That last outcome is the only recruitment route that is not a scripted event,
which ties Charisma's combat role directly to the companion system.

**Routing pays worse than killing.** A fled enemy leaves with its loot. Presence
wins cost less HP and less gold — a real trade, not a strictly better option.

Fled creatures are handed to the event deck and can return later, angrier.

---

### Libido — the stat the world moves

Not chosen at creation. 0–100, starting near 30, drifting with what happens to
you. It is the corruption axis, and it costs one number.

| Band | Range | Allure | Composure |
|---|---|---|---|
| **Cold** | 0–24 | −5 | +10 |
| **Even** | 25–59 | — | — |
| **Heated** | 60–84 | +10 | −10 |
| **Consumed** | 85–100 | +20 | −25 |

Your Presence attacks land harder and your Resolve holds worse. One number
pulling both ways, and the only glass-cannon axis in the game.

**Up:** losing Resolve in a fight · consumables and enchanted gear · area tags
like `corrupt` or `lush` · certain creature auras.
**Down:** resting at the Hub · specific items · scenes · `austere` or `holy`
areas.

Both directions are slow — a point or three per event.

**Brakes, all three required:**

- **Resting at the Hub always pulls toward Even.** Free, unlimited. There is
  always a way back.
- **Rise is capped per area.** One bad crypt cannot take you from Even to
  Consumed.
- **Consumed announces itself** in the status line and in the prose.

CoC2 interpolates Libido's effects linearly off three thresholds feeding two
stats, which is unreadable in play. Bands, like everything else here.

---

### Attribute Range — stats that change prose

The most useful idea taken from CoC2, with its scaling bug removed.

```
Feeble  ≤ 8       Ordinary  9–15       Notable  ≥ 16
```

**Never rolled.** A threshold, evaluated deterministically, used to gate prose
variants and route options: a Notable-Brawn character simply *gets* the
description where the beam looks shiftable.

It is one boolean per attribute in the narration packet, and it is what makes a
build change what the player *reads* rather than only what they roll.

**CoC2's bug, avoided:** they scaled the threshold against level, so a Level 7
with Strength 15 failed a check a Level 3 with Strength 8 passed — you could get
numerically stronger and worse at narrative checks. Aimon has no levels, so the
bar never moves.

**One threshold set, applied everywhere without exception.** CoC2's wiki admits
ranges are checked at varying percentages with no consistency, which is exactly
the opacity that made Beyond Zork's stats unreadable. Consistency is the whole
value of the mechanic.

---

### Taxonomy — resistance from tags

Creature tags already exist, so this costs a lookup table.

| Tag | Effect |
|---|---|
| `undead`, `construct` | Immune to all Presence. No Resolve track. |
| `beast` | Intimidate only. Taunt and Seduce do nothing. |
| `mindless` | Immune to Presence and to Sensing. |
| `proud` | Taunt at double pressure, Seduce at half. |
| `venal` | Bribe threshold halved. |
| `armoured` | Reduction +15%. |

This is also the answer to "why not always play Presence". A crypt is a Weapon
dungeon and a court is a Presence dungeon, and the tags say so the moment you
sense one.

---

### Threat and Sensing

**Threat** decides who enemies swing at: base 10, plus recent damage dealt, plus
Taunt. Highest is targeted. One number, no AI system.

**Presence attacks ignore Threat entirely and always target the player**, because
companions have no Resolve track. A Presence-heavy encounter is a duel happening
inside a brawl.

**Sensing** is `examine <creature>` during combat. Costs the turn, and reveals HP,
Resolve, armour, tags and resistances permanently. Against `mindless` it fails,
which is itself information.

---

### Critical hits and fumbles

Crit chance is `Wits` percent, plus any weapon bonus. Fumble is a roll of 96–100.

Each result is a concrete *event*, not a number — the engine picks from a fixed
table, the Narrator describes it.

**Critical hit:**

| Result | Chance |
|---|---|
| Ignore armour | 50% |
| 1½× damage or pressure | 35% |
| Double | 10% |
| Triple | 4% |
| Automatic defeat of the target | 1% |

**Fumble:**

| Result | Chance |
|---|---|
| Recover, no effect | 35% |
| Drop weapon (natural weapons recover) | 40% |
| Break weapon (10% chance of also hitting self) | 20% |
| Hit self | 5% |

Eamon's table also had a 1% *kill self*. **Deliberately dropped** — losing a
trained character to a 1-in-2,500 roll is not defensible in a generated world.

---

### Encounter size is difficulty

Every living hostile in the room acts every round — no initiative, no action
economy, no cap. So **the number of creatures is the difficulty**, more than any
of their stats: at tier 1 a pack of three out-damages a starting character about
three to one however weak each one is, and no amount of lowering HP fixes it.

`monsters.encounterCap` bounds the total per tier. It trims the composition
rather than replacing it, so a warband is still a warband — just a smaller one
near the Hub.

Enemy gambit thresholds may be written flat (`self.hp<40`) or as a percentage of
that combatant's own maximum (`self.hp<40%`). **Prefer the percentage.** Every
threshold in the base table was flat, and a tier-1 creature has around 18 max HP
— so it sat permanently under all of them, and its leaders summoned every round
while its wretches fled on round one, whatever the fight was doing.

### Combat flow

Turn-based. No initiative order, no status effects, no area attacks.

Companions act each round, engine-controlled, and can break and flee like
anything else.

**Flee is always available and always works**, at the cost of dropping something
or taking a parting hit. That is the safety valve that replaces a winnability
solver.

**The engine assigns every monster stat** from `monsters.json` and the area's
difficulty. Nothing else sets them.

---

### Defeat

**HP reaching zero and Resolve reaching zero are the same defeat.** Different
narration, identical mechanics.

```jsonc
"defeat": {
  "mode": "setback",                   // permadeath · setback · none
  "lose": ["purse", "carried"],
  "recovery": "onVictor",
  "decayTurns": 200,
  "skillLoss": 0
}
```

`defeatBy: "hp" | "resolve"` is recorded and picks the narration. Nothing else
reads it.

**Recovery — the corpse run.** Losses are not deleted, they are **moved**. You
wake at the Hub, stripped; your gold and gear are on the creature that beat you,
in the room where it happened. One `location` field change. Because a dead NPC
drops everything into the room, winning the rematch returns all of it. After
`decayTurns` the victor sells it on and it surfaces in a shop.

**The bank is defeat insurance.** Only `purse` is at risk, never `banked`, so
every trip out of the Hub carries a real question about how much to take.

**The starter kit is `untradable`.** Otherwise a player walks out of the Hub,
dies on purpose, and sells the free club and leathers at 40% — repeatedly, at no
risk. Vendors refuse anything carrying the tag.

**Dropped gear is flagged `persistent`** and excluded from repopulation. Decay at
200 turns already fires before repopulate at 400, and NPCs never repopulate, so
this is belt-and-braces rather than an open hole — but a player's lost sword is
not something to leave to ordering.

**Never take an attribute point.** Attributes never rise, so attribute loss is
permadeath in slow motion wearing the mask of a mild setback. `skillLoss` is the
severity dial instead — recoverable by playing.

**Bad-end scenes** are authored per victor tag per trigger, not per creature.
Four or five tags × two triggers is eight to ten pieces of writing for a whole
campaign, and a generated monster inherits the right pair from its tags.

---

### Skills

Nine trained numbers, all rising with use, all capped:

- Five weapon skills: axe, bow, club, spear, sword
- Three approach skills: intimidate, taunt, seduce
- Armour expertise

Weapon and approach skills rise on a successful hit; armour expertise on damage
absorbed. This is the whole progression system — no XP, no levels.
