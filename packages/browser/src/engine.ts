import { resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "patchright-core";
import { storagePartitioningArgs } from "./chrome-features.js";
import { type AttachTarget, createAttachEngine, parseAttachTarget } from "./engine-attach.js";
import { createCamoufoxEngine } from "./engine-camoufox.js";
import { createLightpandaEngine } from "./engine-lightpanda.js";
import { findProfileChrome, startedChromePid } from "./lifecycle.js";
import { chromeNetwork, pinUserAgent, verifyCoherence } from "./network-chrome.js";
import { networkEngineClash } from "./network.js";
import { policyEngineClash } from "./policy.js";
import { type ResolvedBrowser, resolveBrowser } from "./browsers.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import {
  type IdentitySettings,
  keychainArgs,
  launchSettings,
  readIdentitySettings,
  recordEngineClash,
  systemTimezone,
  chromeEnv,
} from "./settings.js";
import { type Tuning, launchTuning } from "./tuning.js";
import { IdleTimer, idleMs } from "./idle-timer.js";
import { type ClientInfo, type IdleTimerLike, type McpConfig, playwright, upstream } from "./upstream.js";
import { names } from "./names.js";

/**
 * Where the browser context behind an MCP session comes from. The host asks an
 * engine for a context when a session first needs the browser, and again after the browser
 * closed (idle limit, `browser_close`); it never launches a browser any other way. This module
 * and the `engine-*.ts` modules are the only code that knows how each engine starts.
 *
 * - `chrome`: the default. turno launches the installed Chrome itself, as a Patchright
 *   persistent context on the profile it chose (the identity's, or a temporary one), with the
 *   launch options upstream would use, so the profile and the tools see the same browser.
 * - `upstream`: every other mode (`--isolated`, `--cdp-endpoint`, `--endpoint`, `--extension`,
 *   `--shared-browser-context`, another browser than Chromium), handed to upstream's
 *   `createBrowserWithInfo` exactly as the stock program does.
 * - `lightpanda`: read mode on Lightpanda (`engine-lightpanda.ts`), chosen explicitly.
 * - `attach`: the Chrome the user already has open (`engine-attach.ts`), chosen explicitly.
 * - `camoufox`: Camoufox, a Firefox build, on stock Playwright (`engine-camoufox.ts`), chosen
 *   explicitly.
 *
 * Which one runs is decided at every launch (`engineChoice`): a server flag (`--engine`,
 * `--attach`) wins over identity.json (`engine`, `attach`), which is read at every launch like
 * the rest of it; without either, the config decides between `chrome` and `upstream`. Another
 * engine is one more `Engine` and one more case in `createEngine`; the host only sees
 * `LaunchedBrowser`.
 */

type EngineId = "chrome" | "upstream" | "lightpanda" | "attach" | "camoufox";

export interface LaunchedBrowser {
  engine: EngineId;
  /** The context the tools drive. */
  context: BrowserContext;
  /** The browser process, when turno started it and can name it. */
  pid?: number;
  /** Closes the session's browser (or leaves a shared one to the last session). */
  close(): Promise<void>;
  /**
   * False once the browser started closing (idle limit, a crash). Playwright may report the
   * close a moment after Chrome has exited, so the host asks before reusing a browser.
   */
  isOpen(): boolean;
  /** Closes the browser after the configured time without a tool call. */
  idleTimer?: IdleTimerLike;
  /**
   * True when the browser is the user's own (attach mode): the host opens a tab of its own as
   * the current tab, the tab governor touches only the agent's tabs, and nothing is brought to
   * the front.
   */
  userBrowser?: boolean;
  /** Marks a page as opened by the agent, so `close` closes it (attach mode). */
  own?(page: Page): void;
}

