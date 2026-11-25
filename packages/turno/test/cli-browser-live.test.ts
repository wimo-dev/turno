import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BrowserApi, type BrowserDeps, browserCommand } from "../src/cli/commands/browser.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `turno browser live|pause|resume` and `set --live`. identity.json goes through the real
 * turno-browser from the workspace against the sandbox HOME; the running server's live view is
 * a fake, so no server or browser starts and no link is opened.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

type LiveStatus = NonNullable<Awaited<ReturnType<BrowserApi["liveStatus"]>>>;

const real = async (): Promise<BrowserApi> => (await import("turno-browser")).api;
const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);
const LINK = "http://127.0.0.1:43210/?code=one-time-code-for-the-test";

function status(over: Partial<LiveStatus> = {}): LiveStatus {
  return {
    identity: "school",
    pid: 4242,
    port: 43210,
    started: "2026-11-19T06:00:00.000Z",
    paused: null,
    waiting: 0,
    busy: 0,
    wait: 120_000,
    browser: true,
    engine: "chrome",
    view: { available: true, headless: false },
    showing: 1,
    pinned: false,
    hidden: false,
    viewers: 0,
    stuck: null,
    tabs: [{ id: 1, url: "https://example.com/inbox", title: "Inbox" }],
    ...over,
  };
}

interface Fake {
  api: BrowserApi;
  opened: string[];
  calls: string[];
}

async function fake(current: LiveStatus | undefined): Promise<Fake> {
  const base = await real();
  const calls: string[] = [];
  let state = current;
  const api = {
    ...base,
    liveStatus: async () => {
      calls.push("status");
      return state;
    },
    livePause: async () => {
      calls.push("pause");
      state = { ...state!, paused: { since: new Date().toISOString(), by: "turno browser pause" } };
      return state;
    },
    liveResume: async () => {
      calls.push("resume");
      state = { ...state!, paused: null };
      return state;
    },
    liveLink: async () => {
      calls.push("link");
      return LINK;
    },
  } as BrowserApi;
  return { api, opened: [], calls };
}

async function browser(args: string[], f?: Fake) {
  const mod = f?.api ?? (await real());
  const deps: BrowserDeps = {
    load: async () => mod,
    interactive: () => false,
    confirm: async () => false,
    openUrl: async (url) => {
      f?.opened.push(url);
    },
  };
  const io = fakeIo(sb.env);
  const code = await browserCommand(deps)
    .run(args, io)
    .then(String, (e: Error) => e.message);
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

describe("turno browser set --live", () => {
  it("turns the live view on with a wait, refuses a bad wait as its flag, shows it, and turns it off", async () => {
    expect((await browser(["add", "school"])).code).toBe("0");
    expect((await browser(["set", "school", "--live", "true", "--live-wait", "90s"])).code).toBe("0");
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({
      version: 10,
      live: { enabled: true, wait: "90s" },
    });
    expect((await browser(["show", "school"])).out).toMatch(
      /live view\s+on \(turno browser live school\); a paused call waits up to 90s/,
    );
    expect((await browser(["set", "school", "--live-wait", "1s"])).code).toMatch(
      /^--live-wait must be a duration from "5s" to "30m"/,
    );
    expect((await browser(["set", "school", "--live", "maybe"])).code).toMatch(/--live must be true or false/);
    expect((await browser(["set", "school", "--no-live", "--live", "true"])).code).toMatch(/--no-live does not go/);
    expect((await browser(["set", "school", "--no-live"])).code).toBe("0");
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).live).toBeUndefined();
  });
});

describe("turno browser live, pause and resume", () => {
  it("says that no server runs, or how to turn the view on, when there is nothing to talk to", async () => {
    await browser(["add", "school"]);
    // On by default: without a server there is just nothing to talk to yet.
    expect((await browser(["pause", "school"])).code).toMatch(/^no turno-browser-mcp serves "school" right now/);
    await browser(["set", "school", "--live", "false"]);
    expect((await browser(["live", "school"])).code).toBe(
      'the live view is off for "school". Turn it on with turno browser set school --live true; it starts with the next turno-browser-mcp for this identity.',
    );
    expect((await browser(["live", "nobody"])).code).toMatch(/identity "nobody" does not exist/);
  });

  it("opens the view with a one-time link it never prints, and --no-open and --json leave it shut", async () => {
    await browser(["add", "school"]);
    const f = await fake(status());
    const out = await browser(["live", "school"], f);
    expect(out.code).toBe("0");
    expect(f.opened).toEqual([LINK]);
    expect(out.out).toMatch(/school\s+the agent is idle/);
    expect(out.out).toContain("Inbox");
    expect(`${out.out}\n${out.err}`).not.toContain("code=");
    expect(out.err).toContain("the link works once");

    const shut = await fake(status());
    expect((await browser(["live", "school", "--no-open"], shut)).code).toBe("0");
    expect(shut.opened).toEqual([]);
    expect(shut.calls).not.toContain("link");
    const json = await browser(["live", "school", "--json"], shut);
    expect(JSON.parse(json.out)).toMatchObject({ identity: "school", view: { available: true }, wait: 120_000 });
    expect(shut.opened).toEqual([]);
  });

  it("does not open a view in read mode or attach mode, and says why", async () => {
    await browser(["add", "school"]);
    const reason =
      "Read mode (Lightpanda) renders no pixels, so there is nothing to show. Pause and resume still work.";
    const f = await fake(status({ engine: "lightpanda", view: { available: false, reason, headless: true } }));
    const out = await browser(["live", "school"], f);
    expect(out.code).toBe("0");
    expect(out.out).toContain(reason);
    expect(f.opened).toEqual([]);
    expect(f.calls).not.toContain("link");
  });

  it("pauses and resumes, and says what the agent does meanwhile", async () => {
    await browser(["add", "school"]);
    const f = await fake(status());
    const paused = await browser(["pause", "school"], f);
    expect(paused.out).toBe(
      'paused "school": the agent\'s next call waits up to 2m for you. Act in the browser or the live view (turno browser live school), then: turno browser resume school',
    );
    expect((await browser(["live", "school", "--no-open"], f)).out).toMatch(/paused for \d+s \(turno browser pause\)/);
    expect((await browser(["resume", "school"], f)).out).toBe(
      'resumed "school": the agent\'s waiting calls go on, and each is told what changed.',
    );
    expect((await browser(["resume", "school"], f)).out).toBe('"school" was not paused.');
    expect(f.calls.filter((c) => c === "pause" || c === "resume")).toEqual(["pause", "resume", "resume"]);
  });
});
