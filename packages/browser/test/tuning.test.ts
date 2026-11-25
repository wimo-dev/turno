import { describe, expect, it } from "vitest";
import { extractTuning } from "../src/argv.js";
import {
  BACKGROUND_SWITCHES,
  DEFAULT_TABS,
  LOW_RESOURCES,
  backgroundIdleMs,
  launchTuning,
  resolveTuning,
} from "../src/tuning.js";
import { parseDuration, parseSize } from "../src/units.js";

const base = { created: "2026-11-18T00:00:00.000Z", updated: "2026-11-18T00:00:00.000Z" };

describe("resolveTuning", () => {
  it("uses the defaults without identity.json or flags: a cap of 8, popups closed, park at 5m, close at 15m, no throttling", () => {
    expect(resolveTuning(undefined)).toEqual({
      tabs: { max: 8, popups: "close", parkMs: 300_000, closeMs: 900_000 },
      backgroundThrottling: false,
      resources: {},
      humanize: { level: "auto" },
      sharing: "tabs",
      tabLocks: {},
      cursor: "auto",
    });
    expect(DEFAULT_TABS).toEqual({ max: 8, popups: "close", parkMs: 300_000, closeMs: 900_000 });
  });

  it("takes identity.json over the defaults and the flags over identity.json", () => {
    const settings = { ...base, version: 2, tabs: { max: 4, park: "2m", close: "0" }, backgroundThrottling: true };
    expect(resolveTuning(settings)).toEqual({
      tabs: { max: 4, popups: "close", parkMs: 120_000, closeMs: 0 },
      backgroundThrottling: true,
      resources: {},
      humanize: { level: "auto" },
      sharing: "tabs",
      tabLocks: {},
      cursor: "auto",
    });
    expect(
      resolveTuning(settings, { maxTabs: 0, popups: "keep", closeAfterMs: 60_000, backgroundThrottling: false }),
    ).toEqual({
      tabs: { max: 0, popups: "keep", parkMs: 120_000, closeMs: 60_000 },
      backgroundThrottling: false,
      resources: {},
      humanize: { level: "auto" },
      sharing: "tabs",
      tabLocks: {},
      cursor: "auto",
    });
  });

  it("takes --humanize over identity.json humanize, and keeps the seed", () => {
    expect(resolveTuning({ ...base, version: 4, humanize: { level: "full", seed: 7 } }).humanize).toEqual({
      level: "full",
      seed: 7,
    });
    expect(
      resolveTuning({ ...base, version: 4, humanize: { level: "full", seed: 7 } }, { humanize: "off" }).humanize,
    ).toEqual({ level: "off", seed: 7 });
    expect(resolveTuning(undefined, { humanize: "adaptive" }).humanize).toEqual({ level: "adaptive" });
  });

  it("takes the tab lock wait and idle release from identity.json, the defaults staying when unset", () => {
    expect(resolveTuning({ ...base, version: 9, tabLocks: { wait: "30s", release: "0" } }).tabLocks).toEqual({
      waitMs: 30_000,
      releaseMs: 0,
    });
    expect(resolveTuning({ ...base, version: 9, tabLocks: { release: "10m" } }).tabLocks).toEqual({
      releaseMs: 600_000,
    });
  });

  it("takes --sharing over identity.json sharing", () => {
    expect(resolveTuning({ ...base, version: 5, sharing: "tabs" }).sharing).toBe("tabs");
    expect(resolveTuning({ ...base, version: 5, sharing: "tabs" }, { sharing: "session" }).sharing).toBe("session");
    expect(resolveTuning(undefined, { sharing: "tabs" }).sharing).toBe("tabs");
    expect(extractTuning(["--sharing", "tabs", "--headless"])).toEqual({
      tuning: { sharing: "tabs" },
      rest: ["--headless"],
    });
    expect(() => extractTuning(["--sharing=all"])).toThrow(
      '--sharing must be "session" (one agent session at a time) or "tabs", not "all"',
    );
  });

  it("turns on blocking and the cache only when identity.json asks, with a 100MB cache by default", () => {
    expect(resolveTuning({ ...base, version: 2, settle: "100ms" }).settleMs).toBe(100);
    expect(resolveTuning({ ...base, version: 2, block: { trackers: true }, cache: {} }).resources).toEqual({
      block: { trackers: true, types: [], patterns: [] },
      cacheBytes: 100 * 1024 ** 2,
    });
    expect(
      resolveTuning({
        ...base,
        version: 2,
        block: { types: ["image"], patterns: ["ads.example"] },
        cache: { maxSize: "20MB" },
      }).resources,
    ).toEqual({
      block: { trackers: false, types: ["image"], patterns: ["ads.example"] },
      cacheBytes: 20 * 1024 ** 2,
    });
  });
});

