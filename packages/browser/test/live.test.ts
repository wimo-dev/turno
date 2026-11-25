import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_WAIT_MS,
  PauseGate,
  describeChanges,
  handBackWhenIdle,
  formatPause,
  resolveLive,
  resumeNote,
  timeoutMessage,
  viewRefusal,
} from "../src/live.js";

/** The live view's pause gate and notes, without a browser or a server. */

describe("resolveLive", () => {
  it("is on by default (and with auto), and a flag wins over identity.json", () => {
    expect(resolveLive(undefined)).toEqual({ enabled: true, waitMs: DEFAULT_LIVE_WAIT_MS });
    expect(resolveLive({ enabled: "auto" })).toEqual({ enabled: true, waitMs: DEFAULT_LIVE_WAIT_MS });
    expect(resolveLive({ enabled: false })).toEqual({ enabled: false, waitMs: DEFAULT_LIVE_WAIT_MS });
    expect(resolveLive({ enabled: true, wait: "30s" })).toEqual({ enabled: true, waitMs: 30_000 });
    expect(resolveLive({ enabled: false, wait: "30s" }, { live: true, waitMs: 5_000 })).toEqual({
      enabled: true,
      waitMs: 5_000,
    });
  });
});

describe("PauseGate", () => {
  it("lets a call through at once when there is no pause", async () => {
    expect(await new PauseGate().wait(10)).toEqual({ kind: "open" });
  });

  it("holds a call until resume, with the tabs from the start of the pause and the input count", async () => {
    let now = 1_000;
    const gate = new PauseGate(() => now);
    expect(gate.start("the live view", Promise.resolve([{ id: 1, url: "https://a.example/", title: "A" }]))).toBe(true);
    expect(gate.start("again")).toBe(false);
    const held = gate.wait(60_000);
    await Promise.resolve();
    expect(gate.held).toBe(1);
    gate.noteInput();
    gate.noteInput();
    now = 66_000;
    expect(gate.resume()).toBe(true);
    expect(await held).toEqual({
      kind: "resumed",
      pausedMs: 65_000,
      by: "the live view",
      step: false,
      before: [{ id: 1, url: "https://a.example/", title: "A" }],
      inputs: 2,
      pageInputs: 0,
      auto: false,
    });
    expect(gate.held).toBe(0);
    expect(gate.paused).toBeUndefined();
    expect(gate.resume()).toBe(false);
  });

  it("holds the agent while the person keeps using the browser, and hands back once they stop", async () => {
    let now = 0;
    const gate = new PauseGate(() => now);
    const owner = { gate, resume: () => gate.resume() };
    gate.start("the person's input in the browser window", Promise.resolve([]), { idleMs: 5_000 });
    const since = gate.paused!.since;
    // What the page reports, once: the reader hands each input out a single time.
    let pending: { at: number; count: number } | undefined;
    const activity = async () => {
      const p = pending;
      pending = undefined;
      return p;
    };
    const back = handBackWhenIdle(owner, since, activity, { pollMs: 1, now: () => now });
    const held = gate.wait(60_000);
    let settled = false;
    void held.then(() => {
      settled = true;
    });
    // Input in the page every 2 s for 10 s: the call stays held all along.
    for (let at = 2_000; at <= 10_000; at += 2_000) {
      now = at;
      pending = { at, count: 1 };
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);
    }
    now = 12_000;
    gate.noteInput(); // the live view too
    now = 16_900;
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    now = 17_000;
    await back;
    expect(await held).toMatchObject({ kind: "resumed", auto: true, inputs: 1, pageInputs: 5 });
  });

  it("keeps an automatic pause once the person presses Pause", async () => {
    let now = 0;
    const gate = new PauseGate(() => now);
    gate.start("the live view", Promise.resolve([]), { idleMs: 1_000 });
    const back = handBackWhenIdle({ gate, resume: () => gate.resume() }, gate.paused!.since, undefined, {
      pollMs: 1,
      now: () => now,
    });
    expect(gate.keep()).toBe(true);
    now = 60_000;
    await back;
    expect(gate.paused).toMatchObject({ by: "the live view" });
    expect(gate.paused?.idleMs).toBeUndefined();
  });

  it("gives up after the wait, still paused, and stops waiting when the call is cancelled", async () => {
    const gate = new PauseGate();
    gate.start("turno browser pause");
    const out = await gate.wait(20);
    expect(out.kind).toBe("timeout");
    expect(gate.paused?.by).toBe("turno browser pause");
    const abort = new AbortController();
    const held = gate.wait(60_000, abort.signal);
    abort.abort();
    expect(await held).toEqual({ kind: "aborted" });
    expect(gate.held).toBe(0);
  });

  it("releases every held call at once", async () => {
    const gate = new PauseGate();
    gate.start("the live view");
    const calls = [gate.wait(60_000), gate.wait(60_000), gate.wait(60_000)];
    await Promise.resolve();
    expect(gate.held).toBe(3);
    gate.resume();
    expect((await Promise.all(calls)).map((c) => c.kind)).toEqual(["resumed", "resumed", "resumed"]);
  });
});

