# turno-browser

**A browser your agents use with your accounts. It stays light on your machine, and the model
never sees your passwords.**

An MCP server that lets a coding agent drive the Chrome installed on your machine (or Brave or
Edge), with one persistent profile per identity. You sign in to a site once, by hand, and the agent works in
that same signed-in browser afterwards.

![Two accounts, each with its own Chrome profile, and a third identity an agent drives through the gateway](https://raw.githubusercontent.com/wimo-dev/turno/main/docs/assets/browser-identities.png)

```sh
npm install --global turno-browser
turno-browser init
```

It runs on macOS, Linux and Windows 10 and 11 (x64).

`init` asks a name for the identity, opens Chrome so you sign in by hand once, and gives the
identity to your agent. Each step is also a command of its own: `turno-browser add`, `login` and
`setup`. With `--identity`, `--agent` and `--yes` it runs without a terminal, and `--json` prints
one report of what it did. On a machine with no Chromium-based browser,
`turno-browser install-browser` downloads Chrome for Testing into your user cache, with no admin
rights.

No Node on the machine? Each [GitHub release](https://github.com/wimo-dev/turno/releases) of
turno-browser also has a standalone executable for macOS (Apple silicon and Intel) and Linux, with
`SHA256SUMS` and build provenance attestations; a Windows one is experimental.
[Install without Node](https://turno.wimo.dev/docs/browser/get-started#install-without-node) has
the steps.

The docs are at [turno.wimo.dev/docs/browser](https://turno.wimo.dev/docs/browser), starting with
[Get started](https://turno.wimo.dev/docs/browser/get-started).

## Why

- **Your agent opens a browser that is not signed in.** Here each identity is a real Chrome
  profile that keeps its cookies, so the agent starts where you left off.
- **A browser left open eats the machine.** Tabs are capped, parked and closed, Chrome closes
  when nobody is using it, and it closes with the agent that started it.
- **Passwords should not pass through a model.** A vault in the OS secret store fills a sign-in
  form without the agent ever seeing the values.

It has no account, no server of its own and no telemetry.
[What leaves your machine](https://turno.wimo.dev/docs/browser/what-leaves-your-machine) lists
every way data can go out: some turn on by themselves when something is there to answer them, and
the rest stay off until you turn them on or run them.

## Where it sits

A driver moves the browser. turno-browser is the layer above it: it decides which browser that
is, whose session it carries, how long it stays open and what the model gets to see. It serves
the Playwright MCP tools and flags (`browser_navigate`, `browser_click`, `browser_snapshot` and
the rest) on your own Chrome, headed by default. It sits next to tools like browser-use,
Stagehand and Browserbase; [Browser tools compared](https://turno.wimo.dev/docs/browser/alternatives)
says when each one is the better choice.

## What you get

On from the start. The rows that are settings are worked out at every launch, never written into
`identity.json`, and each one is yours to turn off; `turno-browser show <id>` lists each value
and where it came from:

| | |
|---|---|
| [Identities](https://turno.wimo.dev/docs/browser/identities) | one Chrome profile per identity, with its time zone, languages and locale fixed |
| [Tab limits](https://turno.wimo.dev/docs/browser/tabs) | at most 8 pages, parked after 5 minutes unused, closed after 15; Chrome closes after 15 minutes without a call. `--resources low` is a tighter preset for a machine short of memory |
| [Credential vault](https://turno.wimo.dev/docs/browser/vault) | `browser_login` fills username, password and one-time code; the agent never sees them, and a password field never comes back to it, whoever typed it |
| [Session export and import](https://turno.wimo.dev/docs/browser/moving-a-session) | an identity's session as one encrypted file, for another machine |
| [Compact snapshots](https://turno.wimo.dev/docs/browser/actions#snapshots) | every element the agent acts on and the text a reader needs, the rest left out (Hacker News: 12,238 to 3,786 tokens); a very long page comes back as a table of contents that `browser_read` reads by part, and an action that stays on the page answers with what changed |
| [`browser_batch`](https://turno.wimo.dev/docs/browser/actions) | up to 20 actions in one call, a check after each one, and errors with a stable code that say what is in the way |
| [Faster actions](https://turno.wimo.dev/docs/browser/actions#actions) | the wait after a click, key press or typed text ends when the page is done with it: a click went from 860 ms to 413 ms at the median on the local evaluation suite |
| [Flows](https://turno.wimo.dev/docs/browser/flows) | save what an agent did on a site once, and replay it with parameters; each step checks that it acts on the same element |
| [From the shell](https://turno.wimo.dev/docs/browser/actions#from-the-shell) | `turno-browser do <id> open`, `snapshot`, `click`, `type`, `read`: the same browser and rules, as shell commands |
| [Steps only you may do](https://turno.wimo.dev/docs/browser/live-view#when-the-agent-asks-for-you) | `browser_request_human` brings the tab to you with a banner for a password, a captcha, a code or consent; the agent waits, and never gets what you typed. A passkey request hands you the browser by itself |
| [The last click is yours](https://turno.wimo.dev/docs/browser/live-view#the-last-click-is-yours) | the agent does not click a button that places an order, pays, sends, publishes or confirms a deletion: it asks you, and the banner says what the click does (`--last-click false` lets it click) |
| [Notifications](https://turno.wimo.dev/docs/browser/live-view#notifications) | a system notification when the agent waits for you, and when it is done after a long run (`--notify false` turns them off) |
| [Live view and take-over](https://turno.wimo.dev/docs/browser/live-view) | `turno-browser live <id>` opens a panel on 127.0.0.1: the agent's tab next to a timeline of its steps. Click or type on it, or in the agent's Chrome, and the agent waits; the browser goes back to it 5 seconds after your last input, and it is told what changed |
| [Several agents, one browser](https://turno.wimo.dev/docs/browser/sharing) | several agent sessions in one identity's Chrome, each in its own tabs (`--sharing session` for one at a time) |
| [Recordings](https://turno.wimo.dev/docs/browser/flows#recordings-and-traces) | every session as a flow and a screenshot per action, under a 200MB cap and never of a page with a vault value |
| [Human-like input](https://turno.wimo.dev/docs/browser/actions#human-like-input) | the pointer moves along a curve and text is typed key by key; by default the level follows the page |
| [Cookies and storage](https://turno.wimo.dev/docs/browser/vault#cookies-and-stored-tokens) | the `storage` tools, with the values that keep you signed in read as `[masked]` |
| [The agent cursor](https://turno.wimo.dev/docs/browser/agent-cursor) | when you can see the browser, Chrome itself highlights the element the agent acts on and shows its clicks, with nothing in the page; `cursor: on` draws a named cursor and a badge in the page |
| [Health, reputation and doctor](https://turno.wimo.dev/docs/browser/identities#session-health) | a signed-out identity says so, each site's challenges are counted, `status` shows each identity at a glance (who holds it, its vault's sites, the agents that have it) and `doctor` checks Chrome and every identity |

On when something is there to answer them:

| | |
|---|---|
| [Natural language actions](https://turno.wimo.dev/docs/browser/natural-language-and-captchas#natural-language-actions) | `browser_act`, `browser_extract` and `browser_observe`, with no setup: the first that works of your client's model (MCP sampling), `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the environment, and the Claude Code CLI or Codex on the PATH with your own login |
| [Captcha solving](https://turno.wimo.dev/docs/browser/natural-language-and-captchas#captcha-solving) | `browser_solve_captcha`, through a solver service, when a solver key is configured in `identity.json` or the environment; without one, the captcha goes to you |

Off until you turn it on, per identity:

| | |
|---|---|
| [Identity policy](https://turno.wimo.dev/docs/browser/policy) | the domains an identity's tabs may show and the features that are off for good; only the command line writes it |
| [Traces](https://turno.wimo.dev/docs/browser/flows#recordings-and-traces) | a Playwright trace of each browser session (while tracing, Chrome loads no image or frame of another site) |
| [Blocking and cache](https://turno.wimo.dev/docs/browser/network#blocking-and-the-resource-cache) | block trackers, images, media or fonts; cache static resources on disk |
| [Proxy](https://turno.wimo.dev/docs/browser/network#network-and-user-agent) | a proxy of the identity's own, with its password in the secret store, and a check of where it exits. Without one, Chrome follows the system's proxy and `show` names it; a headless Chrome gets a user agent built from your installed Chrome, once `login` has read its client hints |
| [Engines](https://turno.wimo.dev/docs/browser/engines) | read mode on Lightpanda for reading pages with little memory, attach to the Chrome you have open, or Camoufox |

## On its own, or with turno

**On its own.** turno-browser is its own package: it does not need turno. `turno-browser setup
<agent>` prints the config for Claude Code, Codex, Cursor, Copilot or Gemini (or a generic JSON
entry), and writes nothing. The agent then runs `turno-browser-mcp --identity <id>` when it needs
the browser. From a terminal, `turno-browser do` reaches the same browser through a background
server it starts on demand:

```sh
turno-browser do school open https://example.com
turno-browser do school snapshot
turno-browser background stop school
```

**With [turno](https://www.npmjs.com/package/turno-cli).** turno's gateway runs one browser
server for every session of every agent and stops it when nobody uses it. `turno browser
<command>` and `turno identity ... browser:<id>` run the same commands and add what turno has,
like the `mcp.toml` block. See the guide
[Let an agent use my signed-in browser](https://turno.wimo.dev/docs/guides/signed-in-browser).

`turno-browser --help` lists every command by section, and the
[reference](https://turno.wimo.dev/docs/browser/reference/cli) has the help of each one.

## Identities

Each identity keeps, next to its profile, an `identity.json` with what should not change between
sessions: time zone, languages, locale, region, and an optional session health check.

```sh
turno-browser add school --languages es-MX,es,en
turno-browser set school --health-url https://mail.example.com/ --health-text Inbox
turno-browser show school
```

The settings are applied at every Chrome start, and one Chrome runs per identity: a second
server gets a message that names the process holding it. With a health check, a signed-out
identity is marked `NEEDS_AUTH` and tool calls ask for `turno-browser login <id>` instead of
failing on a login page.

With a Spanish locale (`es`, `es-MX`, `es-419`), what a person sees in the browser comes in
Spanish: the live view, the banner of a step that is yours and the welcome page of `login`.
`turno-browser remove <id>` shows what goes and asks before it deletes, and takes the identity
out of each agent that has it.

## Credential vault

An identity can keep a username, a password and a TOTP secret per site in the OS secret store
(macOS Keychain, Linux Secret Service, or files encrypted with DPAPI for your user on Windows),
never as plain text. The `browser_login` tool fills them
into that site's sign-in page:

```sh
turno-browser vault add school mail --url https://mail.example.com/login --username alice --totp
turno-browser vault list school
```

- **Bound to the site.** The tool fills only when the page is on an origin given with `--url`,
  and only into frames of those origins.
- **Never in a result.** Once a value was filled, every result and error shows `[vault: ...]`
  in its place: snapshots, network requests and console messages.
- **Password fields too.** A password or a one-time code never comes back to the agent,
  whoever typed it: a snapshot shows `[sensitive field]`, and `browser_type` refuses those
  fields. Network results keep the names of credentials (Authorization and Cookie headers,
  token, session and password fields) and show `[redacted]` for their values.
- **It submits.** The tool submits the filled form and the result says so, without the values;
  `turno-browser vault submit school confirm` makes it stop after filling, so the agent clicks
  the sign-in button.

The threat model is in
[SECURITY.md](https://github.com/wimo-dev/turno/blob/main/SECURITY.md#the-credential-vault).

## A browser that cleans up

| What | Default |
|---|---|
| Pages open per session's browser | at most 8; past that the least recently used closes, never the agent's current tab |
| Popups that open while no tool call runs | closed; a window the agent's own click opened stays |
| A page unused for 5 minutes | parked on `about:blank`; it loads again when the agent uses it |
| A page unused for 15 minutes | closed |
| Chrome with no tool call for 15 minutes | closed; the next call opens it with the same profile |

```sh
turno-browser set school --tabs-max 4 --tabs-popups keep --tabs-park 2m --tabs-close 0
```

What was closed or parked is listed at the end of the next tool result. When the agent that
started it exits, Chrome closes too.

## Move a session

```sh
# asks for a passphrase twice
turno-browser export school --out school.session --expires 2d
turno-browser import school.session --as school-laptop
```

The file holds the identity's cookies, localStorage and IndexedDB, encrypted with the passphrase
(scrypt and AES-256-GCM), and is refused after its expiry (7 days by default, at most 90). It
never holds vault credentials.

## Acceptable use

Use it with your own accounts, on sites whose terms allow automated access by you, and at a
human pace. Do not use it to get around access controls, paywalls or rate limits, to scrape at
scale, or to access accounts that are not yours. Captcha solving runs only with a solver key you
configure, and then it is for your own accounts only. You are responsible for how you use it. The software is provided "as is", without warranty (Apache License 2.0).

## License

Apache-2.0. Patchright and Playwright are Apache-2.0 and install as regular npm dependencies.
