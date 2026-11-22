import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPaths as paths, tildify } from "turno-core/paths";
import { type ProcTable, readProcTable, signalProcess } from "turno-core/process";
import { type PressureProbe, memoryPressureProbe } from "turno-core/memory";
import { type SecretStore, describeSecretStore, secretStore, windowsPowerShell } from "turno-core/secrets";
import { backgroundAlive, readBackgroundState } from "./background-state.js";
import {
  type BrowserLaunch,
  type DetectedBrowser,
  browserLabel,
  detectBrowsers,
  findBrowser,
  isBrowserId,
  majorOf,
  profileLastVersion,
  versionFromPlist,
} from "./browsers.js";
import { profileHasCookies, readLoginRecord } from "./login.js";
import { readHealth } from "./health.js";
import { identityDir, isValidIdentityId } from "./ids.js";
import { defaultChromeUserDataDir, parseAttachTarget, readAttachEndpoint } from "./engine-attach.js";
import {
  type LightpandaInfo,
  findLightpanda,
  findOrphanLightpandas,
  lightpandaCookieJar,
  lightpandaInstallHint,
} from "./engine-lightpanda.js";
import {
  type CamoufoxInfo,
  type PlaywrightCoreInfo,
  camoufoxInstallHint,
  camoufoxProfileDir,
  findCamoufox,
  findPlaywrightCore,
  playwrightCoreHint,
} from "./engine-camoufox.js";
import { findProfileChrome, sweepOrphan } from "./lifecycle.js";
import { totalMemory } from "./memory.js";
import { readChallenges, summarizeChallenges } from "./reputation.js";
import { inUseMessage, readRuntimeLock, runtimeLockAlive, runtimeLockPath } from "./runtime-lock.js";
import { type IdentitySettings, acceptLanguages, checkIdentitySettings, systemTimezone } from "./settings.js";
import { names } from "./names.js";
import {
  AGENTS,
  type AgentServers,
  type McpEntry,
  entryCommandFound,
  entryIdentity,
  readRegistrations,
  serverName,
} from "./agent-mcp.js";
import { vaultItem, vaultSummary } from "./vault.js";

/**
 * `turno browser doctor`: what a browser identity needs to work, one check per row,
 * each problem with the command that fixes it, like `turno doctor`.
 *
 * - Browsers: Google Chrome and the other Chromium-based browsers found (`browsers.ts`), their
 *   versions, and a smoke launch on a throwaway profile (headless); with none, the no-admin way
 *   to get one (`install-browser`).
 * - System: a headed Chrome needs the desktop session (macOS) or a display (Linux), the secret
 *   store in use (Keychain, Secret Service or Windows DPAPI, and where its files are), and the
 *   memory pressure the system reports (a warning when it is up; never a failure).
 * - Engines: Lightpanda for read mode and Camoufox with the stock Playwright it runs on (both
 *   optional; a failure only when an identity uses them), and a Lightpanda an earlier server
 *   left running.
 * - Per identity: the browser that opens its profile and whether it is installed, identity.json, who holds it (runtime lock and Chrome's profile lock), session
 *   health, challenges in the last 7 days, the opt-in network settings (`proxy`: whether
 *   the secret store has its credentials, never their value; `userAgent`), and whether the
 *   secret store has an item for each vault credential (a lookup, never a read of the value).
 * - Agents (turno-browser on its own): which agents' configs have each identity's server, a
 *   server whose command is gone, one whose identity is gone, and a config file that cannot be
 *   read. The files are only read.
 *
 * `--fix` removes runtime locks whose process is gone and stops a Chrome an earlier run left
 * behind on an identity's profile (the same sweep a server start does), and stops a Lightpanda
 * an earlier server left running.
 */

export interface DoctorCheck {
  /** "chrome", "system", "engines", "identities" or "identity <id>". */
  area: string;
  level: "ok" | "warn" | "fail" | "info";
  text: string;
  /** The command that fixes it, which a person runs (or `--fix` runs, with `auto`). */
  fix?: string;
  /** True when `turno browser doctor --fix` runs `fix`. */
  auto?: boolean;
  /** The manual step, when no single command fixes it. */
  manual?: string;
}

