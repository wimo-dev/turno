# turno-core

**The part of turno that its packages share.** You do not install it yourself:
[turno-cli](https://www.npmjs.com/package/turno-cli) and
[turno-browser](https://www.npmjs.com/package/turno-browser) depend on it.

turno lets you switch accounts in your coding agents and keep everything else: the conversation,
the MCP sign-ins and the browser session. The command line and the browser are separate packages,
and each has to work without the other, yet both need to find the same folders, read the same
secret store and handle processes the same way. That shared ground is this package.

| Import | What it gives |
|---|---|
| `turno-core/paths` | turno's folders, from `HOME`, the XDG variables and `TURNO_CONFIG_DIR`, `TURNO_STATE_DIR`, `TURNO_DATA_DIR`; the browser's folders; private folders (0700) and files (0600); a `PATH` lookup |
| `turno-core/secrets` | the machine's secret store: the macOS Keychain through `security`, the Linux Secret Service through `secret-tool`, or on Windows files in `%LOCALAPPDATA%\turno\secrets` encrypted with DPAPI through Windows PowerShell. Values travel on stdin, never in a process argument list |
| `turno-core/process` | whether a PID is alive, signals that never throw, and the process table with process groups |

It is internal to turno. For per-folder accounts and the MCP gateway, install
[turno-cli](https://www.npmjs.com/package/turno-cli); for a browser with one profile per
identity, [turno-browser](https://www.npmjs.com/package/turno-browser).

[turno.wimo.dev](https://turno.wimo.dev) · [Security](https://turno.wimo.dev/docs/security) ·
[Releases](https://turno.wimo.dev/docs/releases) · Apache-2.0
