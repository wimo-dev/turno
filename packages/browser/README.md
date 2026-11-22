# turno-browser

**A browser your agents use with your accounts. It stays light on your machine, and the model
never sees your passwords.**

An MCP server that lets a coding agent drive the Google Chrome installed on your machine, with
one persistent profile per identity. You sign in to a site once, by hand, and the agent works in
that same signed-in browser afterwards.

![Two accounts, each with its own Chrome profile, and a third identity an agent drives through the gateway](https://raw.githubusercontent.com/wimo-dev/turno/main/docs/assets/browser-identities.png)

```sh
npm install --global turno-browser
turno-browser init
```

`init` asks a name for the identity, opens Chrome so you sign in by hand once, and gives the
identity to your agent. Each step is also a command of its own: `turno-browser add`, `login` and
`setup`.

The docs are at [turno.wimo.dev/docs/browser](https://turno.wimo.dev/docs/browser), starting with
[Get started](https://turno.wimo.dev/docs/browser/get-started).

## Why

- **Your agent opens a browser that is not signed in.** Here each identity is a real Chrome
  profile that keeps its cookies, so the agent starts where you left off.
- **A browser left open eats the machine.** Tabs are capped, parked and closed, Chrome closes
  when nobody is using it, and it closes with the agent that started it.
- **Passwords should not pass through a model.** A vault in the OS secret store fills a sign-in
  form without the agent ever seeing the values.

## Where it sits

A driver moves the browser. turno-browser is the layer above it: it decides which browser that
is, whose session it carries, how long it stays open and what the model gets to see. It serves
the Playwright MCP tools and flags (`browser_navigate`, `browser_click`, `browser_snapshot` and
the rest) on your own Chrome, headed by default. It sits next to tools like browser-use,
Stagehand and Browserbase; [Browser tools compared](https://turno.wimo.dev/docs/browser/alternatives)
says when each one is the better choice.

## What you get

On from the start:

| | |
|---|---|
| [Identities](https://turno.wimo.dev/docs/browser/identities) | one Chrome profile per identity, with its time zone, languages and locale fixed |
| [Tab limits](https://turno.wimo.dev/docs/browser/tabs) | at most 8 pages, parked after 5 minutes unused, closed after 15; Chrome closes after 15 minutes without a call |
| [Credential vault](https://turno.wimo.dev/docs/browser/vault) | `browser_login` fills username, password and one-time code; the agent never sees them, and a password field never comes back to it, whoever typed it |
| [Session export and import](https://turno.wimo.dev/docs/browser/moving-a-session) | an identity's session as one encrypted file, for another machine |
| [`browser_batch`](https://turno.wimo.dev/docs/browser/actions) | up to 20 actions in one call, and errors that say what is in the way |
| [Flows](https://turno.wimo.dev/docs/browser/flows) | save what an agent did on a site once, and replay it with parameters |
| [From the shell](https://turno.wimo.dev/docs/browser/actions#from-the-shell) | `turno-browser do <id> open`, `snapshot`, `click`, `type`, `read`: the same browser and rules, as shell commands |
| [The agent cursor](https://turno.wimo.dev/docs/browser/agent-cursor) | when you can see the browser, a named cursor and a badge show where the agent is working; the model never sees it |
| [Health, reputation and doctor](https://turno.wimo.dev/docs/browser/identities#session-health) | a signed-out identity says so, each site's challenges are counted, and `doctor` checks Chrome and every identity |

Off until you turn it on, per identity:

| | |
|---|---|
| [Several agents, one browser](https://turno.wimo.dev/docs/browser/sharing) | several agent sessions in one identity's Chrome, each in its own tabs |
| [Live view and take-over](https://turno.wimo.dev/docs/browser/live-view) | watch the agent's tab on 127.0.0.1, pause it, act, and resume; the agent is told what changed |
| [Recordings and traces](https://turno.wimo.dev/docs/browser/flows#recordings-and-traces) | every session as a flow, a Playwright trace and a screenshot per action |
| [Human-like input](https://turno.wimo.dev/docs/browser/actions#human-like-input) | the pointer moves along a curve and text is typed key by key |
| [Blocking and cache](https://turno.wimo.dev/docs/browser/network#blocking-and-the-resource-cache) | block trackers, images, media or fonts; cache static resources on disk |
| [User agent and proxy](https://turno.wimo.dev/docs/browser/network#network-and-user-agent) | a user agent built from your installed Chrome, and a proxy with its password in the secret store |
| [Engines](https://turno.wimo.dev/docs/browser/engines) | read mode on Lightpanda for reading pages with little memory, attach to the Chrome you have open, or Camoufox |
| [Natural language actions](https://turno.wimo.dev/docs/browser/natural-language-and-captchas#natural-language-actions) | `browser_act`, `browser_extract` and `browser_observe`, on a model you pick |
| [Captcha solving](https://turno.wimo.dev/docs/browser/natural-language-and-captchas#captcha-solving) | `browser_solve_captcha`, through a solver service you configure |

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
[reference](https://turno.wimo.dev/docs/reference/turno-browser) has the help of each one.

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

## Credential vault

An identity can keep a username, a password and a TOTP secret per site in the OS secret store
(macOS Keychain, Linux Secret Service), never in a file. The `browser_login` tool fills them
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
  fields.
- **It does not submit.** The agent clicks the sign-in button, unless you run
  `turno-browser vault submit school auto`.

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
scale, or to access accounts that are not yours. Captcha solving is off unless you turn it on, and
then it is for your own accounts only. You are responsible for how you use it. The software is provided "as is", without warranty (Apache License 2.0).

## License

Apache-2.0. Patchright and Playwright are Apache-2.0 and install as regular npm dependencies.
