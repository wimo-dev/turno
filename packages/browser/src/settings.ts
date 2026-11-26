import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { browserPaths as paths, replaceFileSync } from "turno-core/paths";
import { type ActSettings, type CaptchaSettings, actProblems, captchaProblems } from "./opt-in-settings.js";
import { parseAttachTarget } from "./engine-attach.js";
import { IdentityError, assertIdentityId } from "./ids.js";
import { type BrowserChoice, browserProblem } from "./browsers.js";
import { HUMANIZE_LEVELS, type HumanizeSettings } from "./humanize.js";
import { type ProxySettings, type UserAgentMode, networkEngineClash, networkProblems } from "./network.js";
import { type IdentityPolicy, policyProblems } from "./policy.js";
import { parseDuration, parseSize } from "./units.js";

/**
 * identity.json: what stays fixed for one browser identity, so a site sees the same person in
 * the same place every time. It sits next to the Chrome profile directory
 * (`<data>/browser/identities/<id>.json`), never inside it, so Chrome never reads or rewrites it
 * and copying a profile does not copy it by accident.
 *
 * - `timezone`: an IANA zone. Chrome gets it in its process environment (`TZ`), only when it
 *   differs from the system's (an identity set up at home keeps that zone on a trip), so pages,
 *   workers and Chrome itself read the same zone. Windows Chrome does not read `TZ`; there it is
 *   Playwright's `timezoneId`.
 * - `languages`: the Accept-Language order, passed as Chrome's own `--accept-lang`, so the
 *   header keeps Chrome's q-values and `navigator.languages` matches it. Without it, `locale`
 *   gives `[locale, base language]`.
 * - `locale`: also passed as `--lang` (Chrome's UI and, on Linux and Windows, `Intl`), and on
 *   Linux as the Chrome process's `LANG`. It is not Playwright's `locale` option: that one
 *   collapses Accept-Language to a single value, which no installed Chrome sends (measured with
 *   Chrome 157), and does not reach workers. On macOS Chrome takes `Intl` from the system's
 *   language list whatever the flags say.
 * - `region`: the two-letter country the identity's sites know it from. Recorded, not applied.
 * - `health`: a URL and a text or selector that proves the identity is signed in (session
 *   health, `health.ts`).
 * - `tabs`, `backgroundThrottling`, `settle`, `block`, `cache` (format 2): how the host runs this
 *   identity's Chrome
 *   (`tuning.ts`): the tab governor and background tab throttling.
 * - `keychain` (format 3): where Chrome gets the key that encrypts the profile's cookies.
 *   `"mock"` (the default, also when the key is missing) keeps Playwright's
 *   `--use-mock-keychain` and `--password-store=basic`, a fixed public key; `"system"` drops
 *   them, so Chrome uses the macOS Keychain or the Linux Secret Service.
 * - `humanize` (format 4): human-like pointer, typing and scrolling (`humanize.ts`), off by default.
 * - `sharing` (format 5): `"session"` (the default) serves one agent session at a time;
 *   `"tabs"` lets several sessions use the browser at once, each in its own locked tabs
 *   (`sharing.ts`; mcp.toml then runs the server with `exclusive = false`).
 * - `engine`, `attach` (format 6): which engine runs the identity (`engine.ts`). `engine:
 *   "lightpanda"` is read mode; `attach` connects to a Chrome the user already has open
 *   (`"auto"`, a user data dir, or a loopback endpoint). Both off by default.
 * - `record` (format 7): what turno-browser records for this identity, all off by default:
 *   `flows` (every session's actions as a flow, `recorder.ts`), `traces` (Playwright traces) and
 *   `screenshots` (one per action), the last two under the identity's state folder with a
 *   size cap (`maxSize`, default 200MB) and the oldest recordings removed first (`recordings.ts`).
 * - `act`, `captcha` (format 8): natural language actions and captcha solving, both off by
 *   default and both sending page content to a model or a solver the user picks
 *   (`opt-in-settings.ts`). Keys are `keychain:` references, never values.
 * - `tabLocks` (format 9): with `"sharing": "tabs"`, how long a call waits for a tab another
 *   session holds (`wait`, default 10s) and how long a session without calls keeps its tabs
 *   (`release`, default 5m) (`tab-locks.ts`). No effect with `"sharing": "session"`.
 * - `live` (format 10): the live view and take-over (`live.ts`), off by default: `enabled` serves
 *   a view of the agent's tab on 127.0.0.1 and lets the user pause the agent; `wait` is how long
 *   a paused call waits for the user to resume before it fails (default 2m).
 * - `userAgent`, `proxy` (format 11), and the `"camoufox"` value of `engine`: opt-in network and
 *   user agent settings (`network.ts`) and Camoufox as an alternate engine
 *   (`engine-camoufox.ts`), all off by default.
 * - `cursor` (format 12): the agent cursor: `"auto"` (the default) lets Chrome draw it when
 *   someone can see the browser (a Chrome window, or the live view), with nothing in the page
 *   (`agent-cursor-cdp.ts`); `"on"` always draws the named arrow and badge in the page
 *   (`agent-cursor.ts`); `"off"` never draws.
 * - `resources` (format 13): `"low"` applies the low-resource preset (`tuning.ts`) for a
 *   machine short of memory; `"normal"` (the default) keeps the defaults. A key set on its own
 *   (`tabs`, `backgroundThrottling`) still wins over the preset.
 * - `policy` (format 13): what the identity may do (`policy.ts`): the hosts its pages may show,
 *   the features that do not exist for it, and whether browser_login may submit. Only the
 *   command line writes it.
 * - `browser` (format 13): which Chromium-based browser opens the profile (`browsers.ts`):
 *   `"chrome"` (the default), `"edge"`, `"brave"`, `"chromium"`, `"chrome-for-testing"`, or the
 *   absolute path of another one. A server's `--browser` or `--executable-path` wins over it.
 * - Format 14 adds values, not keys: `"auto"` for `live.enabled`, `resources`, `humanize.level`
 *   and `userAgent` (the default, said out loud), and an explicit `false` for the keys that had no
 *   off value: `act`, `cache`, `captcha`, `proxy`, `health`, `userAgent` and `locale`.
 *
 * A key that is not in the file takes the default the code resolves at launch (`defaults.ts`),
 * from the context: headless or windowed, the live view, memory pressure, the engine, the policy.
 * Those defaults are never written here, so a file keeps saying only what the person chose.
 */

