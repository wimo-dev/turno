import type { Locator, Page } from "patchright-core";
import { describe, expect, it } from "vitest";
import { HUMANIZED_TOOLS, HumanInput, adaptiveSites, humanizeTools } from "../src/human-input.js";
import type { HumanizeLevel } from "../src/humanize.js";
import { recordChallenge } from "../src/reputation.js";
import type { UpstreamTool } from "../src/upstream.js";
import { sandbox } from "./helpers/sandbox.js";

/**
 * The playing half of human-like input, on fake pages: what reaches page.mouse, page.keyboard
 * and the locator for each level, with a fake clock so the waits cost nothing.
 */

type Call = [string, ...unknown[]];

class FakePage {
  log: Call[] = [];
  href = "https://example.com/";
  mouse = {
    move: async (x: number, y: number) => void this.log.push(["move", x, y]),
    click: async (x: number, y: number, o?: unknown) => void this.log.push(["mouse.click", x, y, o]),
    wheel: async (dx: number, dy: number) => void this.log.push(["wheel", dx, dy]),
    down: async () => void this.log.push(["down"]),
    up: async () => void this.log.push(["up"]),
  };
  keyboard = {
    press: async (key: string, o?: { delay?: number }) => void this.log.push(["press", key, o?.delay]),
    insertText: async (text: string) => void this.log.push(["insertText", text]),
    type: async (text: string) => void this.log.push(["type", text]),
  };
  url() {
    return this.href;
  }
  viewportSize() {
    return { width: 1000, height: 800 };
  }
  moves() {
    return this.log.filter((c) => c[0] === "move").map((c) => ({ x: c[1] as number, y: c[2] as number }));
  }
}

interface FieldState {
  text: boolean;
  focused: boolean;
  empty: boolean;
}

class FakeLocator {
  calls: Call[] = [];
  box: { x: number; y: number; width: number; height: number } | null = { x: 400, y: 300, width: 120, height: 40 };
  field: FieldState = { text: true, focused: false, empty: true };
  failBox = false;
  constructor(private readonly page: FakePage) {}
  async boundingBox() {
    if (this.failBox) throw new Error("Timeout 1000ms exceeded");
    return this.box;
  }
  async scrollIntoViewIfNeeded() {}
  async evaluate(fn: (el: unknown) => unknown) {
    if (fn.name === "fieldState") return this.field;
    if (fn.name === "isFocused") return true;
    throw new Error(`unexpected evaluate ${fn.name}`);
  }
  async click(o?: unknown) {
    this.calls.push(["click", o]);
    this.page.log.push(["locator.click"]);
  }
  async dblclick(o?: unknown) {
    this.calls.push(["dblclick", o]);
  }
  async hover(o?: unknown) {
    this.calls.push(["hover", o]);
  }
  async fill(v: string, o?: unknown) {
    this.calls.push(["fill", v, o]);
  }
  async pressSequentially(v: string, o?: unknown) {
    this.calls.push(["pressSequentially", v, o]);
  }
  async press(k: string, o?: unknown) {
    this.calls.push(["press", k, o]);
  }
  async setChecked(c: boolean, o?: unknown) {
    this.calls.push(["setChecked", c, o]);
  }
  async selectOption(v: unknown, o?: unknown) {
    this.calls.push(["selectOption", v, o]);
    return [];
  }
  async dragTo(t: unknown, o?: unknown) {
    this.calls.push(["dragTo", t, o]);
  }
}

/** Upstream's tab, with a private field like the real class, so a wrong `this` would throw. */
class FakeTab {
  #completions = 0;
  constructor(
    readonly page: FakePage,
    readonly locators: FakeLocator[],
  ) {}
  async targetLocator(_params: unknown) {
    return { locator: this.locators[0], selector: "#target", resolved: "locator('#target')" };
  }
  async targetLocators(params: unknown[]) {
    return params.map((_, i) => ({ locator: this.locators[i], selector: `#t${i}`, resolved: "" }));
  }
  async waitForCompletion(cb: () => Promise<void>) {
    this.#completions++;
    return await cb();
  }
  get completions() {
    return this.#completions;
  }
}

