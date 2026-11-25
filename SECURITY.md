# Security policy

## Reporting a vulnerability

Report it privately through GitHub: **Security > Report a vulnerability** on this repository
(private vulnerability reporting). That is the only channel; please do not open a public issue,
discussion or pull request for a vulnerability.

What to include: the version (`turno version`), OS, the component (CLI, gateway, status line,
accounts bridge, browser), steps to reproduce, and the impact you see. Remove tokens, Keychain
values and personal paths from logs before you send them.

What to expect:

| Step | Target |
|---|---|
| Acknowledgement | 3 working days |
| Triage and severity | 7 days |
| Fix for high and critical issues | 30 days |
| Coordinated disclosure | at most 90 days after the report, earlier once a fix ships |

Fixed issues get a GitHub security advisory and, where it applies, a CVE requested through
GitHub. Reporters are credited unless they ask not to be.

### Fixes and releases

The changeset of a security fix names the advisory and the CVE, for example "Fix token leak in
the gateway log (GHSA-xxxx-xxxx-xxxx, CVE-2026-12345)", so the release notes (each package's
`CHANGELOG.md` and the GitHub release) list every vulnerability that release fixes. A fix for
a vulnerability that is not public yet ships first and the changelog entry is completed when
the advisory is published.

**Reports written with AI tools** are welcome if you say so in the report, you have verified the
finding yourself, and the proof of concept is real. Invented or unverified findings waste the
maintainer's time; reporters who send them repeatedly are blocked.

## Supported versions

During 0.x only the latest minor release gets security fixes. Upgrade with `turno upgrade`.

## Security model

turno runs on your machine, as your user, and handles credentials of several accounts. This
is what it stores, what it trusts, and what it does not protect against.

### What turno stores

| Data | Where | Protection |
|---|---|---|
| Agent logins (one per profile) | each agent's own config dir, e.g. `~/.claude-<profile>` | written by the agent itself; turno never reads, copies or proxies them |
| MCP server secrets | macOS Keychain or Linux Secret Service (`secret-tool`), items `turno/<server>/<key>` | read at use time, passed on stdin (never in a command line), never logged |
| OAuth tokens of remote MCP servers | the same secret store, items `turno/oauth/<server>@<variant>` | never in a file or a log; refreshed by mcpd and sent only to that server's own origin |
| Master gateway token | `~/.local/state/turno/mcpd.token` | file mode 600; used by turno only, for mcpd's own endpoints; never written into an agent config |
| Per-profile gateway tokens | each profile's agent config (`.claude.json` for Claude Code), and `~/.local/state/turno/mcpd-tokens/<profile>.token` for the launchers of Codex, Copilot and Cursor | file mode 600; each one holds that profile's own token, derived from the master token |
| Browser identities | `~/.local/share/turno/browser/<identity>` | live cookies of the sites you signed into: treat as credentials. By default Chrome encrypts them with a fixed public key (`--use-mock-keychain`), so anyone who can read the folder can read them; `"keychain": "system"` in identity.json uses the OS keychain's key instead, so a copy of the folder (a backup, a synced disk) does not hand over the sessions; changing it signs the identity out, so export first and import after |
| Session exports (`turno browser export`) | the file you name, mode 600 | cookies, localStorage and IndexedDB of an identity, encrypted with your passphrase (scrypt, AES-256-GCM) and refused on import after their expiry (default 7 days); never the vault |
| Browser vault credentials (username, password, TOTP secret per site) | the same secret store (on Windows, DPAPI-encrypted files in `%LOCALAPPDATA%\turno\secrets`), items `turno-browser/vault/<identity>/<site>` | never in a file, a log, a tool result or a snapshot; the index `<identity>.vault.json` (mode 600) holds only site names, origins and the submit policy |
| Chrome profiles for `turno open` | `~/.local/share/turno/chrome/<profile>` | the claude.ai session of each profile |
| Installed MCP servers | `~/.local/share/turno/servers/<name>/` | folders mode 700; exact versions, no install scripts unless `--allow-scripts` |
| Usage, run records, exhausted marks, logs, caches, `mcpd-clients.json` | `~/.local/state/turno/` | folders 0700, files 0600; no secrets |
| Tool call log | `~/.local/state/turno/logs/calls.jsonl` | mode 600; tool names, profiles, agents, durations, sizes and redacted errors, never arguments or results; `call_log = false` under `[mcpd]` turns it off |
| Backups of the files turno changes | `~/.local/state/turno/backups/` | folders 0700, files 0600; they can hold literal secrets that were in those files; pruned after 30 days, keeping the newest 10 (`turno undo --prune` by hand) |
| Accounts bridge audit log | `~/.local/state/turno/audit.jsonl` (mode 600) | append-only and hash-chained; prompts, results and the policy decision of each delegated task |

