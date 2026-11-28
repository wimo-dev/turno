import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  Exit,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  type Parsed,
  bool,
  emit,
  fail,
  jsonOutput,
  parseFlags,
  str,
  style,
} from "turno-core/cli";
import { tildify } from "turno-core/paths";
import type { BrowserFunctions } from "../api.js";
import {
  type EffectiveSettings,
  SAID_APART,
  defaultLines,
  describeOrigin,
  effectiveEntries,
  fromDefault,
} from "../defaults.js";
import { effectiveSettings, exitProblems, proxyInUse } from "../effective.js";
import { findCamoufox } from "../engine-camoufox.js";
import { findLightpanda } from "../engine-lightpanda.js";
import { type ActKey, describeAct } from "../act-chain.js";
import { captchaSourceLabel, resolveCaptchaSource } from "../captcha.js";
import type { CliNames, Ctx } from "./context.js";

/** `show --json` (`turno identity show browser:<id> --json` in turno). */
export const SHOW_JSON = jsonOutput([
  "id",
  "dir",
  "settingsFile",
  "settings",
  "problems",
  "inUse",
  "holder",
  "health",
  "login",
  "effective",
  "act",
  "captcha",
]);
/** `set --json`: what changed, or would. */
export const SET_JSON = jsonOutput(["id", "settingsFile", "dryRun", "changes", "settings"]);
/** `doctor --json`: the shape of `turno doctor --json`. */
export const DOCTOR_JSON = jsonOutput(["ok", "counts", "checks", "fixed"]);
/** `reputation --json`: one element per identity. */
export const REPUTATION_JSON = jsonOutput(["id", "file", "total", "sites"]);

/**
 * identity.json in the CLI (`show`, `set`, the settings flags of `add`), `doctor` and
 * `reputation`. The functions come through `Ctx.api`, so tests can pass fakes.
 */
type IdentitySettings = NonNullable<ReturnType<BrowserFunctions["checkIdentitySettings"]>["settings"]>;
type HealthCheck = Exclude<IdentitySettings["health"], false | undefined>;
type TabSettings = NonNullable<IdentitySettings["tabs"]>;
type BlockSettings = NonNullable<IdentitySettings["block"]>;
type CacheSettings = Exclude<IdentitySettings["cache"], false | undefined>;
type HumanizeSettings = NonNullable<IdentitySettings["humanize"]>;
type RecordSettings = NonNullable<IdentitySettings["record"]>;
type ActSettings = Exclude<IdentitySettings["act"], false | undefined>;
type CaptchaSettings = Exclude<IdentitySettings["captcha"], false | undefined>;
type TabLockSettings = NonNullable<IdentitySettings["tabLocks"]>;
type LiveSettings = NonNullable<IdentitySettings["live"]>;
type ProxySettings = Exclude<IdentitySettings["proxy"], false | undefined>;
type PolicySettings = NonNullable<IdentitySettings["policy"]>;
type SettingsPatch = Parameters<BrowserFunctions["writeIdentitySettings"]>[1];
type DoctorCheck = Awaited<ReturnType<BrowserFunctions["runDoctor"]>>["checks"][number];

/** Flags that write identity.json, shared by `add` and `set`. An empty value removes the key. */
export const SETTINGS_FLAGS: FlagSpec = {
  timezone: { type: "string" },
  locale: { type: "string" },
  languages: { type: "string" },
  region: { type: "string" },
  "health-url": { type: "string" },
  "health-text": { type: "string" },
  "health-selector": { type: "string" },
  "no-health": { type: "boolean" },
  // off: no health check, not even the one `login` finds (format 14).
  health: { type: "string" },
  // How the host runs this identity's Chrome (format 2 of identity.json): the tab governor,
  // background throttling, settle, resource blocking and cache.
  "tabs-max": { type: "string" },
  "tabs-popups": { type: "string" },
  "tabs-park": { type: "string" },
  "tabs-close": { type: "string" },
  "no-tabs": { type: "boolean" },
  "background-throttling": { type: "string" },
  settle: { type: "string" },
  "block-trackers": { type: "string" },
  "block-types": { type: "string" },
  "block-patterns": { type: "string" },
  "no-block": { type: "boolean" },
  cache: { type: "boolean" },
  "cache-max-size": { type: "string" },
  "no-cache": { type: "boolean" },
  // Human-like input (format 4): off, light, full or adaptive.
  humanize: { type: "string" },
  // How many agent sessions use the identity's browser at once (format 5), and with tabs how
  // long a call waits for a held tab and when an idle session lets go (format 8).
  sharing: { type: "string" },
  "tab-lock-wait": { type: "string" },
  "tab-lock-release": { type: "string" },
  // Which engine runs the identity (format 6): read mode on Lightpanda, or attach mode.
  engine: { type: "string" },
  attach: { type: "string" },
  // What turno-browser records for this identity (format 7): flows, traces, screenshots.
  "record-flows": { type: "string" },
  "record-traces": { type: "string" },
  "record-screenshots": { type: "string" },
  "record-max-size": { type: "string" },
  "no-record": { type: "boolean" },
  // Natural language actions and captcha solving (format 8): off by default, opt-in only.
  act: { type: "boolean" },
  "act-sampling": { type: "string" },
  "act-provider": { type: "string" },
  "act-endpoint": { type: "string" },
  "act-model": { type: "string" },
  "act-key": { type: "string" },
  "act-max-steps": { type: "string" },
  "act-max-tokens": { type: "string" },
  "act-timeout": { type: "string" },
  "no-act": { type: "boolean" },
  "captcha-provider": { type: "string" },
  "captcha-endpoint": { type: "string" },
  "captcha-key": { type: "string" },
  "captcha-timeout": { type: "string" },
  "no-captcha": { type: "boolean" },
  // The live view and take-over (format 10).
  live: { type: "string" },
  "live-wait": { type: "string" },
  "no-live": { type: "boolean" },
  // Opt-in network and user agent settings (format 11), all off by default.
  "user-agent": { type: "string" },
  "proxy-server": { type: "string" },
  "proxy-username": { type: "string" },
  "proxy-password": { type: "string" },
  "no-proxy": { type: "boolean" },
  // The agent cursor (format 12): auto, on or off.
  cursor: { type: "string" },
  // Notifications and the last click (format 14): true or false.
  notify: { type: "string" },
  "last-click": { type: "string" },
  // The low-resource preset (format 13): normal or low.
  resources: { type: "string" },
  // What the identity may do (format 13): allowed hosts, disabled features, auto submit.
  "policy-file": { type: "string" },
  "allowed-domains": { type: "string" },
  disable: { type: "string" },
  "auto-submit": { type: "string" },
  "no-policy": { type: "boolean" },
  // The Chromium-based browser that opens the profile (format 13): a name or an absolute path.
  browser: { type: "string" },
};

