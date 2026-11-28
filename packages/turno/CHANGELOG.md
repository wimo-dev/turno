# turno-cli

## 0.6.2

### Patch Changes

- 6a2c0d1: Page snapshots are compact. Every element an agent can act on keeps its ref, and the text a reader needs stays, while wrappers without a name, the destination under a named link, separators, text that repeats a neighbouring button's name, refs on elements nobody acts on and runs of identical rows are left out. Measured with the new `pnpm bench:snapshot --public`: Hacker News 12,238 to 3,786 tokens, a GitHub repository page 18,879 to 7,721, Wikipedia search results 5,842 to 3,040, with every interactive ref kept and the same answers to fixed questions. A page still past about 15,000 tokens once compact (a long Wikipedia article: 128,673 tokens) comes back as a table of contents of its landmarks, headings and text fields with refs and sizes (849 tokens). The new `browser_read` tool reads one part by ref, the whole page compact, or with `full: true` the page as Playwright wrote it. `TURNO_BROWSER_SNAPSHOT=full` in the server's environment turns compaction off; `turno help environment` lists it.
- f717317: turno-browser turns its features on by default, worked out at every launch and never written into identity.json. `show`, `status` and `doctor` list each value with where it came from, for example `resources: low (auto: memory pressure)`.
  
  What changes for an existing identity, without touching its identity.json: the live view is on (it opens only with `turno-browser live`); flows and screenshots are recorded, under the 200MB cap and never of a page with a vault value (traces stay off: while tracing, Chrome loads no image or frame of another site); the `vision`, `pdf`, `devtools` and `network` tools are listed when the server has no `--caps`; `browser_login` submits the form (`vault submit <id> confirm` keeps the old behavior, and must be run again even if it was chosen before); the low-resource preset turns on under memory pressure; human-like input is `auto`; several agent sessions share the browser in their own tabs, so `browser_close` closes a session's tabs and the idle release closes the browser (`--sharing session` for one at a time; an mcp.toml block with `exclusive = true` keeps working, and doctor says how to change it); a headless Chrome gets the coherent user agent (once `login` has read that Chrome's client hints) and background throttling when the live view is off; Chrome gets the system's locale when identity.json names none; and `login` finds a health check when there is none. A key set in identity.json still wins over every default, and `off` (`--health off`, `--locale off`, `--user-agent off`) pins one off. A file with an `auto` or `false` value is written as format 14, which turno-browser 0.10 refuses.
  
  New identities created at a terminal on macOS with Google Chrome keep their cookie key in the system keychain, and `add` mentions Camoufox, Lightpanda and attach mode when they apply. turno prints the mcp.toml block of a new identity with `exclusive = false`, except in attach mode.
- 6fbaf91: The live view is a panel now: the agent's tab next to a timeline of its steps (the time, what it did, the element or address, how long it took, and whether it failed or was not run), with the pauses, your turns and what changed when you handed the browser back. A line never shows what the agent typed, filled or selected, a script, or an address's query, and every line goes through the same redaction as the agent's results, so vault values stay hidden. When the same call on the same element fails three times in a row, the line and the status say the session looks stuck. New steps and changes of state are announced to screen readers. `turno-browser live` opens the view as an app window of your Chromium browser (`--tab` for a tab of the default browser).
  
  You can take the controls without pausing first: clicking, typing or scrolling on the picture while the agent works, or in the agent's Chrome window, makes the agent's next call wait. The browser goes back to the agent 5 seconds after your last input, or with the view's Hand back button (Resume before), and the waiting call is told that you used the browser and what changed. `turno browser live` without a running server no longer says the view is off when only no server runs.
- 3a1482a: The last click is yours: when the agent's `browser_click` would place an order, make a payment, send a message or money, publish a post or confirm a deletion, turno-browser does not click. The agent is told what the click would do and to ask you with `browser_request_human` and `requireHumanClick`, and that step's banner says what the click does, from the page: the order's total, the amount, who a message goes to. The check is conservative: a word that also names a harmless step ("Buy now", "Send", "Post", "Delete") counts only when the page agrees (a checkout with an amount, a message being written, a dialog that warns it cannot be undone), and steps on the way ("Add to cart", "Proceed to checkout", "Send code") never count. `turno-browser set <id> --last-click false` turns it off.
  
  turno-browser shows a notification of the system when the agent waits for you (a person step, a passkey prompt, a captcha no solver answers) and when it is done after a long run, with `osascript` on macOS, `notify-send` on Linux and a PowerShell toast on Windows. The text is redacted like any result and is never run as a script. `turno-browser set <id> --notify false` or `TURNO_BROWSER_NOTIFY=off` turns them off. identity.json format 14 also takes the `notify` and `lastClick` keys; a file that sets one is refused by an older turno-browser.
- 612479e: The `storage` tools (cookies, localStorage, sessionStorage and the storage state file) are listed by default, with session values masked: a cookie that is HttpOnly, named like a credential (`session`, `sid`, `token`, `auth`, `csrf`, `login`) or holding a random-looking value, and the tokens in stored items, read `[masked]`. Names, domains, paths, expiry and flags stay. After every browser call the server reads the cookies and the page's web storage, so a random-looking session value is also hidden from `browser_evaluate` (`document.cookie`), response bodies, console messages, snapshots and written files. A mask written back keeps the value it stands for, in the same cookie or item only, so `browser_cookie_set` with `[masked]` and `browser_set_storage_state` with a saved file keep the session. Attach mode and a policy that lists `storage` keep the tools off.
  
  Without a proxy of its own, an identity's Chrome follows the system's proxy as before; `show` and `status` now name it (macOS `scutil --proxy`, Windows Internet Settings, GNOME settings or the proxy variables), and `"proxy": false` makes Chrome connect directly. With a proxy in use, turno-browser looks up where it exits (one HTTPS request to get.geojs.io through the proxy, once a day per proxy) and warns when the identity's time zone or locale does not match; `TURNO_BROWSER_EXIT_CHECK=0` turns the lookup off.
- cbed7d4: An action that stays on the page (a click, a key, a selection, a drag) answers with what changed since the last snapshot the agent was given, by ref, when it is the same session and URL and the changes are under half the compact page. Before, the result only linked the snapshot file Playwright wrote, and an agent that wanted to see what its click did called `browser_snapshot` for the whole page: opening the "Code" menu on a GitHub repository page now answers with 262 tokens of changes, against 7,683 for the page. A navigation, another tab or a change that is most of the page answer as before, and `browser_snapshot` always returns the whole page. `TURNO_BROWSER_SNAPSHOT=compact` turns the changes off.

## 0.6.1

### Patch Changes

- Updated dependencies [d65d855]
- Updated dependencies [c80b30c]
  - turno-core@0.5.0

## 0.6.0

### Minor Changes

