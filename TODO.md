#TODO

This file contains various tasks, issues, bugs and changes that the user wants to implement. The newest task added is always at the bottom. When the user asks you to do the tasks in TODO, start with the topmost open task (unless otherwise specified). When the task is done, mark the checkbox and write a brief summary on what was done.

Task types:

- FIX: A bug, usability issue. High priority.
- NEW: A new feature or extension of a feature.
- ITERATE: A change to an existing feature.
- SPIKE: Research this, suggest a plan.

---

1. [ ] SPIKE: Very first area generated beyond the hub featured many unfair fights. Tier 1 enemies in the first area should have less HP and Resolve. The difficulty feels too high.

---
[ ] SPIKE: Areas need an identity. I think when an Area is generated, there needs to also be some area-level information about the area, e.g. a Town should have an identity, a main form of trade, a leader, etc. An area can also not have an identity (or rather, it's identity is that there's nothing of interest). We also need some cap on the wealth of that area, so that we don't end up with an Area with every room having things to pick up and hundreds of gold. We could consider gamifying it a bit, and say that within this Area we can have X Containers, and each Container (whether chest, corpse or other) has a chance to yield a low, medium, high, or ultra rare reward, with the ultra rare reward's chance increasing based on the difficulty of the area... As a thought. Other items can also exist in rooms, but their value should be low. 

---
2. [ ] SPIKE: The world generation needs more rule-driven procedural generation. The likelihood of a Coven being right next to a Town should be low or zero, etc. Same as Minecraft, the biomes need to also consider adjacent biomes.

---
3. [ ] NEW:

Option A. I need two external, separate scripts (launched through individual .bat files). EXPORT.bat that exports all the json values related to the gameplay as a .csv, and an IMPORT.bat that parses a .csv back to json.

Option B. The Editor should be extended and improved so that it's easier to create new areas, enemies, etc. and to tweak difficulty. Right now it's a rather raw representation of all the data.

Regardless of Option, I would like to see descriptions for each tag, even if the LLM would not use a description field (though it would make it a bit more predictable in behaviour).

---