On macOS, turno's Keychain items trust `/usr/bin/security`, so mcpd can read a secret when it
starts a server, in the background, without a Keychain dialog. The price: any process running
as you can read those items without a prompt too, as it could a mode 600 file. They are still
encrypted at rest and stay out of backups, dotfile repositories and config diffs. The Linux
Secret Service has no per-application access control, so an unlocked collection is the same.
On Windows (turno-browser), each item is a file in `%LOCALAPPDATA%\turno\secrets` encrypted
with DPAPI for the current user: only that user can decrypt it (on that machine, unless the
account has a roaming profile), any process running as that user can, and the value reaches
Windows PowerShell on stdin, never in a command line.
Machines without a secret store (most servers and containers) use `env:` references in
`mcp.toml` instead.

`turno mcp import` shows secrets masked and stores nothing until `--write`. With
`--move-secrets` it moves env and header secrets to the secret store; secrets in a server's
args or URL query string stay literal in `mcp.toml`, since they cannot come from the store.

turno does not intercept, store or forward model traffic, and it does not handle the OAuth
tokens of Claude, ChatGPT, GitHub or any other vendor's agent login. Each agent logs in by
itself, in its own config directory.

### The agents' terms of service

turno launches the agents' own, unmodified command line tools, and each one signs in with your
own account. turno never reads, copies, stores or forwards their login tokens and never routes
requests with them; features that would need to (for example a usage meter that calls a vendor
API with your login) are out of scope. Profiles and folder rules choose which of your own
accounts opens a folder. `fallback`, which chooses which of your accounts opens a folder while another
is marked exhausted, is off unless you set it, and it is not a way around a vendor's usage limits or
safeguards: each vendor's terms and usage policies apply to every account you use, and
following them is up to you.

### The gateway (`mcpd`)

- Listens on `127.0.0.1` only, never on a public interface, and only on `mcpd.port`: if
  another process holds that port, mcpd fails and names it instead of moving.
- Requires a bearer token on every request. Each profile has its own token, and the token
  decides the profile, so which servers (`profiles`) and tools (`tools` allow and deny) a
  session reaches. The master token opens only mcpd's own endpoints (`/status`, `/refresh`)
  and is refused for MCP sessions. `turno mcp token rotate` replaces it and so invalidates
  every profile token. mcpd does not pass any token it receives on to the MCP servers behind
  it (each server gets its own secrets from the secret store).
- Rejects any request that carries an `Origin` header, so a web page in your browser cannot
  reach it (DNS rebinding and cross-site requests), and request bodies over
  `mcpd.max_request_body` (32 MiB by default).
- Runs MCP servers as your user, with the commands you put in `mcp.toml`. A server you add is
  code you trust; the gateway does not sandbox it.
- Is the OAuth client of `auth = "oauth"` remote servers: it logs in once per account with
  PKCE, refuses authorization servers without S256 and answers whose issuer or state does not
  match, and never presents a token to another server.
- Folder server sets (`mcp`, `mcp_deny` in `config.toml`) hide servers from sessions in a
  folder; they are a convenience, not a boundary: a session whose folder mcpd cannot learn
  sees every server.

