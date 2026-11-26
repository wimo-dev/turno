/**
 * `turno help <topic>`: environment, exit-codes and json (like gh's help topics). Static text
 * only, so a topic loads no command module.
 */
import { EXIT_ROWS } from "./exit.js";
import { columns, examplesBlock } from "./io.js";

/** Variables turno reads, by section: name and what it does. */
const ENVIRONMENT: readonly { title: string; rows: readonly (readonly [string, string])[] }[] = [
  {
    title: "Where turno keeps things",
    rows: [
      ["TURNO_CONFIG_DIR", "config.toml and mcp.toml (default: $XDG_CONFIG_HOME/turno, else ~/.config/turno)"],
      [
        "TURNO_STATE_DIR",
        "state, logs, caches and backups (default: $XDG_STATE_HOME/turno, else ~/.local/state/turno)",
      ],
      [
        "TURNO_DATA_DIR",
        "installed servers and browser identities (default: $XDG_DATA_HOME/turno, else ~/.local/share/turno)",
      ],
      ["TURNO_BIN", "where the launchers go (default: ~/.local/bin)"],
      ["TURNO_HUB", "Claude Code's shared folder (default: ~/.claude)"],
      ["TURNO_HUB_CONFIG", "Claude Code's shared .claude.json (default: ~/.claude.json)"],
      ["TURNO_FONT_DIR", "where turno ui installs the status line font"],
      ["TURNO_APPS_DIR", "where turno looks for terminal apps on macOS (default: /Applications)"],
      ["TURNO_CHROME_APP", "Google Chrome on macOS, for turno open (default: /Applications/Google Chrome.app)"],
      ["TURNO_CHROME_BIN", "the Chrome program on Linux, for turno open"],
    ],
  },
  {
    title: "How turno behaves",
    rows: [
      [
        "TURNO_NO_INPUT",
        "1: never ask, exit 2 and name the flag instead (same as --no-input); 0: ask even inside an agent session",
      ],
      ["TURNO_COLOR", "always, never or auto (same as --color); see the order below"],
      ["TURNO_ALLOW_PLAIN", "1: turno auto runs the plain agent when config.toml does not parse"],
      [
        "TURNO_SAFE",
        "1: turno run, turno <profile> and turno auto open the agent in safe mode, without the gateway and the status line (same as --no-gateway)",
      ],
      ["TURNO_NO_UPDATE_CHECK", "1: no daily update check and no notice"],
      ["TURNO_NO_UPDATE_NOTIFIER", "1: same as TURNO_NO_UPDATE_CHECK (the name gh uses)"],
      ["TURNO_REGISTRY", "npm registry for update checks (default: npm_config_registry, else registry.npmjs.org)"],
      ["TURNO_BROWSER_IDLE", "turno-browser closes Chrome after this long without a tool call (default: 15m)"],
      [
        "TURNO_BROWSER_BACKGROUND_IDLE",
        "the background server of a browser identity exits after this long without a request (default: 15m; 0: never)",
      ],
      [
        "TURNO_BROWSER_EXIT_CHECK",
        "0: turno-browser does not look up where a proxy exits (one HTTPS request to get.geojs.io through the proxy, once a day)",
      ],
      ["TURNO_LIGHTPANDA_PATH", "the Lightpanda binary turno-browser's read mode runs (default: lightpanda on PATH)"],
      [
        "TURNO_BROWSER_SESSION",
        "the session name of turno browser do (same as --session; default: default), to keep several apart",
      ],
      [
        "TURNO_CAMOUFOX_PATH",
        "the Camoufox executable turno-browser's camoufox engine runs (default: the newest in Camoufox's cache)",
      ],
      [
        "TURNO_PLAYWRIGHT_CORE",
        "the playwright-core folder the camoufox engine runs on (default: the one next to turno-browser)",
      ],
      [
        "TURNO_BROWSER_ACT_CLI",
        "off: natural language actions never run the Claude Code CLI or Codex (MCP sampling and API keys still count)",
      ],
      [
        "TURNO_BROWSER_CAPTCHA_ENDPOINT",
        "a task-api captcha solver's URL, for identities without a captcha group (with TURNO_BROWSER_CAPTCHA_KEY)",
      ],
      ["TURNO_BROWSER_CAPTCHA_KEY", "that solver's account key, hidden from every result"],
      ["TURNO_BROWSER_NOTIFY", "off: turno-browser shows no notification of the system, for any identity"],
    ],
  },
  {
    title: "Set by turno for the agents it starts (read them, do not set them)",
    rows: [
      ["TURNO_PROFILE", "the profile a launcher opened"],
      ["TURNO_AGENT", "that profile's agent (codex, copilot, cursor)"],
      ["TURNO_SESSION_PID", "the agent's process id, sent to the gateway"],
      ["TURNO_SESSION_CWD_B64", "the agent's folder (base64url), sent to the gateway"],
      ["TURNO_MCPD_TOKEN", "the profile's gateway token, for agents that read headers from the environment"],
      ["TURNO_MCPD_SERVICE", "set by the mcpd service file (LaunchAgent or systemd unit)"],
      [
        "TURNO_BROWSER_PROMPTED_PARAMS",
        "set by turno browser replay for the server it starts: the parameters typed at its hidden prompt",
      ],
      [
        "TURNO_BROWSER_ACT_CHILD",
        "set by turno-browser for the Claude Code CLI or Codex it runs: a turno-browser under it never runs one again",
      ],
    ],
  },
  {
    title: "Standard variables turno honors",
    rows: [
      ["NO_COLOR", "set and not empty: no colors (no-color.org)"],
      ["FORCE_COLOR", "0 or false: no colors; anything else: colors, also in a pipe"],
      ["CLICOLOR_FORCE", "set and not 0: colors, also in a pipe"],
      ["CLICOLOR", "0: no colors"],
      ["TERM", "dumb: no colors"],
      ["COLUMNS", "the width to lay out for (default: the terminal's, else 80)"],
      ["DO_NOT_TRACK", "1: no update check (turno sends nothing else anywhere)"],
      ["CI", "set: no update check"],
      ["NO_UPDATE_NOTIFIER", "1: no update check"],
      [
        "XDG_CONFIG_HOME, XDG_STATE_HOME, XDG_DATA_HOME, XDG_CACHE_HOME",
        "base folders, when the TURNO_* ones are not set",
      ],
      ["VISUAL, EDITOR", "the editor of turno config edit"],
      [
        "NODE_COMPILE_CACHE, NODE_DISABLE_COMPILE_CACHE",
        "Node's compile cache (turno keeps it in $XDG_CACHE_HOME/turno)",
      ],
    ],
  },
];

