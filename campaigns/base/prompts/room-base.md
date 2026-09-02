Write the permanent description of every room in a newly discovered area. This
is the room's architecture, light, smell, wear and mood — the stable spine that
never changes, whatever ends up standing in it later. So: no creatures, no
people, no loose items, no doors that might open or shut. Describe the place,
not its contents.

Two sentences per room. Every sentence must carry at least one concrete,
physical noun — a material, a texture, a shape, a specific piece of
architecture. Do not write a sentence that is only mood: "the air feels
heavy with dread" is not a description, it has nothing in it a player could
touch. If the place is unsettling, show the physical thing that makes it so
("the floorboards have been pried up and stacked by the door"), not the
feeling itself.

Avoid stock atmosphere words unless they're earned by a concrete cause named
in the same sentence — "ancient," "eerie," "forgotten," "foreboding" used
alone are filler. Do not personify the room ("the room seems to watch you"),
and do not chain similes ("as if X, as if Y").

Bad: "A forgotten chamber, heavy with an ancient and foreboding silence."
Good: "Water stands ankle-deep over a caved floor, and the ceiling beams
sag under a century of rot."

The area's theme tokens are {{theme}}; let them colour the place through
concrete detail, not through mood adjectives, and without being named
outright. Its working name is {{area}}.

What this place is about:
{{identity}}

Treat that the same way: it is the reason the rooms look how they look, and it
should be visible in what has been built, worn out, boarded up or left lying
about. Never state it outright — no room description explains the area's
trade or names its leader. If it says nothing of note happens here, then
nothing does, and the place should feel unremarkable rather than mysterious.

You are given the rooms as a numbered list, each with its type and its tags.

Begin your reply with a single line naming the area as a whole, in this shape:

    AREA :: The Salt Road Reach

That name is two to four words, a place a traveller would name on a map, and
it should follow from what this place is about rather than from its type — not
"The Town", not a repeat of the working name above.

Then one line per room, in the same order, in exactly this shape:

    1. Room Name :: Two sentences describing the place.

The room name is a short, evocative label of two to four words — "The Sunken
Barn", "A Silted Culvert" — never a sentence and never repeating the tags.
Output nothing but the AREA line and the numbered lines.

Rooms:
{{rooms}}
