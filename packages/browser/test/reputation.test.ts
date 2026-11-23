import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity } from "../src/identities.js";
import {
  readChallenges,
  recordChallenge,
  reputationPath,
  reputationReport,
  summarizeChallenges,
  watchChallenges,
} from "../src/reputation.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

/**
 * The reputation log: one JSON line per challenge a page of an identity showed (captcha,
 * verify it's you, block), with the site's host name only. No URL path, no page content.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const NOW = new Date("2026-11-17T16:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("reputation log", () => {
  it("appends one line per challenge under the identity's state folder, mode 600", () => {
    recordChallenge("school", sb.env, { site: "mail.example.com", kind: "captcha", markers: ["captcha"] }, daysAgo(1));
    recordChallenge("school", sb.env, { site: "mail.example.com", kind: "verify", markers: ["verify it's you"] }, NOW);
    const file = reputationPath("school", sb.env);
    expect(file).toBe(join(sb.home, ".local", "state", "turno", "browser", "identities", "school", "reputation.jsonl"));
    expectMode(file, 0o600);
    expect(
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { ts: daysAgo(1).toISOString(), site: "mail.example.com", kind: "captcha", markers: ["captcha"] },
      { ts: NOW.toISOString(), site: "mail.example.com", kind: "verify", markers: ["verify it's you"] },
    ]);
  });

  it("skips lines it cannot read instead of failing", () => {
    recordChallenge("school", sb.env, { site: "a.example", kind: "block", markers: ["access denied"] }, NOW);
    writeFileSync(
      reputationPath("school", sb.env),
      `not json\n${readFileSync(reputationPath("school", sb.env), "utf8")}{"ts":1}\n`,
    );
    expect(readChallenges("school", sb.env)).toEqual([
      { ts: NOW.toISOString(), site: "a.example", kind: "block", markers: ["access denied"] },
    ]);
  });

  it("counts per site and kind, with the trend of the last 7 days against the 7 before", () => {
    const at = (d: number, site: string, kind: "captcha" | "verify" | "block") => ({
      ts: daysAgo(d).toISOString(),
      site,
      kind,
      markers: [],
    });
    const sites = summarizeChallenges(
      [
        at(1, "a.example", "captcha"),
        at(2, "a.example", "captcha"),
        at(3, "a.example", "block"),
        at(9, "a.example", "captcha"),
        at(8, "b.example", "verify"),
        at(10, "b.example", "verify"),
        at(20, "c.example", "block"),
      ],
      NOW,
    );
    expect(sites).toEqual([
      {
        site: "a.example",
        total: 4,
        solved: 0,
        captcha: 3,
        verify: 0,
        block: 1,
        last7d: 3,
        prev7d: 1,
        trend: "up",
        lastSeen: daysAgo(1).toISOString(),
      },
      {
        site: "b.example",
        total: 2,
        solved: 0,
        captcha: 0,
        verify: 2,
        block: 0,
        last7d: 0,
        prev7d: 2,
        trend: "down",
        lastSeen: daysAgo(8).toISOString(),
      },
      {
        site: "c.example",
        total: 1,
        solved: 0,
        captcha: 0,
        verify: 0,
        block: 1,
        last7d: 0,
        prev7d: 0,
        trend: "flat",
        lastSeen: daysAgo(20).toISOString(),
      },
    ]);
  });

  it("reports every identity, or the ones asked for", () => {
    addIdentity("bank", sb.env);
    addIdentity("school", sb.env);
    recordChallenge("school", sb.env, { site: "a.example", kind: "captcha", markers: ["captcha"] }, daysAgo(1));
    const all = reputationReport(sb.env, undefined, NOW);
    expect(all.identities.map((i) => [i.id, i.total])).toEqual([
      ["bank", 0],
      ["school", 1],
    ]);
    expect(reputationReport(sb.env, ["school"], NOW).identities[0]).toMatchObject({
      id: "school",
      total: 1,
      sites: [{ site: "a.example", last7d: 1 }],
    });
    expect(() => reputationReport(sb.env, ["nope"], NOW)).toThrow(/identity "nope" does not exist/);
  });
});

/** A page that loads HTML at a URL, like a Playwright page for the watcher. */
class FakePage extends EventEmitter {
  constructor(
    public current: string,
    public html: string,
  ) {
    super();
  }
  url() {
    return this.current;
  }
  async content() {
    return this.html;
  }
  load(url: string, html: string) {
    this.current = url;
    this.html = html;
    this.emit("load");
  }
}

class FakeContext extends EventEmitter {
  constructor(public list: FakePage[] = []) {
    super();
  }
  pages() {
    return this.list;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>";

describe("watchChallenges", () => {
  it("checks every page load, existing and new pages, and reports the site and kind only", async () => {
    const first = new FakePage("about:blank", "");
    const ctx = new FakeContext([first]);
    const seen: unknown[] = [];
    let clock = NOW.getTime();
    watchChallenges(ctx, (c) => seen.push(c), { now: () => clock });
    first.load("https://shop.example.com/cart?token=secret", CHALLENGE);
    await settle();
    const popup = new FakePage("about:blank", "");
    ctx.emit("page", popup);
    popup.load("https://mail.example.com/", "<title>Inbox</title><body>Hello</body>");
    popup.load("data:text/html,captcha", "<title>captcha</title>");
    await settle();
    expect(seen).toEqual([
      { site: "shop.example.com", kind: "captcha", markers: ["checking your browser", "just a moment"] },
    ]);

    // The same site and kind again within a minute is one event (a reload loop).
    first.load("https://shop.example.com/", CHALLENGE);
    await settle();
    expect(seen).toHaveLength(1);
    clock += 61_000;
    first.load("https://shop.example.com/", CHALLENGE);
    await settle();
    expect(seen).toHaveLength(2);
  });

  it("hands each check to onCheck, also one the log counts once, with what it found", async () => {
    const page = new FakePage("about:blank", "");
    const ctx = new FakeContext([page]);
    const seen: unknown[] = [];
    const checks: Promise<unknown>[] = [];
    watchChallenges(ctx, (c) => seen.push(c), { onCheck: (p, found) => p === page && checks.push(found) });
    page.load("https://shop.example.com/", CHALLENGE);
    page.load("https://shop.example.com/", CHALLENGE);
    page.load("https://shop.example.com/", "<title>Cart</title><body>Your cart</body>");
    const found = await Promise.all(checks);
    expect(found.map((f) => (f as { kind?: string } | undefined)?.kind)).toEqual(["captcha", "captcha", undefined]);
    expect(seen).toHaveLength(1);
  });

  it("stops watching when asked, and survives a page that cannot be read", async () => {
    const page = new FakePage("about:blank", "");
    page.content = async () => {
      throw new Error("navigating");
    };
    const ctx = new FakeContext([page]);
    const seen: unknown[] = [];
    const stop = watchChallenges(ctx, (c) => seen.push(c));
    page.load("https://a.example/", CHALLENGE);
    await settle();
    expect(seen).toEqual([]);
    page.content = async () => CHALLENGE;
    stop();
    page.load("https://a.example/", CHALLENGE);
    await settle();
    expect(seen).toEqual([]);
  });
});