- 4088401: Behavior change: `turno-browser remove <id>` (and `turno browser remove`, `turno identity remove browser:<id>`) now asks before it deletes anything, showing the list of what goes. `--yes` skips the question; without a terminal and without `--yes` it refuses with exit code 2 instead of deleting. It also removes what it used to leave behind: it stops the identity's background server, a Chrome on its profile and the turno-browser-mcp processes started for it (instead of refusing while they run); it takes the identity's MCP server out of each agent that has it with the agent's own command (`claude mcp remove --scope user browser-<id>`, `codex mcp remove`, `copilot mcp remove`, `gemini mcp remove`); it deletes the `keychain:` items identity.json references (proxy, act, captcha) unless another identity or turno's mcp.toml uses them, the vault's credentials even when the vault index is broken, and the session exports it wrote. Chrome's own cookie key (`"keychain": "system"`) is shared with every Chrome profile and is kept. Afterwards it checks that nothing is left and exits 1 when something is. `--json` reports `planned`, `deleted`, `failed`, `left` (each with the step that removes it) and `kept`. `destroy` is another name for `remove`. `turno identity remove browser:<id>` passes `--yes` and `--json` on to turno-browser.

### Patch Changes

- fb4c2e3: An identity can run on another Chromium-based browser than Google Chrome: `turno-browser set <id> --browser chrome|edge|brave|chromium|chrome-for-testing|<path>` (also on `add`; identity.json `browser`, format 13). Every command uses it: the agent's server, `login`, `export` and `import`, the background server and `replay`. A server's own `--browser` or `--executable-path` still wins over it. When Google Chrome is not installed, `add` and `init` pick the first browser they find and write it to identity.json, so a profile never changes browser by itself. Switching the browser of a profile another browser already opened is refused unless you pass `--force`, since the new browser rewrites the profile and, with `keychain: "system"`, cannot read the old one's cookies.
  
  New `turno-browser install-browser`: for a machine without any Chromium-based browser and no admin password, it downloads Chrome for Testing into the user cache with the installer of the patchright-core turno-browser uses (about 190 MB, no system change). `doctor` lists every browser it finds (Chrome, Edge, Brave, Chromium, Chrome for Testing), starts the first one when Chrome is missing, says which browser each identity uses and whether it is installed, warns when a newer browser last opened a profile, and names `install-browser` when there is none. turno-cli needs turno-browser's API 1.14.
- Updated dependencies [6bf9b12]
  - turno-core@0.4.0

## 0.5.3

### Patch Changes

- 298c744: The agent cursor follows the pointer path with humanize on, counts the other busy sessions on the badge with shared tabs, keeps the typing bubble up long enough to see, and keeps its label inside the page. Each session's cursor is named after its own agent ("Claude Code", "Codex", "Cursor", "Copilot", "Gemini CLI") instead of the raw client name or the name of the first one: mcpd sends the client's name with each call (`io.turno/client` in `_meta`), and a shared host uses each connection's own.
- ce785fd: A password or one-time code never reaches the agent, whoever typed it: every page snapshot (also the snapshot files an action writes to the workspace) shows its value as `[sensitive field]`, and the value is hidden from every later result. `browser_type`, `browser_fill_form` and key presses into a password or one-time code field are refused with an error that says to ask the person (`browser_request_human`) or to use `browser_login`; a flow replay types one only from the secret store (`keychain:<item>`) or from the hidden prompt of `turno browser replay`, which names those parameters for the server it starts in `TURNO_BROWSER_PROMPTED_PARAMS` (listed in `turno help environment`). `browser_network_requests` and `browser_network_request` keep the names of credentials and show `[redacted]` for their values (Authorization, Cookie and Set-Cookie headers, token, code, session, key, secret and password fields), also in a file saved with `filename`. A tool result that ends on a captcha, "verify it's you" or block page says so and suggests that the person handles it.

## 0.5.2

### Patch Changes

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

## 0.5.1

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

- df52afc: turno-browser has its own `turno-browser` command: add, list, show, set, login, vault, export, import, flows, replay, record, traces, live, pause, resume, doctor and reputation work without turno, with `--version` and a help grouped by section. `turno-browser add` prints how to connect an agent instead of an `mcp.toml` block, and `turno-browser do` says it needs turno for now. `turno browser ...` and the browser part of `turno identity ...` now run turno-browser's commands through its typed api (API_VERSION 1.12, new member `cli`) with the same flags, output and exit codes, so turno-cli needs turno-browser 1.12 or a later 1.x. turno-core gains `turno-core/cli`, the command line toolkit (arguments, output, styles, exit codes, command groups, hints, hidden input) that both programs share.

### Patch Changes

- 44fb809: `turno-browser-mcp --identity <id> --background` serves an identity to the shell without turno: MCP over streamable HTTP on a Unix socket in a private folder of the identity's state (or 127.0.0.1 with a per-server token where a socket cannot be used), one Chrome shared by every connection with the identity's sharing rules, and an exit after 15 minutes without a request (`--background-idle`, `TURNO_BROWSER_BACKGROUND_IDLE`). While it runs it alone drives the identity's browser: a stdio server of the same identity refuses calls that need the browser with a message that names it, and it does not start while another process has the identity's Chrome open. The package exports a client for it (`startBackground`, `backgroundStatus`, `openBackgroundSession`, `stopBackground`), also in the typed api, now version 1.11. turno-cli now asks for turno-browser 1.11 or a later 1.x.
- e2b1779: `turno-browser do` works without turno: it starts the identity's background server on the first action, keeps one session per agent or shell between commands, and ends it with `end`, `close` or when that process exits. `turno browser do` keeps going through mcpd.
  
  New `turno-browser` commands: `setup <claude-code|codex|cursor|copilot|gemini|json> [--identity <id>]` prints the MCP config that gives an agent an identity (it writes nothing; `--json` for scripts), `background status|start|stop` shows and controls the background servers, and `secret set|has|list|remove` stores the `keychain:<item>` secrets identity.json names, in the same store and items as `turno secret`.
  
  Hints, errors and doctor fixes name the commands of the program you typed: `turno-browser ...` on its own (the MCP server's messages too), `turno browser ...` and `turno identity ... browser:<id>` inside turno. `turno-browser doctor` lists a running background server, and a stdio server refused by a background server names `turno-browser background stop <id>`.
  
  turno-core exports the owner, name and lock of a shell session of browser commands (`turno-core/cli`), shared by `turno browser do` and `turno-browser do`.
  
  The npm description, keywords and MCP Registry entry follow the new tagline. Wording: the help no longer labels the off-by-default settings (natural language actions, captcha solving, network and user agent, Camoufox) as "not recommended"; they stay off by default and the help still says what each one sends where.
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
- bf1cafb: `turno browser do <id> <action>` drives a browser identity from the shell, for coding agents that
  prefer commands to MCP tools: `open`, `back`, `snapshot`, `read`, `find`, `click`, `type`,
  `press`, `select`, `hover`, `wait`, `screenshot`, `tabs`, `login` (a vault sign-in), `call` (any
  tool of the server), `close`, `session` and `end`. Each action is one tool call through mcpd to the
  identity's turno-browser-mcp, so the tab locks or the one-session lease, attach mode, read mode's
  refusals, humanize, recordings and the vault apply as they do to an agent. The commands one agent
  or one terminal shell runs are one session and keep their tab: turno keeps the mcpd session open
  between them and ties it to the agent (or the shell), and `end` closes it; `--session <name>` or
  `TURNO_BROWSER_SESSION` keeps several apart. Output is `url:` and `title:` lines and what the
  action returned, errors on stderr with exit 1, or one object with `--json`. `turno browser <id>
  <action>` is the short form when the id is not a subcommand. The Claude Code plugin adds a short
  `browser-identity` skill that teaches the loop and reads the installed help first.
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

### Patch Changes

- 31a9a36: `turno doctor`, `turno status`, `turno mcp daemon status` and `turno doctor --security` no longer
  wait for lsof to tell who holds mcpd's port. A free port is told by a refused connection, and a
  running mcpd's port is checked against the pid it reports, so lsof's scan of every process (which
  takes seconds on a busy Mac) runs only when another process holds the port. When lsof cannot say
  which process that is, doctor still reports the port as in use.

## 0.3.0

### Minor Changes

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
- 59309b5: `turno browser export <id> --out <file>` and `turno browser import <file> [--as <id>]` move an
  identity's cookies, localStorage and IndexedDB as one file encrypted with a passphrase (scrypt
  and AES-256-GCM), refused after its expiry and never holding vault credentials.
  `"keychain": "system"` in identity.json makes Chrome encrypt an identity's cookies with the OS
  keychain instead of Playwright's fixed mock key; the default is unchanged.
  turno-browser's API is now 1.2, which this turno requires.