/**
 * The newest format version of identity.json this package reads, in its `version` key: turno's
 * state-file convention, where a file without `version` is format 1 and a newer one
 * is refused. Format 2 adds the browser keys (`FORMAT_2_KEYS`); a file is written as format 2
 * only when it uses one of them, so an older turno-browser keeps reading every other file and
 * refuses one it would misread with "update turno-browser".
 */
export const IDENTITY_FORMAT_VERSION = 14;

/** The keys format 2 added. */
const FORMAT_2_KEYS = ["tabs", "backgroundThrottling", "settle", "block", "cache"] as const;

/** The keys format 3 added. */
const FORMAT_3_KEYS = ["keychain"] as const;

/** The keys format 4 added. */
const FORMAT_4_KEYS = ["humanize"] as const;

/** The keys format 5 added. */
const FORMAT_5_KEYS = ["sharing"] as const;

/** The keys format 6 added. */
const FORMAT_6_KEYS = ["engine", "attach"] as const;

/** The keys format 7 added. */
const FORMAT_7_KEYS = ["record"] as const;

/** The keys format 8 added. */
const FORMAT_8_KEYS = ["act", "captcha"] as const;

/** The keys format 9 added. */
const FORMAT_9_KEYS = ["tabLocks"] as const;

/** Longest `tabLocks.wait`: a call that waits longer for a tab is better off opening its own. */
const MAX_TAB_LOCK_WAIT_MS = 10 * 60_000;
/** Longest `tabLocks.release`. */
const MAX_TAB_LOCK_RELEASE_MS = 24 * 3_600_000;

/** With `"sharing": "tabs"`: the lock wait and the idle release, as durations. */
export interface TabLockSettings {
  wait?: string;
  release?: string;
}

/** The keys format 10 added. */
const FORMAT_10_KEYS = ["live"] as const;

/** The live view and take-over (`live.ts`); on by default for a server with an identity. */
export interface LiveSettings {
  /** Serve the live view and let the user pause the agent; `"auto"` (format 14) is the default. */
  enabled?: boolean | "auto";
  /** How long a paused call waits for the user, like `"2m"` (from `"5s"` to `"30m"`). */
  wait?: string;
}

/** Bounds of `live.wait`. */
export const MIN_LIVE_WAIT_MS = 5_000;
export const MAX_LIVE_WAIT_MS = 30 * 60_000;

/** The keys format 11 added (the `"camoufox"` engine also writes format 11). */
const FORMAT_11_KEYS = ["userAgent", "proxy"] as const;

/** The keys format 12 added. */
const FORMAT_12_KEYS = ["cursor"] as const;

/** The keys format 13 added. */
const FORMAT_13_KEYS = ["resources", "policy", "browser"] as const;

/**
 * The values of `resources`: the defaults, the low-resource preset (`tuning.ts`), or `"auto"`
 * (format 14, the default): the preset while the system reports memory pressure.
 */
export const RESOURCE_MODES = ["normal", "low", "auto"] as const;
export type ResourceMode = (typeof RESOURCE_MODES)[number];

/** The values of `cursor` (the agent cursor, `agent-cursor.ts`). */
export const CURSOR_MODES = ["auto", "on", "off"] as const;
export type CursorMode = (typeof CURSOR_MODES)[number];

/** The values of `engine`: `"chrome"` (the default), read mode, and Camoufox (format 11). */
const ENGINE_VALUES = ["chrome", "lightpanda", "camoufox"] as const;