/** The identity.json key behind each tuning flag, so the package's messages name the flag. */
const KEY_FLAGS: readonly (readonly [string, string])[] = [
  ["tabs.max", "--tabs-max"],
  ["tabs.popups", "--tabs-popups"],
  ["tabs.park", "--tabs-park"],
  ["tabs.close", "--tabs-close"],
  ["backgroundThrottling", "--background-throttling"],
  ["settle", "--settle"],
  ["block.trackers", "--block-trackers"],
  ["block.types", "--block-types"],
  ["block.patterns", "--block-patterns"],
  ["cache.maxSize", "--cache-max-size"],
  ["humanize.level", "--humanize"],
  ["sharing", "--sharing"],
  ["cursor", "--cursor"],
  ["notify", "--notify"],
  ["lastClick", "--last-click"],
  ["resources", "--resources"],
  ["browser", "--browser"],
  ["tabLocks.wait", "--tab-lock-wait"],
  ["tabLocks.release", "--tab-lock-release"],
  ["engine", "--engine"],
  ["attach", "--attach"],
  ["record.flows", "--record-flows"],
  ["record.traces", "--record-traces"],
  ["record.screenshots", "--record-screenshots"],
  ["record.maxSize", "--record-max-size"],
  ["act.sampling", "--act-sampling"],
  ["act.provider", "--act-provider"],
  ["act.endpoint", "--act-endpoint"],
  ["act.model", "--act-model"],
  ["act.key", "--act-key"],
  ["act.maxSteps", "--act-max-steps"],
  ["act.maxTokens", "--act-max-tokens"],
  ["act.timeout", "--act-timeout"],
  ["captcha.provider", "--captcha-provider"],
  ["captcha.endpoint", "--captcha-endpoint"],
  ["captcha.key", "--captcha-key"],
  ["captcha.timeout", "--captcha-timeout"],
  ["live.enabled", "--live"],
  ["live.wait", "--live-wait"],
  ["userAgent", "--user-agent"],
  ["proxy.server", "--proxy-server"],
  ["proxy.username", "--proxy-username"],
  ["proxy.password", "--proxy-password"],
];

const TABS_MAX_PROBLEM = "--tabs-max must be a whole number from 0 (no cap) to 100";

/**
 * A rejected identity.json with each problem of a tuning key told as its flag: the package
 * says `identity "school": settle must be ...`, the command line says `--settle must be ...`.
 * Other messages stay as the package wrote them.
 */
function flagMessage(message: string): string {
  const problems = message.replace(/^identity "[^"]*": /, "").split("; ");
  const told = problems.map((p) => {
    const hit = KEY_FLAGS.find(([key]) => p.startsWith(`${key} `));
    return hit ? `${hit[1]}${p.slice(hit[0].length)}` : undefined;
  });
  return told.every((t) => t !== undefined) ? told.join("; ") : message;
}

/** `off` or `false`: the format 14 off value of a key that has no other. */
const isOff = (v: string | null) => v !== null && ["off", "false"].includes(v.toLowerCase());

/** A true or false flag value; also on/off and yes/no. */
function booleanValue(flag: string, v: string): boolean {
  const word = v.toLowerCase();
  if (["true", "on", "yes"].includes(word)) return true;
  if (["false", "off", "no"].includes(word)) return false;
  return fail(`${flag} must be true or false (an empty value removes it)`);
}

const list = (v: string) =>
  v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * A group of identity.json (tabs, block, cache) after the flags: `parts` set or (with null)
 * remove its keys, the rest of `base` stays. Null when nothing is left, so the key goes.
 */
function mergeGroup<T extends object>(base: T | undefined, parts: Partial<Record<keyof T, unknown>>): T | null {
  const next: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(parts)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return Object.keys(next).length ? (next as T) : null;
}

export const SETTINGS_FLAG_NAMES = Object.keys(SETTINGS_FLAGS).map((f) => `--${f}`);

/** The identity.json change the flags ask for; `current` fills the parts of health not given. */
export function settingsPatch(p: Parsed, current?: IdentitySettings): SettingsPatch {
  const patch: SettingsPatch = {};
  const value = (name: string) => {
    const v = str(p, name);
    return v === undefined ? undefined : v.trim() === "" ? null : v.trim();
  };
  for (const key of ["timezone", "region"] as const) {
    const v = value(key);
    if (v !== undefined) patch[key] = v;
  }
  // off: Chrome's own language instead of the system's (format 14).
  const locale = value("locale");
  if (locale !== undefined) patch.locale = isOff(locale) ? false : locale;
  const langs = value("languages");
  if (langs !== undefined)
    patch.languages =
      langs === null
        ? null
        : langs
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean);
  const url = value("health-url");
  const text = value("health-text");
  const selector = value("health-selector");
  const healthWord = value("health");
  if (healthWord !== undefined && healthWord !== null && !isOff(healthWord))
    fail("--health takes off (no health check at all); --health-url sets one, --no-health goes back to the default");
  if (bool(p, "no-health") || healthWord !== undefined) {
    if (url !== undefined || text !== undefined || selector !== undefined)
      fail("--no-health and --health off do not go with the other --health flags");
    patch.health = healthWord ? false : null;
  } else if (url !== undefined || text !== undefined || selector !== undefined) {
    const base = current?.health || undefined;
    const health: HealthCheck = { url: url ?? base?.url ?? "" };
    const t = text === undefined ? base?.text : (text ?? undefined);
    const s = selector === undefined ? base?.selector : (selector ?? undefined);
    if (t) health.text = t;
    if (s) health.selector = s;
    if (!health.url) fail("a health check needs --health-url (a page only a signed-in user sees)");
    if (!health.text && !health.selector)
      fail("a health check needs --health-text or --health-selector (what that page shows when signed in)");
    patch.health = health;
  }
  tuningPatch(p, value, patch, current);
  const engine = value("engine");
  if (engine !== undefined) patch.engine = engine as SettingsPatch["engine"];
  // Checked by the package: an unknown name comes back as `--browser must be ...`.
  const browser = value("browser");
  if (browser !== undefined) patch.browser = browser;
  const attach = value("attach");
  if (attach !== undefined) patch.attach = attach;
  networkPatch(p, value, patch, current);
  policyPatch(p, value, patch, current);
  return patch;
}

