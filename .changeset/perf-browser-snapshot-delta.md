---
"turno-browser": minor
"turno-cli": patch
---

An action that stays on the page (a click, a key, a selection, a drag) answers with what changed since the last snapshot the agent was given, by ref, when it is the same session and URL and the changes are under half the compact page. Before, the result only linked the snapshot file Playwright wrote, and an agent that wanted to see what its click did called `browser_snapshot` for the whole page: opening the "Code" menu on a GitHub repository page now answers with 262 tokens of changes, against 7,683 for the page. A navigation, another tab or a change that is most of the page answer as before, and `browser_snapshot` always returns the whole page. `TURNO_BROWSER_SNAPSHOT=compact` turns the changes off.