/** What turno-browser records for an identity (`recorder.ts`, `recordings.ts`); defaults in `defaults.ts`. */
export interface RecordSettings {
  /** Record every session's actions as a flow (`auto-<time>`), the newest few kept. */
  flows?: boolean;
  /** Playwright traces of each browser session, paused around vault sign-ins. */
  traces?: boolean;
  /** A screenshot after each action, skipped on a page that holds vault values. */
  screenshots?: boolean;
  /** Size cap of the identity's recordings, like `"200MB"`; the oldest go first. */
  maxSize?: string;
}

/** Recordings size cap bounds. */
const MIN_RECORD_BYTES = 10 * 1024 ** 2;
const MAX_RECORD_BYTES = 10 * 1024 ** 3;

/** How many agent sessions use the identity's browser at once (`sharing.ts`). */
type SharingSetting = "session" | "tabs";

/** Where Chrome gets its cookie encryption key. */
type KeychainMode = "mock" | "system";

/** Playwright's switches that give Chrome a fixed key instead of the OS store's. */
const MOCK_KEYCHAIN_SWITCHES = ["--use-mock-keychain", "--password-store=basic"] as const;

/** Resource types `block.types` may name: the heavy ones a page usually works without. */
const BLOCKABLE_TYPES = ["image", "media", "font"] as const;
type BlockableType = (typeof BLOCKABLE_TYPES)[number];

/** Opt-in resource blocking (`resources.ts`). */
interface BlockSettings {
  /** The built-in list of ad and tracker hosts. */
  trackers?: boolean;
  types?: BlockableType[];
  /** Host names (with their subdomains) or URL globs (`*` matches anything). */
  patterns?: string[];
}

/** Opt-in on-disk resource cache (`resources.ts`). */
interface CacheSettings {
  /** Size cap, like `"100MB"` (default 100MB). */
  maxSize?: string;
}

/** Largest cache accepted. */
const MAX_CACHE_BYTES = 10 * 1024 ** 3;

/** Longest `settle` accepted: past this, a wait is a `browser_wait_for`, not a settle. */
const MAX_SETTLE_MS = 10_000;

/** The tab governor (`tuning.ts`): durations are strings like `"5m"`, `"0"` turns a stage off. */
interface TabSettings {
  /** Most pages open at once; the least recently used one closes past it. 0: no cap. */
  max?: number;
  /** `"close"`: close a popup the agent did not open; `"keep"`: leave it. */
  popups?: "close" | "keep";
  /** Unused this long, a page is parked on about:blank (its URL comes back on the next use). */
  park?: string;
  /** Unused this long, a page is closed. */
  close?: string;
}

export interface HealthCheck {
  /** A page that shows `text` or `selector` only to a signed-in user. */
  url: string;
  text?: string;
  selector?: string;
}

export interface IdentitySettings {
  /** Format version (`IDENTITY_FORMAT_VERSION`); a file without it is format 1. */
  version?: number;
  timezone?: string;
  /** A language tag; `false` (format 14) keeps Chrome's own instead of the system's. */
  locale?: string | false;
  languages?: string[];
  region?: string;
  /** `false` (format 14): no health check, not even one detected after a sign-in. */
  health?: HealthCheck | false;
  tabs?: TabSettings;
  /** True: let Chrome throttle tabs that are not in front (see `tuning.ts`). */
  backgroundThrottling?: boolean;
  /** Wait after each action for the work it started, like `"250ms"` (Playwright's `timeouts.settle`). */
  settle?: string;
  block?: BlockSettings;
  /** The own resource cache; `false` (format 14) says off out loud. */
  cache?: CacheSettings | false;
  /** `"system"`: Chrome encrypts cookies with the OS store's key; default `"mock"`. */
  keychain?: KeychainMode;
  /** Human-like input: `level` (off, light, full, adaptive) and an optional `seed`. */
  humanize?: HumanizeSettings;
  /** `"tabs"`: several agent sessions at once, each in its own locked tabs; default `"session"`. */
  sharing?: SharingSetting;
  /** `"lightpanda"`: read mode on Lightpanda; `"camoufox"`: Camoufox; default `"chrome"`. */
  engine?: (typeof ENGINE_VALUES)[number];
  /** Connect to a Chrome the user has open: `"auto"`, a user data dir, or a loopback endpoint. */
  attach?: string;
  record?: RecordSettings;
  /** Natural language actions (`browser_act`, `browser_extract`, `browser_observe`); `false` turns them off. */
  act?: ActSettings | false;
  /** A captcha solver for `browser_solve_captcha`; `false` turns solving off. */
  captcha?: CaptchaSettings | false;
  /** With `"sharing": "tabs"`: how long a call waits for a held tab, and when an idle session lets go. */
  tabLocks?: TabLockSettings;
  /** The live view and take-over: `enabled` and `wait`; off by default. */
  live?: LiveSettings;
  /**
   * `"coherent"`: the installed Chrome's own user agent and client hints, checked at launch;
   * `"auto"` (the default): coherent in a headless Chrome; `false`: never.
   */
  userAgent?: UserAgentMode | "auto" | false;
  /** A proxy for the identity's traffic; credentials only as `keychain:` references. `false`: none, not even the system's. */
  proxy?: ProxySettings | false;
  /** The agent cursor: `"auto"` (the default, when the browser can be seen), `"on"` or `"off"`. */
  cursor?: CursorMode;
  /** `"low"`: the low-resource preset (fewer tabs, Chrome closed sooner); default `"auto"`. */
  resources?: ResourceMode;
  /** What the identity may do: allowed hosts, disabled features, auto submit (`policy.ts`). */
  policy?: IdentityPolicy;
  /** The Chromium-based browser that opens the profile; default `"chrome"` (`browsers.ts`). */
  browser?: BrowserChoice;
  /** ISO dates. */
  created: string;
  updated: string;
}