/** A policy file: one JSON object, checked by the package when it is written. */
export function readPolicyFile(file: string): PolicySettings {
  let text: string;
  try {
    text = readFileSync(resolve(file), "utf8");
  } catch (err) {
    return fail(
      `--policy-file ${file} cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(`--policy-file ${file} is not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return fail(`--policy-file ${file} must hold one JSON object, like { "allowedDomains": ["example.com"] }`);
  return raw as PolicySettings;
}

/**
 * The format 13 `policy` key: a whole policy from a file, or its parts from flags. Removing a
 * part keeps the policy (an empty one still turns browser_run_code_unsafe off); --no-policy
 * removes it.
 */
function policyPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const file = str(p, "policy-file");
  const domains = value("allowed-domains");
  const disabled = value("disable");
  const autoSubmit = value("auto-submit");
  const parts = {
    allowedDomains: typeof domains === "string" ? list(domains) : domains,
    disabled: typeof disabled === "string" ? (list(disabled) as PolicySettings["disabled"]) : disabled,
    autoSubmit: typeof autoSubmit === "string" ? booleanValue("--auto-submit", autoSubmit) : autoSubmit,
  };
  const given = Object.values(parts).some((v) => v !== undefined);
  if (bool(p, "no-policy")) {
    if (given || file !== undefined) fail("--no-policy does not go with the other policy flags");
    patch.policy = null;
  } else if (file !== undefined) {
    if (given)
      fail("--policy-file does not go with --allowed-domains, --disable or --auto-submit: put them in the file");
    patch.policy = readPolicyFile(file);
  } else if (given) {
    patch.policy = mergeGroup<PolicySettings>(current?.policy, parts) ?? {};
  }
}

/** The features a policy turns off, as the server applies them. */
function offFeatures(policy: PolicySettings): string[] {
  const off = new Set<string>([...(policy.disabled ?? []), "run_code"]);
  if (policy.allowedDomains) off.add("network");
  return [...off];
}

/** A policy in a few words: "opens only example.com, *.example.com; off: captcha, run_code". */
export function describePolicy(policy: PolicySettings): string {
  return [
    policy.allowedDomains ? `opens only ${policy.allowedDomains.join(", ")}` : "any site",
    `off: ${offFeatures(policy).join(", ")}`,
    policy.autoSubmit === false ? "browser_login never submits" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** The format 11 keys: `userAgent` and `proxy`. The package checks the values. */
function networkPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  // Checked by the package; off pins the browser's own user agent even in headless (format 14).
  const userAgent = value("user-agent");
  if (userAgent !== undefined)
    patch.userAgent = isOff(userAgent) ? false : (userAgent as IdentitySettings["userAgent"] | null);
  const parts = {
    server: value("proxy-server"),
    username: value("proxy-username"),
    password: value("proxy-password"),
  };
  const given = Object.values(parts).some((v) => v !== undefined);
  if (bool(p, "no-proxy")) {
    if (given) fail("--no-proxy does not go with the other --proxy flags");
    patch.proxy = null;
  } else if (parts.server !== undefined && isOff(parts.server)) {
    if (parts.username !== undefined || parts.password !== undefined)
      fail("--proxy-server off does not go with the other --proxy flags");
    patch.proxy = false;
  } else if (given) {
    patch.proxy = mergeGroup<ProxySettings>(current?.proxy || undefined, parts);
  }
}

/** The format 2 keys of the patch: tabs, backgroundThrottling, settle, block and cache. */
function tuningPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const tabs = {
    max: value("tabs-max"),
    popups: value("tabs-popups"),
    park: value("tabs-park"),
    close: value("tabs-close"),
  };
  if (bool(p, "no-tabs")) {
    if (Object.values(tabs).some((v) => v !== undefined)) fail("--no-tabs does not go with the other --tabs flags");
    patch.tabs = null;
  } else if (Object.values(tabs).some((v) => v !== undefined)) {
    let max: number | null | undefined;
    if (typeof tabs.max === "string") {
      if (!/^\d+$/.test(tabs.max)) fail(TABS_MAX_PROBLEM);
      max = Number(tabs.max);
    } else max = tabs.max;
    patch.tabs = mergeGroup<TabSettings>(current?.tabs, { ...tabs, max });
  }

  const throttling = value("background-throttling");
  if (throttling !== undefined)
    patch.backgroundThrottling = throttling === null ? null : booleanValue("--background-throttling", throttling);
  const settle = value("settle");
  if (settle !== undefined) patch.settle = settle;

  const trackers = value("block-trackers");
  const types = value("block-types");
  const patterns = value("block-patterns");
  if (bool(p, "no-block")) {
    if (trackers !== undefined || types !== undefined || patterns !== undefined)
      fail("--no-block does not go with the other --block flags");
    patch.block = null;
  } else if (trackers !== undefined || types !== undefined || patterns !== undefined) {
    patch.block = mergeGroup<BlockSettings>(current?.block, {
      trackers: typeof trackers === "string" ? booleanValue("--block-trackers", trackers) : trackers,
      types: typeof types === "string" ? list(types) : types,
      patterns: typeof patterns === "string" ? list(patterns) : patterns,
    });
  }

  const maxSize = value("cache-max-size");
  if (bool(p, "no-cache")) {
    if (bool(p, "cache") || maxSize !== undefined) fail("--no-cache does not go with --cache or --cache-max-size");
    patch.cache = null;
  } else if (bool(p, "cache") || maxSize !== undefined) {
    // The cache stays on when its size is removed: {} is on with the default size.
    patch.cache = mergeGroup<CacheSettings>(current?.cache || undefined, { maxSize }) ?? {};
  }

  // An empty value removes the whole group (the seed with it); a level keeps a seed set by hand.
  const humanize = value("humanize");
  if (humanize !== undefined)
    patch.humanize = humanize === null ? null : ({ ...current?.humanize, level: humanize } as HumanizeSettings);
  // Checked by the package: an unknown value comes back as `--sharing must be ...`.
  const sharing = value("sharing");
  if (sharing !== undefined) patch.sharing = sharing as IdentitySettings["sharing"] | null;
  // Checked by the package too: an unknown value comes back as `--cursor must be ...`.
  const cursor = value("cursor");
  if (cursor !== undefined) patch.cursor = cursor as IdentitySettings["cursor"] | null;
  const notify = value("notify");
  if (notify !== undefined) patch.notify = notify === null ? null : booleanValue("--notify", notify);
  const lastClick = value("last-click");
  if (lastClick !== undefined) patch.lastClick = lastClick === null ? null : booleanValue("--last-click", lastClick);
  // And this one: `--resources must be ...`.
  const resources = value("resources");
  if (resources !== undefined) patch.resources = resources as IdentitySettings["resources"] | null;
  const locks = { wait: value("tab-lock-wait"), release: value("tab-lock-release") };
  if (locks.wait !== undefined || locks.release !== undefined)
    patch.tabLocks = mergeGroup<TabLockSettings>(current?.tabLocks, locks);
  recordPatch(p, value, patch, current);
  actPatch(p, value, patch, current);
  captchaPatch(p, value, patch, current);
  livePatch(p, value, patch, current);
}

/** A whole number flag value as a number; anything else goes to the package, which says why. */
const wholeNumber = (v: string | null | undefined) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);

/** The format 8 `act` key: natural language actions, with MCP sampling or a provider. */
function actPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const sampling = value("act-sampling");
  const parts = {
    sampling: typeof sampling === "string" ? booleanValue("--act-sampling", sampling) : sampling,
    provider: value("act-provider"),
    endpoint: value("act-endpoint"),
    model: value("act-model"),
    key: value("act-key"),
    maxSteps: wholeNumber(value("act-max-steps")),
    maxTokens: wholeNumber(value("act-max-tokens")),
    timeout: value("act-timeout"),
  };
  const given = Object.values(parts).some((v) => v !== undefined);
  if (bool(p, "no-act")) {
    if (given || bool(p, "act")) fail("--no-act does not go with the other --act flags");
    patch.act = null;
  } else if (given || bool(p, "act")) {
    patch.act = mergeGroup<ActSettings>(current?.act || undefined, parts) ?? {};
  }
}

/** The format 8 `captcha` key: a solver service and its key's secret store reference. */
function captchaPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const parts = {
    provider: value("captcha-provider"),
    endpoint: value("captcha-endpoint"),
    key: value("captcha-key"),
    timeout: value("captcha-timeout"),
  };
  const given = Object.values(parts).some((v) => v !== undefined);
  if (bool(p, "no-captcha")) {
    if (given) fail("--no-captcha does not go with the other --captcha flags");
    patch.captcha = null;
  } else if (given) {
    patch.captcha = mergeGroup<CaptchaSettings>(current?.captcha || undefined, parts);
  }
}

/** How an identity's natural language actions get a model, and why, in one line. */
function actLine(act: ActKey, env: NodeJS.ProcessEnv): string {
  const r = describeAct(act, env);
  return `${r.path === "off" ? "off" : `on: ${r.label}`} (${r.reason})`;
}

/** `show --json`'s `captcha`: where the solver key comes from, or why captchas go to the person. */
export function captchaJson(captcha: CaptchaSettings | false | undefined, env: NodeJS.ProcessEnv) {
  const source = resolveCaptchaSource(captcha, env);
  return source.kind === "none"
    ? { path: "human", label: "browser_request_human", reason: source.reason }
    : { path: source.kind, label: captchaSourceLabel(source), reason: "a solver key is configured" };
}

