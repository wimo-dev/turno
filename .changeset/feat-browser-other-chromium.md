---
"turno-browser": minor
"turno-cli": patch
---

An identity can run on another Chromium-based browser than Google Chrome: `turno-browser set <id> --browser chrome|edge|brave|chromium|chrome-for-testing|<path>` (also on `add`; identity.json `browser`, format 13). Every command uses it: the agent's server, `login`, `export` and `import`, the background server and `replay`. A server's own `--browser` or `--executable-path` still wins over it. When Google Chrome is not installed, `add` and `init` pick the first browser they find and write it to identity.json, so a profile never changes browser by itself. Switching the browser of a profile another browser already opened is refused unless you pass `--force`, since the new browser rewrites the profile and, with `keychain: "system"`, cannot read the old one's cookies.

New `turno-browser install-browser`: for a machine without any Chromium-based browser and no admin password, it downloads Chrome for Testing into the user cache with the installer of the patchright-core turno-browser uses (about 190 MB, no system change). `doctor` lists every browser it finds (Chrome, Edge, Brave, Chromium, Chrome for Testing), starts the first one when Chrome is missing, says which browser each identity uses and whether it is installed, warns when a newer browser last opened a profile, and names `install-browser` when there is none. turno-cli needs turno-browser's API 1.14.
