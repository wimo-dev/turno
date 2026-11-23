# turno-core

## 0.5.0

### Minor Changes

- d65d855: turno-browser runs on Windows 10 and 11 (x64): `npm install --global turno-browser`, no admin rights. It finds Google Chrome, Microsoft Edge and Brave in `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%`, and `install-browser` puts Chrome for Testing in `%LOCALAPPDATA%\ms-playwright`. Identities live in `%LOCALAPPDATA%\turno\data`, settings in `%APPDATA%\turno` and runtime state in `%LOCALAPPDATA%\turno\state`; the `TURNO_*_DIR` and `XDG_*` variables still move them. The background server and the live view listen on named pipes (`\\.\pipe\turno-browser-<id>-<hash>`) instead of socket files. A Chrome left running is found through its profile's lock and the process table, and ended with its helpers by `taskkill /T`; messages say `taskkill /PID <pid> /T /F` where they said `kill <pid>`. `setup` and `init` register the server as `cmd /c turno-browser-mcp --identity <id>`, and `init --yes` runs an agent's `.cmd` command through `cmd.exe` with each argument quoted. The vault and `keychain:` secrets use turno-core's Windows secret store (DPAPI files). Lightpanda has no Windows build.
  
  turno-core: the turno folders follow Windows' conventions (`%APPDATA%`, `%LOCALAPPDATA%`), `findOnPath` reads `PATHEXT`, a file replaced while another process reads it is retried instead of failing, and `killTree` ends a process tree on every platform. The Windows process table and the DPAPI store call WMI and DPAPI through .NET only, with no cmdlet, so Windows PowerShell answers in a fraction of a second even in the few variables an agent passes its servers (a cmdlet there took 20 seconds).
- c80b30c: A secret store on Windows: each item (a vault credential or a `keychain:` secret) is a file in `%LOCALAPPDATA%\turno\secrets` encrypted with DPAPI for the current user, through Windows PowerShell 5.1 with the value on stdin, never in a command line. It needs no admin rights and no native module, has no size limit (Credential Manager caps an item at 2560 bytes), and checking whether an item exists only looks at the file. `turno-browser doctor` now names the secret store in use, and on Windows its folder.

## 0.4.0

### Minor Changes

- 6bf9b12: A low-resource preset for machines short of memory: `turno-browser set <id> --resources low` (identity.json `"resources": "low"`, or `turno-browser-mcp --resources low`) keeps at most 2 tabs open, parks an unused tab after 2 minutes, closes Chrome after 5 minutes without a tool call and the background server after 5 minutes without a request, turns off Chrome's back/forward cache so a parked tab frees its memory at once, and adds a short note to tool results while the system reports memory pressure. A key set on its own (`--tabs-max`, `TURNO_BROWSER_IDLE`, `--background-idle`) still wins over the preset. `turno-browser doctor` shows the memory pressure. The memory pressure probe mcpd uses moved to `turno-core/memory`, so turno-browser reads the same level.

## 0.3.0

### Minor Changes

- cd53ee9: `turno-browser completion <zsh|bash|fish>` prints a shell completion script: commands, identity
  names, setup agents, `do` actions and each command's flags. It only reads identity folders, so
  completing never starts Chrome or reads the secret store. The scripts come from turno-core, which
  turno uses too.

### Patch Changes

- cd53ee9: - `turno --help | head` and `turno-browser --help | head` end quietly instead of printing an
    EPIPE stack trace when the reader stops early.
  - Bash completion works on the bash 3.2 macOS ships: each word reaches turno on its own, and
    the script loads with `eval "$(turno completion bash)"`, since bash 3.2 cannot source `<(...)`.
  - `turno mcp daemon run` stops by itself when its home folder is removed (a throwaway HOME
    someone deleted), instead of running on with nothing left to serve.

## 0.2.0

### Minor Changes

- df52afc: turno-browser has its own `turno-browser` command: add, list, show, set, login, vault, export, import, flows, replay, record, traces, live, pause, resume, doctor and reputation work without turno, with `--version` and a help grouped by section. `turno-browser add` prints how to connect an agent instead of an `mcp.toml` block, and `turno-browser do` says it needs turno for now. `turno browser ...` and the browser part of `turno identity ...` now run turno-browser's commands through its typed api (API_VERSION 1.12, new member `cli`) with the same flags, output and exit codes, so turno-cli needs turno-browser 1.12 or a later 1.x. turno-core gains `turno-core/cli`, the command line toolkit (arguments, output, styles, exit codes, command groups, hints, hidden input) that both programs share.
- e2b1779: `turno-browser do` works without turno: it starts the identity's background server on the first action, keeps one session per agent or shell between commands, and ends it with `end`, `close` or when that process exits. `turno browser do` keeps going through mcpd.
  
  New `turno-browser` commands: `setup <claude-code|codex|cursor|copilot|gemini|json> [--identity <id>]` prints the MCP config that gives an agent an identity (it writes nothing; `--json` for scripts), `background status|start|stop` shows and controls the background servers, and `secret set|has|list|remove` stores the `keychain:<item>` secrets identity.json names, in the same store and items as `turno secret`.
  
  Hints, errors and doctor fixes name the commands of the program you typed: `turno-browser ...` on its own (the MCP server's messages too), `turno browser ...` and `turno identity ... browser:<id>` inside turno. `turno-browser doctor` lists a running background server, and a stdio server refused by a background server names `turno-browser background stop <id>`.
  
  turno-core exports the owner, name and lock of a shell session of browser commands (`turno-core/cli`), shared by `turno browser do` and `turno-browser do`.
  
  The npm description, keywords and MCP Registry entry follow the new tagline. Wording: the help no longer labels the off-by-default settings (natural language actions, captcha solving, network and user agent, Camoufox) as "not recommended"; they stay off by default and the help still says what each one sends where.

## 0.1.0

### Minor Changes

- a0bfce8: New package `turno-core` with what turno-cli and turno-browser share: turno's paths, the secret
  store (macOS Keychain, Linux Secret Service) and the process helpers. Both packages
  now depend on it instead of keeping their own copies; behavior is unchanged.

### Patch Changes

- 2948759: The package homepage is now https://turno.wimo.dev.
- 5566437: Every package has a README that tells the same story as the site. turno-cli's follows the
  order of turno.wimo.dev and lists what the browser gained; turno-browser's is organized around
  what the package does (identities, the credential vault, session export and import, tab limits,
  `browser_batch`, blocking and cache, health and doctor); turno-core's says what the shared
  package is for; turno-fonts' shows the status line and how `turno ui install` uses the font.
  Each links to its page on turno.wimo.dev and to the releases.