/** Where an identity's captcha solver key comes from, or that captchas go to the person. */
function captchaLine(captcha: CaptchaSettings | false | undefined, env: NodeJS.ProcessEnv): string {
  const source = resolveCaptchaSource(captcha, env);
  return source.kind === "none"
    ? `a person answers captchas (browser_request_human): ${source.reason}`
    : `solver: ${captchaSourceLabel(source)}`;
}

/** The format 10 `live` key: the live view and take-over. */
function livePatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const enabled = value("live");
  const wait = value("live-wait");
  if (bool(p, "no-live")) {
    if (enabled !== undefined || wait !== undefined) fail("--no-live does not go with --live or --live-wait");
    patch.live = null;
  } else if (enabled !== undefined || wait !== undefined) {
    patch.live = mergeGroup<LiveSettings>(current?.live, {
      enabled: enabled === "auto" ? "auto" : typeof enabled === "string" ? booleanValue("--live", enabled) : enabled,
      wait,
    });
  }
}

/** The format 7 `record` key: what turno-browser records for this identity. */
function recordPatch(
  p: Parsed,
  value: (name: string) => string | null | undefined,
  patch: SettingsPatch,
  current?: IdentitySettings,
): void {
  const parts = {
    flows: value("record-flows"),
    traces: value("record-traces"),
    screenshots: value("record-screenshots"),
    maxSize: value("record-max-size"),
  };
  const given = Object.values(parts).some((v) => v !== undefined);
  if (bool(p, "no-record")) {
    if (given) fail("--no-record does not go with the other --record flags");
    patch.record = null;
  } else if (given) {
    const flag = (name: string, v: string | null | undefined) =>
      typeof v === "string" ? booleanValue(`--record-${name}`, v) : v;
    patch.record = mergeGroup<RecordSettings>(current?.record, {
      flows: flag("flows", parts.flows),
      traces: flag("traces", parts.traces),
      screenshots: flag("screenshots", parts.screenshots),
      maxSize: parts.maxSize,
    });
  }
}

/** What an identity records, in a few words: "flows, traces (up to 200MB)". */
export function describeRecord(r: RecordSettings | undefined): string | undefined {
  if (!r) return undefined;
  const on = (["flows", "traces", "screenshots"] as const).filter((k) => r[k]);
  if (!on.length) return undefined;
  const files = r.traces || r.screenshots;
  return `${on.join(", ")}${files ? ` (up to ${r.maxSize ?? "200MB"})` : ""}`;
}

export function hasSettings(patch: SettingsPatch): boolean {
  return Object.keys(patch).length > 0;
}

/** A proxy for `show`: the server and where the credentials come from, never their value. */
function describeProxy(p: ProxySettings): string {
  const who = p.username ? `, signs in as ${p.username} with ${p.password}` : "";
  return `${p.server}${who}`;
}

function describeHealth(h: HealthCheck): string {
  return [h.url, h.text ? `shows "${h.text}"` : "", h.selector ? `has ${h.selector}` : ""].filter(Boolean).join(" ");
}

function describeTabs(t: TabSettings): string {
  const parts: string[] = [];
  if (t.max !== undefined) parts.push(t.max === 0 ? "no cap on open tabs" : `at most ${t.max} open`);
  if (t.popups) parts.push(t.popups === "keep" ? "popups kept" : "popups closed");
  if (t.park !== undefined) parts.push(t.park === "0" ? "never parked" : `parked after ${t.park}`);
  if (t.close !== undefined) parts.push(t.close === "0" ? "never closed when unused" : `closed after ${t.close}`);
  return parts.join(", ");
}