/** A change to identity.json: a value sets the key, `null` removes it. */
export type SettingsPatch = {
  [K in
    | "timezone"
    | "locale"
    | "languages"
    | "region"
    | "health"
    | (typeof FORMAT_2_KEYS)[number]
    | (typeof FORMAT_3_KEYS)[number]
    | (typeof FORMAT_4_KEYS)[number]
    | (typeof FORMAT_5_KEYS)[number]
    | (typeof FORMAT_6_KEYS)[number]
    | (typeof FORMAT_7_KEYS)[number]
    | (typeof FORMAT_8_KEYS)[number]
    | (typeof FORMAT_9_KEYS)[number]
    | (typeof FORMAT_10_KEYS)[number]
    | (typeof FORMAT_11_KEYS)[number]
    | (typeof FORMAT_12_KEYS)[number]
    | (typeof FORMAT_13_KEYS)[number]]?: IdentitySettings[K] | null;
};

const KEYS = new Set([
  "version",
  "timezone",
  "locale",
  "languages",
  "region",
  "health",
  ...FORMAT_2_KEYS,
  ...FORMAT_3_KEYS,
  ...FORMAT_4_KEYS,
  ...FORMAT_5_KEYS,
  ...FORMAT_6_KEYS,
  ...FORMAT_7_KEYS,
  ...FORMAT_8_KEYS,
  ...FORMAT_9_KEYS,
  ...FORMAT_10_KEYS,
  ...FORMAT_11_KEYS,
  ...FORMAT_12_KEYS,
  ...FORMAT_13_KEYS,
  "created",
  "updated",
]);

/**
 * The Chrome switches to drop for this identity's keychain setting, as Playwright launch
 * options: nothing for the default mock keychain.
 */
export function keychainArgs(settings: Pick<IdentitySettings, "keychain"> | undefined): {
  ignoreDefaultArgs?: string[];
} {
  return settings?.keychain === "system" ? { ignoreDefaultArgs: [...MOCK_KEYCHAIN_SWITCHES] } : {};
}

/**
 * The environment for a Chrome this process launches for an identity: the caller's, so HOME
 * and the XDG folders follow the identity's environment instead of this process's. On Windows
 * USERPROFILE is the account's own profile folder: with another one Chrome refuses the DevTools
 * pipe ("remote debugging requires a non-default data directory"), as seen on windows-latest.
 */
export function chromeEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !(platform === "win32" && k.toUpperCase() === "USERPROFILE")) out[k] = v;
  if (platform === "win32") out.USERPROFILE = userInfo().homedir;
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(v: Record<string, unknown>, allowed: string[], prefix: string, out: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) out.push(`unknown key "${prefix}.${k}"`);
}

