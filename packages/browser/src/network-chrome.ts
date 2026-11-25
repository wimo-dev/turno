import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "patchright-core";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, browserPaths as paths } from "turno-core/paths";
import { findBrowser, readVersion } from "./browsers.js";
import { findChrome } from "./doctor.js";
import {
  CHROME_PROXY_ARGS,
  type ExpectedIdentity,
  type ObservedIdentity,
  OBSERVE_SCRIPT,
  type ResolvedProxy,
  coherenceProblems,
  majorOf,
  reducedUserAgent,
  resolveProxy,
} from "./network.js";
import { type IdentitySettings, acceptLanguages, chromeEnv } from "./settings.js";
import type { McpConfig } from "./upstream.js";

/**
 * How the chrome engine applies identity.json `proxy` and `userAgent` (`network.ts`). Both are
 * settled before Chrome starts: a missing secret or an unknown Chrome version stops the launch
 * with nothing to undo.
 *
 * `userAgent: "coherent"` changes nothing in a headed Chrome, which already presents itself
 * as it is; the launch check still runs. A headless Chrome says HeadlessChrome, so it gets two
 * things, measured with Chrome 157:
 *
 * - the `--user-agent` switch with the headed string for the same version and OS, which every
 *   request, popup and worker carries from the start; on its own it blanks the client hints'
 *   high entropy values (full version list, architecture, platform version), which a real
 *   Chrome never does;
 * - so each page also gets those values back through `Emulation.setUserAgentOverride`, with
 *   the metadata this same Chrome reports when nothing overrides it, read once per Chrome
 *   version by a short headless launch on a throwaway profile and kept in the state folder.
 *   Dedicated workers take them from their page.
 *
 * A tab a tool opens gets them before its first navigation. A popup a page opens gets them as
 * soon as it exists, which can be after its first document loaded: that document reads blank
 * high entropy values (the user agent string is right there too).
 */

export interface ChromeNetwork {
  /** Chrome switches to add. */
  args: string[];
  /** Playwright's `proxy` launch option, credentials included. */
  proxy?: ResolvedProxy;
  /** With `userAgent`, what the launch check expects the page to read. */
  verify?: ExpectedIdentity;
  /** With `userAgent` in a headless Chrome: the string and metadata each page gets. */
  pin?: UserAgentPin;
}

