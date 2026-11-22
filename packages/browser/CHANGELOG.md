# turno-browser

## 0.8.0

### Minor Changes

- b94a272: New tool `browser_request_human`: the agent hands the browser to the person for a step only they may do (a password, a captcha, an emailed code, a second factor, accepting terms). The tab comes to the front with a banner that shows the instruction and a Done button, and a ring around the target; every call of every session waits until the step ends on a URL, a selector, Done or the timeout (5 minutes by default, 10 at most). The result says what changed and how many clicks and fields the person made, never what they typed. It works with a Chrome window, or with the live view open on a headless Chrome.

### Patch Changes

- 298c744: The agent cursor follows the pointer path with humanize on, counts the other busy sessions on the badge with shared tabs, keeps the typing bubble up long enough to see, and keeps its label inside the page. Each session's cursor is named after its own agent ("Claude Code", "Codex", "Cursor", "Copilot", "Gemini CLI") instead of the raw client name or the name of the first one: mcpd sends the client's name with each call (`io.turno/client` in `_meta`), and a shared host uses each connection's own.
- ce785fd: A password or one-time code never reaches the agent, whoever typed it: every page snapshot (also the snapshot files an action writes to the workspace) shows its value as `[sensitive field]`, and the value is hidden from every later result. `browser_type`, `browser_fill_form` and key presses into a password or one-time code field are refused with an error that says to ask the person (`browser_request_human`) or to use `browser_login`; a flow replay types one only from the secret store (`keychain:<item>`) or from the hidden prompt of `turno browser replay`, which names those parameters for the server it starts in `TURNO_BROWSER_PROMPTED_PARAMS` (listed in `turno help environment`). `browser_network_requests` and `browser_network_request` keep the names of credentials and show `[redacted]` for their values (Authorization, Cookie and Set-Cookie headers, token, code, session, key, secret and password fields), also in a file saved with `filename`. A tool result that ends on a captcha, "verify it's you" or block page says so and suggests that the person handles it.
- 3a8e4b3: `turno-browser set --help` describes `--engine camoufox` by what it needs and what it lacks, without a "not recommended" label, like the other opt-in settings.
- 70e2adc: `turno-browser init --agent json` ends with "start a new session of your MCP client" instead of "start a new any MCP client session".

## 0.7.0

### Minor Changes

- 69f67a1: The agent cursor: when someone can see the browser (a Chrome window, or the live view), each page shows that an agent is at work and where. A Figma-like arrow with the agent's name and the identity glides to each element it acts on, a ring marks the element, a click leaves a ripple, a field being typed into gets a typing bubble, and a thin frame with a badge ("turno · Claude Code at work", or "paused · you have the controls" while the live view's pause is on) goes around the page while calls run. Several agent sessions on one identity's Chrome each get a cursor and a color of their own, and with humanize on the arrow follows the real pointer path.
  
  It is drawn in a closed shadow root that is out of the accessibility tree, out of the page's text and never a click target, and it is hidden while the model's screenshot is taken, so the model sees the page as before. `turno-browser set <id> --cursor auto|on|off` (identity.json `cursor`, format 12) and `turno-browser-mcp --cursor` choose it: `auto` (the default) draws it when the browser can be seen, and `off` leaves pages exactly as they are.
- 0c723fc: `turno-browser init` sets turno-browser up step by step: it names and creates an identity (or
  uses one that is there), opens Chrome to sign in by hand on a first site, finds the agents
  installed here and runs the agent's `mcp add` command only on a yes. Without a terminal it needs
  `--identity` and `--agent`, skips the sign-in and prints the command instead. `turno-browser`
  with no command now points to it.
  
  The first steps say more of what happened:
  
  - `login` opens a page that says what to do instead of a blank tab, and on close names the sites
    that were opened, or says that nothing new was signed in.
  - `show` has a "last sign-in" line, local times and a hint to turn on the health check;
    `doctor` says when an identity was never signed in by hand.
  - `list`, `show` and `doctor` say "not in use" instead of "free".
  - `do <id> end` says that Chrome stays open in the background server and how to close it now.
  - `do` errors no longer start with "Error: Error:", and a stale ref or text where a ref goes gets
    a hint (`snapshot`, `find`).
  - `setup claude` suggests `claude-code`.
  - `add` prints its next steps with each explanation on its own line, so the commands paste into
    zsh as they are.