/** Problems with the format 2 keys, in key order. */
function browserProblems(v: Record<string, unknown>, out: string[]): void {
  if (v.tabs !== undefined) {
    const t = v.tabs;
    if (!isObject(t)) out.push("tabs must be an object with max, popups, park or close");
    else {
      if (t.max !== undefined && (typeof t.max !== "number" || !Number.isInteger(t.max) || t.max < 0 || t.max > 100))
        out.push("tabs.max must be a whole number from 0 (no cap) to 100");
      if (t.popups !== undefined && t.popups !== "close" && t.popups !== "keep")
        out.push('tabs.popups must be "close" or "keep"');
      for (const k of ["park", "close"] as const) {
        if (t[k] !== undefined && (typeof t[k] !== "string" || parseDuration(t[k] as string) === undefined))
          out.push(`tabs.${k} must be a duration like "5m" or "0" (off)`);
      }
      unknownKeys(t, ["max", "popups", "park", "close"], "tabs", out);
    }
  }
  if (v.backgroundThrottling !== undefined && typeof v.backgroundThrottling !== "boolean")
    out.push("backgroundThrottling must be true or false");
  if (v.settle !== undefined) {
    const ms = typeof v.settle === "string" ? parseDuration(v.settle) : undefined;
    if (ms === undefined || ms > MAX_SETTLE_MS) out.push('settle must be a duration from "0" to "10s", like "250ms"');
  }
  if (v.block !== undefined) {
    const b = v.block;
    if (!isObject(b)) out.push("block must be an object with trackers, types or patterns");
    else {
      if (b.trackers !== undefined && typeof b.trackers !== "boolean") out.push("block.trackers must be true or false");
      if (
        b.types !== undefined &&
        (!Array.isArray(b.types) || b.types.some((t) => !(BLOCKABLE_TYPES as readonly unknown[]).includes(t)))
      ) {
        out.push(`block.types must be a list of ${BLOCKABLE_TYPES.map((t) => `"${t}"`).join(", ")}`);
      }
      if (
        b.patterns !== undefined &&
        (!Array.isArray(b.patterns) ||
          b.patterns.length > 500 ||
          b.patterns.some((p) => typeof p !== "string" || !p.trim() || /\s/.test(p)))
      ) {
        out.push("block.patterns must be a list of host names or URL patterns without spaces (at most 500)");
      }
      unknownKeys(b, ["trackers", "types", "patterns"], "block", out);
    }
  }
  if (v.keychain !== undefined && v.keychain !== "mock" && v.keychain !== "system")
    out.push('keychain must be "mock" (the default) or "system"');
  humanizeProblems(v.humanize, out);
  if (v.sharing !== undefined && v.sharing !== "session" && v.sharing !== "tabs")
    out.push('sharing must be "tabs" (the default, each agent session in its own tabs) or "session" (one at a time)');
  if (v.cursor !== undefined && !(CURSOR_MODES as readonly unknown[]).includes(v.cursor))
    out.push('cursor must be "auto" (the default, when the browser can be seen), "on" or "off"');
  if (v.resources !== undefined && !(RESOURCE_MODES as readonly unknown[]).includes(v.resources))
    out.push(
      'resources must be "auto" (the default: the low-resource preset while memory is short), "normal" or "low"',
    );
  engineProblems(v, out);
  if (v.browser !== undefined) {
    const problem = browserProblem(v.browser);
    if (problem) out.push(problem);
    else if (v.engine === "camoufox" || v.engine === "lightpanda")
      out.push(
        `browser does not go with engine "${v.engine}": it picks the Chromium-based browser of the chrome engine`,
      );
  }
  recordProblems(v, out);
  actProblems(v.act, out);
  captchaProblems(v.captcha, v, out);
  tabLockProblems(v.tabLocks, out);
  liveProblems(v.live, out);
  networkProblems(v, out);
  const networkClash = networkEngineClash(engineOf(v), v);
  if (networkClash) out.push(networkClash);
  policyProblems(v.policy, engineOf(v), v, out);
  if (v.cache !== undefined && v.cache !== false) {
    const c = v.cache;
    if (!isObject(c)) out.push('cache must be an object, like {} or { "maxSize": "100MB" }, or false');
    else {
      if (c.maxSize !== undefined) {
        const bytes = typeof c.maxSize === "string" ? parseSize(c.maxSize) : undefined;
        if (bytes === undefined || bytes < 1024 ** 2 || bytes > MAX_CACHE_BYTES)
          out.push('cache.maxSize must be a size from "1MB" to "10GB", like "100MB"');
      }
      unknownKeys(c, ["maxSize"], "cache", out);
    }
  }
}

function tabLockProblems(t: unknown, out: string[]): void {
  if (t === undefined) return;
  if (!isObject(t)) {
    out.push('tabLocks must be an object, like { "wait": "30s", "release": "10m" }');
    return;
  }
  const ms = (v: unknown) => (typeof v === "string" ? parseDuration(v) : undefined);
  if (t.wait !== undefined) {
    const wait = ms(t.wait);
    if (wait === undefined || wait > MAX_TAB_LOCK_WAIT_MS)
      out.push('tabLocks.wait must be a duration from "0" (fail at once) to "10m", like "30s"');
  }
  if (t.release !== undefined) {
    const release = ms(t.release);
    if (release === undefined || release > MAX_TAB_LOCK_RELEASE_MS)
      out.push('tabLocks.release must be a duration from "0" (free between calls) to "24h", like "10m"');
  }
  unknownKeys(t, ["wait", "release"], "tabLocks", out);
}

function humanizeProblems(h: unknown, out: string[]): void {
  if (h === undefined) return;
  if (!isObject(h)) {
    out.push('humanize must be an object, like { "level": "light" }');
    return;
  }
  if (!(HUMANIZE_LEVELS as readonly unknown[]).includes(h.level))
    out.push(`humanize.level must be ${HUMANIZE_LEVELS.map((l) => `"${l}"`).join(", ")}`);
  if (
    h.seed !== undefined &&
    (typeof h.seed !== "number" || !Number.isInteger(h.seed) || h.seed < 0 || h.seed >= 2 ** 32)
  )
    out.push("humanize.seed must be a whole number from 0 to 4294967295");
  unknownKeys(h, ["level", "seed"], "humanize", out);
}

