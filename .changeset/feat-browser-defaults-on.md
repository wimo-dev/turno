---
"turno-browser": minor
"turno": patch
---

turno-browser turns its features on by default, worked out at every launch and never written into identity.json. `show`, `status` and `doctor` list each value with where it came from, for example `resources: low (auto: memory pressure)`.

What changes for an existing identity, without touching its identity.json: the live view is on (it opens only with `turno-browser live`); flows and screenshots are recorded, and a trace is kept when a step fails, under the 200MB cap and never of a page with a vault value; the `vision`, `pdf`, `devtools` and `network` tools are listed when the server has no `--caps`; `browser_login` submits the form (`vault submit <id> confirm` keeps the old behavior, and must be run again even if it was chosen before); the low-resource preset turns on under memory pressure; human-like input is `auto`; several agent sessions share the browser in their own tabs (`--sharing session` for one at a time; an mcp.toml block with `exclusive = true` keeps working, and doctor says how to change it); a headless Chrome gets the coherent user agent (once `login` has read that Chrome's client hints) and background throttling when the live view is off; Chrome gets the system's locale when identity.json names none; and `login` finds a health check when there is none. A key set in identity.json still wins over every default, and `off` (`--health off`, `--locale off`, `--user-agent off`) pins one off. A file with an `auto` or `false` value is written as format 14, which turno-browser 0.10 refuses.

New identities created at a terminal on macOS with Google Chrome keep their cookie key in the system keychain, and `add` mentions Camoufox, Lightpanda and attach mode when they apply. turno prints the mcp.toml block of a new identity with `exclusive = false`, except in attach mode.
