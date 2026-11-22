import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Page } from "patchright-core";
import { envValue, browserPaths as paths } from "turno-core/paths";
import type { Engine, LaunchedBrowser } from "./engine.js";
import { IdleTimer, idleMs } from "./idle-timer.js";
import { playwright, upstream } from "./upstream.js";

/**
 * Attach mode: the `attach` engine. Instead of launching a Chrome, turno connects over CDP to
 * the Chrome the user already has open, so the agent works in the user's real, signed-in
 * browser. Opt-in only, per identity (identity.json `attach`) or per server (`--attach`).
 *
 * How Chrome allows it today: since Chrome 136, `--remote-debugging-port` is ignored on the
 * default user data dir. Since Chrome 144 the user can turn on remote debugging for the running
 * browser at chrome://inspect/#remote-debugging; Chrome then listens on 127.0.0.1, writes the
 * port and path to `DevToolsActivePort` in its user data dir, and asks the user to allow each new
 * connection. That dialog is the consent step: turno waits for it (`CONNECT_TIMEOUT_MS`) and
 * cannot answer it.
 *
 * The target (`parseAttachTarget`) is `auto` (the default Chrome profile of this computer),
 * the absolute path of a Chrome user data dir (Beta, Canary, a profile started with
 * `--remote-debugging-port` and its own `--user-data-dir`), or a loopback `http://` or `ws://`
 * endpoint.
 *
 * turno never closes the user's browser or a tab it did not open:
 *
 * - at connect it opens one tab of its own and makes it the agent's current tab, so a first
 *   `browser_navigate` never replaces a page of the user's;
 * - tabs that open during a tool call count as the agent's (`own`); tabs that were open before,
 *   or that the user opens between calls, are the user's;
 * - closing (`browser_close`, the session ending, the idle limit) closes the agent's tabs that
 *   are still open and disconnects: Playwright's `Browser.close` on a CDP connection only drops
 *   the connection, it does not close Chrome (checked with Chrome 157);
 * - the host's tab governor touches only the agent's tabs, and never closes a popup;
 * - no runtime lock, orphan sweep or shutdown signal reaches this Chrome: those act on the
 *   identity's own profile and the Chrome turno started on it, which attach mode never starts.
 */

/** How long to wait for the connection, which includes the user answering Chrome's dialog. */
const CONNECT_TIMEOUT_MS = 60_000;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type AttachTarget = { kind: "auto" } | { kind: "dir"; dir: string } | { kind: "endpoint"; url: string };

/** The target an `attach` value names, or a message saying what is wrong with it. */
export function parseAttachTarget(value: string): AttachTarget | { error: string } {
  const v = value.trim();
  if (v === "auto") return { kind: "auto" };
  if (isAbsolute(v)) return { kind: "dir", dir: v };
  if (/^(https?|wss?):\/\//.test(v)) {
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      return { error: `attach "${v}" is not a URL` };
    }
    if (!LOOPBACK.has(url.hostname))
      return { error: `attach "${v}" must be on this computer (127.0.0.1, localhost or [::1])` };
    return { kind: "endpoint", url: v };
  }
  return {
    error: `attach must be "auto", the absolute path of a Chrome user data dir, or a loopback http:// or ws:// endpoint, not "${v}"`,
  };
}

/** The user data dir of the installed Chrome's default profile, where Chrome writes `DevToolsActivePort`. */
export function defaultChromeUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = paths(env).home;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32")
    return join(
      envValue(env, "LOCALAPPDATA", "win32") || join(home, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "google-chrome");
}

/** `DevToolsActivePort`: the port on the first line, the browser's WebSocket path on the second. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | undefined {
  const [rawPort, rawPath] = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !rawPath?.startsWith("/")) return undefined;
  return { port, path: rawPath };
}

const ENABLE = "open chrome://inspect/#remote-debugging in that Chrome and turn remote debugging on";

/**
 * How long `resolveAttachEndpoint` waits for `DevToolsActivePort` to hold a port and a path.
 * Chrome creates the file and then writes it, not atomically, so a read right after Chrome starts
 * (or right after remote debugging is turned on) can find it missing or empty.
 */
const PORT_FILE_WAIT_MS = 5_000;
const PORT_FILE_POLL_MS = 50;

type PortFileState = { endpoint: string } | "missing" | "not ready";