### The accounts bridge

A delegated task runs headless in the profile that owns the account. A read gets only the
account's `read_tools`, and Claude Code refuses every other tool. An account without
`read_tools`, and by default every call to a mail or messaging account, asks for your
confirmation in the client, as writes do. The run loads no settings files, starts in turno's
own empty folder with a minimal environment, and gets only the account's MCP servers when
they go through the gateway. Every call, with the decision (policy, confirmation, allowed
tools), is written to the audit log (`turno identity log`). Details:
[docs/accounts.md](docs/accounts.md).

### The browser package

`turno-browser-mcp` serves over stdio, through mcpd. It refuses `--port` or `--host` together with
`--identity`, which would serve a signed-in browser over HTTP, unless you pass
`--allow-http-identity`; it then listens on 127.0.0.1 only.

### The credential vault

`turno browser vault add <identity> <site>` stores a username, a password and optionally a
TOTP secret for one site of one browser identity, and the `browser_login` tool fills them into
that site's sign-in form. The
values come from a hidden prompt or stdin, go straight to the secret store, and are read back
only inside `turno-browser-mcp` when the tool runs. The model names the site; it never sends
or receives a value.

What it guards against:

- **Leaking into the conversation.** Before anything is filled, the values join a redactor
  that every result and error of that server passes through, so a snapshot of the filled
  form, a network request body, a console message or an error shows `[vault: <site> ...]`
  instead. It matches the value as typed and URL-, form-, JSON- and HTML-encoded. One-time
  codes stay redacted for 10 minutes.
- **Being spent on the wrong site.** Each site is stored with the origins given by `--url`
  (https only; http only on localhost). `browser_login` refuses unless the current page is on
  one of them, and fills only frames of those origins, so a page that tricks the model into
  calling it gets nothing.
- **Being read back by script.** On a page `browser_login` filled, `browser_evaluate` and
  `browser_run_code_unsafe` are refused until the page navigates; `browser_run_code_unsafe`,
  which runs code in the server process, is refused for any identity that has vault
  credentials. A password goes only into `<input type="password">`, a username and a code only
  into text inputs, also when the model names the field.
- **Password fields typed by anyone.** The value of a password or one-time code field (by
  type, `autocomplete` or a name like `otp`) is masked as `[sensitive field]` in every page
  snapshot, also in the snapshot files written to the workspace, and joins the redactor,
  whoever typed it. The agent's `browser_type`, `browser_fill_form` and key presses into such
  a field are refused; the person types it, or `browser_login` fills it from the vault.
- **Credentials in network output.** `browser_network_requests` and `browser_network_request`
  show `[redacted]` for `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`
  values and for query, form and JSON fields named like a token, code, session, key, secret
  or password, in their results and in the files they save.