/** The engine identity.json asks for: attach wins, like at launch. */
function engineOf(v: Record<string, unknown>): string {
  return v.attach !== undefined ? "attach" : String(v.engine ?? "chrome");
}

/** Problems with the format 6 keys (and the format 11 `"camoufox"` engine). */
function engineProblems(v: Record<string, unknown>, out: string[]): void {
  if (v.engine !== undefined && !(ENGINE_VALUES as readonly unknown[]).includes(v.engine))
    out.push('engine must be "chrome" (the default), "lightpanda" (read mode) or "camoufox"');
  if (v.engine === "camoufox" && v.keychain === "system")
    out.push('keychain does not go with engine "camoufox": it sets how Chrome encrypts its cookies');
  if (v.attach !== undefined) {
    const target = typeof v.attach === "string" ? parseAttachTarget(v.attach) : { error: "attach must be a string" };
    if ("error" in target) out.push(target.error);
    else if (v.engine === "lightpanda" || v.engine === "camoufox")
      out.push(`attach does not go with engine "${v.engine}": pick one`);
    else if (v.sharing === "tabs") out.push('attach does not go with sharing "tabs": pick one');
  }
  const level = isObject(v.humanize) ? v.humanize.level : undefined;
  if (v.engine === "lightpanda" && level !== undefined && level !== "off" && level !== "auto")
    out.push('humanize does not go with engine "lightpanda": read mode lays out no page to move a pointer over');
}

/** Problems with the format 7 `record` key, alone and with the engine keys. */
function recordProblems(v: Record<string, unknown>, out: string[]): void {
  if (v.record === undefined) return;
  const r = v.record;
  if (!isObject(r)) {
    out.push("record must be an object with flows, traces, screenshots or maxSize");
    return;
  }
  for (const k of ["flows", "traces", "screenshots"] as const)
    if (r[k] !== undefined && typeof r[k] !== "boolean") out.push(`record.${k} must be true or false`);
  if (r.maxSize !== undefined) {
    const bytes = typeof r.maxSize === "string" ? parseSize(r.maxSize) : undefined;
    if (bytes === undefined || bytes < MIN_RECORD_BYTES || bytes > MAX_RECORD_BYTES)
      out.push('record.maxSize must be a size from "10MB" to "10GB", like "200MB"');
  }
  unknownKeys(r, ["flows", "traces", "screenshots", "maxSize"], "record", out);
  const clash = recordEngineClash(engineOf(v), r);
  if (clash) out.push(clash);
}

/** Problems with the format 8 `live` key. */
function liveProblems(l: unknown, out: string[]): void {
  if (l === undefined) return;
  if (!isObject(l)) {
    out.push('live must be an object, like { "enabled": true }');
    return;
  }
  if (l.enabled !== undefined && typeof l.enabled !== "boolean" && l.enabled !== "auto")
    out.push('live.enabled must be true, false or "auto" (the default)');
  if (l.wait !== undefined) {
    const ms = typeof l.wait === "string" ? parseDuration(l.wait) : undefined;
    if (ms === undefined || ms < MIN_LIVE_WAIT_MS || ms > MAX_LIVE_WAIT_MS)
      out.push('live.wait must be a duration from "5s" to "30m", like "2m"');
  }
  unknownKeys(l, ["enabled", "wait"], "live", out);
}

/**
 * Why an engine cannot record what `record` asks for. Attach mode: a trace covers every tab of
 * the browser, the user's own too, so neither traces nor screenshots are taken there. Read mode:
 * Lightpanda renders no page, so there is nothing to screenshot or screencast.
 */
export function recordEngineClash(
  engine: string,
  record: { traces?: unknown; screenshots?: unknown },
): string | undefined {
  const asked = [record.traces === true && "traces", record.screenshots === true && "screenshots"].filter(Boolean);
  if (!asked.length) return undefined;
  const what = `record.${asked.join(" and record.")}`;
  if (engine === "attach")
    return `${what} do not go with attach mode: a trace or screenshot could show your own tabs. Keep record.flows only, or drop attach`;
  if (engine === "lightpanda")
    return `${what} do not go with engine "lightpanda": read mode renders no page to screenshot or trace. Keep record.flows only, or use engine "chrome"`;
  return undefined;
}

export function identitySettingsPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).identitiesDir, `${id}.json`);
}

/** The system's IANA time zone, as Chrome reports it when nothing overrides it. */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the file uses a value format 14 added: `"auto"` for `live.enabled`, `resources`,
 * `humanize.level` or `userAgent`, or `false` for a key that had no off value. Only then is the
 * file written as format 14, so a turno-browser that predates these values refuses it instead
 * of misreading it, and every other file keeps its format.
 */
