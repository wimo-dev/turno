# turno-browser

## 0.11.0

### Minor Changes

- 16ae3c1: Natural language actions (`browser_act`, `browser_extract`, `browser_observe`) are on whenever a model can answer them, without an identity.json `act` group. The server takes the first that works: MCP sampling when the connected client offers it (decided per connection), else `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the environment, else the Claude Code CLI (`claude -p`, `haiku`) or Codex (`codex exec`, `gpt-5.6-terra`) found on the PATH, run headless with your own login; with none of them the tools are not listed. The CLI gets the prompt on its standard input, never on its command line, runs with its tools off and no MCP server loaded, and stops after 90 seconds; `TURNO_BROWSER_ACT_CLI=off` keeps the CLIs out of it. A provider named in identity.json keeps working as before. Captcha solving is on when a solver key is configured, in identity.json or with `TURNO_BROWSER_CAPTCHA_ENDPOINT` and `TURNO_BROWSER_CAPTCHA_KEY` in the environment; without one, a result that ends on a captcha says so and hands the step to the person with `browser_request_human`. `show`, `status` and `doctor` say which path each identity resolves to and why. See [Natural language actions and captcha solving](https://turno.wimo.dev/docs/browser/natural-language-and-captchas).
- 465c6d0: Recorded flows and repeated steps check that they act on the same element. Each flow step keeps a fingerprint of its element (role, accessible name, label, nearest landmark, and the page's URL with ids as `*`); on replay, the element a locator finds must match it, or the step does not run and the replay stops with what differs and a fresh snapshot. With `record.flows` (on by default) the identity also keeps an action cache in `~/.local/share/turno/browser/action-cache/<id>.json` (mode 600): an action that names an element by a selector (a `browser_batch` step, `turno-browser do click '#save'`) is refused when the selector now finds another element than the one an earlier action worked on. Neither the cache nor a flow keeps a vault value: names the redactor knows are stored as their mark, and a locator that holds one is dropped. Measured with the new `pnpm bench:cache` on five changed versions of a form: replays went from 3 wrong-element clicks in 45 steps to none (15% of steps refused), and the same actions repeated by CSS selector from 9 wrong-element actions in 45 to none (27% refused).
- c192bd4: `browser_batch` checks each step and says why it stopped. An action can carry `expect`: text the page must show after it, text that must be gone, a part of the URL, or the value its target must hold (a field's text, the selected option's label, `"true"` for a checked box), waited for up to `timeout` ms (default 5000). The first action that fails, or whose check does not hold, stops the batch; its error starts with a stable code (the `ELEMENT_*` codes of a diagnosed element, and `INVALID_ACTION`, `TIMEOUT`, `REFUSED`, `CHECK_FAILED`, `ERROR`), its line in the batch says the code, and the result carries a snapshot of the page at the failure, so the agent needs no extra call to see where it stands.
- 6a2c0d1: Page snapshots are compact. Every element an agent can act on keeps its ref, and the text a reader needs stays, while wrappers without a name, the destination under a named link, separators, text that repeats a neighbouring button's name, refs on elements nobody acts on and runs of identical rows are left out. Measured with the new `pnpm bench:snapshot --public`: Hacker News 12,238 to 3,786 tokens, a GitHub repository page 18,879 to 7,721, Wikipedia search results 5,842 to 3,040, with every interactive ref kept and the same answers to fixed questions. A page still past about 15,000 tokens once compact (a long Wikipedia article: 128,673 tokens) comes back as a table of contents of its landmarks, headings and text fields with refs and sizes (849 tokens). The new `browser_read` tool reads one part by ref, the whole page compact, or with `full: true` the page as Playwright wrote it. `TURNO_BROWSER_SNAPSHOT=full` in the server's environment turns compaction off; `turno help environment` lists it.
- f717317: turno-browser turns its features on by default, worked out at every launch and never written into identity.json. `show`, `status` and `doctor` list each value with where it came from, for example `resources: low (auto: memory pressure)`.
  
  What changes for an existing identity, without touching its identity.json: the live view is on (it opens only with `turno-browser live`); flows and screenshots are recorded, under the 200MB cap and never of a page with a vault value (traces stay off: while tracing, Chrome loads no image or frame of another site); the `vision`, `pdf`, `devtools` and `network` tools are listed when the server has no `--caps`; `browser_login` submits the form (`vault submit <id> confirm` keeps the old behavior, and must be run again even if it was chosen before); the low-resource preset turns on under memory pressure; human-like input is `auto`; several agent sessions share the browser in their own tabs, so `browser_close` closes a session's tabs and the idle release closes the browser (`--sharing session` for one at a time; an mcp.toml block with `exclusive = true` keeps working, and doctor says how to change it); a headless Chrome gets the coherent user agent (once `login` has read that Chrome's client hints) and background throttling when the live view is off; Chrome gets the system's locale when identity.json names none; and `login` finds a health check when there is none. A key set in identity.json still wins over every default, and `off` (`--health off`, `--locale off`, `--user-agent off`) pins one off. A file with an `auto` or `false` value is written as format 14, which turno-browser 0.10 refuses.
  
  New identities created at a terminal on macOS with Google Chrome keep their cookie key in the system keychain, and `add` mentions Camoufox, Lightpanda and attach mode when they apply. turno prints the mcp.toml block of a new identity with `exclusive = false`, except in attach mode.
- c2a8cbc: The agent cursor's default (`cursor: "auto"`) is drawn by Chrome now, with nothing in the page: when the browser can be seen (a window, or the live view), Chrome highlights the element the agent acts on and shows a ripple for each click of the agent, painted above the page where no page script can see them. The highlight shows in the live view too and is hidden while the model's screenshot is taken. The named arrow, the ring and the badge drawn in the page are `cursor: "on"`, and the fallback when Chrome refuses the protocol calls. The reputation bench's probe page now reports elements no page script made under `<html>`.
- 6fbaf91: The live view is a panel now: the agent's tab next to a timeline of its steps (the time, what it did, the element or address, how long it took, and whether it failed or was not run), with the pauses, your turns and what changed when you handed the browser back. A line never shows what the agent typed, filled or selected, a script, or an address's query, and every line goes through the same redaction as the agent's results, so vault values stay hidden. When the same call on the same element fails three times in a row, the line and the status say the session looks stuck. New steps and changes of state are announced to screen readers. `turno-browser live` opens the view as an app window of your Chromium browser (`--tab` for a tab of the default browser).
  
  You can take the controls without pausing first: clicking, typing or scrolling on the picture while the agent works, or in the agent's Chrome window, makes the agent's next call wait. The browser goes back to the agent 5 seconds after your last input, or with the view's Hand back button (Resume before), and the waiting call is told that you used the browser and what changed. `turno browser live` without a running server no longer says the view is off when only no server runs.
- 3a1482a: The last click is yours: when the agent's `browser_click` would place an order, make a payment, send a message or money, publish a post or confirm a deletion, turno-browser does not click. The agent is told what the click would do and to ask you with `browser_request_human` and `requireHumanClick`, and that step's banner says what the click does, from the page: the order's total, the amount, who a message goes to. The check is conservative: a word that also names a harmless step ("Buy now", "Send", "Post", "Delete") counts only when the page agrees (a checkout with an amount, a message being written, a dialog that warns it cannot be undone), and steps on the way ("Add to cart", "Proceed to checkout", "Send code") never count. `turno-browser set <id> --last-click false` turns it off.
  
  turno-browser shows a notification of the system when the agent waits for you (a person step, a passkey prompt, a captcha no solver answers) and when it is done after a long run, with `osascript` on macOS, `notify-send` on Linux and a PowerShell toast on Windows. The text is redacted like any result and is never run as a script. `turno-browser set <id> --notify false` or `TURNO_BROWSER_NOTIFY=off` turns them off. identity.json format 14 also takes the `notify` and `lastClick` keys; a file that sets one is refused by an older turno-browser.
- 612479e: The `storage` tools (cookies, localStorage, sessionStorage and the storage state file) are listed by default, with session values masked: a cookie that is HttpOnly, named like a credential (`session`, `sid`, `token`, `auth`, `csrf`, `login`) or holding a random-looking value, and the tokens in stored items, read `[masked]`. Names, domains, paths, expiry and flags stay. After every browser call the server reads the cookies and the page's web storage, so a random-looking session value is also hidden from `browser_evaluate` (`document.cookie`), response bodies, console messages, snapshots and written files. A mask written back keeps the value it stands for, in the same cookie or item only, so `browser_cookie_set` with `[masked]` and `browser_set_storage_state` with a saved file keep the session. Attach mode and a policy that lists `storage` keep the tools off.
  
  Without a proxy of its own, an identity's Chrome follows the system's proxy as before; `show` and `status` now name it (macOS `scutil --proxy`, Windows Internet Settings, GNOME settings or the proxy variables), and `"proxy": false` makes Chrome connect directly. With a proxy in use, turno-browser looks up where it exits (one HTTPS request to get.geojs.io through the proxy, once a day per proxy) and warns when the identity's time zone or locale does not match; `TURNO_BROWSER_EXIT_CHECK=0` turns the lookup off.
- a6e1eef: What a page reads about the browser is now what the same Chrome shows without turno on this computer. The color scheme, reduced motion and contrast follow the system instead of Playwright's light default. A headless Chrome reports the computer's primary display and the window Chrome would open on it (1200x852 on a 1512x982 MacBook screen) instead of a 1280x720 page on an 800x600 screen; a viewport, device or `--window-size` you set still wins. An identity's time zone and locale are set when Chrome starts (`TZ` and `LANG` of its process, `--lang`, `--accept-lang`), so workers read the same values as their page, and without a locale in identity.json Chrome reads the system's language itself, as it does for a person (on macOS that is `es-419` for a Mexican Spanish system, not `es-MX`).
  
  The passkey watch no longer adds a script and a binding to every page: it wraps `navigator.credentials` only on a sign-in page while the agent acts on it, and puts Chrome's own methods back 3 seconds later, so a page reads native methods at load. With human-like input off, a click lands at a point inside its element instead of the exact center, at no cost in time. An identity that names no browser runs Google Chrome from ~/Applications too.
- cbed7d4: An action that stays on the page (a click, a key, a selection, a drag) answers with what changed since the last snapshot the agent was given, by ref, when it is the same session and URL and the changes are under half the compact page. Before, the result only linked the snapshot file Playwright wrote, and an agent that wanted to see what its click did called `browser_snapshot` for the whole page: opening the "Code" menu on a GitHub repository page now answers with 262 tokens of changes, against 7,683 for the page. A navigation, another tab or a change that is most of the page answer as before, and `browser_snapshot` always returns the whole page. `TURNO_BROWSER_SNAPSHOT=compact` turns the changes off.

### Patch Changes

- 2187b40: `turno-browser doctor` says whether the installed patchright-core is the version the reputation suite last passed with, and warns when it is another one: how turno's scripts reach pages and the automation leak checks were not verified on it.
- e2e3b8c: The wait after a click, key press or typed text now ends as soon as the page is done with the action: the requests it started have answered (or none started within 100 ms), a navigation has reached DOMContentLoaded, and nothing on the page changed for two animation frames, checked in an isolated world the page cannot see. Playwright's fixed wait (`settle`, 500 ms by default, twice when the action made requests) is now only the limit. On the local evaluation suite a click went from 860 ms to 413 ms at the median (1,432 to 552 ms at p95), with the agent cursor's glide in both. Camoufox and read mode keep Playwright's wait.
  
  Action errors that name what is in the way start with a stable code (`ELEMENT_COVERED`, `ELEMENT_HIDDEN`, `ELEMENT_DISABLED`, `ELEMENT_READONLY`, `ELEMENT_GONE`, `ELEMENT_NOT_STABLE`), which JSON results carry as `code` with the covering element as `cover`. A click that opens a `confirm()` or `alert()` dialog no longer hangs until the client's timeout, and `browser_handle_dialog` answers it while the agent cursor draws (it waited on the page the dialog holds) and without a step screenshot waiting out its 5 seconds. A page that closes its own tab right after an action returns the tab now current instead of an error.

## 0.10.1

### Patch Changes

- 2c8541c: A tool call whose navigation the policy takes back no longer waits until a timeout. The tab used to go back in history, and Chrome restored the page from its back/forward cache, for which Playwright sees no DOMContentLoaded or load: a `browser_navigate` whose redirect left the allowed domains could wait the full 60 s navigation timeout, which is also the MCP client's limit, so the call failed with "Request timed out", and a click on a refused link took about 15 s. The tab now loads its last allowed page again, and the call returns as soon as it shows.

## 0.10.0

### Minor Changes

- d65d855: turno-browser runs on Windows 10 and 11 (x64): `npm install --global turno-browser`, no admin rights. It finds Google Chrome, Microsoft Edge and Brave in `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%`, and `install-browser` puts Chrome for Testing in `%LOCALAPPDATA%\ms-playwright`. Identities live in `%LOCALAPPDATA%\turno\data`, settings in `%APPDATA%\turno` and runtime state in `%LOCALAPPDATA%\turno\state`; the `TURNO_*_DIR` and `XDG_*` variables still move them. The background server and the live view listen on named pipes (`\\.\pipe\turno-browser-<id>-<hash>`) instead of socket files. A Chrome left running is found through its profile's lock and the process table, and ended with its helpers by `taskkill /T`; messages say `taskkill /PID <pid> /T /F` where they said `kill <pid>`. `setup` and `init` register the server as `cmd /c turno-browser-mcp --identity <id>`, and `init --yes` runs an agent's `.cmd` command through `cmd.exe` with each argument quoted. The vault and `keychain:` secrets use turno-core's Windows secret store (DPAPI files). Lightpanda has no Windows build.
  
  turno-core: the turno folders follow Windows' conventions (`%APPDATA%`, `%LOCALAPPDATA%`), `findOnPath` reads `PATHEXT`, a file replaced while another process reads it is retried instead of failing, and `killTree` ends a process tree on every platform. The Windows process table and the DPAPI store call WMI and DPAPI through .NET only, with no cmdlet, so Windows PowerShell answers in a fraction of a second even in the few variables an agent passes its servers (a cmdlet there took 20 seconds).

### Patch Changes

- 30e4617: turno-browser now also comes as a standalone executable for machines without Node or npm: one file per platform (macOS on Apple silicon and Intel, Linux x64, and an experimental Windows x64) on each GitHub release, with `SHA256SUMS` and build provenance attestations. The executable is both programs: `turno-browser <command>`, and `turno-browser mcp` for the MCP server. In it, `turno-browser setup` and `init` give the agent the executable itself (`<path>/turno-browser mcp --identity <id>`), and `status` and `doctor` recognize that entry in an agent's config. See [Install without Node](https://turno.wimo.dev/docs/browser/get-started#install-without-node).
- c80b30c: A secret store on Windows: each item (a vault credential or a `keychain:` secret) is a file in `%LOCALAPPDATA%\turno\secrets` encrypted with DPAPI for the current user, through Windows PowerShell 5.1 with the value on stdin, never in a command line. It needs no admin rights and no native module, has no size limit (Credential Manager caps an item at 2560 bytes), and checking whether an item exists only looks at the file. `turno-browser doctor` now names the secret store in use, and on Windows its folder.
- Updated dependencies [d65d855]
- Updated dependencies [c80b30c]
  - turno-core@0.5.0

## 0.9.0

### Minor Changes

- acb9cf6: New per-identity policy in identity.json (format 13), written only by the command line: `turno-browser set <id> --policy-file <file>` (or `--allowed-domains`, `--disable`, `--auto-submit false`, `--no-policy`), `add` with the same flags, and `init --policy-file <file>` for an onboarding without a terminal. `allowedDomains` (like `example.com`, `*.example.com`, `localhost:*`) checks every main-frame navigation of every tab: `browser_navigate`, `browser_tabs` new, links, forms, scripts and popups are stopped before they leave Chrome, and a redirect to another host is taken back when it commits; the call fails with an error that names the host and the allowed list. Scripts, images and data a page loads from other hosts are not checked. `disabled` removes features from the identity (`act`, `captcha`, `login`, `totp`, `attach`, `evaluate`, `run_code`, `network`): their tools are not listed and are refused, and the settings they need are refused. Any policy turns `browser_run_code_unsafe` off, `allowedDomains` turns the network routing tools off, a tool's file argument inside turno's own folders is refused, and the server refuses to start with a `--caps` whose tools the policy turns off. `autoSubmit: false` keeps `browser_login` from submitting whatever `vault submit` says. `show --json` and `status --json` show the policy. An older turno-browser refuses an identity.json with a policy.
- 4088401: `turno-browser init` runs without a terminal. With `--yes` it now runs the agent's own `mcp add` command (for example `claude mcp add --scope user browser-<id> ...`) with its output captured, instead of only printing it; without `--yes` it still prints it. An agent that already has the identity's server is left as it is, so running `init` twice adds nothing and does not fail. `--json` prints one report of what was created, the sign-in step, and the agent's registration (the command it ran, its exit code and output), and never asks. `init` exits 1 when the agent's command fails and 127 when `--yes` names an agent whose program is not on the PATH. Each registration is recorded in the identity's state folder, so `remove` can take it out again.
- aa6bfe2: What a person sees in the browser comes in Spanish when the identity's locale is Spanish (`es`, `es-MX`, `es-419`; else the first of `languages`): the live view page and its messages, the `browser_request_human` banner and its Done button, the agent cursor's badge and the welcome page of `turno-browser login`. Any other locale, or none, keeps English. Tool results, tool descriptions and CLI output stay in English. The live view now shows a person step's pause as "Paused (your turn)" instead of the tool name.
- 6bf9b12: A low-resource preset for machines short of memory: `turno-browser set <id> --resources low` (identity.json `"resources": "low"`, or `turno-browser-mcp --resources low`) keeps at most 2 tabs open, parks an unused tab after 2 minutes, closes Chrome after 5 minutes without a tool call and the background server after 5 minutes without a request, turns off Chrome's back/forward cache so a parked tab frees its memory at once, and adds a short note to tool results while the system reports memory pressure. A key set on its own (`--tabs-max`, `TURNO_BROWSER_IDLE`, `--background-idle`) still wins over the preset. `turno-browser doctor` shows the memory pressure. The memory pressure probe mcpd uses moved to `turno-core/memory`, so turno-browser reads the same level.
- fb4c2e3: An identity can run on another Chromium-based browser than Google Chrome: `turno-browser set <id> --browser chrome|edge|brave|chromium|chrome-for-testing|<path>` (also on `add`; identity.json `browser`, format 13). Every command uses it: the agent's server, `login`, `export` and `import`, the background server and `replay`. A server's own `--browser` or `--executable-path` still wins over it. When Google Chrome is not installed, `add` and `init` pick the first browser they find and write it to identity.json, so a profile never changes browser by itself. Switching the browser of a profile another browser already opened is refused unless you pass `--force`, since the new browser rewrites the profile and, with `keychain: "system"`, cannot read the old one's cookies.
  
  New `turno-browser install-browser`: for a machine without any Chromium-based browser and no admin password, it downloads Chrome for Testing into the user cache with the installer of the patchright-core turno-browser uses (about 190 MB, no system change). `doctor` lists every browser it finds (Chrome, Edge, Brave, Chromium, Chrome for Testing), starts the first one when Chrome is missing, says which browser each identity uses and whether it is installed, warns when a newer browser last opened a profile, and names `install-browser` when there is none. turno-cli needs turno-browser's API 1.14.
- 0d9363d: A page's passkey prompt hands the browser to the person by itself. When a page starts a WebAuthn ceremony that puts up Chrome's passkey window (creating a passkey, or signing in with one), the agent's calls wait while a banner (in the identity's language, English or Spanish) asks the person to use their passkey there, and the step ends when the request settles, when the page navigates away from it, on Done or after 5 minutes. The call that started it (or the next one) says how it went, even when the identity's policy stopped a navigation during it: created, used, cancelled or timed out, left, or failed with the error's name, never credential data (`turno.passkey` in JSON). Passkey autofill (`mediation: "conditional"`) never stops the agent. Passkeys need a visible Chrome window: the watch, a small script that wraps `navigator.credentials`, goes in only when someone can see the browser (a Chrome window, or the live view on), like the agent cursor's `auto`. With `--headless` and the live view on, the live view cannot show Chrome's passkey window, so the agent is told to ask the person for a browser with a window instead of waiting. In attach mode only the agent's own tabs count.
- 4088401: Behavior change: `turno-browser remove <id>` (and `turno browser remove`, `turno identity remove browser:<id>`) now asks before it deletes anything, showing the list of what goes. `--yes` skips the question; without a terminal and without `--yes` it refuses with exit code 2 instead of deleting. It also removes what it used to leave behind: it stops the identity's background server, a Chrome on its profile and the turno-browser-mcp processes started for it (instead of refusing while they run); it takes the identity's MCP server out of each agent that has it with the agent's own command (`claude mcp remove --scope user browser-<id>`, `codex mcp remove`, `copilot mcp remove`, `gemini mcp remove`); it deletes the `keychain:` items identity.json references (proxy, act, captcha) unless another identity or turno's mcp.toml uses them, the vault's credentials even when the vault index is broken, and the session exports it wrote. Chrome's own cookie key (`"keychain": "system"`) is shared with every Chrome profile and is kept. Afterwards it checks that nothing is left and exits 1 when something is. `--json` reports `planned`, `deleted`, `failed`, `left` (each with the step that removes it) and `kept`. `destroy` is another name for `remove`. `turno identity remove browser:<id>` passes `--yes` and `--json` on to turno-browser.
- 4088401: New `turno-browser status [<id>] [--json]` (also `turno browser status`): each identity at a glance, read only. It shows the profile, a summary of identity.json (time zone, languages, engine, sharing, humanize, live view, recording, act, captcha, proxy), who holds it, the vault's sites and submit policy, the last sign-in by hand, the host names the profile holds cookies for (never their names or values; not read while Chrome has the profile open, and noted where Node has no `node:sqlite`), when it last served a tool call, and the agents whose config has it. A server now records the time of its last tool call (at most once a minute) in the identity's state folder, `last-used.json`. `doctor` checks that the secret store has an item for each vault credential (a lookup, never the value), and, run as turno-browser, which agents' configs have each identity: a server whose command is gone, one whose identity was deleted, a registration init made that the agent lost, and a config file that cannot be read. Only entries that run turno-browser-mcp count as turno's, so a server merely named `browser-<something>` is left alone by doctor and by `remove`.
- 31dc9de: A person step no longer outlasts the agent's tool call. A `browser_request_human` call waits for the step at most `waitMs` (50 s by default, up to 4 minutes); if the person has not finished by then, the call returns a "still open" result with the step's id and the step goes on, with the banner up and every other call held. The agent calls `browser_request_human` with `{ "continue": true }` (or the step's id) to keep waiting, and the step's timeout still counts from when it began. A call with a new instruction while a step is open is refused and names the open step. The click that starts a page's passkey prompt waits in the same pieces, and a cancelled call ends the step it asked for.

### Patch Changes

- f42408b: Attach mode no longer fails with "DevToolsActivePort is not a port and a path" when it reads the file while Chrome is still writing it, for example right after Chrome starts with remote debugging on. It now reads the file again for up to 5 seconds while it is missing, empty or partial, and only then says what to do. `turno-browser doctor` still checks it once, without waiting.
- Updated dependencies [6bf9b12]
  - turno-core@0.4.0

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
