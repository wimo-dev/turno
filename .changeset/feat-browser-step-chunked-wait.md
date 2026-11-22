---
"turno-browser": minor
---

A person step no longer outlasts the agent's tool call. A `browser_request_human` call waits for the step at most `waitMs` (50 s by default, up to 4 minutes); if the person has not finished by then, the call returns a "still open" result with the step's id and the step goes on, with the banner up and every other call held. The agent calls `browser_request_human` with `{ "continue": true }` (or the step's id) to keep waiting, and the step's timeout still counts from when it began. A call with a new instruction while a step is open is refused and names the open step. The click that starts a page's passkey prompt waits in the same pieces, and a cancelled call ends the step it asked for.