function setup(level: HumanizeLevel, seed = 1) {
  let t = 0;
  const sleeps: number[] = [];
  const page = new FakePage();
  const locator = new FakeLocator(page);
  const input = new HumanInput(
    { level, seed },
    {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    },
  );
  const wrapped = input.wrapLocator(locator as unknown as Locator, page as unknown as Page);
  return { page, locator, input, wrapped, sleeps, elapsed: () => t };
}

const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) =>
  p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

describe("humanizeTools", () => {
  it("wraps only the input tools, keeps every schema object, and runs upstream's handler on a humanized tab", async () => {
    const page = new FakePage();
    const locator = new FakeLocator(page);
    const tab = new FakeTab(page, [locator]);
    const clickHandle = async (context: { ensureTab(): Promise<FakeTab> }, params: unknown) => {
      const t = await context.ensureTab();
      const { locator: l } = await t.targetLocator(params);
      await t.waitForCompletion(async () => await l!.click({ timeout: 5000 }));
    };
    const snapshotHandle = async () => {};
    const tools = [
      { capability: "core", schema: { name: "browser_click" }, handle: clickHandle },
      { capability: "core", schema: { name: "browser_snapshot" }, handle: snapshotHandle },
    ] as unknown as UpstreamTool[];
    let t = 0;
    const input = new HumanInput({ level: "light", seed: 3 }, { now: () => t, sleep: async (ms) => void (t += ms) });
    const out = humanizeTools(tools, input);
    expect(out[1]).toBe(tools[0 + 1]);
    expect(out[0]).not.toBe(tools[0]);
    expect(out[0]!.schema).toBe(tools[0]!.schema);
    const context = { ensureTab: async () => tab, other: () => "kept" };
    await (out[0] as unknown as { handle: (c: object, p: unknown) => Promise<void> }).handle(context, {
      target: "e1",
    });
    expect(tab.completions).toBe(1);
    expect(page.moves().length).toBeGreaterThan(5);
    const [, options] = locator.calls[0] as [string, { timeout: number; position: object; delay: number }];
    expect(options.timeout).toBe(5000);
    expect(options.position).toBeDefined();
    expect(options.delay).toBeGreaterThanOrEqual(40);
  });

  it("covers the stock input tools, and nothing that only reads", () => {
    for (const name of ["browser_click", "browser_hover", "browser_type", "browser_drag", "browser_mouse_wheel"])
      expect(HUMANIZED_TOOLS.has(name)).toBe(true);
    for (const name of ["browser_snapshot", "browser_navigate", "browser_evaluate"])
      expect(HUMANIZED_TOOLS.has(name)).toBe(false);
  });
});

