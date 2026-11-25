import { execFileSync } from "node:child_process";
import type { PressureLevel } from "turno-core/memory";
import { type ActFallback, resolveAct } from "./act-chain.js";
import type { HumanizeLevel } from "./humanize.js";
import type { IdentityPolicy } from "./policy.js";
import type { HealthCheck, IdentitySettings } from "./settings.js";

/**
 * The defaults of an identity, resolved in code at every launch from the context the browser
 * starts in: headless or windowed, the live view, memory pressure, the engine, the policy. The
 * agent cursor's `auto` worked this way first; every feature that used to wait for an opt-in now
 * does too. Nothing here writes identity.json: a key that is not in the file takes the default
 * again at the next launch, so a change of default never needs a migration, and the file keeps
 * saying only what the person chose (`show`, `status` and `doctor` tell the two apart).
 *
 * Precedence, for every key: a `turno-browser-mcp` flag, then identity.json (where `false`, the
 * format 14 off value, also counts), then the default below. A default that depends on something
 * the caller does not know yet (the CLI has no server, so no `headless`) comes back with an
 * undefined value and the rule that decides it at launch.
 *
 * `act` and `captcha` follow what the environment offers: a model for natural language actions
 * (`act-chain.ts`: MCP sampling, an API key, a subscription CLI) and a captcha solver key
 * (`captcha.ts`). Some defaults wait on work that is not done yet: the system proxy and the
 * masking of `storage` values. Each has an entry that says "not yet available" until it lands,
 * so the place where it plugs in is already here.
 */

/** Where an effective value came from. */
export type Origin =
  /** identity.json sets it. */
  | { from: "file" }
  /** A `turno-browser-mcp` flag sets it. */
  | { from: "flag" }
  /** The default, the same in every context. */
  | { from: "default" }
  /** A default that a condition decided: `because` says which. */
  | { from: "auto"; because: string }
  /** A default the caller cannot decide without the server's context: `rule` says how it goes. */
  | { from: "launch"; rule: string }
  /** A default whose feature is not available yet. */
  | { from: "unavailable"; because: string };

export interface Effective<T> {
  /** Undefined only with a `launch` origin: the value is decided when the browser starts. */
  value: T | undefined;
  origin: Origin;
}

/** What the resolver knows about the browser being launched (or, from the CLI, about the machine). */
export interface DefaultsContext {
  /** The server serves an identity: the live view and recordings exist only then. */
  identity: boolean;
  /** Chrome runs without a window; undefined when not known (the CLI). */
  headless?: boolean;
  /** The engine a flag or identity.json picks: `chrome`, `lightpanda`, `camoufox` or `attach`. */
  engine: string;
  /** The memory pressure turno-core reads now; undefined when not read. */
  pressure?: PressureLevel;
  /** identity.json `policy` as the server started. */
  policy?: IdentityPolicy;
  /** The server sets a user agent of its own (`--user-agent`, `--device`) or a proxy (`--proxy-server`). */
  serverUserAgent?: boolean;
  /** The system's language tag (`systemLocale`); undefined when it could not be read. */
  systemLocale?: string;
  /** A health check the last `login` detected (`health-detect.ts`). */
  detectedHealth?: HealthCheck;
  /** The vault's submit choice when the person made one (`vault submit`); undefined: none. */
  vaultSubmit?: "auto" | "confirm";
  /** The server's `--caps` list, when it was given: it is the whole list then. */
  caps?: readonly string[];
  /** What the environment offers natural language actions (`resolveActFallback`); undefined: not looked at. */
  actFallback?: ActFallback;
  /** Whether the client offers MCP sampling; undefined when no client is known (the CLI). */
  sampling?: boolean;
  /**
   * The captcha solver key the environment holds, as `captcha.ts` labels it, or why there is
   * none; undefined: not looked at.
   */
  captchaKey?: { solver: string } | { missing: string };
}

/** turno-browser-mcp's flags that win over identity.json. */
export interface DefaultsFlags {
  live?: boolean;
  resources?: "normal" | "low" | "auto";
  humanize?: HumanizeLevel;
  sharing?: "session" | "tabs";
  backgroundThrottling?: boolean;
}