export interface ChromeInfo {
  path: string;
  version?: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Run the smoke launch (default true). */
  launch?: boolean;
  /** Repair what is safe to repair, then check again. */
  fix?: boolean;
  /** Finds Chrome (tests inject one). */
  chrome?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => ChromeInfo | undefined;
  /** The Chromium-based browsers other than Google Chrome (tests inject them). */
  otherBrowsers?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => DetectedBrowser[];
  /**
   * Starts and closes a browser (Chrome, or the first other one when Chrome is missing) on a
   * temporary profile; resolves with the milliseconds it took.
   */
  smoke?: (env: NodeJS.ProcessEnv, launch?: BrowserLaunch) => Promise<number>;
  /** Finds Lightpanda (tests inject one). */
  lightpanda?: (env: NodeJS.ProcessEnv) => LightpandaInfo | undefined;
  /** Finds Camoufox and the stock Playwright it runs on (tests inject them). */
  camoufox?: (env: NodeJS.ProcessEnv) => CamoufoxInfo | undefined;
  playwrightCore?: (env: NodeJS.ProcessEnv) => (PlaywrightCoreInfo & { ok: boolean }) | undefined;
  /** The secret store proxy credentials come from (tests inject a fake); default: this machine's. */
  secrets?: SecretStore;
  /** Reads the memory pressure (tests inject one); default: what mcpd reads (`turno-core/memory`). */
  memory?: PressureProbe;
  /** The process table, for a Lightpanda left running (tests inject one). */
  procTable?: () => ProcTable | undefined;
  /** The mcp.toml servers that run turno-browser-mcp for an identity (turno-cli reads mcp.toml). */
  servers?: readonly ServedIdentity[];
  /**
   * The turno-browser servers in the agents' config files, for the registration checks
   * (`browserEntries`): turno-browser on its own passes them; inside turno, mcp sync writes the
   * agents' configs and checks them.
   */
  agents?: { entries: readonly McpEntry[]; errors: readonly AgentServers[] };
  now?: Date;
}

/** One mcp.toml server of an identity, as mcpd runs it. */
export interface ServedIdentity {
  /** The server's name in mcp.toml (`browser-work`). */
  name: string;
  identity: string;
  /** mcp.toml `exclusive`: one client session at a time. */
  exclusive: boolean;
  /** mcp.toml `scope`: with "session" every client session gets its own server. */
  scope: string;
  /** A `--sharing` flag in the server's args, which wins over identity.json. */
  sharing?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** What `--fix` did. */
  fixed: string[];
}

const FIX = "turno browser doctor --fix";

/** CFBundleShortVersionString of a macOS Info.plist (XML). */
export const chromeVersionFromPlist = versionFromPlist;

/** The installed Google Chrome (the `chrome` channel Playwright launches) and its version. */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChromeInfo | undefined {
  const found = findBrowser("chrome", env, platform);
  return found ? { path: found.path, ...(found.version ? { version: found.version } : {}) } : undefined;
}