describe("a humanized click", () => {
  it("travels to a point inside the target, then clicks there with the button held", async () => {
    const { page, locator, wrapped } = setup("light");
    await wrapped.click({ timeout: 5000 });
    const moves = page.moves();
    expect(moves.length).toBeGreaterThan(5);
    const last = moves.at(-1)!;
    expect(inside(last, locator.box!)).toBe(true);
    const [, options] = locator.calls[0] as [string, { position: { x: number; y: number }; delay: number }];
    expect(options.position.x).toBeCloseTo(last.x - locator.box!.x, 6);
    expect(options.position.y).toBeCloseTo(last.y - locator.box!.y, 6);
    expect(options.delay).toBeGreaterThanOrEqual(40);
    expect(options.delay).toBeLessThanOrEqual(90);
    expect(page.log.at(-1)).toEqual(["locator.click"]);
  });

  it("starts the next move where the pointer was, on the same page", async () => {
    const { page, locator, wrapped, input } = setup("light");
    await wrapped.click();
    const end = input.pointerOf(page as unknown as Page)!;
    const before = page.moves().length;
    locator.box = { x: 50, y: 60, width: 80, height: 30 };
    await wrapped.click();
    const first = page.moves()[before]!;
    expect(Math.hypot(first.x - end.x, first.y - end.y)).toBeLessThan(60);
    expect(inside(page.moves().at(-1)!, locator.box)).toBe(true);
  });

  it("falls back to Playwright's own click when the element cannot be aimed at", async () => {
    const { page, locator, wrapped } = setup("full");
    locator.failBox = true;
    await wrapped.click({ timeout: 5000 });
    expect(locator.calls).toEqual([["click", { timeout: 5000 }]]);
    expect(page.moves()).toEqual([]);
  });

  it("at level off, only moves the click off the exact center, with no pause and no pointer path", async () => {
    const { page, locator, wrapped, sleeps } = setup("off");
    await wrapped.click({ timeout: 1 });
    await wrapped.fill("abc");
    const [click, fill] = locator.calls;
    expect(fill).toEqual(["fill", "abc", undefined]);
    const { position, ...rest } = click![1] as { position: { x: number; y: number } };
    expect(rest).toEqual({ timeout: 1 });
    // Inside the 120x40 box's inner 60 percent, and not its center.
    expect(position.x).toBeGreaterThanOrEqual(24);
    expect(position.x).toBeLessThanOrEqual(96);
    expect(position.y).toBeGreaterThanOrEqual(10);
    expect(position.y).toBeLessThanOrEqual(30);
    expect(position).not.toEqual({ x: 60, y: 20 });
    expect(page.log).toEqual([["locator.click"]]);
    expect(sleeps).toEqual([]);
  });

  it("pauses to read a page the first time it acts on it with full, and not again on the same URL", async () => {
    const { wrapped, sleeps, page } = setup("full");
    await wrapped.click();
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    const count = sleeps.length;
    await wrapped.hover();
    expect(sleeps[count]).toBeLessThan(250);
    page.href = "https://example.com/next";
    const again = sleeps.length;
    await wrapped.click();
    expect(sleeps[again]).toBeGreaterThanOrEqual(250);
  });
});

describe("humanized typing", () => {
  it("clicks into an empty field and types each key with a delay", async () => {
    const { page, locator, wrapped, sleeps } = setup("light");
    await wrapped.fill("hi you");
    expect(locator.calls[0]![0]).toBe("click");
    expect(locator.calls.some((c) => c[0] === "fill")).toBe(false);
    const keys = page.log.filter((c) => c[0] === "press").map((c) => c[1]);
    expect(keys).toEqual(["h", "i", " ", "y", "o", "u"]);
    for (const c of page.log.filter((x) => x[0] === "press")) expect(c[2]).toBeGreaterThanOrEqual(30);
    expect(sleeps.length).toBeGreaterThan(6);
  });

  it("replaces what a focused field holds, like fill, and clears it for an empty value", async () => {
    const { page, locator, wrapped } = setup("light");
    locator.field = { text: true, focused: true, empty: false };
    await wrapped.fill("ok");
    expect(locator.calls).toEqual([]);
    expect(page.log.filter((c) => c[0] === "press").map((c) => c[1])).toEqual(["ControlOrMeta+a", "o", "k"]);
    page.log = [];
    await wrapped.fill("");
    expect(page.log.map((c) => c[1])).toEqual(["ControlOrMeta+a", "Backspace"]);
  });

  it("commits characters that have no key as text, and Enter for a newline", async () => {
    const { page, locator, wrapped } = setup("light");
    locator.field = { text: true, focused: true, empty: true };
    await wrapped.fill("añ\nb");
    expect(page.log.map((c) => c.slice(0, 2))).toEqual([
      ["press", "a"],
      ["insertText", "ñ"],
      ["press", "Enter"],
      ["press", "b"],
    ]);
  });

  it("pastes long text and fills fields that are not text, as Playwright does", async () => {
    const { page, locator, wrapped } = setup("full");
    const long = "x".repeat(81);
    await wrapped.fill(long);
    locator.field = { text: false, focused: false, empty: true };
    await wrapped.fill("2026-11-18");
    expect(locator.calls).toEqual([
      ["fill", long, undefined],
      ["fill", "2026-11-18", undefined],
    ]);
    expect(page.log).toEqual([]);
  });

  it("holds Enter and other keys down for a moment", async () => {
    const { locator, wrapped } = setup("light");
    await wrapped.press("Enter", { timeout: 5000 });
    const [, key, options] = locator.calls[0] as [string, string, { delay: number; timeout: number }];
    expect(key).toBe("Enter");
    expect(options.timeout).toBe(5000);
    expect(options.delay).toBeGreaterThanOrEqual(30);
  });
});