export interface LaunchRequest {
  config: McpConfig;
  clientInfo: ClientInfo;
  /** The parsed command line options (upstream reads `--extension` details from them). */
  cliOptions: Record<string, unknown>;
  /** The session title the browser is bound under (`browser.bind`), "<client> (2)" for a second one. */
  title: string;
  /** The identity whose profile this is (`--identity`), for its settings and runtime lock. */
  identity?: IdentityRef;
  /** How to run this browser; the chrome engine applies `backgroundThrottling`. */
  tuning?: Tuning;
  /** Hides a secret the launch read (proxy credentials) from every tool result. */
  secret?: (value: string, label: string) => void;
}

/** A browser identity as the host knows it: its id and the environment that locates its files. */
export interface IdentityRef {
  id: string;
  env: NodeJS.ProcessEnv;
}

export interface Engine {
  id: EngineId;
  launch(request: LaunchRequest): Promise<LaunchedBrowser>;
  /**
   * Why this engine does not run a tool, checked before the call reaches (or launches) the
   * browser; undefined when it runs it. For the identity's engine, `identity` says which one.
   */
  refuse?(tool: string, identity?: IdentityRef): string | undefined;
  /** The engine flags `createEngine` got, so the host's defaults know an engine a flag picks. */
  flags?: EngineFlags;
}

/** True when the config asks for the browser the `chrome` engine launches. */
export function usesChromeEngine(config: McpConfig): boolean {
  const b = config.browser;
  return (
    b.browserName === "chromium" &&
    b.userDataDir !== undefined &&
    !b.isolated &&
    !b.cdpEndpoint &&
    !b.remoteEndpoint &&
    !config.extension &&
    !config.sharedBrowserContext
  );
}

