import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";
import { HUMANIZE_LEVELS, type HumanizeLevel } from "./humanize.js";
import { assertIdentityId, identityDir } from "./identities.js";
import type { EngineFlags } from "./engine.js";
import type { LiveFlags } from "./live.js";
import {
  CURSOR_MODES,
  type CursorMode,
  MAX_LIVE_WAIT_MS,
  MIN_LIVE_WAIT_MS,
  RESOURCE_MODES,
  type ResourceMode,
} from "./settings.js";
import { parseAttachTarget } from "./engine-attach.js";
import type { TuningFlags } from "./tuning.js";
import { parseDuration } from "./units.js";

/**
 * Turns `turno-browser-mcp [--identity <id>] [playwright-mcp flags]` into the argv for the
 * Patchright MCP program, adding turno's defaults that the user did not set:
 *
 * - `--browser chrome`: the installed Google Chrome, not a bundled Chromium. With an identity
 *   whose identity.json names another `browser`, the engine launches that one instead, unless
 *   the user gave `--browser` or `--executable-path` (`browserFromFlags`): a flag wins.
 * - `--user-data-dir <dir>`: the identity's persistent profile, or a fresh temporary one.
 *   Patchright recommends persistent contexts, and the upstream default (a profile shared by
 *   every server started in the same folder) is neither isolated nor per identity.
 *
 * - `--config <file>`: a generated Playwright MCP config whose `timeouts.idle` closes Chrome
 *   after `TURNO_BROWSER_IDLE` (default 15 minutes) without a tool call, headed included; the
 *   next call opens it again with the same profile. `--idle-timeout` and
 *   `PLAYWRIGHT_MCP_IDLE_TIMEOUT` still win, and a `--config` of the user's own replaces it.
 *
 * Headed mode and `viewport: null` are already the program's defaults for headed runs, so
 * nothing is added for them; no init scripts are ever added.
 *
 * The tab governor, background throttling, humanize, sharing and cursor flags (`TUNING_FLAGS`) are turno's: they are
 * taken out here and win over identity.json. So are `--engine <chrome|lightpanda|camoufox>` and `--attach <target>` (`engine.ts`); with either and
 * no identity there is no Chrome profile to create. So are `--live` and `--live-wait <duration>` (`live.ts`), which need an identity.
 *
 * An identity holds saved logins, so serving it over HTTP (`--port`, `--host`) lets any local
 * process drive a signed-in browser without the stdio pipe or mcpd's token. That needs
 * `--allow-http-identity`, and even then the server binds to 127.0.0.1 and keeps the Host check.
 */

export interface BuiltArgv {
  /** Arguments for the MCP program (without node and script path). */
  args: string[];
  identity?: string;
  /** Profile dir passed to the program, when we chose it. */
  userDataDir?: string;
  /** Temporary dir to delete on exit (only for runs without an identity). */
  tempDir?: string;
  /** The Playwright MCP config to write before the program starts, when turno passes one. */
  config?: { path: string; data: PlaywrightMcpConfig };
  /** turno's own flags for the host, when any was given. */
  tuning?: TuningFlags;
  /** `--engine` and `--attach`, when given. */
  engineFlags?: EngineFlags;
  /** `--live` and `--live-wait`, when given. */
  live?: LiveFlags;
}

/** The keys of the Playwright MCP config file that turno sets (pinned by the contract test). */
export interface PlaywrightMcpConfig {
  timeouts: { idle: number };
}

/** How long Chrome stays open without a tool call, unless TURNO_BROWSER_IDLE says otherwise. */
export const DEFAULT_BROWSER_IDLE_MS = 15 * 60_000;

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `"15m"`, `"90s"`, `"500ms"`, `"1h"` or `"0"` (never) in milliseconds. */
export function parseIdle(value: string): number {
  if (value.trim() === "0") return 0;
  const m = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  if (!m) throw new Error(`TURNO_BROWSER_IDLE must be a duration like "15m", "90s" or "0" (never), not "${value}"`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  /** Creates the temporary profile root. Injected by tests. */
  makeTempDir?: () => string;
}

/** Flags that point the program at a browser it does not launch itself. */
const EXTERNAL_BROWSER = ["--cdp-endpoint", "--endpoint", "--extension"];

/** Opt-in to serve an identity over HTTP; consumed here, never passed on. */
const ALLOW_HTTP_IDENTITY = "--allow-http-identity";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Value of `--flag v` or `--flag=v` (the last one wins, as in commander). */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag && args[i + 1] !== undefined) out.push(args[++i]!);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}