describe("the low-resource preset", () => {
  const low = { ...base, version: 13, resources: "low" as const };

  it("applies with resources low: 2 tabs, parked after 2m, Chrome closed after 5m, the back/forward cache off", () => {
    const t = resolveTuning(low);
    expect(t.tabs).toEqual({ max: 2, popups: "close", parkMs: 120_000, closeMs: 900_000 });
    expect(t).toMatchObject({ lowResources: true, browserIdleMs: 300_000, disabledFeatures: ["BackForwardCache"] });
    expect(t.backgroundThrottling).toBe(false);
    expect(LOW_RESOURCES.tabs).toEqual({ max: 2, parkMs: 120_000 });
  });

  it("changes nothing with resources normal or without the key", () => {
    for (const settings of [undefined, { ...base, version: 13, resources: "normal" as const }]) {
      const t = resolveTuning(settings);
      expect(t.tabs).toEqual(DEFAULT_TABS);
      expect(t.lowResources).toBeUndefined();
      expect(t.browserIdleMs).toBeUndefined();
      expect(t.disabledFeatures).toBeUndefined();
    }
  });

  it("lets a key set on its own win over the preset: identity.json first, then the flags", () => {
    const own = { ...low, tabs: { max: 4, park: "0" } };
    expect(resolveTuning(own).tabs).toEqual({ max: 4, popups: "close", parkMs: 0, closeMs: 900_000 });
    expect(resolveTuning(own, { maxTabs: 1, parkAfterMs: 60_000 }).tabs).toMatchObject({ max: 1, parkMs: 60_000 });
    expect(resolveTuning({ ...low, backgroundThrottling: true }).backgroundThrottling).toBe(true);
  });

  it("keeps an idle limit the user set (TURNO_BROWSER_IDLE, --idle-timeout, a config of their own)", () => {
    const t = resolveTuning(low, { idleSet: true });
    expect(t.browserIdleMs).toBeUndefined();
    expect(t.tabs.max).toBe(2);
  });

  it("takes --resources over identity.json either way", () => {
    expect(resolveTuning(undefined, { resources: "low" }).tabs.max).toBe(2);
    expect(resolveTuning(low, { resources: "normal" }).tabs.max).toBe(8);
    expect(extractTuning(["--resources", "low", "--headless"])).toEqual({
      tuning: { resources: "low" },
      rest: ["--headless"],
    });
    expect(() => extractTuning(["--resources=tiny"])).toThrow(
      '--resources must be "normal" or "low" (the low-resource preset), not "tiny"',
    );
  });

  it("shortens the background server's idle limit to 5m unless the flag or the variable set it", () => {
    expect(backgroundIdleMs(low, undefined, undefined, 900_000)).toBe(300_000);
    expect(backgroundIdleMs(low, undefined, 1_800_000, 900_000)).toBe(1_800_000);
    expect(backgroundIdleMs(undefined, undefined, undefined, 900_000)).toBe(900_000);
    expect(backgroundIdleMs(undefined, { resources: "low" }, undefined, 900_000)).toBe(300_000);
  });
});

describe("launchTuning", () => {
  it("adds nothing by default, and drops Playwright's three switches plus focus emulation with backgroundThrottling", () => {
    expect(launchTuning(resolveTuning(undefined))).toEqual({ ignoreDefaultArgs: [], contextOptions: {} });
    expect(launchTuning(resolveTuning(undefined, { backgroundThrottling: true }))).toEqual({
      ignoreDefaultArgs: [
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
      contextOptions: { focusControl: true },
    });
    expect(BACKGROUND_SWITCHES).toHaveLength(3);
  });
});

describe("extractTuning", () => {
  it("takes turno's flags out of the Playwright MCP flags, in both spellings", () => {
    expect(
      extractTuning([
        "--headless",
        "--max-tabs",
        "4",
        "--popups=keep",
        "--park-after",
        "2m",
        "--close-after=0",
        "--background-throttling",
        "--caps",
        "pdf",
      ]),
    ).toEqual({
      tuning: { maxTabs: 4, popups: "keep", parkAfterMs: 120_000, closeAfterMs: 0, backgroundThrottling: true },
      rest: ["--headless", "--caps", "pdf"],
    });
    expect(extractTuning(["--headless"])).toEqual({ rest: ["--headless"] });
  });

  it("refuses a bad value with a message that names the flag", () => {
    expect(() => extractTuning(["--max-tabs", "many"])).toThrow(
      '--max-tabs must be a whole number from 0 (no cap) to 100, not "many"',
    );
    expect(() => extractTuning(["--max-tabs"])).toThrow("--max-tabs needs a value <n>");
    expect(() => extractTuning(["--popups", "--headless"])).toThrow("--popups needs a value <close|keep>");
    expect(() => extractTuning(["--popups", "block"])).toThrow('--popups must be "close" or "keep", not "block"');
    expect(() => extractTuning(["--park-after", "5 minutes"])).toThrow(
      '--park-after must be a duration like "5m", "90s" or "0" (off), not "5 minutes"',
    );
    expect(() => extractTuning(["--background-throttling=yes"])).toThrow("--background-throttling takes no value");
    expect(() => extractTuning(["--humanize", "max"])).toThrow(
      '--humanize must be off, light, full, adaptive, auto, not "max"',
    );
  });

  it("takes --humanize out, in both spellings", () => {
    expect(extractTuning(["--humanize", "light", "--headless"])).toEqual({
      tuning: { humanize: "light" },
      rest: ["--headless"],
    });
    expect(extractTuning(["--humanize=adaptive"])).toEqual({ tuning: { humanize: "adaptive" }, rest: [] });
  });
});

describe("units", () => {
  it("reads durations and sizes", () => {
    expect([
      parseDuration("250ms"),
      parseDuration("90s"),
      parseDuration("5m"),
      parseDuration("1h"),
      parseDuration("0"),
      parseDuration("5"),
    ]).toEqual([250, 90_000, 300_000, 3_600_000, 0, undefined]);
    expect([parseSize("100MB"), parseSize("512kb"), parseSize("1GB"), parseSize("12")]).toEqual([
      100 * 1024 ** 2,
      512 * 1024,
      1024 ** 3,
      undefined,
    ]);
  });
});
