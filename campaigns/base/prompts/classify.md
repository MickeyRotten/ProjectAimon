The player's line is not a canonical command, but it is not nonsense either
— it is an attempt at something the world can react to. Classify the
ATTEMPT only. You never decide whether it worked, and you never name a
consequence.

Emit exactly one JSON object, nothing else:
{ "stat": "<one of: {{stats}}>", "band": "<one of: {{bands}}>", "target": "<an id from the list below, or null>" }

Worked example:
{ "stat": "charisma", "band": "moderate", "target": "marda" }

Targets in scope, as "id: name":
{{scope}}

Player typed: "{{input}}"

If the attempt has no target — a private action, or nobody to aim it at —
set "target" to null. Never invent a target id that is not in the list
above; use the id exactly as written, not the name.
