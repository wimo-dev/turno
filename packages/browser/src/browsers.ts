import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";

/**
 * Which Chromium-based browser runs an identity (identity.json `browser`), where each one lives
 * on macOS and Linux, and how Playwright launches it.
 *
 * - `chrome` (the default): Google Chrome.
 * - `edge`: Microsoft Edge.
 * - `brave`: Brave.
 * - `chromium`: a Chromium build installed on the machine (a distribution's package, or
 *   Chromium.app), never a snap: a snap cannot write a profile under a hidden folder like
 *   ~/.local/share.
 * - `chrome-for-testing`: the Chrome for Testing build Playwright downloads into the user's
 *   cache (`turno-browser install-browser`), with no admin rights.
 * - an absolute path: any other Chromium-based browser, on the user's word.
 *
 * Every browser in the table was launched on a persistent profile through Playwright's pipe,
 * headed and headless, with the live view's screencast and the agent cursor (see the
 * browsers section of the identities doc). Arc and Dia are Chromium builds turno could not
 * test, so they have no name here: they may work with a path. Windows paths are a later stage;
 * a new browser or OS is one more entry in `BROWSERS`.
 */

export const BROWSER_IDS = ["chrome", "edge", "brave", "chromium", "chrome-for-testing"] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

/** identity.json `browser`: one of `BROWSER_IDS`, or the absolute path of a browser's executable. */
export type BrowserChoice = BrowserId | (string & {});

type Os = "darwin" | "linux";

interface BrowserSpec {
  id: BrowserId;
  label: string;
  /**
   * Playwright's channel, when Playwright finds the browser itself at `channelPaths`. A copy
   * somewhere else (Chrome in ~/Applications) is launched by path instead.
   */
  channel?: string;
  /** Where Playwright's channel looks, per OS. */
  channelPaths?: Partial<Record<Os, string[]>>;
  /** Where the browser lives, per OS: system folders first, then the user's own. */
  paths: Partial<Record<Os, (home: string) => string[]>>;
}

const macApp = (app: string, exe: string) => (home: string) => [
  `/Applications/${app}.app/Contents/MacOS/${exe}`,
  join(home, "Applications", `${app}.app`, "Contents", "MacOS", exe),
];

const BROWSERS: readonly BrowserSpec[] = [
  {
    id: "chrome",
    label: "Google Chrome",
    channel: "chrome",
    channelPaths: {
      darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      linux: ["/opt/google/chrome/chrome"],
    },
    paths: {
      darwin: macApp("Google Chrome", "Google Chrome"),
      linux: () => ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    },
  },
  {
    id: "edge",
    label: "Microsoft Edge",
    channel: "msedge",
    channelPaths: {
      darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      linux: ["/opt/microsoft/msedge/msedge"],
    },
    paths: {
      darwin: macApp("Microsoft Edge", "Microsoft Edge"),
      linux: () => ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    },
  },
  {
    id: "brave",
    label: "Brave",
    paths: {
      darwin: macApp("Brave Browser", "Brave Browser"),
      linux: () => ["/opt/brave.com/brave/brave", "/usr/bin/brave-browser", "/usr/bin/brave-browser-stable"],
    },
  },
  {
    id: "chromium",
    label: "Chromium",
    paths: {
      darwin: macApp("Chromium", "Chromium"),
      linux: () => ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/lib/chromium/chromium"],
    },
  },
  {
    id: "chrome-for-testing",
    label: "Chrome for Testing",
    // Playwright's alias for the build it downloads (`playwright install chromium`).
    channel: "chrome-for-testing",
    paths: {},
  },
];