- 50dd77c: Credential vault for browser identities: `turno browser vault add|list|remove|submit`
  stores a username, a password and an optional TOTP secret per site in the OS secret store, and
  the new `browser_login` tool fills them into the site's sign-in page without the agent ever
  seeing them. Results and errors are redacted, values are bound to the site's origins, and the
  form is submitted only when the identity opts in. turno-browser's API is now 1.1, which this
  turno requires.
- aa7e39e: An output contract for scripts, hooks and agents:
  
  - Every `--json` object carries `schemaVersion` (each element, for a list); no existing key
    changed. `--json=fields` lists a command's fields, `--json=a,b` keeps only those, and an
    unknown field is exit 2 with the list. Under `--json`, errors are one JSON line on stderr:
    `{"schemaVersion":1,"error":{"code":"usage","exitCode":2,"message":"..."}}`.
  - `turno limit show --watch --json` and the new `turno mcp top --watch --json` print NDJSON, one
    record per line, like `turno mcp log --follow --json`.
  - Exit codes: 0 ok, 1 failure, 2 usage, 3 no profile for the folder, 4 not signed in, 5 mcpd
    down (`turno help exit-codes`). Changed: `turno auto` exits 3 (was 1) when the folder's
    profile does not exist or there is no rule with `system = ""`; `turno mcp daemon status`,
    `turno mcp top` and `turno mcp savings` exit 5 (was 1) when mcpd is down.
  - `turno profile which --check` answers with that code and prints nothing when the folder has
    a signed-in profile (`--agent` for other agents).
  - turno's own state files are checked before use: a cut or hand-edited file reads as absent
    instead of crashing, and an unreadable `mcp-managed.json` stops `turno mcp sync` and
    `turno uninstall` with a message naming the file (they used to go on as if it were empty).
    `turno identity log --verify` reports a line that is not an audit entry.
  - `turno help environment` lists every variable turno reads and `turno help json` the JSON
    rules; every command help ends with examples. Colors honor `CLICOLOR=0`, `CLICOLOR_FORCE`
    and `TERM=dumb`; `TURNO_NO_UPDATE_NOTIFIER=1` turns the update check off.
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
- cf4e077: Diagnostics and safe mode:
  
  - `turno mcp call <server> [tool] [--args JSON] [--arg k=v|k:=json] [--profile p] [--json]`
    calls a tool through mcpd as a profile's session in this folder would, or lists the tools.
    Exits 1 on `isError` or a refused call, 5 when mcpd is down.
  - `turno doctor --report` prints a Markdown block for an issue: turno, Node, OS, each agent's
    version, mcpd, the findings and every path, with no tokens or secret values.
    `turno config path --all` lists every path turno uses.
  - Safe mode: `turno run <p> --no-gateway`, `turno <p> --no-gateway`, `turno auto --no-gateway`,
    or `TURNO_SAFE=1`, opens the agent with the profile's account but without the gateway entries,
    the gateway token and (Claude Code) the status line and hooks.
  - Copilot CLI and Cursor CLI gateway entries send the session folder (`X-Turno-Cwd-B64`), so
    folder server sets apply to them without the process lookup. Run `turno mcp sync` to rewrite
    existing entries.
  - `system = ""` no longer becomes an empty profile name for the hub's gateway token; `turno
    status` and `turno profile which` say "no profile" for folders without a rule.
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
- 57641d4: `turno identity set browser:<id>` and `turno browser set <id>` take flags for every identity.json
  key of the browser host: `--tabs-max`, `--tabs-popups`, `--tabs-park`, `--tabs-close` and
  `--no-tabs` (tab governor), `--background-throttling`, `--settle`, `--block-trackers`,
  `--block-types`, `--block-patterns` and `--no-block`, `--cache`, `--cache-max-size` and
  `--no-cache`. A flag changes only its part of a group, an empty value removes a key, and a bad
  value is refused with the flag's name. `set` takes `--json` (what changed, or with `--dry-run`
  what would, and the resulting file), and `--dry-run` now validates like the real write.
  `turno identity add browser:<id>` takes the same flags, and `show` lists the new settings.
- 4663312: Move MCP servers between machines, OAuth detection, Codex trust and next-step hints:
  
  - `turno mcp export [--profile p] [--json]` prints mcp.toml without secret values: references
    stay, literal secrets become `keychain:turno/<server>/<key>` names, and the top of the file
    lists the `turno secret set` commands the other machine needs.
  - `turno mcp import <file>` merges an export, a JSON file with `mcpServers` or a Codex
    `config.toml` into mcp.toml, keeping its comments and existing servers (`--force` replaces
    them). A preview until `--write`.
  - With `--write`, both import forms mark remote servers that answer with an OAuth challenge as
    `auth = "oauth"`.
  - `turno profile assign` and `turno profile repair` write Codex `[projects."<folder>"]
    trust_level = "trusted"` entries in Codex profiles for their folder rules, never changing an
    existing entry.
  - Commands that write end with a `Next:` line (`profile add`, `profile assign`, `mcp import
    --write`, `mcp export`, `secret set`); `turno config set hints false` turns them off.

### Patch Changes

- 2948759: The package homepage is now https://turno.wimo.dev.
- 7b77664: pnpm, bun and yarn are first-class install paths. `turno upgrade` and `turno version` recognize
  them from their lockfile even under a custom `PNPM_HOME`, `BUN_INSTALL` or yarn global folder,
  and treat `pnpm dlx` and `bunx` like `npx`: a one-off copy has nothing to upgrade, and
  `turno upgrade` says which command runs the newest release instead of installing turno globally.
  Launchers and the status line refuse to point into any of those caches. `turno browser` and
  `turno identity` find a `turno-browser` that pnpm 11 or later installed in its own global group.
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

- 8922b9d: `turno doctor` names the fix for every finding. Each warning and failure is followed by the
  command that fixes it (`fix: turno profile repair work`, marked when `turno doctor --fix` runs it)
  or the manual step, in sections (System, Config, Profiles, MCP, Look, Gateway) with icons and a
  summary line (`12 ok, 2 warnings, 1 failure in 340ms`). `--json` adds `status`, `fix`, `auto` and
  `manual` per check and `counts`, `ms` and `next` at the top. `--summary` prints one line for hooks
  and status lines. `turno doctor --security` works the same way.
- 3dee471: Syntax highlighting in a terminal, with no new dependencies.
  
  - `turno init` shows the `config.toml` diff and the new `mcp.toml` with TOML colors: table headers bold, keys cyan, strings green, numbers, booleans and dates magenta, comments dim. The `+` and `-` markers keep their green and red, and removed lines stay plain red.
  - `turno mcp import` colors its preview the same way, and a masked secret (the lines marked `# secret, hidden`) shows in yellow so it stands out. `turno mcp config` colors the JSON snippet and dims the file and note lines. `turno config set` colors the `key = value` it prints.
  - `--json` output is colored when it goes to a terminal: keys cyan, strings green, numbers, booleans and null magenta. Piped into `jq` or a file it stays plain JSON, even with `FORCE_COLOR` set.
  - Colors follow one rule everywhere: only on a terminal, never with `NO_COLOR` set. `FORCE_COLOR=1` now colors output that is not a terminal (for example `turno ... | less -R`), and `FORCE_COLOR=0` turns colors off on a terminal (`--json` is the exception: never colored outside a terminal). Output without colors is unchanged byte for byte.