describe("describeChanges", () => {
  const a = { id: 1, url: "https://a.example/login", title: "Sign in" };
  const b = { id: 2, url: "https://b.example/", title: "B" };

  it("says nothing changed when the tabs are the same", () => {
    expect(describeChanges([a, b], [a, b], 1, 1, 0)).toEqual({ changed: false, lines: [] });
  });

  it("names the current tab's new URL and title, new and closed tabs, and input from the view", () => {
    const signedIn = { id: 1, url: "https://a.example/home", title: "Home" };
    const c = { id: 3, url: "https://c.example/", title: "C" };
    const out = describeChanges([a, b], [signedIn, c], 1, 1, 3);
    expect(out.changed).toBe(true);
    expect(out.lines).toEqual([
      "Current tab: https://a.example/login -> https://a.example/home",
      'Title: "Sign in" -> "Home"',
      "New tab: https://c.example/",
      "Closed tab: https://b.example/",
      "The user clicked, typed or scrolled 3 times through the live view.",
    ]);
  });

  it("says when the current tab is another one, and when another tab moved", () => {
    const moved = { ...b, url: "https://b.example/next" };
    expect(describeChanges([a, b], [a, moved], 1, 2, 0).lines).toEqual([
      'Current tab is now another tab: https://b.example/next ("B")',
    ]);
    expect(describeChanges([a, b], [a, moved], 1, 1, 0).lines).toEqual([
      "Another tab: https://b.example/ -> https://b.example/next",
    ]);
  });

  it("counts input alone as a change", () => {
    expect(describeChanges([a], [a], 1, 1, 1).changed).toBe(true);
  });
});

describe("notes", () => {
  it("formats a pause", () => {
    expect(formatPause(9_000)).toBe("9s");
    expect(formatPause(65_000)).toBe("1m 05s");
  });

  it("says whether the held call ran, and why not", () => {
    const base = { pausedMs: 65_000, by: "the live view", tool: "browser_click" };
    expect(resumeNote({ ...base, lines: [], ran: true })).toBe(
      [
        "### Paused by the user",
        "The user paused this browser (the live view) for 1m 05s and has resumed it.",
        "Nothing changed in the browser's tabs (same tabs, URLs and titles).",
        "Your browser_click call ran after the resume; its result follows.",
      ].join("\n"),
    );
    const notRun = resumeNote({ ...base, lines: ["New tab: https://c.example/"], ran: false, recordingFlow: true });
    expect(notRun).toContain("While you waited:\n- New tab: https://c.example/");
    expect(notRun).toContain("Your browser_click call was not run: the browser changed while you waited");
    expect(notRun).toContain("A fresh snapshot follows");
    expect(notRun).toContain("The flow you are recording does not have what the user did.");
    expect(resumeNote({ ...base, lines: ["x"], ran: false, noBrowser: true })).toContain(
      "The browser is not running now",
    );
  });

  it("tells a timed out call that the user still has the browser", () => {
    expect(timeoutMessage("work", "browser_navigate", 130_000, "the live view", 120_000)).toBe(
      'The user paused browser identity "work" 2m 10s ago (the live view) and has not resumed it within 2m 00s, so browser_navigate was not run. The user is probably acting in the browser: wait, or ask them to resume (Resume in the live view, or turno-browser resume work), then call again.',
    );
  });

  it("refuses the view in read mode, attach mode and Camoufox, and only there", () => {
    expect(viewRefusal("lightpanda")).toMatch(
      /^Read mode \(Lightpanda\) renders no pixels.*Pause and resume still work\.$/,
    );
    expect(viewRefusal("attach")).toMatch(/^Attach mode drives your own Chrome, which you already see/);
    expect(viewRefusal("camoufox")).toMatch(
      /^The view is a Chrome DevTools Protocol screencast, and Camoufox is a Firefox build that has none.*Pause and resume still work\.$/,
    );
    expect(viewRefusal("chrome")).toBeUndefined();
    expect(viewRefusal(undefined)).toBeUndefined();
  });
});
