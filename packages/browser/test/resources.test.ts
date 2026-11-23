import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceCache, blocker, freshness, storable } from "../src/resources.js";
import { expectMode } from "./helpers/sandbox.js";

describe("blocker", () => {
  const block = blocker({
    trackers: true,
    types: ["image"],
    patterns: ["ads.example", "*/promo/*", "cdn.example/banners/*"],
  });
  const u = (s: string) => new URL(s);

  it("blocks built-in tracker hosts and their subdomains, the listed types and the user's patterns", () => {
    expect(block(u("https://www.google-analytics.com/g/collect"), "fetch", false)).toBe("tracker");
    expect(block(u("https://securepubads.g.doubleclick.net/tag/js/gpt.js"), "script", false)).toBe("tracker");
    expect(block(u("https://shop.example/logo.png"), "image", false)).toBe("type image");
    expect(block(u("https://x.ads.example/a.js"), "script", false)).toBe("pattern");
    expect(block(u("https://shop.example/promo/a.js"), "script", false)).toBe("pattern");
    expect(block(u("http://cdn.example/banners/1.js"), "script", false)).toBe("pattern");
  });

  it("leaves the rest, and never blocks the page itself", () => {
    expect(block(u("https://shop.example/app.js"), "script", false)).toBeUndefined();
    expect(block(u("https://notads.example/app.js"), "script", false)).toBeUndefined();
    expect(block(u("https://doubleclick.net.shop.example/app.js"), "script", false)).toBeUndefined();
    expect(block(u("https://ads.example/"), "document", true)).toBeUndefined();
    expect(
      blocker({ trackers: false, types: [], patterns: [] })(u("https://www.google-analytics.com/"), "script", false),
    ).toBeUndefined();
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("reads max-age less Age, or Expires against Date", () => {
    expect(freshness({ "cache-control": "public, max-age=3600" }, now)).toBe(3_600_000);
    expect(freshness({ "cache-control": "max-age=3600", age: "600" }, now)).toBe(3_000_000);
    expect(freshness({ expires: "Wed, 18 Nov 2026 13:00:00 GMT", date: "Wed, 18 Nov 2026 12:00:00 GMT" }, now)).toBe(
      3_600_000,
    );
  });

  it("is undefined for no-store, no-cache, no lifetime or a stale response", () => {
    expect(freshness({ "cache-control": "no-store, max-age=3600" }, now)).toBeUndefined();
    expect(freshness({ "cache-control": "no-cache" }, now)).toBeUndefined();
    expect(freshness({}, now)).toBeUndefined();
    expect(freshness({ "cache-control": "max-age=60", age: "120" }, now)).toBeUndefined();
    expect(freshness({ "cache-control": "max-age=0" }, now)).toBeUndefined();
  });
});

describe("storable", () => {
  it("takes a 200 GET of a static type without Authorization, Set-Cookie or an unknown Vary", () => {
    expect(storable("GET", "font", 200, {}, { vary: "Accept-Encoding, Origin" })).toBe(true);
    expect(storable("POST", "font", 200, {}, {})).toBe(false);
    expect(storable("GET", "xhr", 200, {}, {})).toBe(false);
    expect(storable("GET", "image", 206, {}, {})).toBe(false);
    expect(storable("GET", "image", 200, { authorization: "Bearer x" }, {})).toBe(false);
    expect(storable("GET", "image", 200, {}, { "set-cookie": "a=b" })).toBe(false);
    expect(storable("GET", "image", 200, {}, { vary: "Cookie" })).toBe(false);
  });
});

describe("ResourceCache", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const meta = (url: string, expiresAt: number, origin?: string | null) => ({
    url,
    status: 200,
    headers: { "content-type": "image/png" },
    expiresAt,
    ...(origin === undefined ? {} : { origin }),
    size: 0,
  });

  it("stores private files, serves fresh entries, drops stale ones and keeps them across instances", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "turno-rc-")), "cache");
    let now = 1_000;
    const cache = new ResourceCache(dir, 1024 ** 2 * 10, () => now);
    expect(await cache.put(meta("https://a.example/1.png", 5_000), Buffer.from("one"))).toBe(true);
    expectMode(dir, 0o700);
    for (const f of readdirSync(dir)) expectMode(join(dir, f), 0o600);
    expect((await cache.get("https://a.example/1.png", undefined))?.body.toString()).toBe("one");

    const again = new ResourceCache(dir, 1024 ** 2 * 10, () => now);
    expect(again.size).toBe(3);
    expect((await again.get("https://a.example/1.png", undefined))?.body.toString()).toBe("one");
    now = 6_000;
    expect(await again.get("https://a.example/1.png", undefined)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("serves an entry that varies on Origin only to that origin", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "turno-rc-")), "cache");
    const cache = new ResourceCache(dir, 1024 ** 2 * 10, () => 0);
    await cache.put(meta("https://fonts.example/a.woff2", 10, "https://shop.example"), Buffer.from("font"));
    expect(await cache.get("https://fonts.example/a.woff2", "https://shop.example")).toBeDefined();
    expect(await cache.get("https://fonts.example/a.woff2", "https://other.example")).toBeUndefined();
  });

  it("evicts the least recently used entries past the cap and skips entries over a tenth of it", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "turno-rc-")), "cache");
    let now = 0;
    const cap = 1000;
    const cache = new ResourceCache(dir, cap, () => now);
    const body = Buffer.alloc(100);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      now = n;
      await cache.put(meta(`https://a.example/${n}`, 1e9), body);
    }
    now = 20;
    await cache.get("https://a.example/1", undefined);
    now = 21;
    await cache.put(meta("https://a.example/11", 1e9), body);
    expect(cache.size).toBe(1000);
    expect(await cache.get("https://a.example/2", undefined)).toBeUndefined();
    expect(await cache.get("https://a.example/1", undefined)).toBeDefined();
    expect(await cache.put(meta("https://a.example/big", 1e9), Buffer.alloc(101))).toBe(false);
  });
});