- 7d2eea1: Bare `turno` now shows the status screen once turno is set up (the help before that), and `turno status` ends with the one thing to do next (`turno init`, `turno profile repair <p>`, `turno mcp daemon start`, `turno mcp sync`, `turno upgrade` or `turno ui install`); `status --json` has it as `next`. `turno init` also offers to start the gateway and point every profile at it in the same run and the same journal (asked in a terminal; `--start` with `--yes`, `--no-start` to skip), and ends with the command to try.
- a471bba: turno never waits for an answer nobody can give.
  
  - A global `--no-input` flag (before or after the command) and `TURNO_NO_INPUT=1` turn every question off. turno also asks nothing inside a coding agent's session: Claude Code (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), Codex (`CODEX_THREAD_ID`, `CODEX_SANDBOX`), Copilot CLI (`COPILOT_CLI`, `COPILOT_AGENT_SESSION_ID`) and Cursor (`CURSOR_AGENT`). `TURNO_NO_INPUT=0` allows questions again, for an editor terminal that sets one of those variables. Without a terminal there were no questions already.
  - A command that needs an answer then exits with code 2 (`init`, `uninstall` and `profile add` used 1) and names the flag that gives it, in one format: `turno: init needs an answer; pass --yes (or run it in a terminal)`. This covers `turno init`, `turno profile add` and `turno profile repair` (moving your own files aside), `turno uninstall`, `turno browser bench`, and `turno secret set`, which no longer shows its hidden prompt and asks for the value on stdin instead. `turno upgrade --finish` does not ask about `turno mcp sync` and names it instead.
  - `turno help` mentions `--no-input`.
- 0a8f185: Choose a profile from a list when a command needs one and you leave it out: `turno profile assign [dir]`, `turno profile remove` (then a y/N confirmation), `turno run`, `turno session handoff`, `turno limit set` and `clear`, and `turno open <claude.ai link>` outside a profile's session. The list shows each profile as its colored pill with its agent and account, marks the one this folder uses and the exhausted ones, and takes arrow keys or j/k, typing to filter, Enter, and Esc or Ctrl-C to cancel (exit 130, nothing changed). It draws on stderr and always puts the terminal back. Without a terminal, with `--no-input` or inside an agent session, those commands exit with 2 and list the valid values (`pass a profile: personal, work`). `turno profile list` and `turno session list` are restyled: pills in each profile's color, aligned columns, accounts, how many folders use each profile, and each session's age; plain output (a pipe, NO_COLOR) keeps one row per item starting with its name. `--json` output is unchanged.
- 4dd7d66: The new look reaches more screens, and colors get one switch.
  
  - `turno limit show` draws each profile as its colored pill with the account, a usage bar per window colored by level, the reset time, `used up` when a window is full and a red mark while a profile is marked exhausted.
  - `turno mcp list` is a table with server, kind, scope, idle time, profiles (as pills), state (running or stopped in mcpd, or direct), auth (oauth login state, or `secret` when it uses a keychain or env reference) and the details (command or URL, variants, package, tool filters, logins). On a terminal the column titles are muted lowercase, paths are shortened to `~`, the details wrap under their own column and a narrow terminal drops the secondary columns first; nothing runs past the terminal width. It says once when mcpd is not running.
  - `turno mcp top` and `turno mcp log` line up their columns, right-align numbers, show running icons and color the outcome of each call (ok, error, timeout, cancelled), calls in flight, restarts and errors. On a terminal `mcp log` shows only the time when every call is from today, fits each line to the width (long names end in `…`, the agent and then the sizes go first on a narrow terminal) and puts an error on its own line; piped output keeps its columns.
  - On a terminal, a word longer than the line (a long path) is cut at the width instead of running past it.
  - `turno identity list` has sections (service accounts, folder preferences, browser identities) with aligned rows, profile pills and the confirm policy under each account.
  - A global `--color auto|always|never` and `TURNO_COLOR`. Order: `--color`, then `TURNO_COLOR`, then `NO_COLOR`, then `FORCE_COLOR`, then whether output is a terminal. `--json` stays plain outside a terminal whatever the flag says.
  - The status line pill and every other profile pill use one color rule.
  - `turno demo` without a terminal (a pipe, `--no-input`, an agent) prints what it set up and ends instead of waiting for Ctrl-C forever; `--keep` keeps it running until Ctrl-C (also in a terminal, instead of opening a shell).