async function profileLocked5Times(userDataDir: string): Promise<boolean> {
  const { tools } = upstream();
  for (let i = 0; i < 5; i++) {
    if (!tools.isProfileLocked(userDataDir)) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return true;
}

/** Upstream's launch errors, word for word, so a user sees the same message as before. */
function launchError(error: Error, config: McpConfig, userDataDir: string, channel: string | undefined): Error {
  const message = error.message;
  if (message.includes("Executable doesn't exist")) {
    const target = message.includes("ffmpeg")
      ? "ffmpeg"
      : (config.browser.launchOptions.channel ?? config.browser.browserName);
    const label = target === "ffmpeg" ? "FFmpeg" : `Browser "${target}"`;
    const command = config.skillMode
      ? `playwright-cli install-browser ${target}`
      : `npx @playwright/mcp install-browser ${target}`;
    const match = message.match(/Executable doesn't exist at ([^\r\n]+)/);
    const location = match ? `; expected executable at ${match[1]!.trim()}` : "";
    return new Error(`${label} is not installed${location}. Run \`${command}\` to install`);
  }
  if (message.includes("cannot open shared object file: No such file or directory")) {
    const name = channel ?? config.browser.browserName;
    return new Error(
      `Missing system dependencies required to run browser ${name}. Install them with: sudo npx playwright install-deps ${name}`,
    );
  }
  if (message.includes("ProcessSingleton") || message.includes("exitCode=21")) {
    return new Error(
      `Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`,
    );
  }
  return error;
}

/** For an identity, who holds the profile instead of upstream's generic "already in use". */
function profileInUse(identity: IdentityRef | undefined, userDataDir: string): Error {
  if (!identity)
    return new Error(
      `Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser`,
    );
  const chrome = findProfileChrome(userDataDir);
  const who = chrome ? `a Chrome that turno-browser-mcp did not start (pid ${chrome.pid})` : "another Chrome";
  return new Error(
    `browser identity "${identity.id}" is in use by ${who}: a Chrome opened by hand on this profile, or a login from an older turno. ` +
      `Close it, then try again; \`${names().browser} doctor\` shows who holds each identity.`,
  );
}

/**
 * The installed Chrome on a persistent profile, launched by turno with the options upstream's
 * `createPersistentBrowser` uses: the resolved launch and context options, no signal handlers
 * of Playwright's own (the host's shutdown guard and upstream's exit watchdog close it), and
 * extensions allowed. It is bound like upstream's browser, so `playwright-cli` sees it too.
 *
 * For an identity it also takes the identity's runtime lock before Chrome starts,
 * records Chrome's PID and process group in it, gives it back when Chrome closes, and applies
 * identity.json: languages and locale as Chrome flags, the time zone as `timezoneId`. With
 * `backgroundThrottling` it drops Playwright's three anti-throttling switches and
 * turns off its focus emulation (`launchTuning`). Third-party storage partitioning, which
 * Playwright turns off, stays on (`chrome-features.ts`).
 */
const chromeEngine: Engine = {
  id: "chrome",
  async launch({ config, clientInfo, title, identity, tuning, secret }) {
    const userDataDir = config.browser.userDataDir;
    if (userDataDir === undefined) throw new Error("the chrome engine needs a profile directory");
    const { tools } = upstream();
    const tracesDir = resolve(tools.outputDir({ config, cwd: clientInfo.cwd }), "traces");
    const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
    // The user agent the defaults resolved (`defaults.ts`): identity.json's choice, or coherent
    // in a headless Chrome. A default one that cannot be applied is dropped, never fatal.
    const userAgent = tuning ? tuning.userAgent : settings?.userAgent === "coherent" ? "coherent" : undefined;
    const asked = settings ? { ...settings, userAgent } : undefined;
    const byDefault = tuning?.userAgent === "coherent" && settings?.userAgent !== "coherent";
    const plain = asked ? { ...asked, userAgent: undefined } : undefined;
    // Proxy credentials and the coherent user agent are settled before the lock: a missing
    // secret or an unknown Chrome version stops here, with nothing to undo.
    const networkOf = (s: IdentitySettings | undefined) =>
      s ? chromeNetwork(s, config, identity!.env, secret ?? (() => {}), byDefault) : Promise.resolve(undefined);
    let network = await networkOf(asked).catch((error: unknown) => {
      if (!byDefault) throw error;
      return networkOf(plain);
    });
    const held = identity ? acquireRuntimeLock(identity.id, identity.env, { holder: "mcp" }) : undefined;
    let context: BrowserContext;
    let browser: Browser;
    try {
      if (await profileLocked5Times(userDataDir)) throw profileInUse(identity, userDataDir);
      const ignore = config.browser.launchOptions.ignoreDefaultArgs;
      const userArgs = (config.browser.launchOptions.args as string[] | undefined) ?? [];
      const applied = launchSettings(
        settings,
        userArgs,
        systemTimezone(),
        config.browser.contextOptions,
        identity ? tuning?.locale : undefined,
      );
      const tuned = tuning ? launchTuning(tuning) : { ignoreDefaultArgs: [], contextOptions: {} };
      // Chrome's third-party storage partitioning stays on, as in a person's Chrome (`chrome-features.ts`).
      // The low-resource preset's features go in the same list: Chrome reads only the last one.
      const chromium = config.browser.browserName === "chromium";
      const extraFeatures = tuning?.disabledFeatures ?? [];
      const partitioning =
        chromium && ignore !== true
          ? storagePartitioningArgs(extraFeatures)
          : chromium && extraFeatures.length
            ? { ignoreDefaultArgs: [], args: [`--disable-features=${extraFeatures.join(",")}`] }
            : undefined;
      const launchOptions = {
        tracesDir,
        ...config.browser.launchOptions,
        ...tuned.contextOptions,
        ...config.browser.contextOptions,
        args: [...(partitioning?.args ?? []), ...userArgs, ...applied.args, ...(network?.args ?? [])],
        ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
        ...(network?.proxy ? { proxy: network.proxy } : {}),
        handleSIGINT: false,
        handleSIGTERM: false,
        // Elsewhere Chrome gets this process's environment, as before.
        ...(process.platform === "win32" ? { env: chromeEnv(process.env) } : {}),
        ignoreDefaultArgs:
          ignore === true
            ? true
            : [
                "--disable-extensions",
                ...(partitioning?.ignoreDefaultArgs ?? []),
                ...tuned.ignoreDefaultArgs,
                ...(keychainArgs(settings).ignoreDefaultArgs ?? []),
                ...(Array.isArray(ignore) ? ignore : []),
              ],
      };
      const open = async (options: typeof launchOptions) => {
        try {
          return await playwright()[config.browser.browserName].launchPersistentContext(userDataDir, options);
        } catch (err) {
          throw launchError(err as Error, config, userDataDir, options.channel as string | undefined);
        }
      };
      context = await open(launchOptions);
      browser = context.browser() as Browser;
      try {
        const pinned = network?.pin ? pinUserAgent(context, network.pin) : undefined;
        if (network?.verify) await verifyCoherence(context, browser.version(), network.verify, pinned);
      } catch (err) {
        await browser.close().catch(() => {});
        if (!byDefault) throw err;
        // The default coherent user agent did not check out on this Chrome: launch as it is.
        process.stderr.write(`turno-browser-mcp: ${(err as Error).message.split("\n")[0]}; launching without it\n`);
        network = await networkOf(plain);
        const userAgentArgs = new Set(launchOptions.args.filter((a) => a.startsWith("--user-agent=")));
        context = await open({ ...launchOptions, args: launchOptions.args.filter((a) => !userAgentArgs.has(a)) });
        browser = context.browser() as Browser;
      }
      try {
        await browser.bind(title, { workspaceDir: clientInfo.cwd });
      } catch (err) {
        await browser.close().catch(() => {});
        throw err;
      }
    } catch (err) {
      held?.release();
      throw err;
    }
    let closing = false;
    const ms = idleMs(config);
    let idleTimer: IdleTimer | undefined;
    if (ms) {
      const timer = new IdleTimer(ms, () => {
        closing = true;
        void browser.close().catch(() => {});
      });
      browser.once("disconnected", () => timer.dispose());
      idleTimer = timer;
    }
    const pid = startedChromePid(userDataDir);
    if (held) {
      // Playwright starts Chrome as the leader of its own process group; ps confirms it.
      // Windows has no process groups: the pid stands for the tree taskkill ends.
      const pgid =
        pid !== undefined
          ? process.platform === "win32"
            ? pid
            : (findProfileChrome(userDataDir)?.pgid ?? pid)
          : undefined;
      held.update({ ...(pid !== undefined ? { chromePid: pid } : {}), ...(pgid !== undefined ? { pgid } : {}) });
      browser.once("disconnected", () => held.release());
    }
    return {
      engine: "chrome",
      context,
      ...(pid !== undefined ? { pid } : {}),
      ...(idleTimer ? { idleTimer } : {}),
      isOpen: () => !closing && browser.isConnected(),
      async close() {
        closing = true;
        idleTimer?.dispose();
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        held?.release();
      },
    };
  },
};

function remoteConnectOptions(config: McpConfig): Record<string, unknown> {
  const remote = config.browser.remoteEndpoint;
  const headers = config.browser.remoteHeaders;
  if (remote === undefined) return {};
  if (typeof remote === "string") return { headers };
  const { endpoint: _endpoint, ...options } = remote;
  return { ...options, headers: { ...headers, ...remote.headers } };
}

/**
 * Every mode turno does not launch itself goes through upstream's `createBrowserWithInfo`,
 * with the session handling of upstream's MCP program (`program.ts`): sessions share one
 * browser for `--shared-browser-context` and `--isolated`, and the last one to leave closes it.
 */
function createUpstreamEngine(): Engine {
  let shared: Promise<Awaited<ReturnType<ReturnType<typeof upstream>["tools"]["createBrowserWithInfo"]>>> | undefined;
  let clients = 0;
  return {
    id: "upstream",
    async launch({ config, clientInfo, cliOptions, title }) {
      const { tools } = upstream();
      const useShared = config.sharedBrowserContext || config.browser.isolated;
      const bind = { title: clientInfo.clientName, workspaceDir: clientInfo.cwd };
      if (useShared && !shared) {
        const promise = tools.createBrowserWithInfo(config, clientInfo, cliOptions, bind).then(
          (info) => {
            info.browser.once("disconnected", () => {
              if (shared === promise) shared = undefined;
            });
            return info;
          },
          (error: unknown) => {
            if (shared === promise) shared = undefined;
            throw error;
          },
        );
        shared = promise;
      }
      clients++;
      const sharedPromise = shared;
      let sharedInfo: Awaited<NonNullable<typeof shared>> | undefined;
      let info: Awaited<NonNullable<typeof shared>>;
      let browser: Browser;
      try {
        sharedInfo = await sharedPromise;
        if (sharedInfo) {
          info = sharedInfo;
          browser = await sharedInfo.browser.browserType().connect(sharedInfo.endpoint, remoteConnectOptions(config));
        } else {
          info = await tools.createBrowserWithInfo(config, clientInfo, cliOptions, { ...bind, title });
          browser = info.browser;
        }
      } catch (error) {
        clients--;
        throw error;
      }
      let context: BrowserContext;
      try {
        context = config.browser.isolated
          ? await browser.newContext(config.browser.contextOptions)
          : (browser.contexts()[0] ?? (await browser.newContext(config.browser.contextOptions)));
      } catch (error) {
        clients--;
        await browser.close().catch(() => {});
        throw error;
      }
      return {
        engine: "upstream",
        context,
        isOpen: () => browser.isConnected(),
        ...(info.idleTimer ? { idleTimer: info.idleTimer } : {}),
        async close() {
          clients--;
          const last = !sharedInfo || !clients;
          if (last && shared === sharedPromise) shared = undefined;
          if (!last) {
            if (config.browser.isolated) await context.close().catch(() => {});
            await browser.close().catch(() => {});
            return;
          }
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
          await sharedInfo?.browser.close().catch(() => {});
        },
      };
    },
  };
}

/** The engine for this config. */
export function selectEngine(config: McpConfig, fallback: Engine): Engine {
  return usesChromeEngine(config) ? chromeEngine : fallback;
}

/** The `turno-browser-mcp` flags that pick an engine; each wins over identity.json. */
export interface EngineFlags {
  engine?: "chrome" | "lightpanda" | "camoufox";
  /** An attach target (`parseAttachTarget`). */
  attach?: string;
  /** `--browser` or `--executable-path` was given: identity.json `browser` is not applied. */
  browserFromFlags?: boolean;
}

/** The engine one launch uses, before the config decides between `chrome` and `upstream`. */
export type EngineChoice =
  | { kind: "default" }
  | { kind: "lightpanda" }
  | { kind: "camoufox" }
  | { kind: "attach"; target: AttachTarget };

/**
 * Flags first, then identity.json. A flag of either kind replaces both keys of identity.json:
 * `--engine chrome` turns an identity's attach or read mode off for that server.
 */
export function engineChoice(
  flags: EngineFlags,
  settings: Pick<IdentitySettings, "engine" | "attach"> | undefined,
): EngineChoice {
  const fromFlags = flags.engine !== undefined || flags.attach !== undefined;
  const engine = fromFlags ? flags.engine : settings?.engine;
  const attach = fromFlags ? flags.attach : settings?.attach;
  if (attach !== undefined) {
    if (engine === "lightpanda" || engine === "camoufox")
      throw new Error(`attach and the ${engine} engine do not go together: pick one`);
    const target = parseAttachTarget(attach);
    if ("error" in target) throw new Error(target.error);
    return { kind: "attach", target };
  }
  if (engine === "lightpanda") return { kind: "lightpanda" };
  return engine === "camoufox" ? { kind: "camoufox" } : { kind: "default" };
}

/**
 * The host's engine: at every launch it reads the identity's settings and the flags, and hands
 * the launch to `lightpanda`, `attach`, or the engine the config selects.
 */
/**
 * Why an engine cannot run with these settings, if it cannot: attach mode keeps one agent's tabs
 * apart from the user's, not several sessions apart from each other, and read mode has no
 * layout for human-like input to move over.
 */
export function tuningClash(engine: string, tuning: Pick<Tuning, "sharing" | "humanize">): string | undefined {
  if (engine === "attach" && tuning.sharing === "tabs")
    return '"sharing": "tabs" does not go with attach mode: in your own Chrome turno keeps one agent\'s tabs apart from yours, not several sessions apart. Turn one off (--sharing session, or --attach "")';
  if (engine === "lightpanda" && tuning.humanize.level !== "off" && tuning.humanize.level !== "auto")
    return "humanize does not go with read mode: Lightpanda lays out no page, so there is no pointer path or scroll to play. Turn one off (--humanize off, or --engine chrome)";
  return undefined;
}

/**
 * The config with identity.json `browser` applied, for the chrome engine. Precedence: a server's
 * `--browser` or `--executable-path` (and an executable path from the environment or a config
 * file), then identity.json `browser`, then Google Chrome. Throws `BrowserNotFound` when the
 * identity's browser is not installed: turno never opens the profile in another browser on its
 * own.
 */
export function withIdentityBrowser(
  config: McpConfig,
  settings: Pick<IdentitySettings, "browser"> | undefined,
  flags: Pick<EngineFlags, "browserFromFlags">,
  resolve: (choice: string) => ResolvedBrowser = (choice) => resolveBrowser(choice, { command: names().browser }),
  platform: NodeJS.Platform = process.platform,
): McpConfig {
  const choice = settings?.browser;
  const lo = config.browser.launchOptions;
  if (choice === undefined || flags.browserFromFlags || lo.executablePath !== undefined) return config;
  const { launch } = resolve(choice);
  const { channel: _channel, ...rest } = lo;
  const launchOptions: McpConfig["browser"]["launchOptions"] = { ...rest, ...launch };
  // As upstream does for `--browser chromium`: the downloaded build has no setuid sandbox helper
  // on Linux, where user namespaces are often restricted.
  if (platform === "linux" && choice === "chrome-for-testing") launchOptions.chromiumSandbox = false;
  return { ...config, browser: { ...config.browser, launchOptions } };
}

export function createEngine(config: McpConfig, flags: EngineFlags = {}, fallback?: Engine): Engine {
  const base = selectEngine(config, fallback ?? createUpstreamEngine());
  const lightpanda = createLightpandaEngine();
  const camoufox = createCamoufoxEngine();
  const choose = (identity?: IdentityRef): Engine => {
    const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
    const choice = engineChoice(flags, settings);
    if (choice.kind === "lightpanda") return lightpanda;
    if (choice.kind === "camoufox") return camoufox;
    if (choice.kind === "attach") return createAttachEngine(choice.target);
    return base;
  };
  return {
    id: base.id,
    flags,
    launch: async (request) => {
      const engine = choose(request.identity);
      const settings = request.identity ? readIdentitySettings(request.identity.id, request.identity.env) : undefined;
      const record = settings?.record;
      // A flag can pick an engine that identity.json's other keys do not go with: refused here,
      // before anything starts.
      const clash =
        (request.tuning ? tuningClash(engine.id, request.tuning) : undefined) ??
        (record ? recordEngineClash(engine.id, record) : undefined) ??
        (settings ? networkEngineClash(engine.id, settings) : undefined) ??
        policyEngineClash(engine.id, settings?.policy);
      if (clash) throw new Error(clash);
      if (engine.id === "chrome")
        return await engine.launch({ ...request, config: withIdentityBrowser(request.config, settings, flags) });
      return await engine.launch(request);
    },
    refuse(tool, identity) {
      let engine: Engine;
      try {
        engine = choose(identity);
      } catch {
        return undefined; // the launch reports a bad identity.json or flag
      }
      return engine.refuse?.(tool, identity);
    },
  };
}
