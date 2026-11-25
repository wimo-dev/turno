import type { EffectiveSettings } from "./defaults.js";
import type { HumanizeLevel, HumanizeSettings } from "./humanize.js";
import { DEFAULT_CACHE_BYTES, type ResourcePolicy } from "./resources.js";
import type { CursorMode, IdentitySettings, ResourceMode } from "./settings.js";
import type { SharingMode } from "./sharing.js";
import type { TabLockPolicy } from "./tab-locks.js";
import { parseDuration, parseSize } from "./units.js";

/**
 * How the host runs one session's Chrome: the tab governor, background tab
 * throttling, the wait after each action, and resource blocking and caching. Each value comes from, in order of precedence, a `turno-browser-mcp` flag, the
 * identity's identity.json, the low-resource preset when it is on (`LOW_RESOURCES`), then the
 * defaults below and those `defaults.ts` resolves for the launch (background throttling in a
 * headless Chrome nobody watches, the preset under memory pressure, humanize and sharing).
 * identity.json is read at every launch, like the rest of it.
 */

export interface TabPolicy {
  /** Most pages open at once; past it the least recently used page closes. 0: no cap. */
  max: number;
  /** Close a popup the agent did not open (`"close"`), or leave it (`"keep"`). */
  popups: "close" | "keep";
  /** A page unused this long is parked on about:blank; 0: never. */
  parkMs: number;
  /** A page unused this long is closed; 0: never. */
  closeMs: number;
}

export interface Tuning {
  tabs: TabPolicy;
  /**
   * False: Chrome runs every tab at full speed, as Playwright launches it (the default with a
   * window or the live view; headless without the live view it is true). True:
   * Chrome throttles the tabs that are not in front, and the host brings the agent's tab to the
   * front before each call (see `launchTuning`).
   */
  backgroundThrottling: boolean;
  /**
   * The wait after each action for the work it started (Playwright's `timeouts.settle`), from
   * identity.json `settle`; undefined keeps Playwright's (500 ms, or the user's own setting).
   */
  settleMs?: number;
  /** Opt-in resource blocking and cache, from identity.json `block` and `cache`. */
  resources: ResourcePolicy;
  /** Human-like input (`humanize.ts`), from `--humanize` or identity.json `humanize`; `auto` by default. */
  humanize: HumanizeSettings;
  /**
   * `"session"`: one backend serves every call, as mcpd's `exclusive = true` lets one session at
   * a time (the default in attach mode). `"tabs"` (the default): each agent session gets its own
   * tabs, with locks (`sharing.ts`).
   */
  sharing: SharingMode;
  /** With `"sharing": "tabs"`: the lock wait and idle release of identity.json `tabLocks`. */
  tabLocks: Partial<TabLockPolicy>;
  /** The agent cursor (`agent-cursor.ts`), from `--cursor` or identity.json `cursor`; `"auto"` by default. */
  cursor: CursorMode;
  /** True with the low-resource preset (`--resources low` or identity.json `resources`). */
  lowResources?: true;
  /**
   * Chrome's idle limit from the preset, which the host applies; undefined keeps the config's
   * (TURNO_BROWSER_IDLE, 15 minutes by default, or the user's own limit).
   */
  browserIdleMs?: number;
  /** Chrome features the preset turns off, added to the `--disable-features` list turno passes. */
  disabledFeatures?: readonly string[];
  /** `"coherent"` when identity.json or the default asks for the coherent user agent (`network.ts`). */
  userAgent?: "coherent";
  /** The locale Chrome launches with when identity.json sets one; else Chrome reads the system's. */
  locale?: string;
}

/** The defaults, documented on the browser identities page. */
export const DEFAULT_TABS: Readonly<TabPolicy> = Object.freeze({
  max: 8,
  popups: "close",
  parkMs: 5 * 60_000,
  closeMs: 15 * 60_000,
});

/**
 * The low-resource preset, `"resources": "low"`: for a machine that runs short of memory. Each
 * part was measured on a real Chrome (see the tabs page of the browser docs); what saved no
 * memory, or broke pages or the live view, was left out. A key set on its own in identity.json
 * or by a flag wins over the preset's value.
 */
export const LOW_RESOURCES = Object.freeze({
  tabs: Object.freeze({ max: 2, parkMs: 2 * 60_000 }),
  /** Chrome closes after this long without a tool call, unless the user set the idle limit. */
  browserIdleMs: 5 * 60_000,
  /** The background server exits after this long without a request, unless the user set it. */
  backgroundIdleMs: 5 * 60_000,
  /**
   * Chrome's back/forward cache keeps a page it navigated away from alive for minutes, so a
   * parked tab (sent to about:blank) kept its renderer and its memory; without it, parking
   * frees the page at once. The only cost is that going back reloads the page.
   */
  disabledFeatures: Object.freeze(["BackForwardCache"]),
});

/** What `turno-browser-mcp` flags set; each wins over identity.json. */
export interface TuningFlags {
  maxTabs?: number;
  popups?: "close" | "keep";
  parkAfterMs?: number;
  closeAfterMs?: number;
  backgroundThrottling?: boolean;
  humanize?: HumanizeLevel;
  sharing?: SharingMode;
  cursor?: CursorMode;
  resources?: ResourceMode;
  /**
   * The user set Chrome's idle limit (TURNO_BROWSER_IDLE, `--idle-timeout`,
   * PLAYWRIGHT_MCP_IDLE_TIMEOUT or a config of their own): the preset keeps it.
   */
  idleSet?: boolean;
}