- c5b23f5: A visual language for the CLI. `turno` and `turno status` now show sections (Here, Profiles, Machine), each profile as a pill in its own status line color, usage bars colored by level with the time to reset, a gateway icon, and a prominent Next row. `turno help` has section headers, commands in the accent color, an Examples block, and fits the terminal width. `turno init` prints its phases (Found, Plan, Write, Gateway, Sync) with a spinner while the gateway starts, a checklist of synced profiles, the time it took, and a `Try it:` line naming the launcher of the profile the current folder opens. `turno mcp sync` prints one aligned row per config and its timing. `turno undo` sums up each folder in one line (for example `~/.claude-work  23 links removed, settings.json moved back`) and lists every change with `-v`. Tables follow the real terminal width (COLUMNS, then the terminal, 80 otherwise). Without colors (a pipe, NO_COLOR) the same layout prints as plain text with ASCII icons; `--json` output is unchanged. Paths under HOME show as `~` even when HOME has a trailing or doubled slash.
- f849d28: The Claude Code plugin (0.2.0) adds a third skill, `copy-artifact`: it copies a claude.ai artifact (an HTML page, or one made from a type such as a Design canvas, a deck or a document) from one turno profile's account to another, with its own files and its assets (fonts, images). Export runs in a session of the owning profile and packs everything into `~/.cache/turno/artifacts/`; import runs in a session of the target profile, uploads the assets, rewrites the `/_blob/` references and publishes a new artifact. Two dependency-free Node scripts do the packing and the rewriting, and fail loudly on a missing file, a path outside the source folder, an asset no file cites, a cited asset that was not passed, an unknown id or a count that differs from the manifest. Comments, the artifact's database and its version history do not travel; sharing from the Share menu stays the way to edit one artifact from both accounts.
- 6d7926a: Pick which MCP servers each folder sees, and a round of follow-ups:
  
  - A `[[projects]]` rule in config.toml can carry `mcp = ["issues", "docs"]` (only these
    servers) and `mcp_deny = ["mail"]` (not these), with or without a `profile`. mcpd hides the
    other servers from sessions in that folder: they show no tools, refuse calls and never start.
    A git worktree follows its main repository's rule. mcpd now reloads config.toml when it
    changes or on SIGHUP. `turno config check` warns about server names that are not in mcp.toml
    and about direct remote servers a set cannot hide, `turno profile which` shows a folder's set,
    and `profile assign`, `unassign` and `remove` keep it.
  - `turno upgrade --finish` offers to run `turno mcp sync` when agent configs need a new gateway
    token (it asks in a terminal; `--yes` runs it), and records the launchers it rewrites so
    `turno undo` can put them back.
  - `turno mcp sync` removes the token files it wrote for profiles that no longer exist.
  - `turno mcp list` shows each server's tool filters (allow and deny), also per variant.
  - Changing a server's tool filter no longer restarts its process.
  - `turno doctor` warns about accounts in accounts.toml without `read_tools`, and
    `turno doctor --security` counts the profile tokens next to the token age and warns about
    token files older than the current gateway token.
  - `turno mcp install` keeps `servers/<name>/` private (mode 700).
  - mcpd applies `call_log` changes without a restart, and sessions it rebuilds after a restart
    keep their agent's name in the call log.
  - `turno undo` of `profile add` puts back the previous mode of a profile folder that existed.
- 48453b4: mcpd can now log in to remote MCP servers that use OAuth, once per account, for every agent and profile.
  
  - Declare a remote server with `auth = "oauth"` in `mcp.toml`. mcpd proxies it and adds the access token itself, so no agent logs in on its own. A profile that needs another account gets `[server.<name>.variant.<profile>]`; every other profile shares the default login.
  - New `turno mcp login <server> [--profile p]`: finds the authorization server, registers turno (your own `client_id`, a client ID metadata document you host, or dynamic registration), and runs a PKCE login in the browser with a loopback redirect. `--no-browser` prints the link, `--dry-run` shows the plan, `--scope` asks for more scopes.
  - New `turno mcp logout <server> [--profile p | --all]`: revokes the token at the server when it can and deletes it.
  - Tokens are kept only in the Keychain or Secret Service (`turno/oauth/<server>@<variant>`), never in files or logs. mcpd refreshes them when they expire or the server answers 401, and saves a rotated refresh token before using the new access token; if the Keychain refuses that write, mcpd keeps the token in memory and retries instead of losing it.
  - When a login is missing or was revoked, calls fail with the `turno mcp login` command to run, and `turno mcp list`, `turno mcp doctor` and `turno doctor` show it.
- cfe036e: See what the gateway does and what it saves:
  
  - `turno mcp log [-f] [-n N] [--server S] [--profile P] [--json]` shows the tool calls mcpd
    relayed: time, outcome (ok, error, cancelled, timeout), duration, server and variant, tool,
    profile, agent and request and response sizes. mcpd keeps them in
    `~/.local/state/turno/logs/calls.jsonl` (mode 600, rotated at 5 MiB). Records never hold the
    call's arguments or result, and error texts have tokens redacted. Turn it off with
    `call_log = false` under `[mcpd]` in config.toml.
  - `turno mcp top [--once] [--json]` shows each running server's memory (with its child
    processes), sessions, calls in flight, idle time and restarts, refreshing every 2 seconds in a
    terminal.
  - `turno mcp savings [--json]` compares the memory of mcpd and its servers with an estimate of the
    same agent sessions without the gateway (sessions x per-server memory).
  - The mcpd `/status` endpoint now lists the agent sessions and each instance's restarts.
- 91b3a76: Set turno up in one step, or try it without touching your setup.
  
  - New `turno init [--dry-run] [--yes]`: finds the agents on your PATH, your turno profiles, agent folders you made by hand (`~/.claude-work`, `~/.codex-cx`, ...), the MCP servers in your Claude Code, Codex, Cursor and Copilot CLI configs, and the folders each Claude Code account was used in. It proposes profiles, folder rules, a default profile and `mcp.toml`, prints everything (with the `config.toml` diff, the new `mcp.toml` with secrets masked, and any of your files it would move aside), asks, and writes it all as one change that one `turno undo` reverts. In a terminal it asks before adopting each folder; without one it needs `--yes`. `--profile <name[:agent]>`, `--skip <name>`, `--default <profile>` and `--no-mcp` answer the questions from the command line. It ends with what is left: signing in once per profile, `turno mcp daemon start`, `turno mcp sync` and `turno ui install`.
  - New `turno demo` (also `npx turno-cli demo`, no install needed): builds a throwaway HOME in the temp folder with two Claude Code profiles, a folder rule, two small MCP servers behind a gateway on a free port, and the status line, then opens a shell there (`turno demo -- <command>` runs one command instead). It never reads or changes your own HOME and never signs in. When you leave, or press Ctrl-C while it waits, it stops the gateway and removes the folder.
  - `turno help` starts with `turno init` and `turno demo`; `init` and `demo` can no longer be profile names.