function usesFormat14(v: Record<string, unknown>): boolean {
  const level = isObject(v.humanize) ? v.humanize.level : undefined;
  const live = isObject(v.live) ? v.live.enabled : undefined;
  return (
    live === "auto" ||
    v.resources === "auto" ||
    level === "auto" ||
    v.userAgent === "auto" ||
    FALSE_KEYS.some((k) => v[k] === false)
  );
}

/** The keys format 14 lets be `false`: each had no off value before. */
const FALSE_KEYS = ["act", "cache", "captcha", "proxy", "health", "userAgent", "locale"] as const;

/** The canonical form of a BCP 47 tag ("es-mx" is "es-MX"), or undefined when it is not one. */
function canonicalLocale(tag: string): string | undefined {
  try {
    const [c] = Intl.getCanonicalLocales(tag);
    return c;
  } catch {
    return undefined;
  }
}

const isoDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

/** Everything wrong with a parsed identity.json, in key order; empty when it is valid. */
function problemsOf(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["must be a JSON object"];
  const v = raw as Record<string, unknown>;
  const out: string[] = [];
  if (v.version !== undefined && (typeof v.version !== "number" || !Number.isInteger(v.version) || v.version < 1))
    out.push("version must be a positive integer");
  else if (typeof v.version === "number" && v.version > IDENTITY_FORMAT_VERSION) {
    return [
      `is format ${v.version}, from a newer turno-browser (this one reads up to ${IDENTITY_FORMAT_VERSION}); update turno-browser`,
    ];
  }
  if (v.timezone !== undefined) {
    if (typeof v.timezone !== "string") out.push("timezone must be a string");
    else if (!validTimezone(v.timezone))
      out.push(`timezone "${v.timezone}" is not an IANA time zone (for example "Europe/Madrid")`);
  }
  if (v.locale !== undefined && v.locale !== false) {
    if (typeof v.locale !== "string" || !canonicalLocale(v.locale))
      out.push(`locale "${String(v.locale)}" is not a language tag (for example "es-MX")`);
  }
  if (v.languages !== undefined) {
    if (!Array.isArray(v.languages) || v.languages.some((l) => typeof l !== "string" || !canonicalLocale(l)))
      out.push("languages must be a list of language tags");
    else if (v.languages.length === 0) out.push("languages needs at least one language tag");
  }
  if (v.region !== undefined && (typeof v.region !== "string" || !/^[A-Z]{2}$/.test(v.region))) {
    out.push(`region "${String(v.region)}" must be a two-letter country code (for example "MX")`);
  }
  if (v.health !== undefined && v.health !== false) {
    const h = v.health as Record<string, unknown> | null;
    if (typeof h !== "object" || h === null || Array.isArray(h))
      out.push("health must be an object with url and text or selector, or false");
    else {
      if (typeof h.url !== "string" || !/^https?:\/\//.test(h.url))
        out.push("health.url must start with http:// or https://");
      for (const k of ["text", "selector"] as const)
        if (h[k] !== undefined && (typeof h[k] !== "string" || !h[k]))
          out.push(`health.${k} must be a non-empty string`);
      if (h.text === undefined && h.selector === undefined)
        out.push("health needs text or selector (what only a signed-in page shows)");
      for (const k of Object.keys(h))
        if (!["url", "text", "selector"].includes(k)) out.push(`unknown key "health.${k}"`);
    }
  }
  browserProblems(v, out);
  if (!isoDate(v.created)) out.push("created must be an ISO date");
  if (!isoDate(v.updated)) out.push("updated must be an ISO date");
  for (const k of Object.keys(v)) if (!KEYS.has(k)) out.push(`unknown key "${k}"`);
  return out;
}

export interface SettingsCheck {
  path: string;
  /** Present when the file exists and is valid. */
  settings?: IdentitySettings;
  /** Why the file cannot be used; empty when it is valid or missing. */
  problems: string[];
}

/** Reads identity.json without throwing: for `turno browser doctor`. */
export function checkIdentitySettings(id: string, env: NodeJS.ProcessEnv = process.env): SettingsCheck {
  const path = identitySettingsPath(id, env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path, problems: [] };
    return { path, problems: [`cannot be read: ${(err as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { path, problems: ["is not valid JSON"] };
  }
  const problems = problemsOf(raw);
  return problems.length ? { path, problems } : { path, settings: raw as IdentitySettings, problems };
}

/** identity.json of the identity, undefined when there is none. Throws when it is invalid. */
export function readIdentitySettings(id: string, env: NodeJS.ProcessEnv = process.env): IdentitySettings | undefined {
  const { path, settings, problems } = checkIdentitySettings(id, env);
  if (problems.length)
    throw new IdentityError(
      `identity.json of "${id}" (${path}) ${problems[0]!.startsWith("is ") ? problems[0] : `is invalid: ${problems.join("; ")}`}`,
    );
  return settings;
}

/**
 * Applies a patch and writes the file (mode 600, through a rename so a reader never sees half
 * a file). Validates first: a bad value throws and leaves the file as it was.
 */
export function writeIdentitySettings(
  id: string,
  patch: SettingsPatch,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): IdentitySettings {
  const path = identitySettingsPath(id, env);
  const current = existsSync(path) ? readIdentitySettings(id, env) : undefined;
  const stamp = now.toISOString();
  const next: Record<string, unknown> = { ...current, created: current?.created ?? stamp, updated: stamp };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const formats = [
    FORMAT_13_KEYS,
    FORMAT_12_KEYS,
    FORMAT_11_KEYS,
    FORMAT_10_KEYS,
    FORMAT_9_KEYS,
    FORMAT_8_KEYS,
    FORMAT_7_KEYS,
    FORMAT_6_KEYS,
    FORMAT_5_KEYS,
    FORMAT_4_KEYS,
    FORMAT_3_KEYS,
    FORMAT_2_KEYS,
  ];
  // Camoufox is an engine value, not a key: it writes format 11, so an older turno-browser refuses it.
  const found = formats.findIndex((keys) => keys.some((k) => next[k] !== undefined));
  const camoufox = formats.indexOf(FORMAT_11_KEYS);
  const newest = next.engine === "camoufox" && (found < 0 || found > camoufox) ? camoufox : found;
  next.version = usesFormat14(next) ? 14 : newest < 0 ? 1 : 13 - newest;
  if (typeof next.locale === "string") next.locale = canonicalLocale(next.locale) ?? next.locale;
  if (Array.isArray(next.languages)) next.languages = (next.languages as string[]).map((l) => canonicalLocale(l) ?? l);
  if (typeof next.region === "string" && /^[a-z]{2}$/i.test(next.region)) next.region = next.region.toUpperCase();
  const problems = problemsOf(next);
  if (problems.length) throw new IdentityError(`identity "${id}": ${problems.join("; ")}`);
  // Stable key order, whatever order the patch came in.
  const ordered = Object.fromEntries(
    [...KEYS].filter((k) => next[k] !== undefined).map((k) => [k, next[k]]),
  ) as unknown as IdentitySettings;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, path);
  return ordered;
}

/** The Accept-Language order: `languages`, else the locale and its base language. */
export function acceptLanguages(settings: Pick<IdentitySettings, "languages" | "locale">): string[] | undefined {
  if (settings.languages?.length) return settings.languages;
  if (!settings.locale) return undefined;
  const base = settings.locale.split("-")[0]!;
  return base === settings.locale ? [settings.locale] : [settings.locale, base];
}

/**
 * Playwright's context options that otherwise emulate a light color scheme and no motion,
 * contrast or forced-colors preference whatever the system says: null leaves Chrome's own, as in
 * a person's Chrome.
 */
export const SYSTEM_MEDIA = { colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null } as const;

export interface LaunchSettings {
  /** Chrome flags to add. */
  args: string[];
  /** Playwright's `timezoneId`: only on Windows, where Chrome does not read `TZ`. */
  timezoneId?: string;
  /** Variables for the Chrome process's environment (`TZ`, and `LANG` on Linux). */
  env?: Record<string, string>;
}

const hasArg = (args: readonly string[], flag: string) => args.some((a) => a === flag || a.startsWith(`${flag}=`));

/**
 * What the chrome engine adds at launch for these settings. Flags and context options the user
 * already set (through `--config` or the Playwright MCP flags) always win.
 *
 * Everything goes in at launch, as a person's own Chrome would get it, never as a DevTools
 * override of the page: a launch value reaches every page, frame and worker from their first
 * line, while an override reaches only the targets the automation attached to.
 */
export function launchSettings(
  settings: IdentitySettings | undefined,
  userArgs: readonly string[],
  systemTz: string,
  userContext: Record<string, unknown> = {},
  /** The locale identity.json sets; undefined leaves Chrome's own, read from the system. */
  locale: string | undefined = settings?.locale || undefined,
  platform: NodeJS.Platform = process.platform,
): LaunchSettings {
  const out: LaunchSettings = { args: [] };
  if (!settings && locale === undefined) return out;
  const env: Record<string, string> = {};
  if (locale && !hasArg(userArgs, "--lang")) {
    out.args.push(`--lang=${locale}`);
    // Linux Chrome also reads the process locale; macOS and Windows Chrome read their own settings.
    if (platform === "linux") env.LANG = `${locale.replace(/-/g, "_")}.UTF-8`;
  }
  const languages = acceptLanguages({ languages: settings?.languages, locale });
  if (languages && !hasArg(userArgs, "--accept-lang") && userContext.locale === undefined)
    out.args.push(`--accept-lang=${languages.join(",")}`);
  if (settings?.timezone && settings.timezone !== systemTz && userContext.timezoneId === undefined) {
    if (platform === "win32") out.timezoneId = settings.timezone;
    else env.TZ = settings.timezone;
  }
  if (Object.keys(env).length) out.env = env;
  return out;
}
