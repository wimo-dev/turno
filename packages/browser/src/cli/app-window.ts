import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Where `live` opens the view: an app window (`--app`, no tabs and no address bar) of the
 * person's own Chromium browser, so it sits next to the agent's Chrome like a side panel.
 *
 * The window goes to the browser the person already runs: their default browser when it is a
 * Chromium one, else an installed Google Chrome (Microsoft Edge on Windows). A second process
 * started with `--app` hands the window to the one that runs and exits, so the view costs a
 * renderer, not a browser (measured with Chrome 158 on macOS: about 0.4 s and 17 MB more, where
 * a separate Chrome on a profile of its own took 0.8 s and a whole process tree). The view's
 * cookie lands in that browser, as with a tab. Without a Chromium browser, or when it does not
 * start, the link opens in a tab of the default browser.
 */

/** What the lookup reads from the system; tests pass a fake. */
export interface AppWindowProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** A command's standard output, or undefined when it fails. */
  run(command: string, args: readonly string[]): string | undefined;
  exists(path: string): boolean;
}

export interface AppWindowCommand {
  command: string;
  args: string[];
  /** The browser, as the person knows it. */
  browser: string;
}

/** macOS: Chromium browsers by bundle id (lowercase), with their names. */
const MAC_BROWSERS: Readonly<Record<string, string>> = {
  "com.google.chrome": "Google Chrome",
  "com.google.chrome.beta": "Google Chrome Beta",
  "com.google.chrome.dev": "Google Chrome Dev",
  "com.google.chrome.canary": "Google Chrome Canary",
  "com.brave.browser": "Brave Browser",
  "com.microsoft.edgemac": "Microsoft Edge",
  "org.chromium.chromium": "Chromium",
  "com.vivaldi.vivaldi": "Vivaldi",
};

/** Linux: Chromium browsers by the start of their desktop file name, with their commands. */
const LINUX_BROWSERS: readonly [string, string[]][] = [
  ["google-chrome", ["google-chrome", "google-chrome-stable"]],
  ["chromium", ["chromium", "chromium-browser"]],
  ["brave", ["brave-browser", "brave"]],
  ["microsoft-edge", ["microsoft-edge", "microsoft-edge-stable"]],
  ["vivaldi", ["vivaldi", "vivaldi-stable"]],
];

const systemProbe = (env: NodeJS.ProcessEnv): AppWindowProbe => ({
  platform: process.platform,
  env,
  run(command, args) {
    try {
      return execFileSync(command, [...args], {
        encoding: "utf8",
        env,
        timeout: 3_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
  },
  exists: existsSync,
});

/** The bundle id of the default browser on macOS (the handler of https), lowercase. */
function macDefault(p: AppWindowProbe): string | undefined {
  const home = p.env.HOME;
  if (!home) return undefined;
  const plist = posix.join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
  if (!p.exists(plist)) return undefined;
  const out = p.run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]);
  if (!out) return undefined;
  try {
    const handlers = (JSON.parse(out) as { LSHandlers?: Record<string, unknown>[] }).LSHandlers ?? [];
    for (const scheme of ["https", "http"]) {
      const h = handlers.find((x) => x.LSHandlerURLScheme === scheme);
      if (typeof h?.LSHandlerRoleAll === "string") return h.LSHandlerRoleAll.toLowerCase();
    }
  } catch {
    /* not the format this expects */
  }
  return undefined;
}

function onPath(p: AppWindowProbe, command: string): string | undefined {
  // Linux paths, whatever system runs this (tests probe every system from one).
  for (const dir of (p.env.PATH ?? "").split(posix.delimiter)) {
    if (!dir) continue;
    const full = posix.join(dir, command);
    if (p.exists(full)) return full;
  }
  return undefined;
}

/** The command that opens `url` as an app window of a Chromium browser, or undefined for none. */
export function appWindowCommand(url: string, probe?: AppWindowProbe): AppWindowCommand | undefined {
  const p = probe ?? systemProbe(process.env);
  const app = `--app=${url}`;
  if (p.platform === "darwin") {
    const preferred = macDefault(p);
    const chrome = [
      "/Applications/Google Chrome.app",
      posix.join(p.env.HOME ?? "", "Applications/Google Chrome.app"),
    ].some((path) => p.exists(path));
    const bundle = preferred && MAC_BROWSERS[preferred] ? preferred : chrome ? "com.google.chrome" : undefined;
    if (!bundle) return undefined;
    // -n: a new process, which hands the window to the browser that runs (or starts it).
    return { command: "open", args: ["-n", "-b", bundle, "--args", app], browser: MAC_BROWSERS[bundle]! };
  }
  if (p.platform === "linux") {
    const desktop = (p.run("xdg-settings", ["get", "default-web-browser"]) ?? "").trim().toLowerCase();
    const ordered = [
      ...LINUX_BROWSERS.filter(([prefix]) => desktop.startsWith(prefix)),
      ...LINUX_BROWSERS.filter(([prefix]) => prefix === "google-chrome" || prefix === "chromium"),
    ];
    for (const [, commands] of ordered)
      for (const command of commands) {
        const path = onPath(p, command);
        if (path) return { command: path, args: [app], browser: command };
      }
    return undefined;
  }
  if (p.platform === "win32") {
    const roots = [p.env.ProgramFiles, p.env["ProgramFiles(x86)"], p.env.LOCALAPPDATA].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    const candidates: [string, string][] = [
      ...roots.map((d): [string, string] => [
        win32.join(d, "Google", "Chrome", "Application", "chrome.exe"),
        "Google Chrome",
      ]),
      ...roots.map((d): [string, string] => [
        win32.join(d, "Microsoft", "Edge", "Application", "msedge.exe"),
        "Microsoft Edge",
      ]),
    ];
    const found = candidates.find(([path]) => p.exists(path));
    return found ? { command: found[0], args: [app], browser: found[1] } : undefined;
  }
  return undefined;
}
