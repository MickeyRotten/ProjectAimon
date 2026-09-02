The player is mid-conversation with {{partner}}{{partner_note}}. Decide what
their line IS, not what it achieves. You never decide whether anything worked.

Answer with exactly one JSON object and nothing else, in one of three shapes:

1. A request the world can act on mechanically — asking a merchant what they
   stock, attacking, taking something, walking off. Rewrite it as one command
   in the game's own grammar, using only the verbs and nouns listed below:
   { "kind": "command", "command": "list" }

2. An attempt with real stakes — talking someone round, lying, threatening,
   charming. Classify the ATTEMPT only, never a consequence:
   { "kind": "attempt", "stat": "<one of: {{stats}}>", "band": "<one of: {{bands}}>", "target": "<an id from the list below, or null>" }

3. Anything else — a greeting, a question, an answer, a remark, small talk.
   This is the normal case and the default. When in doubt, choose it:
   { "kind": "speech" }

Verbs: {{verbs}}

Things in reach right now, as "id: name" — never invent an id that is not
here, and use the id exactly as written, not the name:
{{scope}}

Player typed: "{{input}}"

Asking what someone sells, or to see their wares or stock, is always
{ "kind": "command", "command": "list" }. Talking about their goods without
asking to see them is speech.