function describeBlock(b: BlockSettings): string {
  const n = b.patterns?.length ?? 0;
  return [b.trackers ? "trackers" : "", ...(b.types ?? []), n ? `${n} pattern${n === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(", ");
}

/** What each humanize level does, for `show`. */
const HUMANIZE_TEXT: Readonly<Record<string, string>> = {
  off: "Playwright's own (humanize off)",
  light: "human-like pointer and typing (light)",
  full: "human-like pointer, typing and scrolling (full)",
  adaptive: "light, full on sites that showed a challenge (adaptive)",
  auto: "by page: off on localhost and for reading, light to act, full on sign-in and payment pages (auto)",
};

/** An ISO time as this machine's local time, to the minute: 2026-11-19 23:46. Anything else as it is. */
export function localTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** What each agent cursor mode does, for `show`. */
const CURSOR_TEXT: Readonly<Record<string, string>> = {
  auto: "drawn by Chrome when the browser can be seen: a window, or the live view (auto)",
  on: "the named arrow and badge, drawn in each page (on)",
  off: "never shown: pages stay as they are (off)",
};

/** Each effective value with where it came from, for `--json`: `{ value, origin, default }`. */
function effectiveJson(e: EffectiveSettings): Record<string, { value: unknown; origin: string; default: boolean }> {
  const out: Record<string, { value: unknown; origin: string; default: boolean }> = {};
  for (const [key, v] of effectiveEntries(e))
    out[key] = { value: v.value ?? null, origin: describeOrigin(v.origin), default: fromDefault(v.origin) };
  return out;
}

export function show(c: Ctx, id: string, args: string[], io: Io): number {
  const m = c.api;
  const p = parseFlags(args, JSON_FLAG, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (${c.names.identity("add", id)})`);
  const { path, settings, problems } = m.checkIdentitySettings(id, io.env);
  const holder = m.inUseBy(id, io.env);
  const health = m.readHealth(id, io.env);
  const login = m.readLoginRecord(id, io.env);
  const effective = effectiveSettings(id, { env: io.env });
  if (bool(p, "json")) {
    emit(io, p, SHOW_JSON, {
      id: `browser:${id}`,
      dir: tildify(m.identityDir(id, io.env), io.env),
      settingsFile: tildify(path, io.env),
      settings: settings ?? null,
      problems,
      inUse: holder !== undefined,
      holder: holder ?? null,
      health: health ?? null,
      login: login ?? null,
      effective: effectiveJson(effective),
      act: problems.length ? null : describeAct(settings?.act as ActKey, io.env),
      captcha: problems.length ? null : captchaJson(settings?.captcha, io.env),
    });
    return Exit.ok;
  }
  const s = style(io);
  const rows: [string, string][] = [
    ["profile", tildify(m.identityDir(id, io.env), io.env)],
    [
      "settings",
      `${tildify(path, io.env)}${settings || problems.length ? "" : s.muted(" (none: Chrome's own time zone and languages)")}`,
    ],
  ];
  if (settings) {
    rows.push(["time zone", settings.timezone ?? s.muted("(the system's)")]);
    if (settings.locale) rows.push(["locale", settings.locale]);
    rows.push([
      "languages",
      settings.languages?.join(", ") ?? s.muted(settings.locale ? "(from the locale)" : "(Chrome's)"),
    ]);
    if (settings.region) rows.push(["region", settings.region]);
    rows.push([
      "health check",
      settings.health
        ? describeHealth(settings.health)
        : settings.health === false
          ? "off, not even the check login finds (--health off)"
          : s.muted(
              `the one login finds, if any (to set one: ${c.names.browser} set ${id} --health-url <url> --health-text <text>)`,
            ),
    ]);
    if (settings.resources === "low")
      rows.push(["resources", "low: at most 2 tabs, idle tabs parked after 2m, Chrome closed after 5m idle"]);
    if (settings.resources === "auto") rows.push(["resources", "low while memory is short at launch (auto)"]);
    if (settings.tabs) rows.push(["tabs", `${describeTabs(settings.tabs)}${s.muted(" (the rest as default)")}`]);
    if (settings.backgroundThrottling !== undefined)
      rows.push([
        "throttling",
        settings.backgroundThrottling ? "background tabs throttled" : "every tab at full speed",
      ]);
    if (settings.settle !== undefined) rows.push(["settle", settings.settle]);
    if (settings.block) rows.push(["blocking", describeBlock(settings.block) || s.muted("(nothing)")]);
    if (settings.cache) rows.push(["cache", `on, up to ${settings.cache.maxSize ?? "100MB"}`]);
    if (settings.keychain === "system") rows.push(["cookie key", "the system keychain (identity.json keychain)"]);
    if (settings.humanize)
      rows.push([
        "input",
        `${HUMANIZE_TEXT[settings.humanize.level] ?? settings.humanize.level}${settings.humanize.seed === undefined ? "" : s.muted(` (seed ${settings.humanize.seed})`)}`,
      ]);
    if (settings.sharing === "tabs") rows.push(["sharing", "every agent session at once, each in its own tabs"]);
    rows.push(["agent cursor", CURSOR_TEXT[settings.cursor ?? "auto"] ?? String(settings.cursor)]);
    if (settings.notify === false) rows.push(["notifications", "off (--notify false)"]);
    if (settings.lastClick === false)
      rows.push(["last click", "the agent may buy, send, publish and delete itself (--last-click false)"]);
    if (settings.browser !== undefined) rows.push(["browser", m.browserLabel(settings.browser)]);
    if (settings.tabLocks)
      rows.push([
        "tab locks",
        `${[
          settings.tabLocks.wait !== undefined ? `wait ${settings.tabLocks.wait}` : "",
          settings.tabLocks.release !== undefined ? `release after ${settings.tabLocks.release}` : "",
        ]
          .filter(Boolean)
          .join(", ")}${s.muted(settings.sharing === "tabs" ? "" : ' (used with "sharing": "tabs")')}`,
      ]);
    if (settings.engine === "lightpanda") rows.push(["engine", "Lightpanda (read mode)"]);
    if (settings.engine === "camoufox") rows.push(["engine", "Camoufox (its own Firefox profile)"]);
    if (settings.userAgent === "coherent")
      rows.push(["user agent", "the installed Chrome's own, checked at every launch (coherent)"]);
    if (settings.userAgent === "auto") rows.push(["user agent", "coherent in a headless Chrome (auto)"]);
    if (settings.userAgent === false) rows.push(["user agent", "Chrome's own, never pinned (off)"]);
    if (settings.locale === false) rows.push(["locale", "Chrome's own (off)"]);
    if (settings.proxy) rows.push(["proxy", describeProxy(settings.proxy)]);
    if (settings.attach !== undefined) rows.push(["engine", `attach to your Chrome (${settings.attach})`]);
    const recorded = describeRecord(settings.record);
    if (recorded) rows.push(["recording", recorded]);
    if (settings.policy) rows.push(["policy", describePolicy(settings.policy)]);
    if (settings.live?.enabled === false) rows.push(["live view", "off"]);
    if (settings.live?.enabled)
      rows.push([
        "live view",
        `on (${c.names.browser} live ${id}); a paused call waits up to ${settings.live.wait ?? "2m"}`,
      ]);
  }
  // On by default, so said for every identity: which model or solver, and why.
  if (!problems.length) {
    rows.push(["act", actLine(settings?.act as ActKey, io.env)]);
    rows.push(["captcha", captchaLine(settings?.captcha, io.env)]);
  }
  if (settings) {
    rows.push(["created", localTime(settings.created)]);
    rows.push(["updated", localTime(settings.updated)]);
  }
  if (health) {
    const state =
      health.status === "ok"
        ? s.ok("signed in")
        : health.status === "needs_auth"
          ? s.err("NEEDS_AUTH")
          : s.warn("check failed");
    rows.push([
      "last check",
      `${state} ${s.muted(`${localTime(health.checkedAt)}${health.detail ? `: ${health.detail}` : ""}`)}`,
    ]);
  }
  rows.push([
    "last sign-in",
    login
      ? `${localTime(login.at)}${login.sites.length ? s.muted(` (${login.sites.join(", ")})`) : s.muted(" (no site opened)")}`
      : m.profileHasCookies(id, io.env)
        ? s.muted(`no record yet (the next ${c.names.identity("login", id)} keeps one)`)
        : s.warn(`never by hand (${c.names.identity("login", id)})`),
  ]);
  rows.push([
    "state",
    holder ? s.warn(holder.replace(/^browser identity "[^"]+" is /, "").replace(/\. .*$/, "")) : s.ok("not in use"),
  ]);
  io.out(s.bold(`browser:${id}`));
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) io.out(s.kv(k, v, width));
  io.out(s.muted("defaults (not in identity.json; decided at every launch):"));
  for (const line of defaultLines(effective, undefined, SAID_APART)) io.out(`  ${line}`);
  const proxy = proxyInUse(settings, effective, io.env);
  for (const problem of exitProblems(id, settings, effective, proxy?.server, io.env)) io.out(s.note("warn", problem));
  for (const problem of problems) io.out(s.note("err", `identity.json ${problem}`));
  if (health?.status === "needs_auth") io.out(s.note("info", `sign in again: ${c.names.browser} login ${id}`));
  return Exit.ok;
}

const SET_FLAGS: FlagSpec = {
  ...SETTINGS_FLAGS,
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  ...JSON_FLAG,
};

/** The arguments of `set` after the identity, for the usage line. */
export const SET_SYNOPSIS =
  "[--timezone <zone>] [--locale <tag>] [--languages <tag,...>] [--region <CC>] [--health-url <url>] [--health-text <text>] [--health-selector <css>] [--health off] [--no-health] " +
  "[--tabs-max <n>] [--tabs-popups close|keep] [--tabs-park <duration>] [--tabs-close <duration>] [--no-tabs] [--background-throttling true|false] [--settle <duration>] [--resources normal|low|auto] " +
  "[--block-trackers true|false] [--block-types image,media,font] [--block-patterns <host|glob>,...] [--no-block] [--cache] [--cache-max-size <size>] [--no-cache] [--humanize auto|off|light|full|adaptive] [--cursor auto|on|off] [--notify true|false] [--last-click true|false] [--sharing session|tabs] [--tab-lock-wait <duration>] [--tab-lock-release <duration>] " +
  "[--engine chrome|lightpanda] [--attach auto|<dir>|<url>] [--record-flows true|false] [--record-traces true|false] [--record-screenshots true|false] [--record-max-size <size>] [--no-record] " +
  "[--act] [--act-sampling true|false] [--act-provider chat-completions] [--act-endpoint <url>] [--act-model <name>] [--act-key keychain:<item>] [--act-max-steps <n>] [--act-max-tokens <n>] [--act-timeout <duration>] [--no-act] " +
  "[--captcha-provider task-api] [--captcha-endpoint <url>] [--captcha-key keychain:<item>] [--captcha-timeout <duration>] [--no-captcha] [--live true|false|auto] [--live-wait <duration>] [--no-live] " +
  "[--user-agent coherent|auto|off] [--proxy-server <url>|off] [--proxy-username <name|keychain:item>] [--proxy-password keychain:<item>] [--no-proxy] " +
  "[--policy-file <file>] [--allowed-domains <host,...>] [--disable <feature,...>] [--auto-submit true|false] [--no-policy] [--browser chrome|edge|brave|chromium|chrome-for-testing|<path>] [--force] [--dry-run] [--json]";

