# Aimon

A solo-play, browser-based text adventure with an LLM narrator. Terminal
aesthetic, generated world, single player, PC and Android.

**The design is the spec.** Start at [CLAUDE.md](CLAUDE.md); the detail lives in
[`docs/`](docs).

## Running it

```
npm install
npm run dev        # boot screen: loads the tables and reports validation
npm test           # vitest
npm run typecheck
npm run build      # static bundle in dist/
npm run sample     # the reference generator, against the real tables
```

## Layout

```
campaigns/base/    the base campaign — every table, merged under every other
data/verbs.json    the parser's vocabulary. Global, never campaign-scoped.
docs/              the design
src/engine/        rng, tags — the pieces every system rolls through
src/campaign/      loading, layering, validation
tools/             the reference generator
```

## Build order

Per CLAUDE.md, and step 4 is the honest checkpoint.

1. **Campaign loader, table loader, tag system** ← done
2. Graph generator
3. Placement roller
4. Movement, map, inventory, autosave — playable with placeholder text
5. Quests
6. Combat
7. The Narrator