/** True when the low-resource preset is asked for by name (`auto` decides at launch, `defaults.ts`). */
function lowResources(settings: Pick<IdentitySettings, "resources"> | undefined, flags: TuningFlags = {}): boolean {
  return (flags.resources ?? settings?.resources) === "low";
}

/** The background server's idle limit: the user's, else the preset's, else `fallback`. */
export function backgroundIdleMs(
  settings: Pick<IdentitySettings, "resources"> | undefined,
  flags: TuningFlags | undefined,
  user: number | undefined,
  fallback: number,
): number {
  return user ?? (lowResources(settings, flags ?? {}) ? LOW_RESOURCES.backgroundIdleMs : fallback);
}

/** The defaults of the launch that the tuning reads (`defaults.ts`). */
export type TuningDefaults = Pick<
  EffectiveSettings,
  "resources" | "backgroundThrottling" | "humanize" | "sharing" | "userAgent" | "locale"
>;

/**
 * The tuning of a session: flags, then identity.json, then the preset, then the defaults. The
 * flags and identity.json already went into `defaults`; without them (a caller with no launch
 * context) only what the flags and the file say counts, and the rest keeps its fixed default.
 */
export function resolveTuning(
  settings: IdentitySettings | undefined,
  flags: TuningFlags = {},
  defaults?: TuningDefaults,
): Tuning {
  const t = settings?.tabs;
  const ms = (v: string | undefined) => (v === undefined ? undefined : parseDuration(v));
  // No flag of turno's: Playwright's --timeout-settle is the flag, and it wins (configForSession).
  const settle = ms(settings?.settle);
  const low = (defaults ? defaults.resources.value === "low" : lowResources(settings, flags))
    ? LOW_RESOURCES
    : undefined;
  const level = flags.humanize ?? defaults?.humanize.value ?? settings?.humanize?.level ?? "auto";
  return {
    tabs: {
      max: flags.maxTabs ?? t?.max ?? low?.tabs.max ?? DEFAULT_TABS.max,
      popups: flags.popups ?? t?.popups ?? DEFAULT_TABS.popups,
      parkMs: flags.parkAfterMs ?? ms(t?.park) ?? low?.tabs.parkMs ?? DEFAULT_TABS.parkMs,
      closeMs: flags.closeAfterMs ?? ms(t?.close) ?? DEFAULT_TABS.closeMs,
    },
    backgroundThrottling:
      flags.backgroundThrottling ?? settings?.backgroundThrottling ?? defaults?.backgroundThrottling.value ?? false,
    ...(settle === undefined ? {} : { settleMs: settle }),
    resources: resourcePolicy(settings),
    humanize: {
      ...settings?.humanize,
      level,
    },
    sharing: flags.sharing ?? settings?.sharing ?? defaults?.sharing.value ?? "tabs",
    cursor: flags.cursor ?? settings?.cursor ?? "auto",
    tabLocks: {
      ...(settings?.tabLocks?.wait === undefined ? {} : { waitMs: ms(settings.tabLocks.wait)! }),
      ...(settings?.tabLocks?.release === undefined ? {} : { releaseMs: ms(settings.tabLocks.release)! }),
    },
    ...(low
      ? {
          lowResources: true as const,
          ...(flags.idleSet ? {} : { browserIdleMs: low.browserIdleMs }),
          disabledFeatures: low.disabledFeatures,
        }
      : {}),
    ...(defaults?.userAgent.value === "coherent" ? { userAgent: "coherent" as const } : {}),
    // Only identity.json's: the system's is the one Chrome reads itself (on macOS it maps es-MX to
    // es-419, say), so a flag with it would make a page see other languages than plain Chrome.
    ...(typeof defaults?.locale.value === "string" && defaults.locale.origin.from === "file"
      ? { locale: defaults.locale.value }
      : {}),
  };
}

function resourcePolicy(settings: IdentitySettings | undefined): ResourcePolicy {
  const out: ResourcePolicy = {};
  const b = settings?.block;
  if (b) out.block = { trackers: b.trackers ?? false, types: b.types ?? [], patterns: b.patterns ?? [] };
  if (settings?.cache)
    out.cacheBytes = settings.cache.maxSize
      ? (parseSize(settings.cache.maxSize) ?? DEFAULT_CACHE_BYTES)
      : DEFAULT_CACHE_BYTES;
  return out;
}

/**
 * The three switches Playwright adds to every Chromium launch so that pages in the background
 * keep running at full speed (`chromiumSwitches`, pinned by the contract test).
 */
export const BACKGROUND_SWITCHES = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
] as const;

/**
 * Launch options for `backgroundThrottling`. Dropping the switches is not enough: Playwright
 * also turns on focus emulation for every page (`Emulation.setFocusEmulationEnabled`), which
 * makes a page in the background report itself visible and run at full speed. `focusControl`
 * turns that off, so Chrome sees which tab is really in front (measured with Chrome 157: a busy
 * background tab drops from about 200 timer ticks and 120 animation frames a second to 1 and 0).
 */
export function launchTuning(tuning: Tuning): { ignoreDefaultArgs: string[]; contextOptions: Record<string, unknown> } {
  if (!tuning.backgroundThrottling) return { ignoreDefaultArgs: [], contextOptions: {} };
  return { ignoreDefaultArgs: [...BACKGROUND_SWITCHES], contextOptions: { focusControl: true } };
}