/** More help for `set`: what each tuning flag writes to identity.json, with the host's command names. */
export function setDetails(n: CliNames): string {
  const b = n.browser;
  return `Each flag writes one key of identity.json; an empty value (--settle "") removes it, and
--no-health, --no-tabs, --no-block and --no-cache remove a whole group. A flag of a group
changes only its part: the rest of that group stays. A key that is not in identity.json takes
its default at every launch (${b} show <id> lists each value and where it comes from);
off pins a key off for good: --health off, --locale off, --user-agent off.

How the host runs this identity's Chrome (read at every Chrome start):
  --resources normal|low|auto     low: the preset for a machine short of memory (at most 2
                                  tabs, idle tabs parked after 2m, Chrome closed after 5m
                                  without a call, a note in tool results when memory runs
                                  low); the flags below still win over it. auto (default):
                                  low while the system reports memory pressure at launch
  --tabs-max <n>                  most tabs open at once, 0 for no cap (default 8)
  --tabs-popups close|keep        close popups the agent did not open (default close)
  --tabs-park <duration>          park an unused tab on about:blank, "0" never (default 5m)
  --tabs-close <duration>         close an unused tab, "0" never (default 15m)
  --background-throttling <bool>  let Chrome slow tabs that are not in front (default: true
                                  in a headless Chrome without the live view, else false)
  --settle <duration>             wait after each action for the work it started, "0" to "10s"
  --block-trackers <bool>         block a built-in list of ad and analytics hosts
  --block-types <list>            block image, media and font requests (never the page itself)
  --block-patterns <list>         block host names (and subdomains) or URL globs with *
  --cache                         keep images, fonts, styles and scripts on disk (100MB)
  --cache-max-size <size>         the cache's size, "1MB" to "10GB"; turns the cache on
  --sharing session|tabs          "tabs" (default): every agent session at once, each in its
                                  own locked tabs; mcp.toml then needs exclusive = false for the
                                  identity's server. "session": one at a time (the default with
                                  --attach)
  --tab-lock-wait <duration>      with tabs: how long a call waits for a tab another session
                                  holds, "0" (fail at once) to "10m" (default 10s)
  --tab-lock-release <duration>   with tabs: a session without calls lets go of its tabs after
                                  this, "0" (free between calls) to "24h" (default 5m)

Blocking without the cache turns Chrome's own HTTP cache off: use them together.

Input:
  --humanize <level>              auto (default): off on localhost and for read-only steps,
                                  light for other actions, full on sign-in, payment and support
                                  pages and on a site after a challenge page there; off, light
                                  (the pointer travels a curve to a point inside the target,
                                  keys typed with human delays), full (plus overshoot, reading
                                  pauses, wheel scrolling) or adaptive (light, full after a
                                  challenge page)
  --cursor auto|on|off            the agent cursor. auto (default): when the browser can be seen
                                  (a window, or the live view), Chrome itself highlights what the
                                  agent acts on and shows its clicks; nothing goes into the page.
                                  on: an arrow with the agent's name that glides to what it acts
                                  on, a ring, click ripples and a frame with a badge, drawn as an
                                  element in each page that a page script can see. off: neither
  --notify true|false             the system's notifications when the agent waits for you (a
                                  person step, a passkey, a captcha) or is done after a long
                                  run. true (default); TURNO_BROWSER_NOTIFY=off also turns them off
  --last-click true|false         true (default): a click that buys, sends, publishes or deletes
                                  is yours: the agent fills in the rest and asks you with
                                  browser_request_human. false lets the agent click it

Which engine runs this identity (all off by default):
  --engine lightpanda             read mode: Lightpanda instead of Chrome, for reading pages;
                                  needs lightpanda on PATH (${b} doctor says how)
  --engine camoufox               Camoufox (a Firefox build) with its own profile; needs
                                  Camoufox and playwright-core (${b} doctor says how); no
                                  captcha solving, and no picture in the live view
  --attach auto|<dir>|<url>       use the Chrome you have open instead of the identity's own:
                                  "auto" is your default Chrome profile, after you turn on
                                  chrome://inspect/#remote-debugging; Chrome asks you to allow
                                  each connection, and the agent then sees all its windows

What turno-browser records for this identity (${b} record):
  --record-flows <bool>           keep every session's actions as a flow (auto-<time>, newest
                                  20; on by default)
  --record-traces <bool>          a Playwright trace of each browser session (${b} traces);
                                  off by default: while tracing, Chrome loads no image or
                                  frame of another site
  --record-screenshots <bool>     a screenshot after each action (on by default, never of a
                                  page that shows a vault value; not with attach or Lightpanda)
  --record-max-size <size>        cap of the traces and screenshots, "10MB" to "10GB" (default 200MB)
Vault sign-ins and passwords never reach a flow, a trace or a screenshot.

On when something answers them, for your own accounts only (they send page content to a
third party, and many sites' terms forbid them; the server lists their tools from its next start).
Without a provider, natural language actions (browser_act, browser_extract, browser_observe) use
your client's model (MCP sampling), else OPENAI_API_KEY or ANTHROPIC_API_KEY from the environment,
else the Claude Code CLI or Codex on the PATH; captcha solving needs a solver key, here or in
TURNO_BROWSER_CAPTCHA_ENDPOINT with TURNO_BROWSER_CAPTCHA_KEY, and otherwise goes to the person:
  --act                           natural language actions in that order (the same as no group)
  --act-provider chat-completions a model API to use when the client has no sampling, with
  --act-endpoint <url>            its base URL (https, or http on this machine),
  --act-model <name>              the model name it expects and
  --act-key keychain:<item>       its key in the secret store (${n.secretSet("<item>")})
  --act-sampling <bool>           false: never ask the client, always use the provider
  --act-max-steps <n>             most actions per call, 1 to 30 (default 10)
  --act-max-tokens <n>            most model tokens per call (default 50000)
  --act-timeout <duration>        longest call, "10s" to "10m" (default 2m)
  --captcha-provider task-api     solve captcha widgets (browser_solve_captcha) through a solver
  --captcha-endpoint <url>        service that speaks the createTask protocol, at this URL,
  --captcha-key keychain:<item>   with its account key in the secret store
  --captcha-timeout <duration>    longest wait for a solution (default 3m)
  --no-act, --no-captcha          remove the group: back to the order above

The live view and take-over (${b} live, pause, resume):
  --live <bool>                   serve a view of the agent's tab on 127.0.0.1 and let you pause
                                  the agent to take the controls (from the next server start);
                                  on by default, and the view opens only with ${b} live <id>
  --live-wait <duration>          how long a paused call waits for you, "5s" to "30m" (default 2m)

Network and user agent (for your own accounts and sites you may automate):
  --user-agent coherent|auto|off  coherent: the installed Chrome's own user agent and client
                                  hints, with this identity's languages and time zone, checked
                                  at every launch (a headless Chrome stops saying
                                  HeadlessChrome). auto (default): coherent in a headless Chrome
                                  only, dropped when the check fails. off: Chrome's own. turno
                                  never takes a typed user agent
  --proxy-server <url>            send this identity's traffic through a proxy: http://,
                                  https://, socks4:// or socks5://host:port; its operator sees
                                  where you go, and sites see its address; off: no
                                  proxy, not even the system's
  --proxy-username <name>         the proxy user name, or keychain:<item>
  --proxy-password keychain:<item> the password, only from the secret store (${n.secretStore ?? n.secretSet("<item>")})
  --no-proxy                      remove the proxy (Chrome follows the system's)

What the identity may do (a policy; only this command writes it, no agent tool can):
  --policy-file <file>            the whole policy from a JSON file, like
                                  {"allowedDomains": ["example.com", "*.example.com"],
                                   "disabled": ["captcha"], "autoSubmit": false}
  --allowed-domains <list>        the hosts its pages may show: example.com, *.example.com
                                  (subdomains), localhost:* (any port), host:8443; every
                                  navigation of every tab is checked, a page's own scripts,
                                  images and data are not
  --disable <list>                features that do not exist for it: act, captcha, login, totp,
                                  attach, evaluate, run_code, storage, network
  --auto-submit false             browser_login never submits, whatever vault submit says
  --no-policy                     remove the policy
Any policy turns browser_run_code_unsafe off, and allowedDomains the network tools. The server
reads the policy when it starts.

Which browser opens the profile (read at every browser start; ${b} doctor lists the installed ones):
  --browser <name|path>           chrome (the default), edge, brave, chromium, chrome-for-testing
                                  (${b} install-browser downloads it, no admin password), or the
                                  absolute path of another Chromium-based browser. A server's own
                                  --browser or --executable-path wins over it
  --force                         switch the browser of a profile another browser already opened:
                                  the cookies carry over with the default keychain, but the new
                                  browser rewrites the profile and an older one can refuse it`;
}

