import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearHealth,
  healthDue,
  healthPath,
  needsAuthMessage,
  readHealth,
  runHealthCheck,
  writeHealth,
} from "../src/health.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { slashes } from "./helpers/programs.js";

/**
 * Session health: a URL plus a text or selector that only a signed-in page shows. The check
 * runs in the identity's own browser; a page without the proof marks the identity NEEDS_AUTH.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const NOW = new Date("2026-11-17T16:00:00.000Z");

class TimeoutError extends Error {
  override name = "TimeoutError";
}

/** A browser context whose single page "shows" the given texts and selectors at a URL. */
function fakeContext(opts: { texts?: string[]; selectors?: string[]; gotoError?: Error }) {
  const log: string[] = [];
  const locator = (found: boolean, what: string) => ({
    first: () => locator(found, what),
    waitFor: async (o: { state?: string; timeout?: number }) => {
      log.push(`wait ${what} ${o.state}`);
      if (!found) throw new TimeoutError(`Timeout ${o.timeout}ms exceeded`);
    },
  });
  const context = {
    async newPage() {
      log.push("newPage");
      return {
        async goto(url: string, o: { waitUntil?: string }) {
          log.push(`goto ${url} ${o.waitUntil}`);
          if (opts.gotoError) throw opts.gotoError;
          return null;
        },
        getByText: (text: string) => locator((opts.texts ?? []).includes(text), `text:${text}`),
        locator: (sel: string) => locator((opts.selectors ?? []).includes(sel), `sel:${sel}`),
        async close() {
          log.push("close");
        },
      };
    },
  };
  return { context, log };
}

describe("runHealthCheck", () => {
  it("is ok when the signed-in text shows, and closes its page", async () => {
    const { context, log } = fakeContext({ texts: ["Inbox"] });
    const r = await runHealthCheck(context, { url: "https://mail.example.com/", text: "Inbox" }, { now: () => NOW });
    expect(r).toEqual({ status: "ok", url: "https://mail.example.com/", checkedAt: NOW.toISOString() });
    expect(log).toEqual([
      "newPage",
      "goto https://mail.example.com/ domcontentloaded",
      "wait text:Inbox visible",
      "close",
    ]);
  });

  it("marks NEEDS_AUTH when the text or the selector is missing", async () => {
    const { context } = fakeContext({ texts: ["Inbox"] });
    expect(
      await runHealthCheck(
        context,
        { url: "https://mail.example.com/", text: "Inbox", selector: "#avatar" },
        { now: () => NOW },
      ),
    ).toEqual({
      status: "needs_auth",
      url: "https://mail.example.com/",
      checkedAt: NOW.toISOString(),
      detail: "no element matched #avatar",
    });
    const missing = await runHealthCheck(
      fakeContext({}).context,
      { url: "https://mail.example.com/", text: "Inbox" },
      { now: () => NOW },
    );
    expect(missing).toMatchObject({ status: "needs_auth", detail: 'the page did not show "Inbox"' });
  });

  it("says error, not NEEDS_AUTH, when the page cannot load", async () => {
    const { context, log } = fakeContext({
      gotoError: new Error("net::ERR_INTERNET_DISCONNECTED at https://mail.example.com/\nCall log: ..."),
    });
    const r = await runHealthCheck(context, { url: "https://mail.example.com/", text: "Inbox" }, { now: () => NOW });
    expect(r).toEqual({
      status: "error",
      url: "https://mail.example.com/",
      checkedAt: NOW.toISOString(),
      detail: "could not load the page: net::ERR_INTERNET_DISCONNECTED at https://mail.example.com/",
    });
    expect(log.at(-1)).toBe("close");
  });
});

describe("health record", () => {
  const check = { url: "https://mail.example.com/", text: "Inbox" };

  it("is stored per identity and cleared after a login", () => {
    expect(readHealth("school", sb.env)).toBeUndefined();
    writeHealth("school", sb.env, { status: "needs_auth", url: check.url, checkedAt: NOW.toISOString(), detail: "x" });
    expect(slashes(healthPath("school", sb.env))).toMatch(/state\/turno\/browser\/identities\/school\/health\.json$/);
    expect(readHealth("school", sb.env)).toMatchObject({ status: "needs_auth" });
    clearHealth("school", sb.env);
    expect(readHealth("school", sb.env)).toBeUndefined();
  });

  it("is due when missing, failed, for another URL, or an ok older than 30 minutes", () => {
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(healthDue(undefined, check, NOW)).toBe(true);
    expect(healthDue({ status: "ok", url: check.url, checkedAt: at(10 * 60_000) }, check, NOW)).toBe(false);
    expect(healthDue({ status: "ok", url: check.url, checkedAt: at(31 * 60_000) }, check, NOW)).toBe(true);
    expect(healthDue({ status: "ok", url: "https://other.example/", checkedAt: at(1000) }, check, NOW)).toBe(true);
    expect(healthDue({ status: "error", url: check.url, checkedAt: at(1000) }, check, NOW)).toBe(true);
    expect(healthDue({ status: "needs_auth", url: check.url, checkedAt: at(1000) }, check, NOW)).toBe(true);
  });

  it("tells the agent exactly what to ask the user", () => {
    expect(
      needsAuthMessage("school", {
        status: "needs_auth",
        url: check.url,
        checkedAt: NOW.toISOString(),
        detail: 'the page did not show "Inbox"',
      }),
    ).toBe(
      `NEEDS_AUTH: browser identity "school" is not signed in: the page did not show "Inbox" at ${check.url} (checked ${NOW.toISOString()}). ` +
        "Ask the user to run `turno-browser login school`, sign in and close the window, then call this tool again.",
    );
  });
});
