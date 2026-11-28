---
"turno-browser": minor
---

Teach mode: show the agent a task once in its own Chrome window, from the side panel's "Teach a flow" or `turno-browser teach <id> --name <flow>`, and it is saved as a normal flow that `browser_replay` and `turno-browser replay` run again. Clicks, typing, choices, checkboxes, Enter, Escape and Tab, uploads, new tabs and typed addresses are written down with the recorder's rules: typed text is a parameter, a password or one-time field keeps no value, and a vault sign-in is one `browser_login` step. The panel lists the steps as they come and, on Stop, a review to rename a step, choose how each value is kept, drop steps and save. It listens from an isolated world over the DevTools protocol, so the page sees no element and no call of it. The API goes to 1.15 with `liveTeach`.
