import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import type { BrowserContext } from "patchright-core";
import { findOnPath, browserPaths as paths } from "turno-core/paths";
import type { Engine, LaunchedBrowser } from "./engine.js";
import { IdleTimer, idleMs } from "./idle-timer.js";
import { identityStateDir } from "./ids.js";
import { FIREFOX_PROXY_PREFS, resolveProxy } from "./network.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { acceptLanguages, chromeEnv, readIdentitySettings, systemTimezone } from "./settings.js";
import { upstream } from "./upstream.js";
import { names } from "./names.js";

/**
 * The `camoufox` engine: Camoufox, a Firefox build with its own fingerprint handling, instead
 * of Chrome. Opt-in only (identity.json `"engine": "camoufox"`, or `--engine camoufox`), off by
 * default and the user's choice. A Firefox with a changed fingerprint is something sites look
 * for, and the identity's Chrome profile and sign-ins do not carry over.
 *
 * turno never downloads it. Two things must be installed:
 *
 * - Camoufox itself: `TURNO_CAMOUFOX_PATH` (the executable, an absolute path), else the newest
 *   build Camoufox's own installer (`pip install camoufox`, then `camoufox fetch`) put in its
 *   cache folder.
 * - Stock Playwright (`playwright-core`) of the same minor version as patchright-core.
 *   patchright-core drives Chromium only: with a Firefox build, evaluate fails and every action
 *   times out (measured with Playwright's Firefox 157). Firefox speaks Playwright's Juggler
 *   protocol, which stock Playwright drives. It is found next to turno-browser (`npm install -g
 *   playwright-core@<version>`) or at `TURNO_PLAYWRIGHT_CORE` (its package folder).
 *
 * The context it launches is handed to the same upstream tool backend as Chrome's, so the
 * stock tools behave the same; the ones in `NOT_IN_CAMOUFOX` are refused before they run.
 *
 * For an identity, Camoufox keeps its own Firefox profile in
 * `<state>/browser/identities/<id>/camoufox-profile`: it never opens the identity's Chrome
 * profile, so a sign-in made in Chrome is not there. The identity's runtime lock is held while
 * it runs, so a Chrome and a Camoufox never drive one identity at once. turno passes Camoufox no
 * generated fingerprint: it presents the values its build reports for this computer.
 */

/** Tools that do not run on Camoufox, with the reason. */
const NOT_IN_CAMOUFOX: Readonly<Record<string, string>> = {
  browser_run_code_unsafe:
    "it runs Playwright code against the patchright-core API, and Camoufox runs on stock Playwright",
  browser_solve_captcha:
    "it sets the token from Patchright's isolated script world and calls the widget's callback in the page's own, and Camoufox runs on stock Playwright",
  browser_request_human:
    "its banner runs in Patchright's isolated script world, out of the page scripts' reach, and Camoufox runs on stock Playwright",
};

/** Why the Camoufox engine refuses this tool, or undefined when it runs it. */
export function camoufoxRefusal(tool: string): string | undefined {
  const why = NOT_IN_CAMOUFOX[tool];
  if (!why) return undefined;
  return `${tool} is not available with the Camoufox engine: ${why}. Use the Chrome engine for it (\`${names().browser} set <id> --engine chrome\`).`;
}

/** How to install Camoufox, for errors and `turno browser doctor`. */
export function camoufoxInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32")
    return "pip install -U camoufox, then camoufox fetch (turno-browser does not run on Windows; use WSL)";
  return "pip install -U camoufox && camoufox fetch (then set TURNO_CAMOUFOX_PATH if turno does not find it)";
}

/** Where Camoufox's own installer keeps its builds (platformdirs' user cache folder). */
export function camoufoxCacheDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = paths(env).home;
  if (platform === "darwin") return join(home, "Library", "Caches", "camoufox");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "camoufox");
}