- d05b5b9: mcpd speaks MCP 2026-07-28 next to 2025-11-25, and stops idle servers sooner when memory is low:
  
  - Agents that use the stateless 2026-07-28 revision (no `initialize`, no session id,
    `Mcp-Method` and `Mcp-Name` headers) are served directly instead of falling back to a
    2025-11-25 session: `server/discover`, cached `tools/list`, `prompts/list` and
    `resources/templates/list` with `ttlMs` and `cacheScope`, relayed calls with progress and
    cancellation, and `subscriptions/listen` for list changes and resource updates. Headers that
    disagree with the body are refused as the revision requires. 2025-11-25 sessions work as
    before. Elicitation and sampling still need a 2025-11-25 session.
  - When the machine is short of memory (macOS memory pressure, Linux PSI, else free memory), idle
    MCP servers stop after `idle_under_pressure` (default 5 minutes, a quarter of it when pressure
    is critical) instead of their usual 20 or 30 minutes. Set it under `[mcpd]` in config.toml or
    with `turno config set mcpd.idle_under_pressure 10m`; `false` turns it off. Session servers
    whose agent still runs are kept.
- e424894: The accounts bridge no longer trusts the calling model to say what a delegated run may do:
  
  - Accounts take `read_tools` (`turno identity add ... --read-tools <patterns>`). A delegated read gets only those tools, so it cannot send, post or delete even if injected text tells it to; Claude Code refuses anything else, and the refused tools are reported.
  - Accounts take `confirm = "always" | "writes" | "never"` (`--confirm`). The default is `always` for mail and messaging services (every call asks the user) and `writes` elsewhere. A read of an account without `read_tools` is now confirmed like a write: add `read_tools` to keep unconfirmed reads.
  - The headless run starts in turno's own empty folder instead of the caller's, loads no settings files (`--setting-sources ""`), gets a minimal environment, and loads only the account's MCP servers (`--strict-mcp-config`) when they go through the turno gateway.
  - The result comes back marked as data from another account and capped at 20,000 characters.
  - Every audit log line records the decision: policy, whether the user was asked and the answer, the allowed tools, the MCP mode and refused tools. `turno identity list` shows each account's policy and `turno identity log` shows the decisions.
- b8d15ec: `turno doctor` names the fix for config.toml findings: `turno profile add <name>` for a profile that does not exist, else the line of config.toml to edit and what to write there (`turno config check` prints the same advice). A local server in `~/.claude.json` that mcp.toml serves runs outside mcpd until `turno mcp sync` replaces its entry, and `turno doctor --fix` now runs that sync. `turno doctor` reports the `env:NAME` and `${NAME}` references of mcp.toml that mcpd would resolve and that are not set, by name only, and checks the gateway token in every profile's config even without `mcp-managed.json`. `turno run` without a profile lists `auto` first in the picker, named with the profile the folder resolves to (`auto (work)`). `turno uninstall --purge` also removes turno's state, caches and installed MCP servers after the same confirmation (no undo after it); without `--purge` nothing changes. Faster: the status line, `turno auto` and `turno resolve` find a worktree's main repository by reading `.git` files instead of running git, and `turno doctor --summary`, `turno uninstall` and `turno mcp log` no longer load the gateway or the MCP SDK.
- 7e58586: `turno mcp` commands are safer and clearer:
  
  - Every `turno mcp` subcommand rejects unknown flags (`turno: unknown option --dryrun`, exit 2)
    and `--help` only prints usage. `mcp doctor`, `mcp list` and `mcp config` take `--json`;
    `mcp sync`, `mcp install` and `mcp refresh` take `--dry-run`.
  - `mcp sync` no longer rewrites `~/.claude.json` while a plain `claude` session is open (use
    `--force`), reads open sessions only from its own HOME, warns when mcpd is not running, does
    not create the gateway token in a dry run, and prints `undo with:` only when something changed.
    The hub config is labeled "plain claude (~/.claude.json)".
  - `mcp import` previews without side effects and with secrets masked, ends with the command that
    writes it, and accepts `--dry-run`. It also reads project servers in `~/.claude.json`, the
    folder's `.mcp.json`, Codex, Cursor and Copilot CLI configs, and says so when it finds none.
    `${VAR}` and `${VAR:-default}` become `env:VAR` references (the new `env:VAR:-default` form
    is resolved by mcpd); a placeholder is never stored in the Keychain. Secrets in args and URL
    query strings are detected and hidden.
  - `mcp install` pins each package to an exact version in `mcp.toml`, installs without install
    scripts (`--allow-scripts` to allow them) and keeps a lockfile per server for reproducible
    reinstalls.
  - `mcp refresh` asks a running mcpd to relearn a server's tools, and falls back to the restart
    hint with an older daemon.
- d89904d: First-run fixes for the command line.
  
  - `turno auto` never switches accounts in silence: a missing launcher, a rule naming a missing profile or a broken `config.toml` stop it with exit 1 and the command that fixes it (`TURNO_ALLOW_PLAIN=1` runs the plain agent despite a broken config). `system = ""` means "no default account": folders without a rule are an error too. `turno auto --agent codex` says when it runs plain `codex`.
  - `turno profile which` and `turno status` show the folder's profile for every agent with profiles.
  - `turno config set` checks values the way `profile add` does (profiles must exist and run the right agent, colors and enums must be valid; exit 2), and `config set fallback` reminds that the fallback is opt-in. `config.toml` errors show `~` paths and explain an unclosed string. Unknown keys and rules or roles that name missing profiles are listed by `turno doctor` and `turno config check`, with a suggestion for typos. New keys `agents.<agent>.default` and `agents.<agent>.fallback`.
  - Typos: `turno --verison` is an unknown option, `turno stauts` suggests `turno status`, `turno profile lst` suggests `turno profile list`.
  - One help path: `turno <command> --help`, `turno <command> <sub> --help` and `turno help <command> [sub]` print the usage on stdout with exit 0, and `--help` anywhere never runs the command. Help wraps at 80 columns. The main help starts with what turno is and a "Start here" line; `migrate` and the older names are hidden (they still work), and `browser` moved to a "Developer tools" section. `turno ui` is a regular command group (`turno ui install --help` works).
  - Launchers stop with `turno: claude is not installed (...)` when the agent is missing, export `BROWSER` only where `turno-open` can work (macOS, or Linux with `xdg-open`), and point at the `turno` on your PATH when there is one. Running from npx's cache, commands that would write its path (`profile add`, `profile repair`, `ui install`) refuse and ask you to install turno first.
  - `profile add` and `doctor` warn when `~/.local/bin` is not on your PATH, with the line to add, and suggest `turno <name>` meanwhile. `doctor` lists all four agents and fails only for one a profile uses; `profile add --agent X` warns when X is not installed.
  - `profile add` and `profile repair` print one summary line for the shared folders (`-v` lists them) and ask before moving your own files to `.aside-<time>/` (`--yes` for scripts; without a terminal they stop and say so).
  - Strict flags on more commands (`session handoff`, `migrate`, `resolve`, `ui install`, identity subcommands): a mistyped flag is an error instead of being ignored. Completion of these flags comes from the same spec.
  - Empty states and wording: `turno limit` with no profiles says so, profiles without data say `no usage data yet`, plurals are right.