- **Session cookies and stored tokens.** The storage tools (cookies, localStorage,
  sessionStorage, the storage state file) are listed by default. After every browser call the
  server reads the browser's cookies and the current page's web storage. A value is masked when
  its cookie is HttpOnly, its name reads like a credential (`session`, `sid`, `token`, `auth`,
  `csrf`, `login`), or it holds a random-looking run of 64 bits or more: it reads `[masked]` in
  the storage tools and, when it looks random, in every other result and written file too
  (`document.cookie` through `browser_evaluate`, a response body, a console message, a
  snapshot, the act model's prompt). Names, domains, paths, expiry and flags stay. A mask the
  agent writes back keeps the value it stands for, in the same cookie or item only.
- **Being recorded.** `browser_login` refuses to run while the server saves traces, sessions
  or video (Playwright's own `--save-*` options), or has the devtools capability. An identity's
  own recordings stop around it (see below).
- **Being submitted without a visible step.** By default the tool only fills; the model clicks
  the sign-in button as a separate tool call. `turno browser vault submit <identity> auto`
  lets the tool submit too.

What it does not guard against:

- A screenshot shows what the page shows, usually the username (passwords are masked by the
  page, not by turno).
- The page itself, once filled, can do anything with the values: that is the site you chose
  to sign into.
- Redaction matches text. A value the page transforms some other way (base64, hashing,
  splitting) before it reaches a result is not caught; it is a guard against accidents and
  an honest model, not against a model or a page set on extracting a secret.
- Anything running as your user can ask the secret store for the items, as it can for every
  other secret turno keeps (see out of scope).
- A script (`browser_evaluate`, `browser_run_code_unsafe`) can transform a cookie or token
  before returning it, a screenshot shows what the page shows, and a trace the agent starts with
  the devtools capability saves the network traffic, cookie headers included, to the workspace.
  An identity policy can turn `storage`, `evaluate` and `run_code` off.

### Recordings and flows

Off by default. `browser_record` saves a flow (the agent's tool calls and the elements they
targeted) and identity.json `record` saves every session as a flow, a Playwright trace and a
screenshot per action. Flows are files of mode 600 under `~/.local/share/turno/browser/flows/`;
traces and screenshots are under the identity's state folder, capped in size.

- A flow keeps typed text as parameters. A sensitive parameter keeps no value: a password,
  one-time code or card field, a field named like `password`, `otp`, `pin` or `token`, a vault
  value typed by hand, or a name the agent marks sensitive. A file holding a value for one is
  refused on write and on read. A vault sign-in is kept as `browser_login` with the site name.
  At replay a sensitive value is given again, or read from the secret store as
  `keychain:<item>`; it then joins the redactor.
- Before a vault fill, a value typed into a secret field, or a sensitive parameter at replay,
  the trace is stopped and saved; it starts again only after every page holding the value has
  navigated, and no screenshot is taken of such a page. Each saved trace is then searched for
  those values (also encoded) and deleted if one is found. There is no video.
- A trace holds what the pages showed, their network traffic and their cookies: treat the
  recordings folder like the profile itself. Traces and screenshots are not taken in attach
  mode (they could show your own tabs) or in read mode.

### Releases and how to verify them

Every package is built and published by CI (`.github/workflows/release.yml`), never from a
laptop, with npm trusted publishing: there is no long-lived npm token. One job runs the tests
and packs the tarballs; a separate job, in a protected environment that a maintainer approves,
attests and publishes those same tarballs without checking out the repository, installing
anything or using a cache, so no project or dependency code runs where the publishing
credential lives. Every release job can reach only the hosts on its allow list. `turno-cli`
and `turno-browser` ship an `npm-shrinkwrap.json`, so `npm install --global` installs the
exact dependency tree that CI tested, and nothing in it runs an install script. Each GitHub
release carries a CycloneDX SBOM. Details: [docs/RELEASING.md](docs/RELEASING.md).

To verify what you installed:

- On npmjs.com, each version shows its provenance: the commit and the workflow run that built
  it.
- `npm pack turno-cli@<version>`, then
  `gh attestation verify turno-cli-<version>.tgz --repo wimo-dev/turno`, checks that tarball
  against the build attestation of the release.
- `npm audit signatures` checks the registry signatures and provenance of every package in a
  project that installs a turno package as a dependency.

The first version of a new package is published by hand, because npm accepts a trusted
publisher only for a package that exists; that one version has no provenance.

### Checking your setup

`turno doctor --security` checks who can read or write turno's folders (`--fix` narrows them
to owner only), who holds the mcpd port, literal secrets left in `mcp.toml`, agent configs and
backups (it names where, never the value), MCP servers that do not run an exact version, the
age of the gateway token (and profile token files older than it), and the audit log's hash
chain.
`turno identity log --verify` checks the hash chain alone and exits 1 when it is broken.

### Out of scope

- Anything another process running as your user can do: it can read the token files, the
  browser profiles and the agent config dirs. turno does not defend against local malware.
- The behavior of the agents and the MCP servers themselves.
- How you use the browser on third-party sites: that is between you and each site's terms.