/** The executable inside one Camoufox build folder, if it has one. */
function executableIn(dir: string, platform: NodeJS.Platform): string | undefined {
  const file =
    platform === "darwin" ? join(dir, "Camoufox.app", "Contents", "MacOS", "camoufox") : join(dir, "camoufox-bin");
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/** The newest Camoufox build under its cache folder, searched a few levels deep. */
function newestBuild(root: string, platform: NodeJS.Platform): string | undefined {
  const found: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    const exe = executableIn(dir, platform);
    if (exe) {
      found.push({ file: exe, mtime: statSync(exe).mtimeMs });
      return;
    }
    if (depth === 0) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || e.endsWith(".app")) continue;
      const sub = join(dir, e);
      try {
        if (statSync(sub).isDirectory()) walk(sub, depth - 1);
      } catch {
        /* gone */
      }
    }
  };
  walk(root, 4);
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.file;
}

export interface CamoufoxInfo {
  path: string;
  version?: string;
}

/** The Camoufox turno would run: `TURNO_CAMOUFOX_PATH`, else the newest build in Camoufox's cache folder. */
export function findCamoufox(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CamoufoxInfo | undefined {
  const configured = env.TURNO_CAMOUFOX_PATH?.trim();
  const path = configured
    ? isAbsolute(configured) && findOnPath(configured, env) && statSync(configured).isFile()
      ? configured
      : undefined
    : newestBuild(camoufoxCacheDir(env, platform), platform);
  if (!path) return undefined;
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env, MOZ_HEADLESS: "1" },
    }).trim();
    return out ? { path, version: out.split("\n")[0]!.trim() } : { path };
  } catch {
    return { path };
  }
}

/** The error when Camoufox is missing, with the install command. */
function camoufoxMissing(env: NodeJS.ProcessEnv): Error {
  const configured = env.TURNO_CAMOUFOX_PATH?.trim();
  const where = configured
    ? `TURNO_CAMOUFOX_PATH (${configured}) is not an executable file with an absolute path`
    : `no Camoufox build is in ${camoufoxCacheDir(env)}`;
  return new Error(
    `the camoufox engine needs Camoufox, and ${where}. Install it: ${camoufoxInstallHint()}. turno never downloads it for you; \`${names().browser} doctor\` checks it.`,
  );
}

/** The minor version of Playwright that patchright-core is built on, like "1.64". */
export function playwrightMinor(): string {
  return upstream().version.split(".").slice(0, 2).join(".");
}

/** Stock Playwright's Firefox launcher, the part of `playwright-core` this engine uses. */
interface FirefoxLauncher {
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<BrowserContext>;
}

export interface PlaywrightCoreInfo {
  dir: string;
  version: string;
}

const require = createRequire(import.meta.url);

/**
 * The stock `playwright-core` this engine would load: `TURNO_PLAYWRIGHT_CORE` (its package
 * folder), else the one Node finds from turno-browser. Undefined when there is none; `ok` is
 * false when its minor version is not patchright-core's.
 */
export function findPlaywrightCore(
  env: NodeJS.ProcessEnv = process.env,
): (PlaywrightCoreInfo & { ok: boolean }) | undefined {
  let manifest: string | undefined;
  const configured = env.TURNO_PLAYWRIGHT_CORE?.trim();
  if (configured) manifest = isAbsolute(configured) ? join(configured, "package.json") : undefined;
  else {
    try {
      manifest = require.resolve("playwright-core/package.json");
    } catch {
      manifest = undefined;
    }
  }
  if (!manifest || !existsSync(manifest)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version?: string };
    if (pkg.name !== "playwright-core" || typeof pkg.version !== "string") return undefined;
    const minor = pkg.version.split(".").slice(0, 2).join(".");
    return { dir: dirname(manifest), version: pkg.version, ok: minor === playwrightMinor() };
  } catch {
    return undefined;
  }
}

/** How to install the stock Playwright this engine needs. */
export function playwrightCoreHint(): string {
  return `npm install -g playwright-core@${playwrightMinor()} (next to turno-browser), or set TURNO_PLAYWRIGHT_CORE to its folder`;
}