/** The capabilities of Playwright MCP that turno lists by default, in the order `--caps` takes them. */
export const DEFAULT_CAPS = ["vision", "pdf", "devtools", "network"] as const;

/** Every effective value `show`, `status`, `doctor` and the host read. */
export interface EffectiveSettings {
  live: Effective<boolean>;
  resources: Effective<"normal" | "low">;
  backgroundThrottling: Effective<boolean>;
  humanize: Effective<HumanizeLevel>;
  sharing: Effective<"session" | "tabs">;
  userAgent: Effective<"coherent" | "off">;
  locale: Effective<string | false>;
  keychain: Effective<"mock" | "system">;
  health: Effective<HealthCheck | false>;
  record: {
    flows: Effective<boolean>;
    screenshots: Effective<boolean>;
    /** `"failed"`: traced, and a trace kept only when a step in it failed. */
    traces: Effective<boolean | "failed">;
  };
  caps: Record<(typeof DEFAULT_CAPS)[number] | "storage", Effective<boolean>>;
  submit: Effective<"auto" | "confirm">;
  act: Effective<boolean>;
  captcha: Effective<boolean>;
  proxy: Effective<boolean>;
}

const file = <T>(value: T): Effective<T> => ({ value, origin: { from: "file" } });
const flag = <T>(value: T): Effective<T> => ({ value, origin: { from: "flag" } });
const byDefault = <T>(value: T): Effective<T> => ({ value, origin: { from: "default" } });
const auto = <T>(value: T, because: string): Effective<T> => ({ value, origin: { from: "auto", because } });
const atLaunch = <T>(rule: string): Effective<T> => ({ value: undefined, origin: { from: "launch", rule } });
const unavailable = <T>(value: T, because: string): Effective<T> => ({
  value,
  origin: { from: "unavailable", because },
});

/** Engines that run a profile of turno's (attach drives the user's own Chrome, read mode keeps no page). */
const profileEngine = (engine: string) => engine !== "attach" && engine !== "lightpanda";

function live(s: IdentitySettings | undefined, ctx: DefaultsContext, f: DefaultsFlags): Effective<boolean> {
  if (f.live !== undefined) return flag(f.live);
  const enabled = s?.live?.enabled;
  if (typeof enabled === "boolean") return file(enabled);
  if (!ctx.identity) return auto(false, "no identity");
  return byDefault(true);
}

function resources(
  s: IdentitySettings | undefined,
  ctx: DefaultsContext,
  f: DefaultsFlags,
): Effective<"normal" | "low"> {
  const asked = f.resources ?? s?.resources;
  if (asked === "normal" || asked === "low") return f.resources ? flag(asked) : file(asked);
  if (ctx.pressure === undefined) return atLaunch("the low-resource preset while memory is short");
  return ctx.pressure === "normal" ? auto("normal", "no memory pressure") : auto("low", "memory pressure");
}

function backgroundThrottling(
  s: IdentitySettings | undefined,
  ctx: DefaultsContext,
  f: DefaultsFlags,
  liveOn: boolean | undefined,
): Effective<boolean> {
  if (f.backgroundThrottling !== undefined) return flag(f.backgroundThrottling);
  if (s?.backgroundThrottling !== undefined) return file(s.backgroundThrottling);
  // A window can be covered and the live view needs frames: only a headless Chrome nobody watches.
  if (ctx.headless === undefined || liveOn === undefined) return atLaunch("on in headless without the live view");
  if (!ctx.headless) return auto(false, "Chrome has a window");
  if (liveOn) return auto(false, "the live view is on");
  return auto(true, "headless without the live view");
}

function humanize(s: IdentitySettings | undefined, ctx: DefaultsContext, f: DefaultsFlags): Effective<HumanizeLevel> {
  if (f.humanize) return flag(f.humanize);
  const level = s?.humanize?.level;
  if (level && level !== "auto") return file(level);
  if (ctx.engine === "lightpanda") return auto("off", "read mode lays out no page");
  return level === "auto" ? file("auto") : byDefault("auto");
}