function readPortFile(file: string): PortFileState {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
  const parsed = parseDevToolsActivePort(text);
  return parsed ? { endpoint: `ws://127.0.0.1:${parsed.port}${parsed.path}` } : "not ready";
}

function portFileOf(target: AttachTarget, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const dir = target.kind === "dir" ? target.dir : defaultChromeUserDataDir(env, platform);
  return { dir, file: join(dir, "DevToolsActivePort") };
}

function notReady(dir: string, file: string, state: "missing" | "not ready", waitMs: number): Error {
  if (state === "missing")
    return new Error(
      `attach: no Chrome with remote debugging on for ${dir} (no DevToolsActivePort). Start Chrome, then ${ENABLE}.`,
    );
  const waited = waitMs > 0 ? ` after ${waitMs / 1000}s` : "";
  return new Error(
    `attach: ${file} is still not a port and a path${waited}. If Chrome stopped while writing it, start Chrome again, then ${ENABLE}.`,
  );
}

/**
 * Where to connect for a target right now, without waiting or connecting: for `auto` and a dir,
 * the endpoint in its `DevToolsActivePort`. Throws with what the user should do when it is not there.
 */
export function readAttachEndpoint(
  target: AttachTarget,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (target.kind === "endpoint") return target.url;
  const { dir, file } = portFileOf(target, env, platform);
  const state = readPortFile(file);
  if (typeof state === "object") return state.endpoint;
  throw notReady(dir, file, state, 0);
}

/**
 * Like `readAttachEndpoint`, but treats a missing, empty or partial `DevToolsActivePort` as not
 * written yet and reads it again until `waitMs` passes. Throws with what the user should do then.
 */
export async function resolveAttachEndpoint(
  target: AttachTarget,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  waitMs: number = PORT_FILE_WAIT_MS,
): Promise<string> {
  if (target.kind === "endpoint") return target.url;
  const { dir, file } = portFileOf(target, env, platform);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = readPortFile(file);
    if (typeof state === "object") return state.endpoint;
    if (Date.now() >= deadline) throw notReady(dir, file, state, waitMs);
    await delay(PORT_FILE_POLL_MS);
  }
}

export function createAttachEngine(target: AttachTarget): Engine {
  return {
    id: "attach",
    refuse(tool) {
      // Arbitrary Playwright code in the user's own browser reaches every site it is signed in to.
      if (tool === "browser_run_code_unsafe")
        return "browser_run_code_unsafe is refused in attach mode: it would run arbitrary code against your own Chrome and every site it is signed in to. Use the other browser tools.";
      return undefined;
    },
    async launch({ config, identity }): Promise<LaunchedBrowser> {
      const env = identity?.env ?? process.env;
      const endpoint = await resolveAttachEndpoint(target, env);
      let browser: Browser;
      try {
        browser = await playwright().chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
      } catch (error) {
        const first = (error as Error).message.split("\n")[0];
        throw new Error(
          `attach: could not connect to Chrome at ${endpoint.replace(/\/devtools\/browser\/.*/, "")} (${first}). ` +
            `Chrome asks you to allow each new connection: click Allow in its dialog. If it did not ask, ${ENABLE}.`,
        );
      }
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => {});
        throw new Error("attach: that Chrome has no default browser context to work in");
      }
      const owned = new Set<Page>();
      let closing = false;
      const close = async () => {
        closing = true;
        upstream().core.utils.gracefullyCloseSet.delete(close);
        idleTimer?.dispose();
        for (const page of owned) if (!page.isClosed()) await page.close().catch(() => {});
        owned.clear();
        // On a CDP connection this disconnects; Chrome and the user's tabs stay.
        await browser.close().catch(() => {});
      };
      // The exit watchdog awaits this before the process exits, so the agent's tabs close then too.
      upstream().core.utils.gracefullyCloseSet.add(close);
      const ms = idleMs(config);
      let idleTimer: IdleTimer | undefined;
      if (ms) {
        idleTimer = new IdleTimer(ms, () => void close());
        browser.once("disconnected", () => idleTimer?.dispose());
      }
      return {
        engine: "attach",
        context,
        userBrowser: true,
        own(page) {
          owned.add(page);
          page.once("close", () => owned.delete(page));
        },
        ...(idleTimer ? { idleTimer } : {}),
        isOpen: () => !closing && browser.isConnected(),
        close,
      };
    },
  };
}
