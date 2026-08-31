# Decisions and history

*Settled audit decisions, superseded rules, what to harvest from the predecessor project, attribution.*

*Part of Project Aimon. Root spec: [CLAUDE.md](../CLAUDE.md)*

---

## Audit decisions — settled

Sixteen gaps found in a design audit, all now decided. Recorded here because the
reasoning matters more than the values, and the values live in `rules.json`.

| # | Gap | Decision |
|---|---|---|
| 1 | Frozen descriptions vs contents | **Superseded** — two-layer descriptions, see Room descriptions |
| 2 | Respawning | Hostiles **and loot** repopulate after 400 turns away; structure never does |
| 3 | Kill-quest targets | Spawned fresh on accept |
| 4 | Corpse run | Hub always issues a free crude kit |
| 5 | Light exhaustion | Forced retreat to the nearest lit room or the entrance, 3 turns |
| 6 | Light supply | **No** guarantee underground — it is a supply problem |
| 7 | Skill cap | 30 |
| 8 | Attribute growth | Rare items **and** an expensive Hub trainer, +1 each per campaign |
| 9 | Gold sinks | All six: repair, consumables, training, bribes, hiring, fast travel |
| 10 | Fast travel | Hub-return consumable only; no gate-to-gate |
| 11 | Orphaned quests | Fail outright when the giver dies |
| 12 | Companions | Own gambits, scale to area tier, dismiss and bench verbs |
| 13 | Combat vs world turns | Each combat round **is** a world turn |
| 14 | Permadeath + autosave | The death is written, then permadeath clears the slots |
| 15 | Vendors | Sell at 40%; restock on a **400-turn timer**, not on re-entry |
| 16 | Layout failure | **Amended** — repack first, and never drop a bridge edge |

### Rule 1 was superseded

The audit settled on "descriptions never mention contents; code lists them
beneath." That was replaced by the two-layer scheme in **Room descriptions** —
a frozen `baseDesc` that names nothing, plus a woven render that names everything
and is cached per content state.

The original decision was sound and the replacement is better: it fixes the
desync by giving the narrator the truth instead of forbidding it the subject.

### The interaction worth watching

**Q2=C plus Q9 plus Q15 is a farming loop.** Full loot repopulation, six gold
sinks, and restocking vendors together mean gold can be ground indefinitely by
walking a cleared area every 400 turns.

Two guards are in the tables, and they are the tuning dials if it turns out to
matter:

- `REPOPULATE.valueMultiplierPerCycle: 0.6`, floored at `0.2` — a room's loot is
  worth less every time it refills, so grinding decays toward nothing
- Vendor restock is on a **turn timer**, not on area re-entry, so walking out and
  back in changes nothing

If the economy still inflates in play, the multiplier is the first number to cut.
**Do not fix it by removing loot repopulation** — that was a deliberate choice to
keep the world alive rather than a hole to plug.

### Light is now a real supply decision

Q5 and Q6 together are the interesting pair. There is **no** guaranteed light
underground, so a warren must be provisioned before entry — but running out is
not a softlock. You are forced back to the nearest lit room or the area entrance,
losing three turns.

Punishing, never fatal. A warning fires at ten turns of light remaining.

### Skill cap check

At Agility 13 with a capped sword skill: `26 + 30 + 5 − 13 + 40 = 88`, under the
95 clamp. Mastery is strong and never automatic, and progression still has
somewhere to go at the top end.


---

## Port manifest — harvesting Project Loom

This is a **new repository**, not a fork. Files are copied in one at a time, on
demand.

### Why not edit Loom

Loom's founding contract is that the narrator emits a block of deltas and the
client applies them — **the narrator writes state**. This project's contract is
the exact inverse. Loom's own history is the evidence: reconciliation passes,
no-op ops, restated ops, gold drifting across beats, one rusty key becoming
seven, taking the clock away from the narrator entirely. Every one of those bug
classes simply does not exist when nothing is ever proposed.

### Port freely — plumbing, no game logic

| From Loom | Use here |
|---|---|
| `openrouter.ts` | streaming, side calls, reasoning param, model catalog |
| `retry.ts` | backoff policy |
| `db.ts` blob store, upload/download/remove | portrait **upload only** |
| `sync.ts`, `syncEngine.ts`, `supabaseClient.ts` | cloud saves — second design only, see below |
| `worldNotes.ts` keyword matcher | **becomes the lorebook directly** |
| `settings.ts` normalize-on-read pattern | every settings field here |
| fonts, `theme.css`, `--scrim`, paper/ink derivation | terminal presentation |
| `SubMenuScreen`, `fields.tsx`, `useConfirm`, `OverlayHeader` | settings screens |
| `diceAnim.ts` + `DiceOverlay` | retarget from a pool to d100; keep the toss |
| `reversal.ts` | snapshots — *easier* here, since state is deterministic |
| Capacitor setup, signed-release CI | the APK |

### Never port

- `deltas.ts`, `loomBlock.ts`, and **anything that imports something that does**
- `autoUpdate.ts`, `stakes.ts`, `journal.ts`, `clock.ts`, `equip.ts`,
  `places.ts`, `cast.ts`, `spotlight.ts`
- `roster.ts` — the standing ladder concept returns, rebuilt against `npcs`;
  the code does not
- **The image *generation* stack** — `images.ts`, `comfyui.ts`, image templates,
  the 1-bit pass, the image model slot. **Cut from scope.** Portraits are
  upload-only.
- **`generateField.ts` / `GenerateModal`** — these were for the Editor, and
  there is no Editor.

### If sync is ported, port the second design

The live game stays on the device playing it; the cloud holds only deliberate
snapshots. Per-turn network cost is zero. Two traps: **a stamp with nothing
local behind it reads as a deletion** and will wipe an older build's save, so
retired keys are skipped and never tombstoned; and **snapshots must freeze their
own portraits** under slot-scoped keys, or replacing an upload rewrites that
face in every save.

### The two rules that stop this becoming Loom again

1. **Port a file only when it is needed that day.** Never pre-emptively, never
   in bulk. Copying one file drags its dependencies, and three days later Loom
   has been reconstructed by accident.
2. **Anything touching the delta system is forbidden**, however useful it looks.


---

## Attribution obligations

If any vocabulary is carried over from Loom's `places.ts`, its licence comes with
it: the steading tag vocabulary there is from **Dungeon World** (Sage LaTorra and
Adam Koebel) under **CC BY 3.0**, and the dungeon and wilderness vocabularies are
project wording informed by *The Perilous Wilds* (Jason Lutes, Lampblack &
Brimstone). Attribution must ship in the repo, not be discovered later.

Eamon itself is public domain, so its mechanics carry no obligation.


---

## Prior art worth reading

Eamon is public domain, and a modern browser rewrite exists (Angular front end).
Worth reading how it models combat, the Main Hall shop, and character persistence
— it is a working version of this exact design.