- 26577d5: The MCP gateway daemon is sturdier and runs on Linux.
  
  - `turno mcp daemon start|stop|restart|status` use a `systemd --user` unit on Linux and the LaunchAgent on macOS; without either you get one clear line instead of a stack trace, and `~/Library` is never created on Linux.
  - mcpd runs as a single instance and never moves to another port: if `mcpd.port` is busy it fails and names the process that holds it, in `mcp daemon status` and `doctor` too. `mcpd.port` is removed when mcpd stops.
  - A broken `mcp.toml` no longer keeps mcpd from starting: it serves the last valid copy (or no servers) and shows the error in `mcp daemon status` and `doctor`. A broken `config.toml` falls back to defaults.
  - `mcpd.log` rotates at 5 MiB, and socket or disk errors are logged instead of stopping the daemon.
  - The LaunchAgent runs as `Interactive`, prefers a stable `turno` or node path over a version manager's, restarts only after a failure, and is written through the journal (`turno undo` restores it). `mcp daemon start --dry-run` prints it; `mcp daemon stop` also removes it, so mcpd does not come back at login; `turno upgrade --finish` rewrites it and restarts mcpd.
  - `turno doctor` checks that the port is held by your own mcpd, that the service file points at paths that exist, that synced profiles use mcpd's port, and that the token file is mode 600.
  - New `turno mcp token rotate`. The token file's mode is checked and fixed on every read.
  - `turno mcp daemon logs` shows local time (`--utc` for the raw lines).
  - `turno mcp daemon` rejects unknown flags and `--help` never runs an action.
  - `turno upgrade` accepts only a plain version from the registry or `--to`.
  - On Linux the client of a gateway connection is found from `/proc` when `lsof` is missing.
- c877e8a: MCP gateway: calls now always finish, and server requests reach the right session.
  
  - Pressing Esc on a slow tool, closing a session, or a new optional `call_timeout` per server
    now cancels the call on the server too, so idle servers stop again as they should. Cancelling
    an `accounts_delegate` run stops the other profile's process and records it as `cancelled`.
  - Editing `mcp.toml` applies to sessions that are already open (a rotated token, new args, a
    changed scope or idle time); a removed server says so instead of running the old definition.
  - On a shared server, a confirmation form or sampling request is sent only to the session whose
    call asked for it; when several sessions are mid-call, it is refused instead of guessed.
    Elicitation and sampling are offered to a server only when your client supports them.
    Project and session servers get `roots/list` answered from their folder, even at startup.
  - Folders with accents, CJK characters or emoji no longer break every gateway server: the
    launchers send the folder encoded (`X-Turno-Cwd-B64`; run `turno mcp sync` and `turno profile
    repair` to pick it up), and mcpd falls back to the session process folder.
  - Tool lists refresh by themselves after each server start and clients are told when they
    change; `resources/list` is no longer cached across projects. The gateway has a
    `POST /refresh/<server>` endpoint.
  - Remote proxies reconnect when the remote server forgets the session, and `type = "sse"` works.
  - Browser-like `session` servers stay up while their session lives; exclusive leases hold
    during long calls; request bodies up to 32 MiB; resource updates go only to subscribers;
    server logs rotate while running.
  - A server that keeps failing to start answers at once with the end of its log and is retried
    with backoff. After an mcpd restart, open conversations keep working instead of getting 404.
  - A declared `package` that is not installed still runs through npx, now with a warning that
    suggests `turno mcp install`.
- a84e56c: Security checks and hardening:
  
  - `turno doctor --security` checks who can read or write turno's folders (`--fix` narrows them
    to owner only), who holds the mcpd port, literal secrets left in `mcp.toml`, agent configs
    and backups (it names where, never the value), MCP servers that do not run an exact version,
    the age of the mcpd token and the audit log's hash chain. `turno doctor` shows which secret
    store `keychain:` references use.
  - `turno identity log --verify` (also `turno accounts log --verify`) checks the audit log's hash
    chain and exits 1 when it is broken; `log --json` lists the entries.
  - mcpd expands `${VAR}`, `${VAR:-default}` and `${env:VAR}` inside a stdio server's args and env
    values and a proxied server's headers, as Claude Code does. A missing variable stops that
    server with an error that names it, instead of passing the literal text.
  - `turno config set mcpd.max_request_body 64MiB` changes the largest request mcpd accepts
    (default 32 MiB).
  - Logs, marks, caches and state files turno writes are created 0600 in 0700 folders.
  - A secret store error prints one line instead of a stack trace; `turno mcp import
    --move-secrets` uses the secret store of the environment it runs in.
  - `turno status` says why mcpd is down (its last start error, who holds its port).
    `turno mcp daemon status` says "1 client session" and shows calls in flight per session.
    `turno usage` says why an account is unknown (claude missing, a timeout) instead of `? · ?`.
  - `turno mcp refresh` reports the instances mcpd could not refresh and exits 1.
- 7da71a8: mcpd follow-ups:
  
  - `turno mcp logout` tells a running mcpd, which stops using the old access token at once
    (it used to keep it for up to a minute). New admin endpoint: `POST /logout/<server>`.
  - When mcpd stops, it tries once more to save rotated OAuth tokens the secret store refused
    earlier, and logs the servers whose tokens are still lost.
  - `/status` reports the memory pressure (`memoryPressure`: level, idle cap, setting), and
    `turno mcp top` shows it in its header (and as `memoryPressure` in `--json`). A change to
    `mcpd.idle_under_pressure` in config.toml now applies without a restart.
  - Open sessions get `tools/list_changed` (and prompts and resources when the server is hidden
    or shown) when an `mcp.toml` tool filter or a folder's server set in config.toml changes
    what they see.
  - A call cancelled while its server is still starting is dropped instead of sent once the
    server is up.
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
- 43beccc: Each profile now has its own MCP gateway token, and servers can hide tools.
  
  - `turno mcp sync` writes each profile's own token into its agent config (derived from the master token), and plain `claude` gets the system profile's. mcpd takes the profile from the token, not from the `X-Turno-Profile` header: a profile cannot open a server limited to other profiles, and a header that names another profile is refused.
  - The master token in `mcpd.token` is no longer written into agent configs and only opens mcpd's own endpoints. **After upgrading, run `turno mcp sync` once**: configs synced by an older turno still send the master token, and mcpd refuses it for MCP sessions with a message that says so. `turno upgrade --finish` and `turno doctor` point it out too.
  - Codex, Copilot and Cursor launchers read their profile's token from `~/.local/state/turno/mcpd-tokens/<profile>.token` (mode 600, written by `turno mcp sync`). `turno mcp config --agent <a> --profile <p>` points other agents at that file.
  - `turno mcp token rotate` invalidates every profile token at once; run `turno mcp sync` afterwards.
  - New `tools = { allow = [...], deny = [...] }` in `mcp.toml`, per server and per profile variant (glob patterns). Filtered tools are not listed and calls to them fail with a clear error. `turno config check` validates them.