## 0.6.0

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
- Updated dependencies [cd53ee9]
- Updated dependencies [cd53ee9]
  - turno-core@0.3.0

## 0.5.0

### Minor Changes

- 44fb809: `turno-browser-mcp --identity <id> --background` serves an identity to the shell without turno: MCP over streamable HTTP on a Unix socket in a private folder of the identity's state (or 127.0.0.1 with a per-server token where a socket cannot be used), one Chrome shared by every connection with the identity's sharing rules, and an exit after 15 minutes without a request (`--background-idle`, `TURNO_BROWSER_BACKGROUND_IDLE`). While it runs it alone drives the identity's browser: a stdio server of the same identity refuses calls that need the browser with a message that names it, and it does not start while another process has the identity's Chrome open. The package exports a client for it (`startBackground`, `backgroundStatus`, `openBackgroundSession`, `stopBackground`), also in the typed api, now version 1.11. turno-cli now asks for turno-browser 1.11 or a later 1.x.
- df52afc: turno-browser has its own `turno-browser` command: add, list, show, set, login, vault, export, import, flows, replay, record, traces, live, pause, resume, doctor and reputation work without turno, with `--version` and a help grouped by section. `turno-browser add` prints how to connect an agent instead of an `mcp.toml` block, and `turno-browser do` says it needs turno for now. `turno browser ...` and the browser part of `turno identity ...` now run turno-browser's commands through its typed api (API_VERSION 1.12, new member `cli`) with the same flags, output and exit codes, so turno-cli needs turno-browser 1.12 or a later 1.x. turno-core gains `turno-core/cli`, the command line toolkit (arguments, output, styles, exit codes, command groups, hints, hidden input) that both programs share.
- e2b1779: `turno-browser do` works without turno: it starts the identity's background server on the first action, keeps one session per agent or shell between commands, and ends it with `end`, `close` or when that process exits. `turno browser do` keeps going through mcpd.
  
  New `turno-browser` commands: `setup <claude-code|codex|cursor|copilot|gemini|json> [--identity <id>]` prints the MCP config that gives an agent an identity (it writes nothing; `--json` for scripts), `background status|start|stop` shows and controls the background servers, and `secret set|has|list|remove` stores the `keychain:<item>` secrets identity.json names, in the same store and items as `turno secret`.
  
  Hints, errors and doctor fixes name the commands of the program you typed: `turno-browser ...` on its own (the MCP server's messages too), `turno browser ...` and `turno identity ... browser:<id>` inside turno. `turno-browser doctor` lists a running background server, and a stdio server refused by a background server names `turno-browser background stop <id>`.
  
  turno-core exports the owner, name and lock of a shell session of browser commands (`turno-core/cli`), shared by `turno browser do` and `turno-browser do`.
  
  The npm description, keywords and MCP Registry entry follow the new tagline. Wording: the help no longer labels the off-by-default settings (natural language actions, captcha solving, network and user agent, Camoufox) as "not recommended"; they stay off by default and the help still says what each one sends where.

### Patch Changes

- d97dbec: Human-like input no longer falls back to a plain fill or click on a busy machine: the steps before
  an action (reading the field, aiming at the element) now wait up to 3 seconds for it instead of 1.
- Updated dependencies [df52afc]
- Updated dependencies [e2b1779]
  - turno-core@0.2.0

## 0.4.0

### Minor Changes

- 50facc9: Record and replay. `browser_record` saves an agent's actions on an identity as a named flow, each
  element kept four ways (Playwright's locator, role and name, text, CSS path) and typed text as
  parameters; passwords, one-time codes and values marked sensitive are never saved, and a vault
  sign-in is kept as `browser_login` with the site name. `browser_replay` runs a flow with
  parameters (`keychain:<item>` reads one from the secret store) and, when a step no longer fits,
  stops with a report the agent can continue from; `browser_flows` lists them. Opt-in per identity
  (`record` in identity.json, `turno browser record <id>`): every session as a flow, Playwright
  traces and a screenshot per action under a size cap, with the trace stopped around sign-ins.
  New commands `turno browser flows|replay|record|traces`; `traces --open` uses the trace viewer
  bundled with patchright-core.
  With `"sharing": "tabs"` a recording holds only the session that started it and replay runs in
  that session's tabs; traces and screenshots are refused in attach mode and in read mode.
- e94a153: Natural language actions and captcha solving for browser identities, both not recommended and off by default.
  
  - `turno identity set browser:<id> --act` lists `browser_act` (an instruction carried out one stock browser action at a time, every step shown), `browser_extract` (data off the page as JSON) and `browser_observe` (proposed calls, not run). The model is your client's, through MCP sampling, or a chat completions API you name with `--act-provider chat-completions --act-endpoint <url> --act-model <name> --act-key keychain:<item>`. The model sees the instruction and a snapshot of the current tab with vault values and password, one-time code and card fields hidden; it can only click, type, select, press keys, hover, drag, wait and go back on that tab; steps, tokens and time are capped per call (`--act-max-steps`, `--act-max-tokens`, `--act-timeout`). A recorded flow keeps the stock steps it chose, never the instruction or the page.
  - `--captcha-provider task-api --captcha-endpoint <url> --captcha-key keychain:<item>` lists `browser_solve_captcha`, which sends a reCAPTCHA v2, hCaptcha or Turnstile widget and the page address to that solver service and puts the token into the page. The service sees the page, and solving a site's captchas by machine may break its terms: it is meant for your own accounts. Every attempt is a line in the identity's reputation log, and `turno browser reputation` shows a `solved` column once a solver answered. Read mode refuses it.
  - Keys are only `keychain:` references read from the secret store at use time, refused as literal values without being echoed, and hidden from every result.
  - identity.json format 8 (`act`, `captcha`); turno-browser API 1.7, which turno-cli now requires.
- dcc2b97: Two opt-in engines for browser identities and servers, both off by default.
  
  Read mode runs an identity (or one server) on Lightpanda instead of Chrome, for reading pages
  with a fraction of the memory: `turno browser set <id> --engine lightpanda`, or
  `turno-browser-mcp --engine lightpanda`. turno never downloads Lightpanda; it runs the
  `lightpanda` on your PATH (or at `TURNO_LIGHTPANDA_PATH`), on a private Unix socket with
  Lightpanda's telemetry off. The tools that work there run; the others (screenshots, dialogs,
  drag and drop, uploads, `browser_login`) are refused with the reason before they reach the
  browser. An identity in read mode keeps its own cookie jar, apart from its Chrome profile.
  
  Attach mode connects to the Chrome you already have open, so the agent works in your signed-in
  browser: `turno browser set <id> --attach auto` (after you turn on remote debugging at
  chrome://inspect/#remote-debugging, Chrome 144 or newer), a Chrome user data folder, or a
  loopback endpoint; `turno-browser-mcp --attach <target>` for one server. Chrome asks you to allow
  each connection. turno works in a tab of its own, closes only the tabs it opened (on
  `browser_close`, at the end of the session and at the idle limit) and never closes Chrome; the
  tab governor leaves your tabs alone, and `browser_run_code_unsafe` is refused.
  
  `turno browser doctor` gains an Engines section (Lightpanda found or how to install it, a
  Lightpanda left running, which `--fix` stops) and checks each identity's attach target without
  connecting. identity.json is now format 6 (`engine`, `attach`), and the turno-browser API is 1.5.
  
  Read mode works with `"sharing": "tabs"`. Two pairs are refused with the reason, in identity.json
  and from server flags: attach mode with `"sharing": "tabs"` (turno keeps one agent's tabs apart
  from yours in your Chrome, not several sessions apart), and read mode with `humanize` (Lightpanda
  lays out no page, so there is no pointer path to play). Attach mode works with `humanize`.
- 4814fb8: Human-like input for browser identities, off by default. `turno identity set browser:<id> --humanize light|full|adaptive` (or `turno-browser-mcp --humanize <level>`, which wins) makes the stock click, hover, type, fill form, select, drag, press key and coordinate tools, and `browser_batch`, move the pointer along a curve from where it last was to a point inside the target, hold the button for tens of milliseconds and type short text key by key with per-key delays. `full` adds a move time that follows distance and target size, overshoot and correction, a reading pause on a new page, longer gaps between words and wheel scrolling; `adaptive` is `light`, and `full` on a site where the identity met a challenge page. Tool names, arguments and results do not change. The setting is the `humanize` key of identity.json (format 4, with an optional `seed`), and turno-cli needs turno-browser API 1.3 for it.
- 6698608: Live view and take-over for browser identities, off by default. `turno browser set <id> --live true` (or `turno-browser-mcp --live`) serves a view of the agent's tab on 127.0.0.1 with a per-server token; `turno browser live <id>` opens it through a link that works once and is never printed. `turno browser pause <id>` (or Pause in the view) holds the agent's next call, up to `live.wait` (2 minutes by default), while you act in the window or through the view; `turno browser resume <id>` lets it go, and each held call is told what changed (URL, title, tabs, your input) and a call that would act on stale refs is not run: it returns an error with a fresh snapshot. The natural language and captcha tools are held too, and a `browser_act` run stops at its next step. A page that holds a vault value or a password is never shown, including a sign-in typed key by key with humanize. Read mode and attach mode refuse the view and keep pause and resume. turno-browser API 1.9, identity.json format 10.
- c716051: Opt-in network and user agent settings, and a Camoufox engine, all off by default and not
  recommended for your own accounts. identity.json format 11 adds `userAgent` and `proxy`, and the
  `engine` key takes `"camoufox"` (also format 11); API_VERSION is 1.10 and turno-cli needs it.
  `"userAgent": "coherent"` takes no typed value: a headless Chrome gets the user agent a headed one
  of the same version sends, with its real client hints metadata, and a launch check refuses any
  contradiction between the user agent, client hints, platform, headers, languages and time zone.
  `proxy` sends the identity's traffic (sign-ins included) through an http, https or SOCKS proxy,
  with its password only from the secret store, hidden from every tool result, and WebRTC limited
  to the proxy. `--engine camoufox` runs an identity on an installed Camoufox through stock
  playwright-core, with its own Firefox profile; turno never downloads it, and every stock tool but
  `browser_run_code_unsafe` runs, as do natural language actions, `browser_login` and
  `turno browser do`. Captcha solving is refused with it, and the live view shows no picture there
  (pause and resume work). The act model's prompt and the live view's tab list hide the proxy
  credentials. New flags on `turno identity set` (`--user-agent`,
  `--proxy-server`, `--proxy-username`, `--proxy-password`, `--no-proxy`), doctor checks for
  Camoufox and the proxy credentials, and fingerprint bench checks that compare headers and a
  worker with the page.
- 4b9556f: Several agent sessions can now share one browser identity, each in its own tabs. Turn it on per identity with `"sharing": "tabs"` in identity.json (`turno identity set browser:<id> --sharing tabs`, or the server's `--sharing tabs`) and serve the identity with `exclusive = false` in mcp.toml; the default stays one session at a time. Each session gets its own current tab and holds the tabs it works on: another session's call on one of them waits up to 10 seconds and then fails with a message that names the holder. A session lets go of its tabs when it ends (mcpd now tells servers that declare the `io.turno/sessions` capability), when a tab closes, or after 5 minutes without a call. `browser_close` closes only the calling session's tabs, tab lists mark the tabs other sessions hold, and the tab governor's cap counts each session's tabs apart. `turno identity add browser:<id> --sharing tabs` prints the matching mcp.toml block. turno-browser's API version is now 1.4.
- 3bd7bc2: Follow-ups for browser identities.
  
  A tool call no longer starts while the tab governor is still closing a popup or a parked tab, so
  the call cannot fail with "Target page, context or browser has been closed". A Chrome that does
  not stop after SIGKILL gets 5 seconds instead of 2 before turno calls it a survivor.
  
  A server in read mode stops a Lightpanda that a killed server left running on the same cookie jar
  when it starts, and removes its socket folder.
  
  `turno browser doctor` warns when an identity that serves one session at a time
  (`"sharing": "session"`) is served by an mcp.toml server with `exclusive = false`, and says how to
  switch it to `"sharing": "tabs"`.
  
  The tab lock wait (10 seconds) and the idle release (5 minutes) of `"sharing": "tabs"` can be set
  per identity: `"tabLocks": { "wait": "30s", "release": "10m" }` in identity.json, or
  `turno browser set <id> --tab-lock-wait 30s --tab-lock-release 10m`. identity.json is now format
  9 and the turno-browser API is 1.8.
  
  The `light` humanize level moves the pointer on a visible arc (some 4 to 8% longer than the
  straight line) instead of an almost straight path. With humanize on, `browser_login` clicks into
  each field and types the value key by key; the keys go to Chrome only, never to a result, a
  recording or a log.
  
  When another element covers the target of a click, hover, type, select or drag before the call,
  and still covers it 300 ms later, the error names that element at once instead of after the 5
  second action timeout.
  
  Chrome keeps its third-party storage partitioning on, as a person's Chrome does: Playwright turns
  it off, and turno now passes Playwright's list of disabled features without it.

## 0.3.0

### Minor Changes

- e806948: `browser_batch`, useful action errors and the settle setting:
  
  - New tool `browser_batch`: runs up to 20 stock browser actions in order in one call, checks
    every action's arguments before running any, stops at the first failure, and returns one line
    per action and one snapshot at the end only when `snapshot` is true.
  - A `browser_click`, `browser_hover`, `browser_type`, `browser_select_option` or `browser_drag`
    that times out because of the element now says which element covers the target (role, name,
    a short selector and its buttons), or that the target is hidden (and by what), disabled,
    read-only or gone, and suggests the next step. Tool names and schemas are unchanged.
  - identity.json `settle` (like `"100ms"`) sets the wait after each action, Playwright's 500 ms
    by default; `--timeout-settle` still wins. In a local benchmark of 8 calls it cut the wall
    time of a form fill from about 1.8 s to 0.6 s.
- cc6b5b2: Browser identity module:
  
  - `identity.json` next to each identity's profile keeps its time zone, languages, locale and
    region fixed; Chrome gets them at every start (`--accept-lang`, `--lang`, and the time zone
    when it differs from the machine's). `turno identity add browser:<id>` pins a new identity to
    the current time zone and takes `--timezone`, `--locale`, `--languages`, `--region` and a
    health check; `turno identity show` and `turno identity set` read and change it
    (`turno browser show/set <id>` too). Without the file nothing changes.
  - A runtime lock (`{ nodePid, chromePid, pgid, startedAt }`) while an identity's Chrome runs: a
    second session gets a message naming the process and how to stop it instead of "Browser is
    already in use".
  - An optional session health check (a URL and a text or selector) marks a signed-out identity
    NEEDS_AUTH; tool calls then fail with a message that asks for `turno browser login <id>`.
  - Each captcha, "verify it's you" or block page an identity meets is logged per site (host name
    only); `turno browser reputation [<id>] [--json]` shows counts and trend.
  - `turno browser doctor [--fix] [--no-launch] [--json]`: Chrome and its version, a smoke launch,
    the desktop session, and per identity its settings, lock, sign-in and recent challenges, with
    a fix for each problem.
  - mcpd: `stop_grace` per server in `mcp.toml`, the wait between closing stdin and SIGTERM;
    5 seconds by default for turno-browser-mcp, the SDK's 2 seconds for every other server.
- 7779c38: Opt-in resource blocking and resource cache per identity, both off by default:
  
  - identity.json `block`: `trackers` (a built-in list of ad and analytics hosts), `types`
    (`image`, `media`, `font`) and `patterns` (host names or URL globs). The page itself is never
    blocked.
  - identity.json `cache`: keeps images, fonts, stylesheets and scripts on disk for that identity
    only (`maxSize`, default 100MB, least recently used first), following `Cache-Control`, never
    storing a response with `Set-Cookie` or a request with `Authorization`. Misses still go out
    through Chrome; hits are served from disk.
- 59309b5: `turno browser export <id> --out <file>` and `turno browser import <file> [--as <id>]` move an
  identity's cookies, localStorage and IndexedDB as one file encrypted with a passphrase (scrypt
  and AES-256-GCM), refused after its expiry and never holding vault credentials.
  `"keychain": "system"` in identity.json makes Chrome encrypt an identity's cookies with the OS
  keychain instead of Playwright's fixed mock key; the default is unchanged.
  turno-browser's API is now 1.2, which this turno requires.
- 85d9bff: Tab governor:
  
  - At most 8 pages stay open per session's browser; past that the least recently used one
    closes (never the agent's current tab). Popups that open while no tool call runs, such as a
    pop-under a page opens seconds after a click, are closed; a window the agent's own click opened
    stays.
  - A page unused for 5 minutes is parked on about:blank and stops running; the next call that uses
    it loads its page again. After 15 minutes unused it closes. The next tool result lists what was
    closed or parked, and tab lists mark parked tabs.
  - identity.json (format 2) takes `tabs` (`max`, `popups`, `park`, `close`) and
    `backgroundThrottling`; `turno-browser-mcp` takes `--max-tabs`, `--popups`, `--park-after`,
    `--close-after` and `--background-throttling`, which win over the file.
  - Background tabs keep running at full speed by default, as before: measured, dropping
    Playwright's switches alone has no effect while focus emulation is on, and turning both off
    stalls actions on a tab that is not in front. `backgroundThrottling` turns both off and brings
    the agent's tab to the front before each call.
- 50dd77c: Credential vault for browser identities: `turno browser vault add|list|remove|submit`
  stores a username, a password and an optional TOTP secret per site in the OS secret store, and
  the new `browser_login` tool fills them into the site's sign-in page without the agent ever
  seeing them. Results and errors are redacted, values are bound to the site's origins, and the
  form is submitted only when the identity opts in. turno-browser's API is now 1.1, which this
  turno requires.
- fa324c0: Cross-package contracts:
  
  - turno-browser exports its public API as a typed `api` object with `API_VERSION` (1.0).
    turno-cli checks it when it loads the package: a turno-browser that is too old (0.2 and older
    have no `API_VERSION`) or too new stops `turno browser` and `turno identity browser:<id>`
    with one line naming what to update, instead of failing later.
  - mcpd sends every `tools/call`, from 2025-11-25 sessions and 2026-07-28 requests alike,
    through one call middleware: the profile's tool filter, then the call log, then the session id.
    Refusals and call log records are unchanged.
  - Each relayed `tools/call` carries `_meta["io.turno/session"]`, an opaque id that is stable for
    one agent session and different for every other. turno-browser-mcp hands it to its own tools
    (`session` in their context); the Playwright tools are unaffected.
- 5b46749: Browser lifecycle:
  
  - `turno-browser-mcp` passes a generated Playwright MCP `--config` that closes Chrome after 15
    minutes without a tool call, headed too; the next call opens it again with the same profile.
    `TURNO_BROWSER_IDLE` changes the limit (`"10m"`, `"0"` keeps Chrome open); `--idle-timeout`
    and a `--config` of your own still win. Flags and tool names are unchanged.
  - On start it closes a Chrome that an earlier, killed run left open on the same profile (only
    a Chrome browser process for exactly that profile whose parent is gone), and on stdin close,
    SIGTERM or SIGHUP it closes Chrome within about 2.5 seconds, forcefully if needed.
  - mcpd stops a quiet `session` server under critical memory pressure even while its session
    lives; the next call starts it again. `turno mcp top` counts the process groups a server's
    children lead, so a browser's helpers always count.
  - Docs: one recommendation for browsers, a `shared` server with `exclusive = true` per identity
    (the block `turno identity add` prints), instead of `scope = "session"`.
- 0537fc1: `turno-browser-mcp` is now the MCP server host instead of a wrapper that ran the Playwright MCP
  program bundled in `patchright-core`. It launches Chrome itself through one engine
  module, serves stdio with the MCP SDK, and runs every stock tool through upstream's tool
  backend, so the 25 tool names and input schemas, every flag, `TURNO_BROWSER_IDLE`, the idle
  close, the orphan sweep and the bounded shutdown work as before. `--port` keeps upstream's HTTP
  server. `initialize` now reports `turno-browser` and its version. A registry for turno's own
  tools is in place (no new tools yet). `@modelcontextprotocol/sdk` is now a dependency.

### Patch Changes

- 01d17db: The idle limit no longer closes Chrome in the middle of a tool call. It counted from the start of
  the last call, so a call that took longer than `TURNO_BROWSER_IDLE` (a slow page, a busy machine)
  failed with "Target page, context or browser has been closed". It now stops while a call runs and
  counts from the end of the last one.
- 2948759: The package homepage is now https://turno.wimo.dev.
- cf29953: The example time zone in the message for an invalid identity.json and in the help of
  `turno identity` is now `Europe/Madrid`.
- 5566437: Every package has a README that tells the same story as the site. turno-cli's follows the
  order of turno.wimo.dev and lists what the browser gained; turno-browser's is organized around
  what the package does (identities, the credential vault, session export and import, tab limits,
  `browser_batch`, blocking and cache, health and doctor); turno-core's says what the shared
  package is for; turno-fonts' shows the status line and how `turno ui install` uses the font.
  Each links to its page on turno.wimo.dev and to the releases.
- a0bfce8: New package `turno-core` with what turno-cli and turno-browser share: turno's paths, the secret
  store (macOS Keychain, Linux Secret Service) and the process helpers. Both packages
  now depend on it instead of keeping their own copies; behavior is unchanged.
- Updated dependencies [2948759]
- Updated dependencies [5566437]
- Updated dependencies [a0bfce8]
  - turno-core@0.1.0

## 0.2.0

### Minor Changes

- c0b33e0: Neutral engine ids for `turno browser bench`, and a README demo of the current CLI.
  
  - `turno browser bench` names its engines by browser and mode: `chrome-headed`,
    `chrome-headless`, `chrome-baseline` and `firefox`. The old ids (`patchright-chrome-headed`,
    `patchright-chrome-headless`, `playwright-stock`, `camoufox`) are still accepted by `--engine`,
    and the report (table and `--json`) uses the new ones. turno-cli keeps working with an older
    turno-browser.
  - `turno doctor` and the status screen recognize turno's own status line when its path is
    quoted (as `turno demo` writes it), and show any other status line command without quotes,
    with ~ for your home folder and cut to fit the row.
  - The README demo is recorded from `turno demo` in a throwaway HOME and shows the status screen,
    `turno init --dry-run`, profiles, the profile picker, `turno doctor` with its fix lines,
    `turno mcp list` and `turno limit show`.
- b3cfa89: A lighter default install and a locked dependency tree.
  
  - `npm install --global turno-cli` no longer pulls in `turno-browser` and `turno-fonts`
    (about 52 MB down to 27 MB). `turno ui install` downloads the status line font and checks
    each file against its pinned SHA-256. Install the browser package yourself when you want it:
    `npm install --global turno-browser`; `turno browser` and `turno identity` say so when it is
    missing, and find it in the global npm folder.
  - `turno-cli` and `turno-browser` ship an `npm-shrinkwrap.json`, so an install from npm gets
    exactly the dependency versions that were tested. No package in either tree runs an install
    script, and CI checks it.
  - `turno browser` is a developer diagnostic for browser engine compatibility. `browser bench`
    asks before it opens Chrome on third-party test pages, and without a terminal it needs
    `--yes` (`--json` alone no longer runs it). `--only-urls` replaces `--no-detectors`, which
    still works. `turno browser` and `turno identity` accept `--help` after any subcommand and
    reject unknown flags.
  - `turno-browser-mcp` refuses `--port` or `--host` together with `--identity`, which would
    serve a signed-in browser over HTTP; pass `--allow-http-identity` to accept that, and it then
    listens on 127.0.0.1 only.
  - An empty `turno identity` suggests `turno identity add ...` instead of the old
    `turno accounts add ...`.

## 0.1.1

### Patch Changes

- 35a3c4a: The README links to the `turno-cli` package, the name the CLI is published under.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release: an MCP server that drives your installed Google Chrome with a persistent
profile per identity (`turno-browser-mcp --identity <name>`), headed by default, plus the
`turno browser bench` checks.