function loadFirefox(env: NodeJS.ProcessEnv): FirefoxLauncher {
  const found = findPlaywrightCore(env);
  if (!found)
    throw new Error(
      `the camoufox engine needs stock Playwright (playwright-core ${playwrightMinor()}): patchright-core drives Chromium only. Install it: ${playwrightCoreHint()}`,
    );
  if (!found.ok)
    throw new Error(
      `the camoufox engine needs playwright-core ${playwrightMinor()}.x, the version patchright-core is built on, and found ${found.version} at ${found.dir}. Install it: ${playwrightCoreHint()}`,
    );
  return (require(found.dir) as { firefox: FirefoxLauncher }).firefox;
}

/** Where an identity's Camoufox keeps its Firefox profile. */
export function camoufoxProfileDir(id: string, env: NodeJS.ProcessEnv): string {
  return join(identityStateDir(id, env), "camoufox-profile");
}

export function createCamoufoxEngine(): Engine {
  return {
    id: "camoufox",
    refuse: camoufoxRefusal,
    async launch({ config, identity, secret }): Promise<LaunchedBrowser> {
      const env = identity?.env ?? process.env;
      const found = findCamoufox(env);
      if (!found) throw camoufoxMissing(env);
      const firefox = loadFirefox(env);
      const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
      const proxy = settings?.proxy ? await resolveProxy(settings.proxy, env, secret ?? (() => {})) : undefined;
      const languages = settings ? acceptLanguages(settings) : undefined;
      const tz = settings?.timezone && settings.timezone !== systemTimezone() ? settings.timezone : undefined;
      const held = identity ? acquireRuntimeLock(identity.id, identity.env, { holder: "mcp" }) : undefined;
      // Without an identity, a throwaway profile removed when the browser closes.
      const temporary = identity ? undefined : mkdtempSync(join(env.TMPDIR || tmpdir(), "turno-camoufox-"));
      // Firefox may still be writing to it as the context closes: retry, and never throw from
      // a close handler (that would end the server).
      const removeTemporary = () => {
        if (!temporary) return;
        try {
          rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
          /* left in the temp folder; the OS clears it */
        }
      };
      let context: BrowserContext;
      try {
        const dir = identity ? camoufoxProfileDir(identity.id, identity.env) : temporary!;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const prefs: Record<string, unknown> = {
          ...(languages ? { "intl.accept_languages": languages.join(",") } : {}),
          ...(proxy ? FIREFOX_PROXY_PREFS : {}),
        };
        context = await firefox.launchPersistentContext(dir, {
          executablePath: found.path,
          headless: config.browser.launchOptions.headless ?? false,
          ...(config.browser.contextOptions ?? {}),
          ...(proxy ? { proxy } : {}),
          ...(tz ? { timezoneId: tz } : {}),
          ...(Object.keys(prefs).length ? { firefoxUserPrefs: prefs } : {}),
          handleSIGINT: false,
          handleSIGTERM: false,
          env: chromeEnv(env),
        });
      } catch (error) {
        held?.release();
        removeTemporary();
        throw new Error(`could not start Camoufox: ${(error as Error).message.split("\n")[0]}`);
      }
      let closing = false;
      context.once("close", () => {
        closing = true;
        held?.release();
        removeTemporary();
      });
      let idleTimer: IdleTimer | undefined;
      const close = async () => {
        upstream().core.utils.gracefullyCloseSet.delete(close);
        idleTimer?.dispose();
        closing = true;
        await context.close().catch(() => {});
        held?.release();
      };
      // This Playwright is not patchright-core's, so its exit hooks do not see the browser:
      // upstream's exit watchdog awaits this close before the process exits.
      upstream().core.utils.gracefullyCloseSet.add(close);
      const ms = idleMs(config);
      if (ms) idleTimer = new IdleTimer(ms, () => void close());
      return {
        engine: "camoufox",
        context,
        ...(idleTimer ? { idleTimer } : {}),
        isOpen: () => !closing,
        close,
      };
    },
  };
}