function sharing(
  s: IdentitySettings | undefined,
  ctx: DefaultsContext,
  f: DefaultsFlags,
): Effective<"session" | "tabs"> {
  if (f.sharing) return flag(f.sharing);
  if (s?.sharing) return file(s.sharing);
  // Attach mode is the user's own Chrome: its tabs are not turno's to hand out.
  if (ctx.engine === "attach") return auto("session", "attach mode");
  return byDefault("tabs");
}

function userAgent(s: IdentitySettings | undefined, ctx: DefaultsContext): Effective<"coherent" | "off"> {
  if (s?.userAgent === "coherent") return file("coherent");
  if (s?.userAgent === false) return file("off");
  if (ctx.engine !== "chrome") return auto("off", `engine ${ctx.engine}`);
  if (ctx.serverUserAgent) return auto("off", "the server sets a user agent or proxy of its own");
  if (ctx.headless === undefined) return atLaunch("coherent in a headless Chrome");
  // A Chrome with a window already sends its own user agent; a headless one says HeadlessChrome.
  return ctx.headless ? auto("coherent", "headless Chrome") : auto("off", "Chrome has a window");
}

function locale(s: IdentitySettings | undefined, ctx: DefaultsContext): Effective<string | false> {
  if (typeof s?.locale === "string") return file(s.locale);
  if (s?.locale === false) return file(false);
  if (s?.languages?.length) return auto(false, "identity.json sets the languages");
  return ctx.systemLocale
    ? auto(ctx.systemLocale, "the system's, which Chrome reads itself")
    : auto(false, "the system's is unknown");
}

function health(s: IdentitySettings | undefined, ctx: DefaultsContext): Effective<HealthCheck | false> {
  if (s?.health) return file(s.health);
  if (s?.health === false) return file(false);
  if (ctx.detectedHealth) return auto(ctx.detectedHealth, "detected after the last login");
  return byDefault(false);
}

function record(s: IdentitySettings | undefined, ctx: DefaultsContext): EffectiveSettings["record"] {
  const r = s?.record;
  const none = !ctx.identity ? "no identity" : undefined;
  const flows = r?.flows !== undefined ? file(r.flows) : none ? auto(false, none) : byDefault(true);
  // Attach mode could screenshot the user's own tabs; read mode renders nothing.
  const noPixels = !profileEngine(ctx.engine) ? `engine ${ctx.engine}` : undefined;
  const screenshots =
    r?.screenshots !== undefined
      ? file(r.screenshots)
      : (none ?? noPixels)
        ? auto(false, (none ?? noPixels)!)
        : byDefault(true);
  const traces: Effective<boolean | "failed"> =
    r?.traces !== undefined
      ? file(r.traces)
      : (none ?? noPixels)
        ? auto(false, (none ?? noPixels)!)
        : // Kept only for a failed step once the driver allows it: while Playwright traces in
          // patchright, Chrome loads no image or frame from another site.
          unavailable(false, "not yet available: tracing stops pages from loading images and frames of other sites");
  return { flows, screenshots, traces };
}

/** The tools a policy turns off: the `network` capability with allowedDomains or in its disabled list. */
function policyOff(policy: IdentityPolicy | undefined, feature: string): boolean {
  if (!policy) return false;
  if (feature === "network" && policy.allowedDomains) return true;
  return (policy.disabled as readonly string[] | undefined)?.includes(feature) === true;
}

function caps(s: IdentitySettings | undefined, ctx: DefaultsContext): EffectiveSettings["caps"] {
  const storage = unavailable(false, "not yet available: cookie and token values are not masked yet");
  if (ctx.caps) {
    const given = (cap: string) => flag(ctx.caps!.includes(cap));
    return {
      vision: given("vision"),
      pdf: given("pdf"),
      devtools: given("devtools"),
      network: given("network"),
      storage: ctx.caps.includes("storage") ? flag(true) : storage,
    };
  }
  return {
    vision: byDefault(true),
    pdf: byDefault(true),
    // The devtools capability traces with the same Playwright tracer as record.traces.
    devtools: s?.record?.traces === true ? auto(false, "record.traces is on") : byDefault(true),
    network: policyOff(ctx.policy, "network") ? auto(false, "the policy turns it off") : byDefault(true),
    storage,
  };
}