export function isBrowserId(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

export function browserLabel(choice: BrowserChoice): string {
  return BROWSERS.find((b) => b.id === choice)?.label ?? choice;
}

/** Why a value cannot be identity.json `browser`, or undefined when it can. */
export function browserProblem(value: unknown): string | undefined {
  if (typeof value === "string" && (isBrowserId(value) || isAbsolute(value))) return undefined;
  return `browser must be ${BROWSER_IDS.map((b) => `"${b}"`).join(", ")} or the absolute path of a Chromium-based browser`;
}

/** A browser found on this machine. */
export interface DetectedBrowser {
  id: BrowserId;
  label: string;
  path: string;
  version?: string;
}

/** What detection reads from the machine; tests give a fake one. */
export interface BrowserProbe {
  exists(path: string): boolean;
  /** The browser's version, from the app's Info.plist on macOS or `--version` elsewhere. */
  version(path: string, platform: NodeJS.Platform): string | undefined;
  /** True for a launcher that hands over to a snap (Ubuntu's chromium-browser). */
  isSnap(path: string): boolean;
  /**
   * The executable of the per-user Chrome for Testing, installed or not. Playwright's registry
   * reads PLAYWRIGHT_BROWSERS_PATH (and HOME) of this process when it loads.
   */
  chromeForTesting(): string | undefined;
}

/** CFBundleShortVersionString of a macOS Info.plist (XML). */
export function versionFromPlist(xml: string): string | undefined {
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]?.trim();
}

function readVersion(path: string, platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === "darwin") {
      const plist = join(dirname(dirname(path)), "Info.plist");
      if (existsSync(plist)) return versionFromPlist(readFileSync(plist, "utf8"));
    }
    return /(\d+\.\d+\.\d+\.\d+)/.exec(
      execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }),
    )?.[1];
  } catch {
    return undefined;
  }
}

/** A small script that names /snap/ is a snap launcher; a real browser binary is megabytes. */
function snapLauncher(path: string): boolean {
  try {
    if (path.startsWith("/snap/")) return true;
    if (statSync(path).size > 64 * 1024) return false;
    return readFileSync(path, "utf8").includes("/snap/");
  } catch {
    return false;
  }
}

/** Where Playwright's installer puts Chrome for Testing for this package's patchright-core. */
function chromeForTestingPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const { registry } = (require("patchright-core/lib/coreBundle") as CoreRegistry).registry;
    return registry.findExecutable("chromium")?.executablePath() ?? undefined;
  } catch {
    return undefined;
  }
}

const MACHINE_PROBE: BrowserProbe = {
  exists: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  version: readVersion,
  isSnap: snapLauncher,
  chromeForTesting: chromeForTestingPath,
};

function osOf(platform: NodeJS.Platform): Os | undefined {
  return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/** The first install of one browser, or undefined. */
export function findBrowser(
  id: BrowserId,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: BrowserProbe = MACHINE_PROBE,
): DetectedBrowser | undefined {
  const spec = BROWSERS.find((b) => b.id === id)!;
  let path: string | undefined;
  if (id === "chrome-for-testing") {
    const exe = probe.chromeForTesting();
    path = exe && probe.exists(exe) ? exe : undefined;
  } else {
    const os = osOf(platform);
    const candidates = os ? (spec.paths[os]?.(paths(env).home) ?? []) : [];
    path = candidates.find((p) => probe.exists(p) && !probe.isSnap(p));
  }
  if (!path) return undefined;
  const version = probe.version(path, platform);
  return { id, label: spec.label, path, ...(version ? { version } : {}) };
}

/** Every browser of the table found on this machine, in the table's order. */
export function detectBrowsers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: BrowserProbe = MACHINE_PROBE,
): DetectedBrowser[] {
  return BROWSER_IDS.map((id) => findBrowser(id, env, platform, probe)).filter((b) => b !== undefined);
}

/** The Playwright launch options that pick the browser: a channel, or an executable path. */
export type BrowserLaunch = { channel: string } | { executablePath: string };

export interface ResolvedBrowser {
  choice: BrowserChoice;
  label: string;
  launch: BrowserLaunch;
  /** Where it was found; undefined for a path given by hand. */
  found?: DetectedBrowser;
}

class BrowserNotFound extends Error {
  override name = "BrowserNotFound";
}

/** How to get a browser without admin rights, for messages. */
function installHint(browserCommand: string): string {
  return `\`${browserCommand} install-browser\` downloads Chrome for Testing into your user cache, no admin password needed`;
}