/** The flags of `set`, for completion. */
export const SET_FLAG_NAMES = ["--dry-run", "--json", "--force", ...SETTINGS_FLAG_NAMES];

/**
 * The package's own validation, run on a copy: identity.json is copied to a throwaway data
 * folder and the patch written there, so `--dry-run` refuses exactly what the write would and
 * shows the file it would leave, without touching the real one.
 */
export function rehearse(
  m: BrowserFunctions,
  id: string,
  patch: SettingsPatch,
  env: NodeJS.ProcessEnv,
): IdentitySettings {
  const dir = mkdtempSync(join(env.TMPDIR || tmpdir(), "turno-identity-"));
  try {
    const copy = { ...env, TURNO_DATA_DIR: dir };
    const from = m.identitySettingsPath(id, env);
    const to = m.identitySettingsPath(id, copy);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    if (existsSync(from)) copyFileSync(from, to);
    return m.writeIdentitySettings(id, patch, copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The switch of a used profile to another browser: refused without `--force` (it fails with
 * why), and with it the reason to print as a warning. Undefined when nothing changes or the
 * profile was never opened.
 */
function browserSwitch(
  c: Ctx,
  id: string,
  current: IdentitySettings | undefined,
  patch: SettingsPatch,
  force: boolean,
  io: Io,
): string | undefined {
  const m = c.api;
  const to = patch.browser ?? "chrome";
  const problem = m.browserSwitchProblem(
    current?.browser ?? "chrome",
    to,
    m.profileLastVersion(m.identityDir(id, io.env)),
    patch.keychain === null ? undefined : (patch.keychain ?? current?.keychain),
  );
  if (!problem || force) return problem;
  return fail(
    `not switching the browser of "${id}": ${problem}. To keep the sign-ins, keep the browser, or make a new identity for ${to} (${c.names.identity("add", `${id}-${typeof to === "string" && !to.startsWith("/") ? to : "other"}`)} --browser ${to}); --force switches anyway`,
  );
}

/**
 * The browser a new identity gets when `--browser` is not given: none (Google Chrome, the
 * default) when Chrome is installed; else the first other Chromium-based browser found, written
 * to identity.json so the profile never changes browser by itself; else none, with the
 * no-admin way to get one.
 */
export function defaultBrowser(
  c: Ctx,
  id: string,
  env: NodeJS.ProcessEnv,
): { browser?: string; note: string } | undefined {
  const found = c.api.detectBrowsers(env);
  if (found.some((b) => b.id === "chrome")) return undefined;
  const first = found[0];
  if (first)
    return {
      browser: first.id,
      note: `Google Chrome is not installed, so this identity uses ${first.label} (identity.json browser; change it with ${c.names.browser} set ${id} --browser <name> before the first sign-in)`,
    };
  return {
    note: `no Chromium-based browser found (Google Chrome, Edge, Brave, Chromium): run ${c.names.browser} install-browser (no admin password), then ${c.names.browser} set ${id} --browser chrome-for-testing`,
  };
}

/**
 * What `add` offers a person for a new identity, and never turns on by itself: the cookie key
 * in the system keychain (already written, said here), Camoufox and Lightpanda when installed,
 * and the user's own Chrome instead of a new profile.
 */
export function addOffers(c: Ctx, id: string, settings: SettingsPatch, env: NodeJS.ProcessEnv): string[] {
  const set = (flags: string) => `${c.names.browser} set ${id} ${flags}`;
  const offers: string[] = [];
  if (settings.keychain === "system")
    offers.push(
      `the cookie key is in the macOS keychain, as your own Chrome keeps it; to keep the fixed test key instead, remove "keychain" from identity.json before the first sign-in`,
    );
  if (settings.engine || settings.attach !== undefined) return offers;
  if (findCamoufox(env)) offers.push(`Camoufox is installed: ${set("--engine camoufox")} runs this identity on it`);
  if (findLightpanda(env))
    offers.push(`Lightpanda is installed: ${set("--engine lightpanda")} reads pages with it (read mode, no clicks)`);
  offers.push(`to work in the Chrome you have open instead of a new profile: ${set("--attach auto")}`);
  return offers;
}

/** What turning on natural language actions or captcha solving costs, said once at `set`. */
function optInNotes(c: Ctx, id: string, patch: SettingsPatch): string[] {
  const notes: string[] = [];
  const restart = `its tools are listed once browser-${id} starts again (${c.host.restart})`;
  if (patch.act)
    notes.push(
      `natural language actions: each call sends the instruction and a snapshot of the page to the model (your client's, or the provider you set), with vault values and sensitive fields hidden; ${restart}. Undo with --no-act; to keep them off, add "act" to the identity's policy (disabled).`,
    );
  if (patch.captcha)
    notes.push(
      `captcha solving: the solver service sees the page address and the captcha, and solving a site's captchas by machine may break its terms; use it only for your own accounts. Every use goes to the reputation log; ${restart}. Undo with --no-captcha.`,
    );
  if (patch.policy !== undefined)
    notes.push(
      `the policy applies from the next start of browser-${id} (${c.host.restart}); an agent that also has a shell on this computer can still run this command`,
    );
  const own = "Meant for your own accounts and sites you may automate.";
  if (typeof patch.userAgent === "string")
    notes.push(
      `userAgent coherent: Chrome's real version and platform are kept, so a site sees one coherent browser; a site may still notice automation by other means. ${own}`,
    );
  if (patch.proxy)
    notes.push(
      `proxy ${patch.proxy.server}: its operator sees where this identity goes, sites see the proxy's address instead of yours, and a sign-in from a new network can lock an account; many sites' terms forbid it. ${own}`,
    );
  if (patch.engine === "camoufox")
    notes.push(
      `engine camoufox: a Firefox build that reports values other than the computer's own is something sites look for, the Chrome profile's sign-ins do not carry over, and it needs Camoufox and playwright-core (${c.names.browser} doctor). ${own}`,
    );
  return notes;
}

export function set(c: Ctx, id: string, args: string[], io: Io): number {
  const m = c.api;
  const p = parseFlags(args, SET_FLAGS, 1);
  if (!m.identityExists(id, io.env)) return fail(`identity "${id}" does not exist (${c.names.identity("add", id)})`);
  const current = m.checkIdentitySettings(id, io.env).settings;
  const patch = settingsPatch(p, current);
  if (!hasSettings(patch))
    return fail(`nothing to set: pass ${SETTINGS_FLAG_NAMES.join(", ")} (an empty value removes one)`);
  const switched = patch.browser !== undefined ? browserSwitch(c, id, current, patch, bool(p, "force"), io) : undefined;
  const dryRun = bool(p, "dry-run");
  let settings: IdentitySettings;
  try {
    settings = dryRun ? rehearse(m, id, patch, io.env) : m.writeIdentitySettings(id, patch, io.env);
  } catch (err) {
    if ((err as Error).name === "IdentityError") return fail(flagMessage((err as Error).message));
    throw err;
  }
  if (bool(p, "json")) {
    emit(io, p, SET_JSON, {
      id: `browser:${id}`,
      settingsFile: tildify(m.identitySettingsPath(id, io.env), io.env),
      dryRun,
      changes: patch,
      settings,
    });
    return Exit.ok;
  }
  if (dryRun) {
    io.out(`(dry run) would update identity.json of "${id}": ${JSON.stringify(patch)}`);
    return Exit.ok;
  }
  io.out(`updated identity.json of "${id}"; the next Chrome start of browser-${id} uses it\n`);
  const code = show(c, id, [], io);
  if (switched) io.out(style(io).note("warn", `browser switched with --force: ${switched}`));
  const sharing = patch.sharing !== undefined ? c.host.sharingNote?.(id, settings.sharing) : undefined;
  if (sharing) io.out(`\n${sharing}`);
  for (const note of optInNotes(c, id, patch)) io.out(style(io).note("warn", note));
  if (typeof patch.attach === "string") {
    const s = style(io);
    io.out(
      s.note(
        "warn",
        "attach mode: the agent works in your own Chrome and sees every window and signed-in site of that profile. " +
          "Turn on remote debugging at chrome://inspect/#remote-debugging and allow each connection Chrome asks about; " +
          'turno closes only the tabs it opened. Undo with --attach "".',
      ),
    );
  }
  return code;
}

const DOCTOR_FLAGS: FlagSpec = { fix: { type: "boolean" }, "no-launch": { type: "boolean" }, ...JSON_FLAG };

const SECTIONS: [string, (area: string) => boolean][] = [
  ["Browsers", (a) => a === "chrome"],
  ["System", (a) => a === "system"],
  ["Engines", (a) => a === "engines"],
  ["Identities", (a) => a === "identities" || a.startsWith("identity ")],
  ["Agents", (a) => a === "agents"],
];

export async function doctor(c: Ctx, args: string[], io: Io): Promise<number> {
  const m = c.api;
  const p = parseFlags(args, DOCTOR_FLAGS, 0);
  const json = bool(p, "json");
  const report = await m.runDoctor({
    env: io.env,
    fix: bool(p, "fix"),
    launch: !bool(p, "no-launch"),
    servers: c.host.servers?.(io.env) ?? [],
    ...(c.host.agents ? { agents: c.host.agents(io.env) } : {}),
  });
  const failed = report.checks.some((c) => c.level === "fail");
  const exit = failed ? Exit.failure : Exit.ok;
  const status = (c: DoctorCheck) => (c.level === "info" ? "skip" : c.level);
  const n = (l: DoctorCheck["level"]) => report.checks.filter((c) => c.level === l).length;
  if (json) {
    emit(io, p, DOCTOR_JSON, {
      ok: !failed,
      counts: { ok: n("ok"), warn: n("warn"), fail: n("fail"), skip: n("info") },
      fixed: report.fixed,
      checks: report.checks.map((c) => ({
        area: c.area,
        status: status(c),
        text: c.text,
        fix: c.level === "ok" ? null : (c.fix ?? null),
        auto: Boolean(c.auto) && (c.level === "warn" || c.level === "fail"),
        manual: c.level === "ok" ? null : (c.manual ?? null),
      })),
    });
    return exit;
  }
  const s = style(io);
  for (const f of report.fixed) io.out(s.check("ok", `fixed: ${f}`));
  if (report.fixed.length) io.out("");
  const ICON = { ok: "ok", warn: "warn", fail: "err", info: "skip" } as const;
  let first = true;
  for (const [title, has] of SECTIONS) {
    const rows = report.checks.filter((c) => has(c.area));
    if (!rows.length) continue;
    if (!first) io.out("");
    first = false;
    io.out(s.header(title));
    let area = "";
    for (const c of rows) {
      if (c.area.startsWith("identity ") && c.area !== area)
        io.out(`  ${s.bold(`browser:${c.area.slice("identity ".length)}`)}`);
      area = c.area;
      const indent = c.area.startsWith("identity ") ? 4 : 2;
      const text = c.level === "fail" ? s.err(c.text) : c.level === "info" ? s.muted(c.text) : c.text;
      io.out(s.note(ICON[c.level], text, indent));
      if (c.level === "ok") continue;
      const under = " ".repeat(indent + 2);
      const label = c.level === "info" ? "optional:" : "fix:";
      if (c.fix)
        io.out(
          s.wrap(
            `${under}${s.muted(label)} `,
            `${c.level === "info" ? s.muted(c.fix) : s.bold(c.fix)}${c.auto ? s.muted(" (runs with --fix)") : ""}`,
          ),
        );
      else if (c.manual) io.out(s.wrap(`${under}${s.muted("manual:")} `, c.manual));
    }
  }
  io.out("");
  io.out(
    [
      `${n("ok")} ok`,
      n("warn") ? `${n("warn")} warning${n("warn") === 1 ? "" : "s"}` : "",
      n("fail") ? `${n("fail")} failure${n("fail") === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", "),
  );
  return exit;
}

export function reputation(c: Ctx, args: string[], io: Io, checkId: (id: string) => string): number {
  const m = c.api;
  const p = parseFlags(args, JSON_FLAG, 1);
  const id = p.positionals[0] === undefined ? undefined : checkId(p.positionals[0].replace(/^browser:/, ""));
  let report: ReturnType<typeof m.reputationReport>;
  try {
    report = m.reputationReport(io.env, id ? [id] : undefined);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (bool(p, "json")) {
    emit(
      io,
      p,
      REPUTATION_JSON,
      report.identities.map((i) => ({
        id: `browser:${i.id}`,
        file: tildify(i.file, io.env),
        total: i.total,
        sites: i.sites,
      })),
    );
    return Exit.ok;
  }
  const s = style(io);
  if (!report.identities.length) {
    io.out(`No browser identities yet. Create one with \`${c.names.identity("add", "<id>")}\`.`);
    return Exit.ok;
  }
  const TREND = { up: s.warn("up"), down: s.ok("down"), flat: s.muted("flat") };
  for (const [i, ident] of report.identities.entries()) {
    if (i) io.out("");
    io.out(s.header(`browser:${ident.id}`));
    if (!ident.sites.length) {
      io.out(`  ${s.muted("no challenges recorded")}`);
      continue;
    }
    // The solved column shows only once a captcha solver answered (identity.json `captcha`).
    const solved = ident.sites.some((x) => x.solved > 0);
    const head = [
      "site",
      "total",
      "captcha",
      "verify",
      "block",
      ...(solved ? ["solved"] : []),
      "7d",
      "prev 7d",
      "trend",
      "last seen",
    ].map((h) => s.muted(h));
    const rows = ident.sites.map((x) => [
      x.site,
      String(x.total),
      String(x.captcha),
      String(x.verify),
      String(x.block),
      ...(solved ? [String(x.solved)] : []),
      String(x.last7d),
      String(x.prev7d),
      TREND[x.trend],
      x.lastSeen,
    ]);
    const right = { align: "right" as const };
    for (const l of s.table([head, ...rows], {
      columns: [{}, right, right, right, right, ...(solved ? [right] : []), right, right, {}, { drop: 1 }],
    }))
      io.out(l);
  }
  return Exit.ok;
}
