---
"turno-browser": minor
"turno-core": minor
---

turno-browser runs on Windows 10 and 11 (x64): `npm install --global turno-browser`, no admin rights. It finds Google Chrome, Microsoft Edge and Brave in `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%`, and `install-browser` puts Chrome for Testing in `%LOCALAPPDATA%\ms-playwright`. Identities live in `%LOCALAPPDATA%\turno\data`, settings in `%APPDATA%\turno` and runtime state in `%LOCALAPPDATA%\turno\state`; the `TURNO_*_DIR` and `XDG_*` variables still move them. The background server and the live view listen on named pipes (`\\.\pipe\turno-browser-<id>-<hash>`) instead of socket files. A Chrome left running is found through its profile's lock and the process table, and ended with its helpers by `taskkill /T`; messages say `taskkill /PID <pid> /T /F` where they said `kill <pid>`. `setup` and `init` register the server as `cmd /c turno-browser-mcp --identity <id>`, and `init --yes` runs an agent's `.cmd` command through `cmd.exe` with each argument quoted. Not on Windows yet: proxy passwords and the vault (no secret store there), and Lightpanda.

turno-core: the turno folders follow Windows' conventions (`%APPDATA%`, `%LOCALAPPDATA%`), `findOnPath` reads `PATHEXT`, a file replaced while another process reads it is retried instead of failing, and `killTree` ends a process tree on every platform.