/**
 * How to launch the browser an identity asks for. Throws `BrowserNotFound`, with what to do,
 * when it is not installed: turno never falls back to another browser on its own, since a
 * profile opened by another browser can lose its sign-ins.
 */
export function resolveBrowser(
  choice: BrowserChoice,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    probe?: BrowserProbe;
    /** The command that names turno-browser here (`turno-browser`, `turno browser`). */
    command?: string;
  } = {},
): ResolvedBrowser {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? MACHINE_PROBE;
  const command = options.command ?? "turno-browser";
  if (!isBrowserId(choice)) {
    if (!isAbsolute(choice) || !probe.exists(choice))
      throw new BrowserNotFound(`the browser at ${choice} (identity.json browser) is not there`);
    return { choice, label: choice, launch: { executablePath: choice } };
  }
  const spec = BROWSERS.find((b) => b.id === choice)!;
  const found = findBrowser(choice, env, platform, probe);
  if (!found) {
    const others = detectBrowsers(env, platform, probe).map((b) => b.id);
    const instead = others.length ? `use one that is installed (${others.join(", ")}) for a new identity, or ` : "";
    const how =
      choice === "chrome-for-testing"
        ? `run \`${command} install-browser\` (no admin password needed)`
        : `install ${spec.label}, or ${instead}${installHint(command)}`;
    throw new BrowserNotFound(`${spec.label} is not installed on this machine: ${how}`);
  }
  const os = osOf(platform);
  const viaChannel =
    spec.channel !== undefined &&
    (choice === "chrome-for-testing" || (os !== undefined && (spec.channelPaths?.[os] ?? []).includes(found.path)));
  return {
    choice,
    label: spec.label,
    launch: viaChannel ? { channel: spec.channel! } : { executablePath: found.path },
    found,
  };
}

/**
 * How login, export and import launch the identity's browser: Google Chrome's channel when
 * identity.json names none (as before identity.json had `browser`), else the resolved one.
 */
export function identityBrowserLaunch(
  settings: { browser?: BrowserChoice } | undefined,
  env: NodeJS.ProcessEnv,
  command?: string,
): BrowserLaunch {
  if (settings?.browser === undefined) return { channel: "chrome" };
  return resolveBrowser(settings.browser, { env, ...(command ? { command } : {}) }).launch;
}

/** The major version in a profile's `Last Version` file (the browser that opened it last). */
export function profileLastVersion(userDataDir: string): string | undefined {
  try {
    const text = readFileSync(join(userDataDir, "Last Version"), "utf8").trim();
    return /^\d+(\.\d+)*$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

export const majorOf = (version: string | undefined): number | undefined => {
  const m = version === undefined ? undefined : /^(\d+)\./.exec(version);
  return m ? Number(m[1]) : undefined;
};

/**
 * Why switching a used profile to another browser is refused without `--force`, or undefined
 * when it is allowed. Measured on macOS with Chrome 157, Brave 157, Edge 158 and Chrome for
 * Testing 156 on the default mock keychain: cookies and local storage carried over in every
 * direction, even 157 to 156. But Brave leaves its own component extensions and prefs in the
 * profile, an older browser refuses a profile whose databases a newer one upgraded, and with
 * keychain "system" each browser encrypts cookies with its own keychain item, so the sign-ins
 * of one are unreadable to the other.
 */
export function browserSwitchProblem(
  from: BrowserChoice,
  to: BrowserChoice,
  lastVersion: string | undefined,
  keychain: "mock" | "system" | undefined,
): string | undefined {
  if (from === to || lastVersion === undefined) return undefined;
  const cookies =
    keychain === "system"
      ? `with keychain "system" each browser encrypts cookies with its own key, so ${browserLabel(to)} cannot read the sign-ins ${browserLabel(from)} saved`
      : "the cookies carry over with the default keychain, but the new browser rewrites the profile and an older one can refuse it";
  return `the profile was last opened by ${browserLabel(from)} (version ${lastVersion}): ${cookies}`;
}

interface CoreRegistry {
  registry: {
    registry: {
      findExecutable(name: string): { executablePath(): string | undefined } | undefined;
    };
  };
}