- 3f675f0: Security hardening of secrets, state files and `turno open`:
  
  - `turno secret set` and `turno mcp import --move-secrets` no longer pass the value as a command argument: on macOS it goes to `security -i` on stdin, so it never shows in the process list.
  - Linux: `turno secret set|has|rm|list` and `keychain:` references in `mcp.toml` use the Secret Service through libsecret's `secret-tool` (attributes `service=turno`, `account=<name>`). Without a secret store turno prints one line suggesting `env:` references instead of a stack trace.
  - turno's config, state and data folders are created with mode 0700 (existing ones are narrowed on first use), and the files turno writes there (`config.toml`, `mcp.toml`, `accounts.toml`, the audit log, backups) are 0600.
  - Backups made before each change are private (0700 folders, 0600 files) and pruned: writing a new backup deletes those older than 30 days, always keeping the newest 10 and any backup that is still the only way back for a file. `turno undo --prune [--older-than 30d] [--keep 10] [--dry-run]` prunes by hand.
  - The accounts bridge audit log is append-only and hash-chained: each line carries the hash of the line before it, so edits and deletions can be detected.
  - `turno open` accepts only http(s) and mailto links, refuses arguments that start with `-`, treats `--help` as help, and works on Linux (`xdg-open`; claude.ai links open in an isolated Chrome profile when `google-chrome`, `google-chrome-stable` or `chromium` is on PATH).
- f46b7c6: `turno undo` reverts a whole profile setup, and `turno uninstall` removes what turno set up.
  
  - `turno profile add` and `turno profile repair` now record the links, launchers and folders they create, the links and empty folders they replace, and the files they move to `.aside-<time>/`. `turno undo <stamp>` removes those links and launchers, moves your own files back, removes the `.aside-*` folder and the profile folder when it is empty again. A profile folder that holds a login (or anything made since) stays. `profile repair` prints its own `undo with:` line, and a launcher that did not change is no longer rewritten.
  - New `turno uninstall [--dry-run] [--yes] [--keep-config]`: stops mcpd and removes its LaunchAgent or systemd user unit, removes the MCP entries `turno mcp sync` added (your own entries stay), puts back the status line you had before `turno ui install` (or removes turno's), removes the launchers turno wrote, its fish completion file, the gateway token and `~/.config/turno` (kept with `--keep-config`). It prints the full list first, asks in a terminal and refuses without one unless `--yes`. Profile folders, browser profiles, backups and Keychain secrets stay and are listed; shell startup lines that load turno's completion are listed to remove by hand. The run is journaled, so `turno undo <stamp>` puts everything back while turno is still installed. The last line is the command that removes the package (`npm uninstall --global turno-cli`, or `brew uninstall turno`).

### Patch Changes

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
- d3c89cd: Faster help and startup, with the same output.
  
  - `turno --help` renders from a static table of command summaries and no longer loads every command module (about 3x faster).
  - `turno`, `turno status` and `turno mcp ...` no longer load the MCP SDK just to read the gateway's token, port and lock files, or to list OAuth logins.
  - `claude auth status` answers are kept for five minutes in turno's state folder, keyed by the profile's login files (`.claude.json`, `.credentials.json`), so `turno`, `turno status` and `turno profile list` no longer start one `claude` per profile on every run. Logging in or out asks again; failures are never kept.
  - `turno profile which` and `turno status` ask git for the folder's repository once instead of once per agent.
  - The CLI turns on Node's compile cache in `~/.cache/turno` (or `$XDG_CACHE_HOME/turno`); `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` work as for any Node program. `turno demo` runs without it, and `turno uninstall` lists the folder as one that stays.
- a53b716: `turno init` and `turno mcp import` now find MCP servers configured inside profile folders (`~/.claude-<name>`, `~/.codex-<name>`, ...), not only in each agent's main config. Previews (`turno init --dry-run`, `turno mcp import` without `--write`) no longer ask npm for command names; that lookup happens only when the manifest is written.
- ab12f13: `turno secret` refuses unknown flags and extra arguments, and `turno secret set --help` prints the usage instead of waiting for a value for a secret named `--help`.
- fb2fa3d: The status line no longer shows `$0.00` for models it has no price for: it shows Claude Code's own
  figure or `$?`. Prices were added for Claude Opus 4.5 and 4.1, Sonnet 4.5 and 4, the 3.x models,
  Mythos, and Bedrock or Vertex model ids; Fable 5.2, Sonnet 5.5 and Haiku 5.5 prices were corrected.
  A damaged cache file, an unexpected payload, a full disk or a read-only state folder now leaves one
  part of the line empty instead of replacing the whole line with an error. The plan is asked again
  every 10 minutes until it is known. The branch is read without running git, the status line cache
  is pruned after a week, and the line shows `mcpd down` when the MCP gateway the agents use does not
  answer.
- 55a2de1: Internal: each agent's differences now live in its adapter (ADR 0032), dead code is gone, and `pnpm check` lints with Biome and knip. No output changes for valid setups; an agent JSON config that is valid JSON but not an object is now reported instead of rewritten by `turno mcp sync`.

## 0.1.1

### Patch Changes

- d28b959: `turno upgrade` recognizes a Homebrew install and runs `brew update` and `brew upgrade turno`
  instead of `npm install --global`.
- ce52d03: The repository moved to `github.com/wimo-dev/turno`. turno-browser is listed in the MCP
  Registry as `io.github.wimo-dev/turno-browser`.

## 0.1.0

First public release.

- One MCP gateway (`mcpd`) for every agent session: tool lists from a cache, servers started on
  first use, shared between sessions where it is safe, stopped when idle, secrets in the macOS
  Keychain. `turno mcp import`, `install`, `sync`, `config` and `doctor` move existing servers
  behind it.
- Profiles for Claude Code, Codex CLI, GitHub Copilot CLI and Cursor CLI, each with its own
  login folder and launcher, and folder rules (`turno profile assign`, `turno auto
  [--agent]`). Claude Code profiles share conversations, skills and settings.
- Gateway entries for opencode, Gemini CLI, Goose, Crush, Droid and Kiro
  (`turno mcp config --agent <name>`).
- The Claude Code status line with usage per account, its font and terminal setup
  (`turno ui install`).
- The accounts bridge, a builtin MCP server that delegates a task to a service account another
  profile is signed into, with confirmation for writes and an audit log.
- `turno status`, `doctor --fix`, `--json` on reads, `--dry-run` and `turno undo` on writes,
  shell completion, `turno upgrade`, and a daily update check that honors `DO_NOT_TRACK`.
