# MCP servers behind mcpd

Every profile's `.claude.json` lists local MCP servers as HTTP entries pointing at mcpd:

```json
"calendar": {
  "type": "http",
  "url": "http://127.0.0.1:47821/mcp/calendar",
  "headers": {
    "Authorization": "Bearer <the work profile's token>",
    "X-Turno-Profile": "work",
    "X-Turno-Pid": "${TURNO_SESSION_PID:-0}",
    "X-Turno-Cwd-B64": "${TURNO_SESSION_CWD_B64:-}"
  }
}
```

`turno mcp sync` writes these. Claude Code expands the `${...}` values when it connects, so
mcpd learns which session (launcher PID) and folder each connection comes from. Codex, Copilot
CLI and Cursor CLI send the same two headers, each in its own syntax
([agents.md](agents.md#which-folder-a-session-is-in)). The launcher
exports the folder base64url-encoded, because a raw path outside Latin-1 (an accent typed in
NFD form, CJK, an emoji) is not a valid header value and the client would refuse to connect.
Without the variable (a plain `claude`), mcpd reads the folder of the client process (`/proc`
on Linux, `lsof` on macOS). Entries written by older versions still send `X-Turno-Cwd`; mcpd
keeps reading it.

## Tokens and profiles

Each profile gets its own gateway token, derived from the master token in
`~/.local/state/turno/mcpd.token` (HMAC-SHA256, so mcpd keeps no list of them). mcpd reads the
profile from the token, not from `X-Turno-Profile`: a session with the `work` token cannot open
a server whose `profiles` leave `work` out (HTTP 403), and a request whose `X-Turno-Profile`
names another profile than its token is refused too. Plain `claude` gets the token of the
system profile. Codex, Copilot and Cursor read the token from `TURNO_MCPD_TOKEN`, which their
launcher fills from `~/.local/state/turno/mcpd-tokens/<profile>.token` (mode 600, written by
`turno mcp sync`).

The master token never goes into an agent config. It opens only mcpd's own endpoints
(`/status`, `/refresh`, `/logout`), which `turno` uses; mcpd refuses it for MCP sessions. Configs synced by
a turno older than per-profile tokens still send it: mcpd answers 403 with "run: turno mcp sync",
and `turno doctor` and `turno upgrade --finish` say the same (`--finish` offers to run the sync,
and `--yes` runs it). Removing a profile does not revoke its token; `turno mcp token rotate` does
(for every profile). The next full `turno mcp sync` removes the token file it wrote for it.

## mcp.toml reference

```toml
[server.<name>]
command = "server-bin"            # stdio server
args = ["--flag"]                 # its arguments
env = { TOKEN = "keychain:turno/name/token", REGION = "eu", OTHER = "env:SOME_VAR" }
                                  # its environment: keychain: and env: values are read when it starts
cwd = "/abs/path"                 # default: project root (project), session folder (session), home (shared)
package = "server-pkg@1.2.3"      # optional: `turno mcp install` pins it to an exact version; until then npx runs it (with a warning in the logs)
scope = "shared"                  # shared | project | session (default shared)
idle = "30m"                      # stop after this long without calls (default 30m shared, 20m others;
                                  # a session server stays while its session's process lives,
                                  # unless memory pressure is critical)
call_timeout = "10m"              # optional: cancel a single request that runs longer (off by default;
                                  # it also cuts calls waiting for the user to answer a form)
stop_grace = "5s"                 # optional: wait after closing stdin before SIGTERM (then 2s and SIGKILL);
                                  # default 5s for turno-browser-mcp, 2s for every other server
exclusive = false                 # one client session at a time (shared scope only)
lease = "5m"                      # exclusive: how long an idle holder keeps it
profiles = ["*"]                  # which profiles get this server (and may open it)
tools = { allow = ["get_*", "list_*"], deny = ["*_delete"] }   # optional: which tools sessions see

[server.<name>.variant.<profile>] # what changes for one profile (a different account)
env = { TOKEN = "keychain:turno/name/token-work" }   # added to the server's env; a key here wins
command = "server-bin-work"       # optional: another program for this profile
args = ["--account", "work"]      # optional: replaces the server's args
cwd = "/abs/path"                 # optional: another working folder
tools = { deny = ["*"] }          # replaces the server's allow / deny, key by key, for this profile

[server.<remote>]
url = "https://example.com/mcp"   # a remote server, reached over HTTP
headers = { Authorization = "keychain:turno/remote/auth" }   # secret headers: proxied by mcpd
type = "http"                     # or "sse" for the legacy HTTP+SSE transport
auth = "oauth"                    # instead of an Authorization header: mcpd logs in (see below)
```

`tools` patterns match whole tool names: `*` is any run of characters, `?` one character. With
`allow`, only matching tools stay; `deny` then removes matching ones. A filtered tool is absent
from `tools/list`, and a call to it gets a JSON-RPC error. mcpd applies the filter, so it works
for stdio servers and proxied remotes, and `turno config check` refuses it on a remote that does
not go through mcpd.

Values starting with `keychain:` are read with `security find-generic-password -s <service> -w`
when the server starts; `env:` reads mcpd's own environment, and `env:NAME:-default` uses the
default when `NAME` is unset or empty. Under the LaunchAgent mcpd sees few variables (set more
with `launchctl setenv`), so prefer `keychain:` for secrets. Store a secret with
`turno secret set <service>` (input is hidden, never printed).

Inside other values, mcpd expands `${NAME}`, `${NAME:-default}` and `${env:NAME}` from its own
environment, as Claude Code does in its config: in a stdio server's `args` and `env` values and
in a proxied server's headers (`"--region=${REGION}"`, `"Bearer ${API_TOKEN}"`). A variable
that is unset and has no default stops that server from starting with an error that names it.
Cursor's placeholders such as `${workspaceFolder}` are left as written. `turno doctor` lists the
variables mcp.toml reads this way that are not set in the shell it runs in (names only, never a
value); mcpd under the LaunchAgent or systemd has its own environment, so set them there too.

## Remote servers with OAuth

A remote server that asks its users to log in (Linear, Notion, GitHub and most hosted MCP
servers) can be declared with `auth = "oauth"`. `turno mcp import --write` sets it for you: it
sends each remote server without an `Authorization` header (or a header with a secret) one
`initialize` request without credentials, and a `401` with a `WWW-Authenticate: Bearer`
challenge, which is how the MCP authorization spec asks for a login, marks the server. Previews
stay offline and mark nothing. mcpd then becomes its OAuth client: you log in
once per account with `turno mcp login`, and every agent and profile reaches the server through
mcpd without a login of its own. See [SECURITY.md](../SECURITY.md#the-gateway-mcpd).

```toml
[server.linear]
url = "https://mcp.linear.app/mcp"
auth = "oauth"

[server.linear.variant.personal]  # this profile logs in with another account
                                  # (optional key: tools)

[server.linear.oauth]             # all optional
scope = "read write"              # instead of what the server asks for
client_id = "abc123"              # a client you registered by hand (pre-registration)
client_secret = "keychain:turno/linear/client-secret"   # its secret, only as a reference
callback_port = 33418             # fixed loopback port, when the client was registered with one
client_metadata_url = "https://example.com/turno-client.json"   # a Client ID Metadata Document you host
authorization_server = "https://auth.example.com"   # when the server lists several
```

```sh
turno mcp login linear                    # the login every profile without a variant uses
turno mcp login linear --profile personal # the personal variant
turno mcp login linear --no-browser       # print the link instead of opening the browser
turno mcp login linear --dry-run          # discovery and registration plan, nothing stored
turno mcp logout linear [--profile p | --all] [--no-revoke]
```

`turno mcp login` finds the authorization server from the server's protected resource metadata,
registers turno (a hand-registered `client_id` first, then a Client ID Metadata Document when
you host one and the server supports it, then dynamic client registration), opens the browser
on a PKCE authorization request, and waits for the answer on `http://127.0.0.1:<port>/callback`.
It refuses authorization servers that do not advertise PKCE with S256, metadata whose `issuer`
is not the one it was fetched for, and answers whose `iss` or `state` does not match.

The tokens go to the secret store (Keychain or Secret Service) as `turno/oauth/<server>@<variant>`,
never to a file or a log. mcpd refreshes the access token when it expires or the server answers
401, and saves a rotated refresh token before it uses the new access token. If the secret store
refuses that write, mcpd keeps the new tokens in memory, tries the write again on each call
and once more when it stops, and notes it in `logs/<server>.log` (tokens the store still refuses
at shutdown are lost, and the next refresh needs a login); a `turno mcp login` or `logout` made
meanwhile wins. When
the authorization server rejects the refresh token (revoked or expired), calls fail with the
`turno mcp login` command to run, and `turno mcp list`, `turno mcp doctor` and `turno doctor`
show the variant as "login required". `turno mcp logout` tells a running mcpd
(`POST /logout/<server>?variant=<v>` with the master token), which stops using the old access
token at once; an mcpd older than 0.2 notices within a minute.

## Server sets per folder

A `[[projects]]` rule in `config.toml` can also say which servers sessions in that folder see
. The rule may have a profile, a server set, or both:

```toml
[[projects]]
path = "~/code/acme"
profile = "work"
mcp = ["issues", "docs"]      # only these servers, by their name in mcp.toml

[[projects]]
path = "~/code/oss"
mcp_deny = ["mail"]           # every server but these
```

`mcp` keeps only the listed servers; `mcp_deny` then removes servers. The rule with the longest
path that has a set wins (a nested rule replaces its parent's set, it does not add to it), and a
git worktree matches the rules of its main repository. Every agent config still lists every
server: mcpd hides the rest per session, from the folder the session sends (or the folder of its
process). A hidden server answers `initialize` with no tools and a line that says which rule
hides it, lists nothing, refuses calls, and is never started. A session whose folder mcpd cannot
learn sees every server. mcpd reloads `config.toml` when it changes (or on SIGHUP); a changed
set applies to open sessions on their next list or call.

`turno config check` warns about names that are not in `mcp.toml` and about remote servers that
skip mcpd, which a set cannot hide. `turno profile which <dir>` shows the set of a folder.
`turno profile assign` and `unassign` change only the profile part of a rule and keep its set.

## Importing what you already have

`turno mcp import` drafts `mcp.toml` from the servers your agents already use: user and project
servers in `~/.claude.json`, `.mcp.json` in the current folder, `~/.codex/config.toml`,
`~/.cursor/mcp.json` and `~/.copilot/mcp-config.json`, then the config inside each turno profile
folder (`~/.claude-<name>/.claude.json`, `~/.codex-<name>/config.toml`, ...), so servers you set
up in one account only are found too; when two define the same name, the main config wins.
`turno init` reads the folders it is about to adopt the same way. It is a preview until
`--write`: secrets are shown masked, nothing is stored and nothing goes online (the command name
of an npx server is guessed from the package and checked on npm when written). `--write --move-secrets` stores env and header secrets
in the Keychain and writes `keychain:` references; secrets in args or URLs stay literal (they
cannot come from the Keychain). `${VAR}` and `${VAR:-default}` become `env:VAR` and
`env:VAR:-default`.

### Moving servers to another machine

`turno mcp export` prints `mcp.toml` without a single secret value, and `turno mcp import <file>`
merges such a file into `mcp.toml` on the other machine:

```sh
turno mcp export > servers.toml                      # every server
turno mcp export --profile work > work.toml          # only what work gets, and only its variant
turno mcp import servers.toml                        # preview: what it would add, replace or keep
turno mcp import servers.toml --write                # merge it; servers already there stay
turno mcp import servers.toml --write --force        # replace those too (backed up; turno undo)
```

Secrets travel by name only. `keychain:` and `env:` references stay as they are; a literal
secret in `env` or `headers` becomes `keychain:turno/<server>/<key>` (`turno/<server>/<profile>/<key>`
in a variant), the same name `--move-secrets` uses. The top of the file lists one
`turno secret set <name>` line for each Keychain secret the servers need, and the variables mcpd
must have. A secret inside `args` or a URL cannot be a reference, so the export replaces it with
`<secret>` and says so; fill those in by hand. Comments in `mcp.toml` are not exported.

`turno mcp import <file>` also takes another agent's MCP config: a JSON file with `mcpServers`
(Claude Code, Cursor, Copilot CLI, `.mcp.json`) or a Codex `config.toml`, converted the way the
import without a file converts them. It never replaces `mcp.toml` as a whole: new servers are
appended (the rest of the file and its comments stay), servers with a name already there are
kept unless `--force`, and a server written as an inline table under `[server]` has to be
replaced by hand. With `--write` it marks OAuth servers as above and ends with the next steps:
`turno secret list` for the references still missing, `turno mcp install`, `turno mcp login`
for OAuth servers, and `turno mcp sync`.

`turno mcp install` then resolves each `package` to an exact version, rewrites it in
`mcp.toml`, installs it without install scripts (`--allow-scripts` to run them) and keeps a
`package-lock.json` in `~/.local/share/turno/servers/<name>/`, so a reinstall gets the same
files.

## Choosing a scope

| Scope | One process per | Use it for |
|---|---|---|
| `shared` | server and variant | stateless API clients, indexes that cover every repository |
| `project` | git repository of the session | servers that read their working folder |
| `session` | Claude session | servers that keep per-conversation state, such as a throwaway browser |

### Browsers

A browser with a saved identity (`turno-browser-mcp --identity <id>`) is a `shared` server with
`exclusive = true`: one Chrome per identity, one session at a time. `turno identity add
browser:<id>` prints the block:

```toml
[server.browser-school]
command = "turno-browser-mcp"
args = ["--identity", "school"]
scope = "shared"
exclusive = true
lease = "10m"
idle = "30m"
```

Two limits apply. Inside the server, Chrome closes after 15 minutes without a tool call (headed
too) and opens again with the same profile on the next call; set `env = { TURNO_BROWSER_IDLE =
"10m" }` to change it, `"0"` to keep it open. mcpd stops the server itself after `idle`, sooner
under memory pressure. A browser without an identity (a temporary profile) can be a `session`
server: Chrome still closes when idle, and mcpd stops the server when the session ends, or
under critical memory pressure. Do not declare an identity as `session`: two sessions would
share one profile, and the second would find it in use. A Chrome left running by a server that
was killed is closed the next time the identity starts. While it runs, at most 8 pages stay open,
popups that open while no tool call runs are closed, and a page unused for 5 minutes is parked on
about:blank (15 minutes: closed); `tabs` in the identity's identity.json or the server's
`--max-tabs`, `--popups`, `--park-after` and `--close-after` flags change that.

Page snapshots are compact: every element an agent can act on keeps its ref, and wrappers, link
destinations and repeated rows are left out (40 to 70% fewer tokens on the pages measured). A
page still long once compact comes back as a table of contents, and `browser_read` reads a part by
ref, or the whole page with `full: true`; `TURNO_BROWSER_SNAPSHOT=full` turns this off.
Next to the stock Playwright MCP tools, turno-browser lists `browser_batch`, which runs several
of them in order in one call and returns one line per action and at most one snapshot. An action
can carry checks (`expect`: text shown or gone, a part of the URL, a field's value); the first
action or check that fails stops the batch, its error starts with a stable code (`ELEMENT_GONE`,
`CHECK_FAILED`, ...), and the result carries a snapshot of the page at the failure. A click, hover, type, select or drag that fails because of the element says
which element covers it, or whether it is hidden or disabled, and what to do next, after a stable
code such as `ELEMENT_COVERED`. After each action the server waits only until the page is done
with it (its requests answered, nothing changed for two animation frames), with Playwright's own
wait as the limit; `settle` in identity.json (like `"100ms"`) lowers that limit.
Blocking ads, trackers or heavy resource types (`block`) and an on-disk cache of static files
(`cache`) are opt-in per identity in identity.json.
With `--identity`, `browser_login <site>` fills a sign-in form from the identity's credential
vault (`turno browser vault add`), on the site's own origins only; the values never appear in a
tool result, and the form is submitted only when the identity allows it
([SECURITY.md](../SECURITY.md#the-credential-vault) has the threat model).

When mcpd stops a browser server it closes its stdin and waits 5 seconds (`stop_grace`) before
SIGTERM, so the server closes Chrome and writes its profile on its own; other servers keep the
MCP SDK's 2 seconds.

Each identity also has:

- **identity.json** next to its profile (`~/.local/share/turno/browser/identities/<id>.json`): the
  time zone, languages, locale and region that stay fixed for it, applied at every Chrome start.
  `turno identity add browser:<id>` pins a new identity to the current time zone; change it with
  `turno identity set browser:<id> --timezone Europe/Madrid --languages es-ES,es,en`, look
  at it with `turno identity show browser:<id>`. Without the file Chrome uses the machine's.
- **A runtime lock** while its Chrome runs. A second session on the same identity gets a tool
  error that names the process holding it and how to stop it (`kill <pid>`), instead of Chrome's
  "Browser is already in use".
- **A session health check**, optional: `turno identity set browser:<id> --health-url <url>
  --health-text <text>` names a page and what it shows only when signed in. When Chrome starts
  (at most every 30 minutes while it passes) turno checks it; if the proof is missing, the
  identity is NEEDS_AUTH and tool calls fail with a message that asks the user to run
  `turno browser login <id>`.
- **A reputation log**: each captcha, "verify it's you" or block page the identity meets, with
  the site's host name only. `turno browser reputation [<id>]` shows the counts per site and
  whether they go up or down.

turno-browser and turno-cli are installed apart. When `turno browser` or `turno identity`
loads turno-browser it compares the package's `API_VERSION` with the one it was built for, and
a package that is too old or too new stops the command with one line naming what to update
(`npm install --global turno-browser@latest`, or `turno upgrade`).

`turno browser doctor` checks Chrome, a test launch and every identity (settings, who holds it,
sign-in, recent challenges) and names the fix for each problem; `--fix` clears stale locks and a
Chrome left running with no server.

A remote server without secret headers or `auth = "oauth"` is written straight into each
profile and never touches mcpd. With either it is proxied, so the secret or the OAuth token
stays in the secret store, and `tools` filters and folder server sets apply to it.

## What the gateway does

- Answers `initialize`, `tools/list`, `prompts/list` and `resources/templates/list` from a
  cache, so a session that never calls a tool never starts the server. `resources/list` always
  reaches a running instance, since resources differ per project.
- Starts the upstream on the first real call and relays requests, notifications, progress and
  cancellation. Every start lists the tools again; when they changed, the cache is updated and
  clients get `list_changed`.
- Relays elicitation and sampling to the session whose call is in flight, and only offers them
  to the server when the client supports them. When calls from several sessions are in flight on
  a shared server, it refuses the request instead of guessing (use `scope = "session"` or
  `exclusive = true` for servers that ask the user). `roots/list` is answered by mcpd from the
  project or session folder; shared servers are not offered roots.
- Cancels a call upstream when the client cancels it or goes away, so an interrupted tool does
  not keep the server alive.
- Stops instances idle for longer than `idle`, session instances whose launcher PID died, and
  instances whose definition changed in `mcp.toml`. Open sessions use the new definition on
  their next call. When memory is tight (the kernel pressure level on macOS, PSI on Linux, else
  free memory), the idle limit shrinks to `idle_under_pressure` under `[mcpd]` in config.toml
  (default `"5m"`, a quarter of it when pressure is critical, `false` turns it off; a change in
  config.toml applies without a restart). A session server whose launcher still runs is kept
  under `warn`; under `critical` it stops like any other once it has been quiet for the
  critical limit, and the next call starts it again. `/status` reports it as `memoryPressure`: `level` (`normal`, `warn`, `critical`,
  or null while the setting is off), `checkedAt`, `idleUnderPressure` and `idleCap` (the idle
  limit in seconds every server gets now, null when they keep their own).
- Speaks two MCP revisions on the same endpoint: 2025-11-25 sessions (`initialize`,
  `Mcp-Session-Id`) and 2026-07-28 stateless requests (`MCP-Protocol-Version: 2026-07-28`,
  `Mcp-Method` and `Mcp-Name` headers, `server/discover`, `subscriptions/listen`). List results
  for 2026-07-28 clients carry `ttlMs` (5 minutes once a running server confirmed the list since
  mcpd started, else 0) and `cacheScope = "private"`. Servers behind mcpd are still spoken to as
  2025-11-25. A 2026-07-28 client cannot answer elicitation or sampling through mcpd yet.
- After 3 failed starts in a row, answers at once with the last lines of the server's log and
  retries with a growing delay (5 s, doubling, up to 5 minutes).
- Rebuilds a session it does not know (mcpd restarted) from the request headers instead of
  answering 404.
- Reloads `mcp.toml` when it changes (or on SIGHUP). When a change to `mcp.toml` (a tool
  filter) or to config.toml (a folder's server set) changes what an open session sees, mcpd
  sends it `notifications/tools/list_changed` (and the prompts and resources ones when the
  server is hidden or shown), so the agent lists again without reconnecting. Stateless
  2026-07-28 clients see the change when their list results expire.
- Drops a call that the client cancels while its server is still starting, instead of sending
  it once the server is up.
- Sends every `tools/call`, from both protocol revisions, through one call middleware before
  relaying it: the profile's tool filter (`tools.allow` / `tools.deny`), then the call log, then
  the session id below.

### The session id in `_meta`

Every `tools/call` mcpd relays carries `_meta["io.turno/session"]`: an opaque id (a UUID) that
is the same for every call of one agent session on one server and different for every other
session. A 2025-11-25 session gets one per `Mcp-Session-Id`; a 2026-07-28 client gets one per
profile, client process and folder. The id is not the `Mcp-Session-Id` and says nothing about
the agent; a new one is made after mcpd restarts. A value the client sent under the same key is
replaced, and every other `_meta` key (`progressToken` included) passes through unchanged.

A server can use it to tell agent sessions apart on a shared instance and ignore it otherwise.
`turno-browser-mcp` reads it and gives it to its own tools (`session` in their context, for the
per-tab locks to come); its Playwright tools are unaffected.

`POST /refresh/<server>` (or `POST /refresh` for all servers) on the gateway, with the master
token, relists running instances and forgets the cached description of the others, without a
restart. It answers `{"server", "refreshed": [...], "forgotten": [...], "errors": {...}}`.

## Watching the gateway

```sh
turno mcp log                 # the last 20 tool calls: time, outcome, duration, server, tool, profile, agent, sizes
turno mcp log -f --server github --profile work   # follow new calls, filtered
turno mcp log --json -n 500   # one JSON record per line, for jq
turno mcp top                 # memory, sessions, calls in flight, idle time and restarts per running server, and memory pressure
turno mcp savings             # mcpd's memory now against the same sessions without the gateway
```

mcpd appends one JSON line per tool call it relays to `~/.local/state/turno/logs/calls.jsonl`
(mode 600, rotated at 5 MiB, two old files kept):

```json
{"time":"2026-11-16T21:00:00.000Z","agent":"claude-code","profile":"work","pid":4242,"server":"github","variant":"work","tool":"create_issue","durationMs":812,"outcome":"ok","requestBytes":431,"responseBytes":2210}
```

`outcome` is `ok`, `error`, `cancelled` or `timeout`; failed calls add `error`, with anything
that looks like a token replaced by `[redacted]`. A record never holds the call's arguments or
its result, only their sizes. `agent` is the name the client gives in `initialize`. Turn the log
off with `call_log = false` under `[mcpd]` in config.toml (mcpd applies it when the file changes).

`turno mcp top` refreshes every 2 seconds in a terminal and prints one snapshot with `--once`,
`--json` or when piped. The line under its header shows the memory pressure mcpd reads
(`normal`, `warn` or `critical`, and the idle limit servers get while memory is tight; no line
while `idle_under_pressure` is off); `--json` has it as `memoryPressure` (`level`,
`idleUnderPressureSeconds`, `idleCapSeconds`). Memory is the resident size of each server process plus its children
(`npx` and shell wrappers start the real server as a child) and the process groups they lead
(a browser server's Chrome and every helper in its group), read with `ps`, or from `/proc` on
Linux hosts without it (children only).

`turno mcp savings` compares mcpd plus every server it runs now with an estimate of the same
live agent sessions without the gateway: each session would start its own copy of every stdio
server its profile uses, so the estimate is sessions x per-server memory. A server that is not
running now counts with the memory mcpd measured the last time it ran (mcpd samples every 15
seconds while servers run and keeps the numbers in `~/.local/state/turno/mcpd-rss.json`).
Resident memory counts shared pages once per process, so both sides overcount a little in the
same way.

## Plugin servers

Servers that come from Claude Code plugins start in every session and bypass mcpd.
`turno mcp doctor` lists them. To route one through mcpd, disable the plugin and declare
`[server.plugin_<plugin>_<name>]` so tool names stay the same.

## Troubleshooting

```sh
turno mcp daemon status    # running servers, clients, memory; or why mcpd is down
turno mcp daemon logs -n 100  # gateway log, in local time (--utc for the raw lines)
turno mcp log --server <name>  # its recent tool calls, with errors and durations
ls ~/.local/state/turno/logs/   # one stderr log per server (and variant)
turno mcp refresh <name>   # forget a cached tool list; a running mcpd relearns it
turno mcp call <name>      # the tools a profile's session sees, through mcpd
turno run <profile> --no-gateway  # the agent without the gateway, to see whether mcpd is the cause
```

### Calling a tool from the terminal

`turno mcp call` talks to mcpd as an agent session would, so a server can be checked without
opening an agent:

```sh
turno mcp call github                                    # the tools profile sessions here see
turno mcp call github search_issues --arg query=bug --arg limit:=5
turno mcp call fs read_file --args '{"path": "README.md"}' --profile work --json
```

It uses the token of `--profile` (default: the profile the current folder resolves to, else the
`system` one) and sends the current folder, so tool filters, profile variants and `[[projects]]`
server sets apply exactly as they do to an agent here; a hidden server answers with the rule
that hides it. `--args` is a JSON object; `--arg key=value` adds a string and `--arg key:=json`
any JSON value (a number, `true`, a list), on top of `--args`. It prints the text of each content
item (other items as one bracketed line), or with `--json` the whole result with `schemaVersion`.
It exits 1 when the tool returns `isError` or mcpd refuses the call, 5 when mcpd is not running.
The call shows up in `turno mcp log` with the agent `turno-mcp-call`. Remote servers that agents
reach directly (no `keychain:` or `env:` header, no OAuth) do not go through mcpd and cannot be
called this way.

## The daemon as a service

`turno mcp daemon start` keeps mcpd alive with a LaunchAgent on macOS
(`~/Library/LaunchAgents/dev.turno.mcpd.plist`) or a `systemd --user` unit on Linux
(`~/.config/systemd/user/turno-mcpd.service`). `--dry-run` prints the file first; the write is
journaled, so `turno undo` restores it. `turno mcp daemon stop` stops mcpd and removes the
file, so it does not come back at login. `turno upgrade --finish` rewrites the file and restarts
mcpd for the new version.

mcpd listens only on `mcpd.port` (config.toml, default 47821). If something else holds that
port, mcpd does not move: it fails and names the owner, and `turno doctor` says the same. Pick
another port with `turno config set mcpd.port <port>`, then `turno mcp sync`.

mcpd refuses request bodies over 32 MiB. Raise or lower that with
`turno config set mcpd.max_request_body 64MiB` (between 1MiB and 1GiB) and restart mcpd.

If `mcp.toml` stops validating, mcpd keeps serving the last copy that did
(`~/.local/state/turno/mcp.last-good.toml`) and reports the error in `turno mcp daemon status`
and `turno doctor`.

`turno mcp token rotate` replaces the master token, which invalidates every profile token,
restarts mcpd and asks you to run `turno mcp sync`.

`turno doctor --security` checks the rest of the posture: who can read turno's folders (and
narrows them with `--fix`), who holds the mcpd port, literal secrets left in `mcp.toml`, agent
configs and backups, servers that run whatever version is newest, the age of the token and the
audit log's hash chain. See [SECURITY.md](../SECURITY.md#checking-your-setup).