/** The client hints metadata of `Emulation.setUserAgentOverride`, as this Chrome reports it. */
interface UserAgentMetadata {
  brands: { brand: string; version: string }[];
  fullVersionList: { brand: string; version: string }[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

export interface UserAgentPin {
  userAgent: string;
  metadata: UserAgentMetadata;
}

/** Where the launch check and the metadata reading load their page: answered by a route, so nothing reaches the network. */
const CHECK_URL = "https://turno-check.invalid/";

const READ_METADATA = `(async () => {
  const d = navigator.userAgentData;
  const h = await d.getHighEntropyValues(["fullVersionList", "platformVersion", "architecture", "model", "bitness", "wow64"]);
  return { brands: d.brands.map((b) => ({ brand: b.brand, version: b.version })), fullVersionList: h.fullVersionList.map((b) => ({ brand: b.brand, version: b.version })),
    platform: d.platform, platformVersion: h.platformVersion, architecture: h.architecture, model: h.model || "", mobile: d.mobile, bitness: h.bitness, wow64: !!h.wow64 };
})()`;

/**
 * The client hints metadata this Chrome reports with nothing overriding it: read by a short
 * headless launch (no switch, throwaway profile, a routed page) and kept per Chrome version.
 */
function metadataFile(env: NodeJS.ProcessEnv, version: string): string {
  return join(
    paths(env).state,
    "browser",
    "chrome-ua",
    `${version.replace(/[^\w.-]/g, "_")}-${process.platform}-${process.arch}.json`,
  );
}

/** The metadata already read for this Chrome version; undefined when it was not read yet. */
function cachedMetadata(env: NodeJS.ProcessEnv, version: string): UserAgentMetadata | undefined {
  try {
    const cached = JSON.parse(readFileSync(metadataFile(env, version), "utf8")) as UserAgentMetadata;
    if (cached.fullVersionList?.length && cached.architecture) return cached;
  } catch {
    /* not read yet */
  }
  return undefined;
}

/**
 * Reads and keeps this Chrome's client hints metadata, so the default coherent user agent applies
 * from the next headless launch (`turno-browser login` calls it once the person is done).
 * Best effort: false when Chrome could not be read.
 */
export async function readChromeMetadata(config: McpConfig, env: NodeJS.ProcessEnv): Promise<boolean> {
  const version = chromeVersion(config, env);
  if (version === undefined) return false;
  return realMetadata(config, env, version).then(
    () => true,
    () => false,
  );
}

async function realMetadata(config: McpConfig, env: NodeJS.ProcessEnv, version: string): Promise<UserAgentMetadata> {
  const file = metadataFile(env, version);
  const cached = cachedMetadata(env, version);
  if (cached) return cached;
  const lo = config.browser.launchOptions;
  const { chromium } = await import("patchright-core");
  const browser = await chromium.launch({
    ...(typeof lo.executablePath === "string"
      ? { executablePath: lo.executablePath }
      : { channel: lo.channel ?? "chrome" }),
    headless: true,
    timeout: 20_000,
    ...(process.platform === "win32" ? { env: chromeEnv(process.env) } : {}),
  });
  let metadata: UserAgentMetadata;
  try {
    const page = await browser.newPage();
    await page.route(CHECK_URL, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>turno</title>" }),
    );
    await page.goto(CHECK_URL, { timeout: 15_000 });
    metadata = (await page.evaluate(READ_METADATA)) as UserAgentMetadata;
  } finally {
    await browser.close().catch(() => {});
  }
  if (!metadata.fullVersionList.length || !metadata.architecture)
    throw new Error(
      'userAgent "coherent": this Chrome reports no client hints metadata, so turno cannot present it coherently headless',
    );
  mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  return metadata;
}

const hasArg = (args: readonly string[], flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

/** The installed Chrome's version, for the user agent string a headless Chrome needs. */
function chromeVersion(config: McpConfig, env: NodeJS.ProcessEnv): string | undefined {
  const exe = config.browser.launchOptions.executablePath;
  if (typeof exe === "string") return readVersion(exe);
  const channel = config.browser.launchOptions.channel ?? "chrome";
  if (channel === "chrome-for-testing") return findBrowser("chrome-for-testing", env)?.version;
  return channel === "chrome" ? findChrome(env)?.version : undefined;
}

export async function chromeNetwork(
  settings: IdentitySettings,
  config: McpConfig,
  env: NodeJS.ProcessEnv,
  secret: (value: string, label: string) => void,
  /**
   * The coherent user agent comes from the defaults, not identity.json: it applies only when
   * this Chrome's metadata was read before (no extra launch now), and is left out otherwise.
   */
  byDefault = false,
): Promise<ChromeNetwork> {
  const out: ChromeNetwork = { args: [] };
  const userArgs = (config.browser.launchOptions.args as string[] | undefined) ?? [];
  if (settings.proxy) {
    if (config.browser.launchOptions.proxy !== undefined || hasArg(userArgs, "--proxy-server"))
      throw new Error(
        "identity.json proxy and a proxy of the server's own (--proxy-server, or the config's launchOptions.proxy) are both set: keep one",
      );
    out.proxy = await resolveProxy(settings.proxy, env, secret);
    out.args.push(...CHROME_PROXY_ARGS.filter((a) => !hasArg(userArgs, a.split("=")[0]!)));
  }
  const defaultVersion = byDefault ? chromeVersion(config, env) : undefined;
  const ready =
    !byDefault ||
    !config.browser.launchOptions.headless ||
    (defaultVersion !== undefined && cachedMetadata(env, defaultVersion));
  if (settings.userAgent === "coherent" && ready) {
    if (config.browser.contextOptions?.userAgent !== undefined || hasArg(userArgs, "--user-agent"))
      throw new Error(
        'identity.json userAgent "coherent" and a user agent of the server\'s own (--user-agent, --device, or the config) are both set: keep one',
      );
    // Headed Chrome already sends its own reduced user agent; a headless one says
    // HeadlessChrome, so it gets the headed string for the same version.
    if (config.browser.launchOptions.headless) {
      const version = chromeVersion(config, env);
      const major = majorOf(version);
      if (version === undefined || major === undefined)
        throw new Error(
          'userAgent "coherent" needs the installed Chrome\'s version for a headless browser, and turno could not read it: it supports Google Chrome (the chrome channel) or a Chrome given with an executable path',
        );
      const userAgent = reducedUserAgent(major);
      out.args.push(`--user-agent=${userAgent}`);
      out.pin = { userAgent, metadata: await realMetadata(config, env, version) };
    }
    const languages = acceptLanguages(settings);
    const given = out.pin?.metadata;
    out.verify = {
      ...(languages ? { languages } : {}),
      ...(settings.timezone ? { timezone: settings.timezone } : {}),
      ...(given
        ? {
            high: {
              fullVersionList: given.fullVersionList,
              architecture: given.architecture,
              platformVersion: given.platformVersion,
            },
          }
        : {}),
    };
  }
  return out;
}

/** Gives every page of the context the pinned user agent and metadata; `ready` resolves once a page has them. */
export function pinUserAgent(context: BrowserContext, pin: UserAgentPin): { ready(page: Page): Promise<void> } {
  const pending = new WeakMap<Page, Promise<void>>();
  const apply = (page: Page) => {
    // The session stays attached: Chrome drops a DevTools client's overrides when it detaches.
    // A page that closes first rejects too; only `ready` (the launch check, a tool's new tab)
    // reports it, so a page that did not get the values fails instead of loading without them.
    const done = context
      .newCDPSession(page)
      .then((session) =>
        session.send("Emulation.setUserAgentOverride", { userAgent: pin.userAgent, userAgentMetadata: pin.metadata }),
      )
      .then(() => undefined)
      .catch((error: Error) => {
        throw new Error(`userAgent "coherent": this page did not take the user agent metadata: ${error.message}`);
      });
    done.catch(() => {});
    pending.set(page, done);
  };
  for (const page of context.pages()) apply(page);
  context.on("page", apply);
  const ready = (page: Page) => pending.get(page) ?? Promise.resolve();
  // A tab a tool opens (browser_tabs) navigates right after newPage resolves: resolve it only
  // once the page has the values, so its first request already carries them.
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    await ready(page);
    return page;
  };
  return { ready };
}

/**
 * The launch check of `userAgent: "coherent"`: loads a blank page of its own on an https origin
 * (client hints exist only in a secure context), answered by a route so no request leaves the
 * machine, reads what the page sees and what the request carried, and refuses the browser when
 * anything contradicts the rest, or the user agent names another version than the Chrome that
 * runs. A headed Chrome shows that tab for a moment. The caller closes the browser on a throw.
 */
export async function verifyCoherence(
  context: BrowserContext,
  version: string,
  expected: ExpectedIdentity,
  pinned?: { ready(page: Page): Promise<void> },
): Promise<void> {
  const page = await context.newPage();
  await pinned?.ready(page);
  let observed: ObservedIdentity;
  let sent: Record<string, string> = {};
  try {
    await page.route(CHECK_URL, async (route) => {
      sent = await route.request().allHeaders();
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>turno</title>" });
    });
    await page.goto(CHECK_URL, { timeout: 15_000 });
    observed = (await page.evaluate(`(${OBSERVE_SCRIPT})()`)) as ObservedIdentity;
  } finally {
    await page.close().catch(() => {});
  }
  const problems = coherenceProblems(observed, expected);
  const major = majorOf(version);
  const uaMajor = /Chrome\/(\d+)\./.exec(observed.userAgent)?.[1];
  if (major !== undefined && uaMajor !== undefined && Number(uaMajor) !== major)
    problems.push(`the user agent says Chrome ${uaMajor}, but Chrome ${major} runs`);
  if (sent["user-agent"] !== undefined && sent["user-agent"] !== observed.userAgent)
    problems.push("the User-Agent header differs from navigator.userAgent");
  const hinted = sent["sec-ch-ua-platform"];
  if (hinted !== undefined && observed.uaData && hinted !== `"${observed.uaData.platform}"`)
    problems.push(`the Sec-CH-UA-Platform header is ${hinted}, but the page reads ${observed.uaData.platform}`);
  if (problems.length)
    throw new Error(
      `userAgent "coherent": this Chrome would not present one coherent identity, so turno did not use it: ${problems.join("; ")}`,
    );
}