/** The Chromium-based browsers other than Google Chrome found on this machine. */
function otherBrowsers(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DetectedBrowser[] {
  return detectBrowsers(env, platform).filter((b) => b.id !== "chrome");
}

/** Starts a browser headless on a throwaway profile, opens a blank page and closes it. */
async function smokeLaunch(env: NodeJS.ProcessEnv, launch: BrowserLaunch = { channel: "chrome" }): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "turno-browser-doctor-"));
  const t0 = Date.now();
  try {
    const { chromium } = await import("patchright-core");
    const context = await chromium.launchPersistentContext(join(dir, "profile"), {
      ...launch,
      headless: true,
      timeout: 30_000,
      env: { ...env } as Record<string, string>,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("about:blank");
    } finally {
      await context.close();
    }
    return Date.now() - t0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;

function systemChecks(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  if (platform === "darwin") {
    out.push({
      area: "system",
      level: "ok",
      text: "macOS: driving Chrome through its DevTools pipe needs no Accessibility or Screen Recording permission",
    });
    if (env.SSH_CONNECTION || env.SSH_TTY) {
      out.push({
        area: "system",
        level: "warn",
        text: "this is an SSH session: a headed Chrome opens only in the signed-in desktop session (where mcpd runs)",
        manual: "run the browser through mcpd, or pass --headless when you start turno-browser-mcp here",
      });
    }
  } else if (platform === "win32") {
    out.push({
      area: "system",
      level: "info",
      text: "Windows: Chrome opens in your desktop session, and the background server listens on a named pipe only your user can open",
    });
  } else if (platform === "linux") {
    if (env.DISPLAY || env.WAYLAND_DISPLAY)
      out.push({
        area: "system",
        level: "ok",
        text: `display: ${env.WAYLAND_DISPLAY ? `Wayland ${env.WAYLAND_DISPLAY}` : `X11 ${env.DISPLAY}`}`,
      });
    else
      out.push({
        area: "system",
        level: "warn",
        text: "no display: a headed Chrome cannot open here",
        manual: "pass --headless to turno-browser-mcp, or run it inside a desktop session",
      });
  }
  return out;
}

/** Which secret store holds the vault and the keychain: items on this machine, and where. */
function secretStoreCheck(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, opts: DoctorOptions): DoctorCheck {
  const store = opts.secrets ?? secretStore(env, platform);
  if (store) return { area: "system", level: "ok", text: `secret store: ${describeSecretStore(store)}` };
  return {
    area: "system",
    level: "info",
    text: "secret store: none found, so the vault and keychain: items cannot be used here",
    manual:
      platform === "win32"
        ? `Windows PowerShell is missing at ${windowsPowerShell(env)}`
        : platform === "darwin"
          ? "the security command is missing from PATH"
          : "install libsecret (secret-tool)",
  };
}

/** The memory pressure the system reports, with the low-resource preset as the way out. */
async function memoryCheck(probe: PressureProbe): Promise<DoctorCheck> {
  const level = await probe().catch(() => "normal" as const);
  const total = totalMemory();
  if (level === "normal") return { area: "system", level: "ok", text: `memory: no pressure (${total} in all)` };
  return {
    area: "system",
    level: "warn",
    text: `memory pressure is ${level} on this machine (${total} in all): every Chrome an identity opens adds to it`,
    manual:
      "close the apps and browser sessions you do not need; where memory runs short often, turn on the low-resource preset for each identity: turno browser set <id> --resources low",
  };
}

function describeSettings(s: IdentitySettings): string {
  const parts: string[] = [];
  if (s.timezone) parts.push(`time zone ${s.timezone}`);
  const langs = acceptLanguages(s);
  if (langs) parts.push(`languages ${langs.join(", ")}`);
  if (s.region) parts.push(`region ${s.region}`);
  const fixed = parts.length ? parts.join(", ") : "no fixed time zone or languages";
  const base = s.resources === "low" ? `${fixed}; low-resource preset` : fixed;
  // The agent cursor is on when the browser can be seen (auto): say so only when set otherwise.
  if (s.cursor === "on") return `${base}; agent cursor always shown`;
  if (s.cursor === "off") return `${base}; agent cursor off`;
  return base;
}

/** The `turno identity set` flag that replaces the value a problem is about. */
function settingsFix(id: string, problem: string): string | undefined {
  const flag = (
    [
      ["timezone", "--timezone <zone>"],
      ["locale", "--locale <tag>"],
      ["languages", "--languages <tag,...>"],
      ["region", "--region <CC>"],
      ["health", "--health-url <url> --health-text <text>"],
      ["cursor", "--cursor auto|on|off"],
    ] as const
  ).find(([key]) => problem.startsWith(key))?.[1];
  return flag ? `turno identity set browser:${id} ${flag}` : undefined;
}

/**
 * A server that lets several client sessions in (`exclusive = false`, one server for all of
 * them) on an identity that serves one session at a time: those sessions silently share one
 * current tab, and one agent's navigation replaces the page another is reading.
 */
function servingRows(id: string, settings: IdentitySettings | undefined, servers: readonly ServedIdentity[]) {
  const out: Omit<DoctorCheck, "area">[] = [];
  for (const server of servers) {
    if (server.identity !== id || server.exclusive || server.scope === "session") continue;
    if ((server.sharing ?? settings?.sharing ?? "session") !== "session") continue;
    out.push({
      level: "warn",
      text: `[server.${server.name}] in mcp.toml lets several sessions in (exclusive = false), but this identity serves one at a time ("sharing": "session"), so those sessions share one current tab`,
      fix: `turno browser set ${id} --sharing tabs`,
    });
  }
  return out;
}

function identityChecks(
  id: string,
  env: NodeJS.ProcessEnv,
  now: Date,
  servers: readonly ServedIdentity[] = [],
  installed: readonly DetectedBrowser[] = [],
): DoctorCheck[] {
  const area = `identity ${id}`;
  const out: DoctorCheck[] = [];
  const add = (c: Omit<DoctorCheck, "area">) => out.push({ area, ...c });

  const { path, settings, problems } = checkIdentitySettings(id, env);
  if (problems.length) {
    const fix = settingsFix(id, problems[0]!);
    add({
      level: "fail",
      text: `identity.json ${problems[0]!.startsWith("is ") ? problems[0] : `is invalid: ${problems.join("; ")}`}`,
      ...(fix ? { fix } : {}),
      manual: problems[0]!.startsWith("is format")
        ? "update turno-browser: npm install --global turno-browser@latest"
        : `edit or delete ${path}`,
    });
  } else if (!settings) {
    add({
      level: "info",
      text: "no identity.json: Chrome's own time zone and languages, which follow this computer",
      fix: `turno identity set browser:${id} --timezone ${systemTimezone()}`,
    });
  } else {
    add({ level: "ok", text: `identity.json: ${describeSettings(settings)}` });
  }

  if (settings) for (const c of engineRows(id, settings, env)) add(c);
  out.push(...browserRows(id, env, installed));
  if (!problems.length) for (const c of servingRows(id, settings, servers)) add(c);

  const lock = readRuntimeLock(id, env);
  const chrome = findProfileChrome(identityDir(id, env));
  if (lock && runtimeLockAlive(lock)) {
    add({
      level: "ok",
      text: inUseMessage(id, lock)
        .replace(/^browser identity "[^"]+" is /, "")
        .replace(/\. .*$/, ""),
    });
  } else if (chrome?.owner === "orphan") {
    add({
      level: "warn",
      text: `Chrome pid ${chrome.pid} was left running on this profile with no server`,
      fix: FIX,
      auto: true,
    });
  } else if (chrome) {
    add({
      level: "warn",
      text: `Chrome pid ${chrome.pid} holds this profile, but no turno process does`,
      manual: "close that Chrome window (a Chrome opened by hand, or a login of an older turno)",
    });
  } else if (lock) {
    add({
      level: "warn",
      text: `stale runtime lock of pid ${lock.nodePid} (that process is gone)`,
      fix: FIX,
      auto: true,
    });
  } else {
    add({ level: "ok", text: "not in use: no process holds it" });
  }

  // The background server `turno-browser do` starts: while it runs, an agent's server of this
  // identity refuses to launch the browser, so say it runs and how to stop it.
  const background = readBackgroundState(id, env);
  if (background?.transport && backgroundAlive(background)) {
    const idle =
      background.idleMs > 0 ? `; it exits after ${Math.round(background.idleMs / 60_000)}m without a request` : "";
    add({
      level: "info",
      text: `background server (pid ${background.pid}) since ${background.startedAt} serves it to turno-browser do; an agent's server of this identity cannot open the browser until it stops${idle}`,
      fix: `turno-browser background stop ${id}`,
    });
  }

  // A profile nobody signed in to by hand starts signed out everywhere: say so before an agent finds out.
  if (!readLoginRecord(id, env) && !profileHasCookies(id, env)) {
    add({
      level: "info",
      text: "never signed in by hand here: the agent starts signed out on every site",
      fix: `turno browser login ${id}`,
    });
  }

  const check = settings?.health;
  const health = readHealth(id, env);
  if (!check) {
    add({
      level: "info",
      text: "no session health check: a signed-out session shows up only when a page asks to sign in",
      fix: `turno identity set browser:${id} --health-url <url> --health-text <text>`,
    });
  } else if (!health || health.url !== check.url) {
    add({ level: "info", text: `health check of ${check.url}: not run yet (it runs when the browser starts)` });
  } else if (health.status === "ok") {
    add({ level: "ok", text: `signed in at ${health.url} (checked ${health.checkedAt})` });
  } else if (health.status === "needs_auth") {
    add({
      level: "fail",
      text: `NEEDS_AUTH: not signed in at ${health.url}: ${health.detail ?? "the check failed"} (checked ${health.checkedAt})`,
      fix: `turno browser login ${id}`,
    });
  } else {
    add({
      level: "warn",
      text: `the health check of ${health.url} could not run: ${health.detail ?? "unknown error"} (checked ${health.checkedAt})`,
      manual: "check the URL and the network; the next browser start tries again",
    });
  }

  const sites = summarizeChallenges(readChallenges(id, env), now).filter((s) => s.last7d > 0);
  if (sites.length) {
    const recent = readChallenges(id, env).filter((e) => now.getTime() - Date.parse(e.ts) <= 7 * 86_400_000);
    const kinds = (["captcha", "verify", "block"] as const)
      .map((k) => [k, recent.filter((e) => e.kind === k).length] as const)
      .filter(([, n]) => n)
      .map(([k, n]) => `${n} ${k}`);
    add({
      level: "warn",
      text: `${recent.length} challenge${recent.length === 1 ? "" : "s"} in the last 7 days on ${sites.length} site${sites.length === 1 ? "" : "s"} (${kinds.join(", ")})`,
      fix: `turno browser reputation ${id}`,
    });
  }
  return out;
}

const ENABLE_DEBUGGING = "start Chrome, open chrome://inspect/#remote-debugging and turn remote debugging on";

/** What an identity's engine needs (identity.json `engine`, `attach`); none for Chrome. */
/** How the chrome engine launches a browser found here. */
function launchOf(b: DetectedBrowser): BrowserLaunch {
  return b.id === "chrome-for-testing" ? { channel: "chrome-for-testing" } : { executablePath: b.path };
}

/**
 * Which browser opens the identity's profile (identity.json `browser`, or Google Chrome), whether
 * it is installed, and whether the profile was last opened by a newer version than it.
 */
function browserRows(id: string, env: NodeJS.ProcessEnv, installed: readonly DetectedBrowser[]): DoctorCheck[] {
  const area = `identity ${id}`;
  const { settings, problems } = checkIdentitySettings(id, env);
  if (problems.length || settings?.engine === "lightpanda" || settings?.engine === "camoufox") return [];
  if (settings?.attach !== undefined) return [];
  const choice = settings?.browser ?? "chrome";
  const from = settings?.browser === undefined ? "the default" : "identity.json browser";
  const last = profileLastVersion(identityDir(id, env));
  let found: DetectedBrowser | undefined;
  if (isBrowserId(choice)) found = installed.find((b) => b.id === choice);
  else if (existsSync(choice)) found = { id: "chromium", label: choice, path: choice };
  if (!found) {
    const other = installed[0];
    const force = last !== undefined && settings?.keychain !== "system" ? " --force" : "";
    return [
      {
        area,
        level: "fail",
        text: `browser: ${browserLabel(choice)} (${from}) is not installed, so this identity's browser does not start`,
        fix: other ? `turno browser set ${id} --browser ${other.id}${force}` : "turno browser install-browser",
        manual: `install ${browserLabel(choice)}, or pick another browser: turno browser set ${id} --browser <name>`,
      },
    ];
  }
  const out: DoctorCheck[] = [
    {
      area,
      level: "ok",
      text: `browser: ${found.label}${found.version ? ` ${found.version}` : ""} (${from})`,
    },
  ];
  const lastMajor = majorOf(last);
  const major = majorOf(found.version);
  if (lastMajor !== undefined && major !== undefined && lastMajor > major)
    out.push({
      area,
      level: "warn",
      text: `the profile was last opened by version ${last}, newer than ${found.label} ${found.version}: an older browser can refuse a profile whose data a newer one upgraded`,
      manual: `update ${found.label}, or open the profile with the browser that last used it`,
    });
  return out;
}

function engineRows(id: string, settings: IdentitySettings, env: NodeJS.ProcessEnv): Omit<DoctorCheck, "area">[] {
  if (settings.engine === "camoufox")
    return [
      {
        level: "info",
        text: `Camoufox: its own Firefox profile in ${camoufoxProfileDir(id, env)}, not the Chrome profile (sign-ins do not carry over)`,
        fix: `turno browser set ${id} --engine chrome`,
      },
    ];
  if (settings.engine === "lightpanda")
    return [
      {
        level: "info",
        text: `read mode on Lightpanda: its own cookies in ${lightpandaCookieJar(id, env)}, not the Chrome profile`,
        fix: `turno browser set ${id} --engine chrome`,
      },
    ];
  if (settings.attach === undefined) return [];
  const target = parseAttachTarget(settings.attach);
  if ("error" in target) return [];
  try {
    const endpoint = readAttachEndpoint(target, env);
    return [
      {
        level: "ok",
        text: `attach: a Chrome listens at ${endpoint.replace(/\/devtools\/.*$/, "")}; it asks you to allow each new connection, and the agent then sees every window of that profile`,
      },
    ];
  } catch {
    const dir = target.kind === "dir" ? target.dir : target.kind === "auto" ? defaultChromeUserDataDir(env) : undefined;
    return [
      {
        level: "warn",
        text: `attach: no Chrome with remote debugging on${dir ? ` for ${dir}` : ""}, so the next tool call fails`,
        manual: ENABLE_DEBUGGING,
      },
    ];
  }
}

/** A `lightpanda serve` that a turno-browser-mcp started and that outlived it. */
function strayLightpandas(table: ProcTable | undefined): number[] {
  return table ? findOrphanLightpandas("any", table).map((o) => o.pid) : [];
}

function engineChecks(opts: DoctorOptions, env: NodeJS.ProcessEnv, ids: string[]): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const area = "engines";
  const lightpanda = (opts.lightpanda ?? findLightpanda)(env);
  const users = ids.filter((id) => checkIdentitySettings(id, env).settings?.engine === "lightpanda");
  const platform = opts.platform ?? process.platform;
  const hint = lightpandaInstallHint(platform);
  const install = platform === "darwin" || platform === "linux" ? { fix: hint } : { manual: hint };
  if (lightpanda)
    out.push({
      area,
      level: "ok",
      text: `Lightpanda${lightpanda.version ? ` ${lightpanda.version}` : ""} at ${lightpanda.path} (read mode)`,
    });
  else if (users.length)
    out.push({
      area,
      level: "fail",
      text: `Lightpanda not found, and read mode needs it for ${users.map((u) => `browser:${u}`).join(", ")}`,
      ...install,
    });
  else
    out.push({
      area,
      level: "info",
      text: "Lightpanda not found: only read mode (--engine lightpanda) needs it, and turno never downloads it",
      ...install,
    });
  out.push(...camoufoxChecks(opts, env, ids, platform));
  const stray = strayLightpandas((opts.procTable ?? readProcTable)());
  if (stray.length)
    out.push({
      area,
      level: "warn",
      text: `Lightpanda pid ${stray.join(", ")} was left running by a server that is gone`,
      fix: FIX,
      auto: true,
    });
  return out;
}

/** Camoufox and the stock Playwright it runs on: a failure only when an identity uses the engine. */
function camoufoxChecks(opts: DoctorOptions, env: NodeJS.ProcessEnv, ids: string[], platform: NodeJS.Platform) {
  const out: DoctorCheck[] = [];
  const area = "engines";
  const users = ids.filter((id) => checkIdentitySettings(id, env).settings?.engine === "camoufox");
  const needed = users.length > 0;
  const who = users.map((u) => `browser:${u}`).join(", ");
  const camoufox = (opts.camoufox ?? findCamoufox)(env);
  const fix = camoufoxInstallHint(platform);
  if (camoufox)
    out.push({
      area,
      level: "ok",
      text: `Camoufox${camoufox.version ? ` (${camoufox.version})` : ""} at ${camoufox.path}`,
    });
  else if (needed)
    out.push({ area, level: "fail", text: `Camoufox not found, and the camoufox engine needs it for ${who}`, fix });
  else
    out.push({
      area,
      level: "info",
      text: "Camoufox not found: only the camoufox engine (--engine camoufox) needs it, and turno never downloads it",
      fix,
    });
  const pw = (opts.playwrightCore ?? findPlaywrightCore)(env);
  const pwFix = playwrightCoreHint();
  if (pw?.ok) out.push({ area, level: "ok", text: `playwright-core ${pw.version} at ${pw.dir} (for Camoufox)` });
  else if (pw)
    out.push({
      area,
      level: needed ? "fail" : "warn",
      text: `playwright-core ${pw.version} at ${pw.dir} is not the version patchright-core is built on, so Camoufox cannot run on it`,
      fix: pwFix,
    });
  else if (needed)
    out.push({
      area,
      level: "fail",
      text: `playwright-core not found, and Camoufox runs on stock Playwright (patchright-core drives Chromium only): needed for ${who}`,
      fix: pwFix,
    });
  else if (camoufox)
    out.push({
      area,
      level: "info",
      text: "playwright-core not found: the camoufox engine runs on stock Playwright, since patchright-core drives Chromium only",
      fix: pwFix,
    });
  return out;
}

/**
 * The opt-in network settings of an identity: where its traffic goes, and whether the secret
 * store holds the proxy credentials (it asks whether the item exists, never reads its value).
 */
async function networkRows(id: string, env: NodeJS.ProcessEnv, opts: DoctorOptions): Promise<DoctorCheck[]> {
  const settings = checkIdentitySettings(id, env).settings;
  const out: DoctorCheck[] = [];
  const area = `identity ${id}`;
  if (settings?.userAgent === "coherent")
    out.push({
      area,
      level: "info",
      text: "userAgent coherent: the installed Chrome's own user agent and client hints, with the identity's languages and time zone, checked at every launch",
    });
  const proxy = settings?.proxy;
  if (!proxy) return out;
  out.push({
    area,
    level: "info",
    text: `proxy ${proxy.server}: the proxy's operator sees where this identity goes (and the content of plain http:// pages), and sites see the proxy's address`,
  });
  const refs = [proxy.username, proxy.password].filter((r): r is string => r?.startsWith("keychain:") === true);
  if (!refs.length) return out;
  const store = opts.secrets ?? secretStore(env);
  if (!store) {
    out.push({
      area,
      level: "fail",
      text: "the proxy credentials are in the secret store, and this machine has none",
      manual: `${noStoreHint(opts.platform ?? process.platform)}, or use a proxy without a password`,
    });
    return out;
  }
  for (const ref of refs) {
    const item = ref.slice("keychain:".length);
    const has = await store.has(item).catch(() => false);
    if (has) out.push({ area, level: "ok", text: `proxy credentials: ${store.label} item "${item}" is there` });
    else
      out.push({
        area,
        level: "fail",
        text: `proxy credentials: ${store.label} has no item "${item}", so the browser does not start`,
        fix: `turno secret set ${item}`,
      });
  }
  return out;
}

/** What gives this machine a secret store: libsecret on Linux; on Windows turno-browser has none yet. */
function noStoreHint(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "turno-browser has no secret store on Windows yet: run this identity from macOS or Linux"
    : "install libsecret (secret-tool)";
}

/** Whether the secret store has an item for each credential of the vault: lookups only, never a value. */
async function vaultRows(id: string, env: NodeJS.ProcessEnv, opts: DoctorOptions): Promise<DoctorCheck[]> {
  const sites = vaultSummary(id, env)?.sites ?? [];
  if (!sites.length) return [];
  const area = `identity ${id}`;
  const store = opts.secrets ?? secretStore(env);
  if (!store)
    return [
      {
        area,
        level: "fail",
        text: `the vault has ${sites.length} credential${sites.length === 1 ? "" : "s"} in the secret store, and this machine has none`,
        manual: `${noStoreHint(opts.platform ?? process.platform)}, then add them again with turno browser vault add`,
      },
    ];
  const missing: string[] = [];
  for (const site of sites) {
    try {
      if (!(await store.has(vaultItem(id, site)))) missing.push(site);
    } catch (err) {
      return [
        {
          area,
          level: "warn",
          text: `the ${store.label} did not answer for the vault: ${firstLine(err)}`,
          manual: "unlock the keychain (or the Secret Service) and run doctor again",
        },
      ];
    }
  }
  const out: DoctorCheck[] = [];
  if (missing.length < sites.length)
    out.push({
      area,
      level: "ok",
      text: `vault: ${store.label} has the credentials of ${sites.filter((s) => !missing.includes(s)).join(", ")}`,
    });
  for (const site of missing)
    out.push({
      area,
      level: "fail",
      text: `vault: ${store.label} has no item for the credentials of ${site}, so browser_login cannot sign in there`,
      fix: `turno browser vault add ${id} ${site} --url <sign-in page> --username <name>`,
    });
  return out;
}

/** Which agents have each identity's server, and the servers that point nowhere. */
function agentRows(ids: readonly string[], env: NodeJS.ProcessEnv, agents: NonNullable<DoctorOptions["agents"]>) {
  const out: DoctorCheck[] = [];
  for (const e of agents.errors)
    out.push({
      area: "agents",
      level: "warn",
      text: `could not read ${AGENTS[e.agent].label}'s config ${tildify(e.file, env)}: ${e.error}`,
      manual: "fix the file by hand; doctor only reads it, to see which identities the agent has",
    });
  for (const e of agents.entries) {
    const id = entryIdentity(e);
    if (id === undefined || ids.includes(id)) continue;
    const remove = AGENTS[e.agent].remove?.(e.server);
    out.push({
      area: "agents",
      level: "warn",
      text: `${AGENTS[e.agent].label} still has the MCP server ${e.server} (${tildify(e.file, env)}), and there is no identity "${id}"`,
      ...(remove
        ? { fix: remove.join(" ") }
        : { manual: `delete the "${e.server}" entry from ${tildify(e.file, env)}` }),
    });
  }
  for (const id of ids) {
    const area = `identity ${id}`;
    const mine = agents.entries.filter((e) => entryIdentity(e) === id);
    for (const e of mine) {
      const label = AGENTS[e.agent].label;
      if (entryCommandFound(e, env))
        out.push({ area, level: "ok", text: `${label} has it (${e.server} in ${tildify(e.file, env)})` });
      else
        out.push({
          area,
          level: "warn",
          text: `${label} runs ${e.server} with ${e.command ?? "no command"}, which is not there`,
          fix: `turno browser setup ${e.agent} --identity ${id}`,
        });
    }
    for (const r of readRegistrations(id, env))
      if (!mine.some((e) => e.agent === r.agent && e.server === r.server) && r.file === AGENTS[r.agent].file(env))
        out.push({
          area,
          level: "warn",
          text: `${AGENTS[r.agent].label} no longer has ${r.server}, which init registered in ${tildify(r.file, env)}`,
          fix: `turno browser setup ${r.agent} --identity ${id}`,
        });
    if (!mine.length)
      out.push({
        area,
        level: "info",
        text: `no agent here has ${serverName(id)} in its config`,
        fix: `turno browser setup <agent> --identity ${id}`,
      });
  }
  return out;
}

/** Every identity id, including profile dirs with an identity.json only. */
function identityIds(env: NodeJS.ProcessEnv): string[] {
  try {
    return readdirSync(paths(env).identitiesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidIdentityId(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

async function collect(
  opts: DoctorOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  now: Date,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const chrome = (opts.chrome ?? findChrome)(env, platform);
  const others = (opts.otherBrowsers ?? otherBrowsers)(env, platform);
  if (chrome)
    checks.push({
      area: "chrome",
      level: "ok",
      text: `Google Chrome${chrome.version ? ` ${chrome.version}` : ""} at ${chrome.path}`,
    });
  for (const b of others)
    checks.push({ area: "chrome", level: "ok", text: `${b.label}${b.version ? ` ${b.version}` : ""} at ${b.path}` });
  if (!chrome && others.length)
    checks.push({
      area: "chrome",
      level: "info",
      text: `Google Chrome is not installed; ${others.map((b) => b.label).join(", ")} can run identities instead (identity.json browser)`,
      fix: `turno browser set <id> --browser ${others[0]!.id}`,
    });
  else if (!chrome)
    checks.push({
      area: "chrome",
      level: "fail",
      text: "Google Chrome not found, and no other Chromium-based browser (Edge, Brave, Chromium, Chrome for Testing)",
      fix: "turno browser install-browser",
      manual: `turno browser install-browser downloads Chrome for Testing into your user cache with no admin password; or install Google Chrome (https://www.google.com/chrome/)${platform === "win32" ? ", or with winget for your user alone: winget install --id Google.Chrome.EXE --scope user" : ""}`,
    });
  // The test launch uses Chrome, or the first other browser when Chrome is missing.
  const first = others[0];
  const target = chrome
    ? { name: "Chrome", launch: { channel: "chrome" } as BrowserLaunch }
    : first
      ? { name: first.label, launch: launchOf(first) }
      : undefined;
  if (opts.launch === false) checks.push({ area: "chrome", level: "info", text: "smoke launch skipped (--no-launch)" });
  else if (!target) checks.push({ area: "chrome", level: "info", text: "smoke launch skipped: no browser to start" });
  else {
    try {
      const ms = await (opts.smoke ?? smokeLaunch)(env, target.launch);
      checks.push({
        area: "chrome",
        level: "ok",
        text: `smoke launch: ${target.name} started and closed in ${(ms / 1000).toFixed(1)}s on a temporary profile`,
      });
    } catch (err) {
      checks.push({
        area: "chrome",
        level: "fail",
        text: `smoke launch failed: ${firstLine(err)}`,
        manual: `open ${target.name} by hand once; on Linux install its system libraries`,
      });
    }
  }
  checks.push(
    ...systemChecks(env, platform),
    secretStoreCheck(env, platform, opts),
    await memoryCheck(opts.memory ?? memoryPressureProbe()),
  );
  const ids = identityIds(env);
  checks.push(...engineChecks(opts, env, ids));
  if (!ids.length)
    checks.push({
      area: "identities",
      level: "info",
      text: "no browser identities yet",
      fix: "turno identity add browser:<id>",
    });
  const installed = [...(chrome ? [{ id: "chrome" as const, label: "Google Chrome", ...chrome }] : []), ...others];
  for (const id of ids)
    checks.push(
      ...identityChecks(id, env, now, opts.servers, installed),
      ...(await networkRows(id, env, opts)),
      ...(await vaultRows(id, env, opts)),
    );
  if (opts.agents) checks.push(...agentRows(ids, env, opts.agents));
  return checks;
}

/** Repairs what is safe: stale runtime locks, a Chrome left running with no server, a stray Lightpanda. */
async function repair(env: NodeJS.ProcessEnv, opts: DoctorOptions): Promise<string[]> {
  const done: string[] = [];
  for (const pid of strayLightpandas((opts.procTable ?? readProcTable)())) {
    signalProcess(pid, "SIGTERM");
    done.push(`stopped Lightpanda pid ${pid}, left running by a server that is gone`);
  }
  for (const id of identityIds(env)) {
    const lock = readRuntimeLock(id, env);
    if (lock && !runtimeLockAlive(lock)) {
      rmSync(runtimeLockPath(id, env), { force: true });
      done.push(`${id}: removed the stale runtime lock of pid ${lock.nodePid}`);
    }
    const swept = await sweepOrphan(identityDir(id, env));
    if (swept.action === "exited" || swept.action === "killed")
      done.push(`${id}: closed Chrome pid ${swept.pid}, left running with no server`);
    else if (swept.action === "survived") done.push(`${id}: Chrome pid ${swept.pid} did not stop`);
  }
  return done;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? new Date();
  let checks = await collect(opts, env, platform, now);
  const fixed: string[] = [];
  if (opts.fix && checks.some((c) => c.auto && (c.level === "warn" || c.level === "fail"))) {
    fixed.push(...(await repair(env, opts)));
    checks = await collect({ ...opts, launch: false }, env, platform, now).then((again) => {
      // Keep the smoke launch result of the first pass: it does not change with a repair.
      const smoke = checks.find((c) => c.area === "chrome" && /^smoke launch/.test(c.text));
      return smoke ? again.map((c) => (c.area === "chrome" && /^smoke launch/.test(c.text) ? smoke : c)) : again;
    });
  }
  return { checks: checks.map(named), fixed };
}

/**
 * A check's fix and text with the commands named the way this process's host types them: the
 * checks are written with turno's names (the troubleshooting docs are generated from them), and
 * turno-browser on its own prints `turno-browser set <id> ...` instead.
 */
function named(check: DoctorCheck): DoctorCheck {
  const n = names();
  if (n.browser === "turno browser") return check;
  const swap = (s: string) =>
    s
      .replace(/turno identity (\w+) browser:(\S+)/g, (_m, sub: string, id: string) => n.identity(sub, id))
      .replace(/turno secret set (\S+)/g, (_m, item: string) => n.secretSet(item))
      .replace(/turno browser /g, `${n.browser} `);
  return {
    ...check,
    text: swap(check.text),
    ...(check.fix ? { fix: swap(check.fix) } : {}),
    ...(check.manual ? { manual: swap(check.manual) } : {}),
  };
}
