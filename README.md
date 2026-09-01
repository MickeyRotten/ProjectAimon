# Aimon

A solo-play, browser-based text adventure with an LLM narrator. Terminal
aesthetic, generated world, single player, PC and Android.

**The design is the spec.** Start at [CLAUDE.md](CLAUDE.md); the detail lives in
[`docs/`](docs).

## Running it

```
npm install
npm run dev        # the game
npm test           # vitest
npm run typecheck
npm run build      # static bundle in dist/
npm run sample     # the reference generator, against the real tables
```

It opens on the autosave if there is one, and otherwise rolls a character and
stands them in the Hub. `?new=1` starts a fresh game, `?seed=anything` names the
world, `?name=` and `?archetype=` name the character. Type `help` for the verbs.

The text is placeholder until the narrator lands at step 7. Everything under it
— the world, the rolls, the map, the clock — is the real thing.

## Layout

```
campaigns/base/    the base campaign — every table, merged under every other
data/verbs.json    the parser's vocabulary. Global, never campaign-scoped.
docs/              the design
src/engine/        rng, tags, rules — the pieces every system rolls through
src/campaign/      loading, layering, validation
src/world/         the lattice, graph shapes, the layout walk, area generation
src/game/          the player, the turn loop, commands, scope, saving
src/ui/            the screen: status line, map panel, log, prompt
tools/             the reference generator
```

## Build order

Per CLAUDE.md, and step 4 is the honest checkpoint.

1. **Campaign loader, table loader, tag system** ← done
2. **Graph generator** ← done
3. **Placement roller** ← done
4. **Movement, map, inventory, autosave** ← done, and this is the checkpoint
5. Quests
6. Combat
7. The Narrator
