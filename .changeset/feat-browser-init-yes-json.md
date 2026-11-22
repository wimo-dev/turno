---
"turno-browser": minor
---

`turno-browser init` runs without a terminal. With `--yes` it now runs the agent's own `mcp add` command (for example `claude mcp add --scope user browser-<id> ...`) with its output captured, instead of only printing it; without `--yes` it still prints it. An agent that already has the identity's server is left as it is, so running `init` twice adds nothing and does not fail. `--json` prints one report of what was created, the sign-in step, and the agent's registration (the command it ran, its exit code and output), and never asks. `init` exits 1 when the agent's command fails and 127 when `--yes` names an agent whose program is not on the PATH. Each registration is recorded in the identity's state folder, so `remove` can take it out again.