function environment(): string[] {
  const out = ["Environment variables turno reads.", ""];
  for (const s of ENVIRONMENT) out.push(`${s.title}:`, columns(s.rows, 2, 26), "");
  out.push(
    "Colors: the first that applies wins: --color, TURNO_COLOR, NO_COLOR, FORCE_COLOR,",
    "CLICOLOR_FORCE, then CLICOLOR=0 or TERM=dumb, then whether output is a terminal.",
    "--json output is colored only on a terminal.",
    "",
    examplesBlock([
      "NO_COLOR=1 turno status",
      "TURNO_NO_INPUT=1 turno profile remove work  # fails fast instead of asking",
      "TURNO_CONFIG_DIR=/tmp/t turno doctor",
      "TURNO_SAFE=1 turno work  # without the gateway, to tell whether a problem is turno's",
    ]),
  );
  return out;
}

function exitCodes(): string[] {
  return [
    "Exit codes. Scripts, hooks and status lines can rely on these.",
    "",
    columns(
      EXIT_ROWS.map(([code, name, what]) => [`${code}  ${name}`, what] as const),
      2,
      18,
    ),
    "",
    "With --json, an error is one JSON line on stderr with the same code:",
    '  {"schemaVersion":1,"error":{"code":"no_profile","exitCode":3,"message":"..."}}',
    "",
    examplesBlock([
      "turno profile which --check || turno profile assign . work",
      "turno mcp daemon status >/dev/null; [ $? -eq 5 ] && turno mcp daemon start",
    ]),
  ];
}

function json(): string[] {
  return [
    "JSON output. Read commands take --json:",
    "",
    columns(
      [
        ["--json", "every field, as one indented document"],
        ["--json=fields", "the field names, one per line, and nothing else"],
        ["--json=a,b", "only those fields; an unknown one is a usage error (exit 2) that lists the known ones"],
        [
          "--watch --json",
          "one compact JSON record per line (NDJSON) until Ctrl-C (turno limit show, turno mcp top); turno mcp log --follow --json too",
        ],
      ],
      2,
      16,
    ),
    "",
    "Every object carries schemaVersion, and so does each element of a list. A version",
    "goes up only when a field is removed or renamed or changes meaning (the changelog",
    "says so); new fields keep it. Errors under --json are JSON on stderr (turno help",
    "exit-codes). turno config get prints a config value as it is in config.toml.",
    "",
    examplesBlock([
      "turno status --json=fields",
      "turno profile list --json=name,email",
      "turno limit show --watch --json | jq -c '.fiveHour'",
    ]),
  ];
}

export const TOPICS: Readonly<Record<string, { summary: string; text: () => string[] }>> = {
  environment: { summary: "every environment variable turno reads", text: environment },
  "exit-codes": { summary: "what each exit code means", text: exitCodes },
  json: { summary: "the --json contract: fields, schemaVersion, NDJSON, errors", text: json },
};