function submit(ctx: DefaultsContext): Effective<"auto" | "confirm"> {
  if (ctx.policy?.autoSubmit === false) return auto("confirm", "the policy's autoSubmit is false");
  if (ctx.vaultSubmit) return file(ctx.vaultSubmit);
  return byDefault("auto");
}

/**
 * Natural language actions: off with `false` or when the policy turns them off, else on when a
 * model answers. identity.json's group, when there, decides the order (`resolveAct`); without
 * it, the chain does, and the origin says which model and why.
 */
function act(s: IdentitySettings | undefined, ctx: DefaultsContext): Effective<boolean> {
  if (s?.act === false) return file(false);
  if (policyOff(ctx.policy, "act")) return auto(false, "the policy turns it off");
  if (!ctx.actFallback)
    return s?.act !== undefined
      ? file(true)
      : atLaunch("on when the client offers MCP sampling, an API key is set or a CLI is found");
  const r = resolveAct(s?.act, ctx.actFallback, ctx.sampling);
  if (s?.act !== undefined) return file(r.path !== "off");
  if (r.path === "off") return auto(false, r.reason);
  if (ctx.sampling === undefined && ctx.actFallback.kind === "none")
    return atLaunch(`only with a client that offers MCP sampling (${r.reason})`);
  return auto(true, `${r.label}: ${r.reason}`);
}

/** Captcha solving: on with a solver key (identity.json, else the environment), else a person answers. */
function captcha(s: IdentitySettings | undefined, ctx: DefaultsContext): Effective<boolean> {
  if (s?.captcha === false) return file(false);
  if (policyOff(ctx.policy, "captcha")) return auto(false, "the policy turns it off");
  if (s?.captcha !== undefined) return file(true);
  if (!ctx.captchaKey)
    return atLaunch(
      "on when TURNO_BROWSER_CAPTCHA_ENDPOINT and TURNO_BROWSER_CAPTCHA_KEY are set, else a person answers",
    );
  return "solver" in ctx.captchaKey
    ? auto(true, ctx.captchaKey.solver)
    : auto(false, `a person answers (browser_request_human): ${ctx.captchaKey.missing}`);
}

/** A feature that turns on with a key: on with its object, off with `false`, and its default otherwise. */
function keyed(value: unknown, missing: Effective<boolean>): Effective<boolean> {
  if (value === false) return file(false);
  if (value !== undefined) return file(true);
  return missing;
}

/** Every effective value of an identity in this context. */
export function resolveDefaults(
  settings: IdentitySettings | undefined,
  ctx: DefaultsContext,
  flags: DefaultsFlags = {},
): EffectiveSettings {
  const liveOn = live(settings, ctx, flags);
  return {
    live: liveOn,
    resources: resources(settings, ctx, flags),
    backgroundThrottling: backgroundThrottling(settings, ctx, flags, liveOn.value),
    humanize: humanize(settings, ctx, flags),
    sharing: sharing(settings, ctx, flags),
    userAgent: userAgent(settings, ctx),
    locale: locale(settings, ctx),
    // New identities get "system" when `add` writes it (`newIdentityKeychain`); an existing one
    // keeps what its cookies were encrypted with.
    keychain: settings?.keychain ? file(settings.keychain) : byDefault("mock"),
    health: health(settings, ctx),
    record: record(settings, ctx),
    caps: caps(settings, ctx),
    submit: submit(ctx),
    act: act(settings, ctx),
    captcha: captcha(settings, ctx),
    // Detecting the system's proxy lands separately.
    proxy: keyed(settings?.proxy, unavailable(false, "not yet available: the system proxy is not read yet")),
  };
}