function guardHttp(args: string[], identity: string | undefined, allowed: boolean): void {
  const http = hasFlag(args, "--port") || hasFlag(args, "--host");
  if (allowed && identity === undefined) throw new Error(`${ALLOW_HTTP_IDENTITY} applies only with --identity`);
  if (identity === undefined || !http) return;
  if (!allowed) {
    throw new Error(
      `--identity with --port or --host would serve a signed-in browser over HTTP to any local process; ` +
        `use stdio through mcpd, or pass ${ALLOW_HTTP_IDENTITY} to accept that (it binds to 127.0.0.1 only)`,
    );
  }
  const hosts = flagValues(args, "--host");
  const host = hosts[hosts.length - 1];
  if (host !== undefined && !LOOPBACK.has(host.toLowerCase())) {
    throw new Error(`an identity is only served on a loopback address (127.0.0.1, localhost, ::1), not ${host}`);
  }
  if (flagValues(args, "--allowed-hosts").some((v) => v.split(",").some((h) => h.trim() === "*"))) {
    throw new Error("an identity is never served with --allowed-hosts '*' (the Host check stops DNS rebinding)");
  }
  if (host === undefined) {
    const at = args.findIndex((a) => a === "--port" || a.startsWith("--port="));
    args.splice(at + (args[at] === "--port" ? 2 : 1), 0, "--host", "127.0.0.1");
  }
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function hasAny(args: string[], flags: string[]): boolean {
  return flags.some((f) => hasFlag(args, f));
}

/** turno's flags for the tab governor and background throttling, with what each takes. */
export const TUNING_FLAGS = {
  "--max-tabs": "<n>",
  "--popups": "<close|keep>",
  "--park-after": "<duration>",
  "--close-after": "<duration>",
  "--background-throttling": "",
  "--humanize": "<off|light|full|adaptive>",
  "--sharing": "<session|tabs>",
  "--cursor": "<auto|on|off>",
  "--resources": "<normal|low>",
} as const;

function tuningValue(flag: keyof typeof TUNING_FLAGS, value: string, out: TuningFlags): void {
  if (flag === "--max-tabs") {
    if (!/^\d+$/.test(value) || Number(value) > 100)
      throw new Error(`--max-tabs must be a whole number from 0 (no cap) to 100, not "${value}"`);
    out.maxTabs = Number(value);
  } else if (flag === "--humanize") {
    if (!(HUMANIZE_LEVELS as readonly string[]).includes(value))
      throw new Error(`--humanize must be ${HUMANIZE_LEVELS.join(", ")}, not "${value}"`);
    out.humanize = value as HumanizeLevel;
  } else if (flag === "--popups") {
    if (value !== "close" && value !== "keep") throw new Error(`--popups must be "close" or "keep", not "${value}"`);
    out.popups = value;
  } else if (flag === "--sharing") {
    if (value !== "session" && value !== "tabs")
      throw new Error(`--sharing must be "session" (one agent session at a time) or "tabs", not "${value}"`);
    out.sharing = value;
  } else if (flag === "--cursor") {
    if (!(CURSOR_MODES as readonly string[]).includes(value))
      throw new Error(`--cursor must be "auto" (when the browser can be seen), "on" or "off", not "${value}"`);
    out.cursor = value as CursorMode;
  } else if (flag === "--resources") {
    if (!(RESOURCE_MODES as readonly string[]).includes(value))
      throw new Error(`--resources must be "normal" or "low" (the low-resource preset), not "${value}"`);
    out.resources = value as ResourceMode;
  } else {
    const ms = parseDuration(value);
    if (ms === undefined) throw new Error(`${flag} must be a duration like "5m", "90s" or "0" (off), not "${value}"`);
    if (flag === "--park-after") out.parkAfterMs = ms;
    else out.closeAfterMs = ms;
  }
}

/** Removes turno's tuning flags (`TUNING_FLAGS`) from args and returns their values. */
export function extractTuning(args: string[]): { tuning?: TuningFlags; rest: string[] } {
  const rest: string[] = [];
  const out: TuningFlags = {};
  let any = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = (eq > 0 ? a.slice(0, eq) : a) as keyof typeof TUNING_FLAGS;
    if (!Object.hasOwn(TUNING_FLAGS, name)) {
      rest.push(a);
      continue;
    }
    any = true;
    if (name === "--background-throttling") {
      if (eq > 0) throw new Error("--background-throttling takes no value");
      out.backgroundThrottling = true;
      continue;
    }
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value ${TUNING_FLAGS[name]}`);
      i++;
    }
    tuningValue(name, value, out);
  }
  return any ? { tuning: out, rest } : { rest };
}

/** The value of `--flag v` or `--flag=v` at `args[i]`, and how many items it took. */
function valueAt(args: string[], i: number, flag: string): { value: string; used: number } | undefined {
  const a = args[i]!;
  if (a.startsWith(`${flag}=`)) return { value: a.slice(flag.length + 1), used: 1 };
  if (a !== flag) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return { value: v, used: 2 };
}

/** Removes `--engine` and `--attach` from args and returns their values, checked. */
export function extractEngine(args: string[]): { engineFlags?: EngineFlags; rest: string[] } {
  const rest: string[] = [];
  const out: EngineFlags = {};
  for (let i = 0; i < args.length; i++) {
    const engine = valueAt(args, i, "--engine");
    const attach = engine ? undefined : valueAt(args, i, "--attach");
    if (engine) {
      if (engine.value !== "chrome" && engine.value !== "lightpanda" && engine.value !== "camoufox")
        throw new Error(`--engine must be "chrome", "lightpanda" (read mode) or "camoufox", not "${engine.value}"`);
      out.engine = engine.value;
      i += engine.used - 1;
    } else if (attach) {
      const target = parseAttachTarget(attach.value);
      if ("error" in target) throw new Error(target.error.replace(/^attach/, "--attach"));
      out.attach = attach.value.trim();
      i += attach.used - 1;
    } else rest.push(args[i]!);
  }
  if ((out.engine === "lightpanda" || out.engine === "camoufox") && out.attach !== undefined)
    throw new Error(`--attach and --engine ${out.engine} do not go together: pick one`);
  return out.engine !== undefined || out.attach !== undefined ? { engineFlags: out, rest } : { rest };
}

/** Removes `--live` and `--live-wait <duration>` from args and returns their values, checked. */
function extractLive(args: string[]): { live?: LiveFlags; rest: string[] } {
  const rest: string[] = [];
  const out: LiveFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--live") {
      out.live = true;
      continue;
    }
    if (a.startsWith("--live=")) throw new Error("--live takes no value");
    const wait = valueAt(args, i, "--live-wait");
    if (!wait) {
      rest.push(a);
      continue;
    }
    const ms = parseDuration(wait.value);
    if (ms === undefined || ms < MIN_LIVE_WAIT_MS || ms > MAX_LIVE_WAIT_MS)
      throw new Error(`--live-wait must be a duration from "5s" to "30m", like "2m", not "${wait.value}"`);
    out.waitMs = ms;
    i += wait.used - 1;
  }
  return out.live !== undefined || out.waitMs !== undefined ? { live: out, rest } : { rest };
}

/** Removes `--identity <id>` / `--identity=<id>` from args and returns the id. */
export function extractIdentity(args: string[]): { identity?: string; rest: string[] } {
  const rest: string[] = [];
  let identity: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--identity") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error("--identity needs a value");
      identity = v;
      i++;
    } else if (a.startsWith("--identity=")) {
      identity = a.slice("--identity=".length);
    } else {
      rest.push(a);
    }
  }
  if (identity !== undefined) assertIdentityId(identity);
  return identity === undefined ? { rest } : { identity, rest };
}

function defaultTempDir(): string {
  return mkdtempSync(join(tmpdir(), "turno-browser-"));
}

export function buildArgv(rawArgs: string[], options: BuildOptions = {}): BuiltArgv {
  const env = options.env ?? process.env;
  const { identity, rest: afterIdentity } = extractIdentity(rawArgs);
  const { tuning, rest: afterTuning } = extractTuning(afterIdentity);
  const { engineFlags, rest: afterEngine } = extractEngine(afterTuning);
  const { live, rest } = extractLive(afterEngine);
  // The live view's control socket and live.json belong to the identity's state folder.
  if (live && identity === undefined) throw new Error("--live and --live-wait apply only with --identity");
  const allowHttp = rest.includes(ALLOW_HTTP_IDENTITY);
  const args = rest.filter((a) => a !== ALLOW_HTTP_IDENTITY);
  guardHttp(args, identity, allowHttp);
  const external = hasAny(args, EXTERNAL_BROWSER);
  const out: BuiltArgv = {
    args,
    ...(tuning ? { tuning } : {}),
    ...(engineFlags ? { engineFlags } : {}),
    ...(live ? { live } : {}),
  };
  const otherEngine =
    engineFlags?.engine === "lightpanda" || engineFlags?.engine === "camoufox" || engineFlags?.attach !== undefined;
  if (otherEngine) {
    const clash = ["--isolated", "--user-data-dir", ...EXTERNAL_BROWSER].find((f) => hasFlag(args, f));
    if (clash)
      throw new Error(
        `${engineFlags?.attach !== undefined ? "--attach" : `--engine ${engineFlags?.engine}`} cannot be combined with ${clash}`,
      );
  }
  if (identity !== undefined) {
    const clash = ["--user-data-dir", "--isolated", ...EXTERNAL_BROWSER].find((f) => hasFlag(args, f));
    if (clash) throw new Error(`--identity cannot be combined with ${clash}`);
    out.identity = identity;
  }

  // A browser of the user's own wins over identity.json `browser` (`engine.ts`).
  if (hasFlag(args, "--browser") || hasFlag(args, "--executable-path"))
    out.engineFlags = { ...out.engineFlags, browserFromFlags: true };
  if (!external && !hasFlag(args, "--browser")) args.push("--browser", "chrome");

  const makeTemp = () => {
    out.tempDir ??= (options.makeTempDir ?? defaultTempDir)();
    return out.tempDir;
  };

  // Read mode, Camoufox and attach mode without an identity start no Chrome, so they need no profile.
  const needsProfile = !(otherEngine && identity === undefined);
  if (!external && needsProfile && !hasFlag(args, "--user-data-dir") && !hasFlag(args, "--isolated")) {
    out.userDataDir = identity !== undefined ? identityDir(identity, env) : join(makeTemp(), "profile");
    args.push("--user-data-dir", out.userDataDir);
  }

  if (!external && !hasFlag(args, "--config") && !env.PLAYWRIGHT_MCP_CONFIG) {
    const idle = env.TURNO_BROWSER_IDLE !== undefined ? parseIdle(env.TURNO_BROWSER_IDLE) : DEFAULT_BROWSER_IDLE_MS;
    const path =
      identity !== undefined
        ? join(paths(env).identityStateDir, identity, "mcp-config.json")
        : join(makeTemp(), "mcp-config.json");
    out.config = { path, data: { timeouts: { idle } } };
    args.push("--config", path);
  }
  // Chrome's idle limit is the user's: the low-resource preset keeps it (`resolveTuning`).
  if (
    !out.config ||
    env.TURNO_BROWSER_IDLE !== undefined ||
    env.PLAYWRIGHT_MCP_IDLE_TIMEOUT !== undefined ||
    hasFlag(args, "--idle-timeout")
  )
    out.tuning = { ...out.tuning, idleSet: true };
  return out;
}
