import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserProbe,
  browserSwitchProblem,
  versionFromFolders,
  detectBrowsers,
  profileLastVersion,
  resolveBrowser,
} from "../src/browsers.js";
import { withIdentityBrowser } from "../src/engine.js";
import { addIdentity, identityDir } from "../src/identities.js";
import { readIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import type { McpConfig } from "../src/upstream.js";
import { cli, fakeIo, real } from "./cli/helpers.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Which Chromium-based browser opens an identity's profile: detection on a fake file system per
 * OS, how each one is launched, the precedence of the server's flags over identity.json, and the
 * rule for switching the browser of a profile that another browser already opened.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A machine with exactly these files; versions by path. */
function machine(files: Record<string, string | undefined>, extra: Partial<BrowserProbe> = {}): BrowserProbe {
  return {
    exists: (p) => p in files,
    version: (p) => files[p],
    isSnap: () => false,
    chromeForTesting: () => undefined,
    ...extra,
  };
}

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC_BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

describe("detection", () => {
  it("finds macOS browsers in /Applications and in ~/Applications, in the table's order", () => {
    const userEdge = join(sb.home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge");
    const cft = "/cache/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing";
    const probe = machine(
      { [MAC_BRAVE]: "157.1.99.57", [userEdge]: "158.0.4370.33", [cft]: "156.0.8078.4" },
      { chromeForTesting: () => cft },
    );
    expect(detectBrowsers(sb.env, "darwin", probe)).toEqual([
      { id: "edge", label: "Microsoft Edge", path: userEdge, version: "158.0.4370.33" },
      { id: "brave", label: "Brave", path: MAC_BRAVE, version: "157.1.99.57" },
      { id: "chrome-for-testing", label: "Chrome for Testing", path: cft, version: "156.0.8078.4" },
    ]);
  });

  it("finds Linux packages and skips a Chromium that is a snap", () => {
    const probe = machine(
      { "/usr/bin/google-chrome-stable": "157.0.8103.79", "/usr/bin/chromium-browser": undefined },
      { isSnap: (p) => p === "/usr/bin/chromium-browser" },
    );
    expect(detectBrowsers(sb.env, "linux", probe)).toEqual([
      { id: "chrome", label: "Google Chrome", path: "/usr/bin/google-chrome-stable", version: "157.0.8103.79" },
    ]);
    expect(detectBrowsers(sb.env, "win32", probe)).toEqual([]);
  });

  it("finds Windows browsers in Program Files, Program Files (x86) and the per-user LOCALAPPDATA", () => {
    const env = {
      USERPROFILE: "C:\\Users\\a",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
    };
    const chrome = "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
    const probe = machine({ [chrome]: "157.0.8103.79", [edge]: "158.0.4370.33", [brave]: "157.1.99.57" });
    expect(detectBrowsers(env, "win32", probe).map((b) => [b.id, b.path])).toEqual([
      ["chrome", chrome],
      ["edge", edge],
      ["brave", brave],
    ]);
    // Without the variables, Windows' default folders.
    expect(detectBrowsers({ USERPROFILE: "C:\\Users\\a" }, "win32", probe).map((b) => b.id)).toEqual([
      "chrome",
      "edge",
      "brave",
    ]);
    // Launched by path: Playwright's channel lookup on Windows has its own order.
    expect(resolveBrowser("chrome", { env, platform: "win32", probe }).launch).toEqual({ executablePath: chrome });
  });

  it("reads a Windows browser's version from the folder next to its executable", () => {
    expect(versionFromFolders(["chrome.exe", "157.0.8103.79", "157.0.8103.114", "SetupMetrics"])).toBe(
      "157.0.8103.114",
    );
    expect(versionFromFolders(["chrome.exe"])).toBeUndefined();
  });
});

describe("how a browser is launched", () => {
  it("uses Playwright's channel at its own location, the path anywhere else", () => {
    const userChrome = join(sb.home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    const at = (files: Record<string, string>) => ({ env: sb.env, platform: "darwin" as const, probe: machine(files) });
    expect(resolveBrowser("chrome", at({ [MAC_CHROME]: "157" })).launch).toEqual({ channel: "chrome" });
    expect(resolveBrowser("chrome", at({ [userChrome]: "157" })).launch).toEqual({ executablePath: userChrome });
    expect(resolveBrowser("brave", at({ [MAC_BRAVE]: "157" })).launch).toEqual({ executablePath: MAC_BRAVE });
    expect(resolveBrowser("/opt/thorium/thorium", at({ "/opt/thorium/thorium": "1" })).launch).toEqual({
      executablePath: "/opt/thorium/thorium",
    });
    const cft = machine({ "/c/chrome": "156" }, { chromeForTesting: () => "/c/chrome" });
    expect(resolveBrowser("chrome-for-testing", { env: sb.env, platform: "darwin", probe: cft }).launch).toEqual({
      channel: "chrome-for-testing",
    });
  });

  it("never falls back to another browser: it says what is installed and how to get one without admin", () => {
    const opts = { env: sb.env, platform: "darwin" as const, command: "turno-browser" };
    expect(() => resolveBrowser("edge", { ...opts, probe: machine({ [MAC_BRAVE]: "157" }) })).toThrow(
      "Microsoft Edge is not installed on this machine: install Microsoft Edge, or use one that is installed (brave) for a new identity, or `turno-browser install-browser` downloads Chrome for Testing into your user cache, no admin password needed",
    );
    expect(() => resolveBrowser("chrome-for-testing", { ...opts, probe: machine({}) })).toThrow(
      "run `turno-browser install-browser`",
    );
    expect(() => resolveBrowser("/nowhere/browser", { ...opts, probe: machine({}) })).toThrow("is not there");
  });
});

describe("precedence: server flags, then identity.json browser, then Google Chrome", () => {
  const config = (launchOptions: Record<string, unknown> = { channel: "chrome" }) =>
    ({ browser: { browserName: "chromium", userDataDir: "/p", launchOptions } }) as unknown as McpConfig;
  const brave = () => ({ choice: "brave", label: "Brave", launch: { executablePath: MAC_BRAVE } });

  it("applies identity.json browser when no flag names one", () => {
    const out = withIdentityBrowser(config({ channel: "chrome", headless: true }), { browser: "brave" }, {}, brave);
    expect(out.browser.launchOptions).toEqual({ headless: true, executablePath: MAC_BRAVE });
  });

  it("keeps the server's --browser, --executable-path or a config's path, and Chrome without a setting", () => {
    const base = config();
    expect(withIdentityBrowser(base, { browser: "brave" }, { browserFromFlags: true }, brave)).toBe(base);
    const byPath = config({ channel: "chrome", executablePath: "/x/chrome" });
    expect(withIdentityBrowser(byPath, { browser: "brave" }, {}, brave)).toBe(byPath);
    const chrome = (choice: string) => ({ choice, label: "", launch: { channel: "chrome" } });
    expect(withIdentityBrowser(base, {}, {}, chrome)).toBe(base);
  });

  it("runs Google Chrome without a setting, from its path when its channel does not find it", () => {
    const userChrome = join(sb.home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    const home = (choice: string) =>
      resolveBrowser(choice, { env: sb.env, platform: "darwin", probe: machine({ [userChrome]: "158.0.0.0" }) });
    expect(
      withIdentityBrowser(config({ channel: "chrome", headless: true }), {}, {}, home).browser.launchOptions,
    ).toEqual({
      headless: true,
      executablePath: userChrome,
    });
  });

  it("turns the sandbox off for Chrome for Testing on Linux, as upstream does for --browser chromium", () => {
    const cft = () => ({ choice: "chrome-for-testing", label: "", launch: { channel: "chrome-for-testing" } });
    const out = withIdentityBrowser(config(), { browser: "chrome-for-testing" }, {}, cft, "linux");
    expect(out.browser.launchOptions).toEqual({ channel: "chrome-for-testing", chromiumSandbox: false });
  });
});

describe("identity.json browser", () => {
  it("is format 13, takes a name or an absolute path, and not with another engine", () => {
    addIdentity("school", sb.env);
    expect(writeIdentitySettings("school", { browser: "brave" }, sb.env)).toMatchObject({ version: 13 });
    writeIdentitySettings("school", { browser: "/opt/thorium/thorium" }, sb.env);
    expect(readIdentitySettings("school", sb.env)?.browser).toBe("/opt/thorium/thorium");
    expect(() => writeIdentitySettings("school", { browser: "firefox" }, sb.env)).toThrow(/browser must be "chrome"/);
    expect(() => writeIdentitySettings("school", { engine: "lightpanda" }, sb.env)).toThrow(
      /browser does not go with engine "lightpanda"/,
    );
  });
});

describe("switching the browser of a profile", () => {
  /** A profile another browser opened: it wrote `Last Version`. */
  function used(id: string, version = "157.0.8103.79") {
    const dir = identityDir(id, sb.env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Last Version"), version);
  }

  it("is free on a profile no browser opened yet, refused on a used one", () => {
    expect(browserSwitchProblem("chrome", "brave", undefined, undefined)).toBeUndefined();
    expect(browserSwitchProblem("brave", "brave", "157.1.99.57", undefined)).toBeUndefined();
    expect(browserSwitchProblem("chrome", "brave", "157.0.8103.79", undefined)).toMatch(
      /last opened by Google Chrome \(version 157\.0\.8103\.79\): the cookies carry over with the default keychain/,
    );
    expect(browserSwitchProblem("chrome", "edge", "157.0.8103.79", "system")).toMatch(
      /each browser encrypts cookies with its own key, so Microsoft Edge cannot read the sign-ins/,
    );
  });

  it("set refuses the switch on a used profile and does it with --force", async () => {
    const api = await real();
    addIdentity("school", sb.env);
    await cli(api).run("set", ["school", "--browser", "chrome-for-testing"], fakeIo(sb.env));
    expect(readIdentitySettings("school", sb.env)?.browser).toBe("chrome-for-testing");
    used("school", "156.0.8078.4");
    expect(profileLastVersion(identityDir("school", sb.env))).toBe("156.0.8078.4");
    await expect(cli(api).run("set", ["school", "--browser", ""], fakeIo(sb.env))).rejects.toThrow(
      /not switching the browser of "school": the profile was last opened by Chrome for Testing .* --force switches anyway/,
    );
    expect(readIdentitySettings("school", sb.env)?.browser).toBe("chrome-for-testing");
    const io = fakeIo(sb.env);
    expect(await cli(api).run("set", ["school", "--browser", "", "--force"], io)).toBe(0);
    expect(readIdentitySettings("school", sb.env)?.browser).toBeUndefined();
    expect(io.lines.join("\n")).toMatch(/browser switched with --force/);
  });
});