/** An origin in a few words: "identity.json", "default", "auto: memory pressure". */
export function describeOrigin(origin: Origin): string {
  switch (origin.from) {
    case "file":
      return "identity.json";
    case "flag":
      return "server flag";
    case "default":
      return "default";
    case "auto":
      return `auto: ${origin.because}`;
    case "launch":
      return `auto: ${origin.rule}`;
    case "unavailable":
      return origin.because;
  }
}

/** True when a default (not the file or a flag) gave the value. */
export function fromDefault(origin: Origin): boolean {
  return origin.from !== "file" && origin.from !== "flag";
}

/** A value with where it came from: "resources: low (auto: memory pressure)". */
export function describeEffective(key: string, e: Effective<unknown>): string {
  const v = e.value;
  const text =
    v === undefined ? "auto" : v === true ? "on" : v === false ? "off" : typeof v === "object" ? "on" : String(v);
  return `${key}: ${text} (${describeOrigin(e.origin)})`;
}

/** Every effective value as `[key, effective]`, in the order `show` prints them. */
export function effectiveEntries(e: EffectiveSettings): [string, Effective<unknown>][] {
  return [
    ["live", e.live],
    ["resources", e.resources],
    ["backgroundThrottling", e.backgroundThrottling],
    ["humanize", e.humanize],
    ["sharing", e.sharing],
    ["userAgent", e.userAgent],
    ["locale", e.locale],
    ["keychain", e.keychain],
    ["health", e.health],
    ["record.flows", e.record.flows],
    ["record.screenshots", e.record.screenshots],
    ["record.traces", e.record.traces],
    ["caps.vision", e.caps.vision],
    ["caps.pdf", e.caps.pdf],
    ["caps.devtools", e.caps.devtools],
    ["caps.network", e.caps.network],
    ["caps.storage", e.caps.storage],
    ["vault submit", e.submit],
    ["act", e.act],
    ["captcha", e.captcha],
    ["proxy", e.proxy],
  ];
}

/** The keys `show`, `status` and `doctor` give rows of their own, with the model or solver and why. */
export const SAID_APART: readonly string[] = ["act", "captcha"];

/**
 * The values identity.json leaves to their defaults, one line each: "resources: low (auto: memory
 * pressure)". With `"auto"`, only those the context decides (not the fixed defaults); `except`
 * leaves keys out.
 */
export function defaultLines(e: EffectiveSettings, only?: "auto", except: readonly string[] = []): string[] {
  return effectiveEntries(e)
    .filter(([key]) => !except.includes(key))
    .filter(([, v]) => fromDefault(v.origin) && (!only || v.origin.from === "auto" || v.origin.from === "launch"))
    .map(([key, v]) => describeEffective(key, v));
}

/**
 * The system's language tag, the way a person's own Chrome would pick it: the POSIX locale
 * variables first (LC_ALL, LC_MESSAGES, LANG), then on macOS the user's region setting
 * (`AppleLocale`), which a process started by launchd sees without any of those variables.
 * Undefined when nothing says (the C or POSIX locale counts as nothing), so Chrome keeps its own.
 */
export function systemLocale(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  appleLocale: () => string | undefined = readAppleLocale,
): string | undefined {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const tag = posixTag(env[name]);
    if (tag) return tag;
  }
  if (platform === "darwin") return posixTag(appleLocale());
  if (platform === "win32") return canonical(Intl.DateTimeFormat().resolvedOptions().locale);
  return undefined;
}

/** `es_MX.UTF-8` as `es-MX`; undefined for C, POSIX or anything that is not a language tag. */
function posixTag(value: string | undefined): string | undefined {
  const base = value?.trim().split(/[.@]/)[0];
  if (!base || base === "C" || base === "POSIX") return undefined;
  return canonical(base.replace(/_/g, "-"));
}

function canonical(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  try {
    const [c] = Intl.getCanonicalLocales(tag);
    return c && c !== "und" ? c : undefined;
  } catch {
    return undefined;
  }
}

function readAppleLocale(): string | undefined {
  try {
    return execFileSync("/usr/bin/defaults", ["read", "-g", "AppleLocale"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