describe("drag, check and the mouse tools", () => {
  it("drags with the button down along a path to a point inside the target", async () => {
    const { page, input } = setup("light");
    const source = new FakeLocator(page);
    const target = new FakeLocator(page);
    target.box = { x: 700, y: 500, width: 60, height: 60 };
    const s = input.wrapLocator(source as unknown as Locator, page as unknown as Page);
    const t = input.wrapLocator(target as unknown as Locator, page as unknown as Page);
    await s.dragTo(t);
    const kinds = page.log.map((c) => c[0]);
    const down = kinds.indexOf("down");
    const up = kinds.indexOf("up");
    expect(down).toBeGreaterThan(3);
    expect(kinds.slice(down + 1, up).filter((k) => k === "move").length).toBeGreaterThan(5);
    expect(inside(page.moves().at(-1)!, target.box)).toBe(true);
    expect(source.calls).toEqual([]);
  });

  it("checks a box at the point the pointer travelled to", async () => {
    const { page, locator, wrapped } = setup("light");
    await wrapped.setChecked(true, { timeout: 5000 });
    const [, checked, options] = locator.calls[0] as [string, boolean, { position: { x: number } }];
    expect(checked).toBe(true);
    expect(options.position.x + locator.box!.x).toBeCloseTo(page.moves().at(-1)!.x, 6);
  });

  it("scrolls the wheel in notches with full, and in one event with light", async () => {
    for (const [level, events] of [
      ["full", 6],
      ["light", 1],
    ] as const) {
      const page = new FakePage();
      const locator = new FakeLocator(page);
      let t = 0;
      const input = new HumanInput({ level, seed: 2 }, { now: () => t, sleep: async (ms) => void (t += ms) });
      const tab = input.wrapTab(new FakeTab(page, [locator]));
      await tab.page.mouse.wheel(0, 600);
      const wheels = page.log.filter((c) => c[0] === "wheel");
      expect(wheels).toHaveLength(events);
      expect(wheels.reduce((sum, c) => sum + (c[2] as number), 0)).toBe(600);
      // The coordinate click travels there first.
      page.log = [];
      await tab.page.mouse.click(300, 200);
      expect(page.moves().length).toBeGreaterThan(3);
      expect(page.log.at(-1)?.[0]).toBe("mouse.click");
    }
  });
});

describe("adaptive", () => {
  it("is light until the site showed a challenge, then full there only", () => {
    const { page, input } = setup("adaptive");
    const p = page as unknown as Page;
    expect(input.levelFor(p)).toBe("light");
    input.noteChallenge("example.com");
    expect(input.levelFor(p)).toBe("full");
    page.href = "https://other.example/";
    expect(input.levelFor(p)).toBe("light");
    page.href = "about:blank";
    expect(input.levelFor(p)).toBe("light");
  });

  it("starts at full on the sites of the last 30 days of the reputation log", () => {
    const sb = sandbox();
    try {
      const now = Date.parse("2026-11-18T12:00:00Z");
      recordChallenge(
        "work",
        sb.env,
        { site: "old.example", kind: "verify", markers: [] },
        new Date(now - 40 * 86_400_000),
      );
      recordChallenge(
        "work",
        sb.env,
        { site: "shop.example", kind: "captcha", markers: [] },
        new Date(now - 86_400_000),
      );
      expect(adaptiveSites("work", sb.env, now)).toEqual(["shop.example"]);
      expect(adaptiveSites("nobody", sb.env, now)).toEqual([]);
      const input = new HumanInput({ level: "adaptive", seed: 1 }, { challenged: adaptiveSites("work", sb.env, now) });
      expect(input.levelFor({ url: () => "https://shop.example/cart" } as unknown as Page)).toBe("full");
    } finally {
      sb.cleanup();
    }
  });
});
