import { randomInt } from "node:crypto";
import type { Locator, Page } from "patchright-core";
import {
  type ActionLevel,
  type Box,
  type HumanizeSettings,
  MAX_TYPED,
  type Persona,
  type Point,
  Rng,
  autoLevel,
  clickTiming,
  hashSeed,
  keyDelays,
  keyHold,
  personaFor,
  pickPoint,
  planMove,
  planWheel,
  readingPause,
} from "./humanize.js";
import { readChallenges } from "./reputation.js";
import type { UpstreamTool } from "./upstream.js";

/**
 * Human-like input, the playing half: plays the plans of `humanize.ts` on a page through
 * Playwright's own `page.mouse` and `page.keyboard`, so every event still goes through Chrome's
 * input pipeline (CDP `Input.*`, `isTrusted` events) and every action keeps Playwright's checks
 * (visible, stable, enabled, not covered).
 *
 * It works under the stock tools without changing them: `humanizeTools` gives each input tool
 * (click, hover, type, drag, select, fill form, press key and the coordinate tools) a view of
 * the tab whose locators, mouse and keyboard are humanized, and runs upstream's own handler on
 * it. The tool's schema, its result text and its errors stay upstream's, and `browser_batch`,
 * which runs the same tools, gets the same input.
 *
 * Whatever goes wrong before the action itself (an element that is not there yet, a page that
 * navigated) falls back to Playwright's own call, so the error the agent sees is upstream's.
 */

/** The stock tools whose input is humanized. */
export const HUMANIZED_TOOLS: ReadonlySet<string> = new Set([
  "browser_click",
  "browser_hover",
  "browser_drag",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_press_sequentially",
  "browser_mouse_move_xy",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_wheel",
]);

/**
 * How long the steps before an action wait for its element: past it, Playwright's own call runs
 * (a plain fill or click, without the human-like path). 1 second was too short on a busy machine,
 * where reading the field or aiming at it can take longer and the action quietly lost its
 * humanize; the wait only runs out when the element is missing, so a longer one costs little.
 */
const PREPARE_TIMEOUT_MS = 3000;

/** How long `offCenter` waits for the element's box: past it, the click runs as Playwright's own. */
const QUICK_BOX_MS = 100;

/** Below this many pixels a side, the center is the only point to aim at. */
const MIN_AIM_PX = 6;

/** A scroll longer than this is a jump (a person drags the scroll bar or presses End). */
const MAX_WHEEL_PX = 3000;

/** How far back the reputation log makes `adaptive` use `full` on a site. */
const ADAPTIVE_WINDOW_MS = 30 * 86_400_000;

/** The sites the identity met a challenge on in the last 30 days (the reputation log), for `adaptive`. */
export function adaptiveSites(id: string, env: NodeJS.ProcessEnv, now: number = Date.now()): string[] {
  try {
    const recent = readChallenges(id, env).filter((e) => now - Date.parse(e.ts) <= ADAPTIVE_WINDOW_MS);
    return [...new Set(recent.map((e) => e.site))];
  } catch {
    return [];
  }
}

export interface HumanInputOptions {
  /** A stable name for the persona (the identity id); without it the seed or a random one. */
  persona?: string;
  /** Sites (host names) where `adaptive` starts at `full`. */
  challenged?: Iterable<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Handle = (context: object, params: unknown, response: unknown, signal?: AbortSignal) => Promise<unknown>;

/** A stock tool with the handler upstream calls (`defineTabTool`). */
interface HandledTool extends UpstreamTool {
  handle: Handle;
}

type TargetResult = { locator: Locator; [key: string]: unknown };

/**
 * A view of `target` where the names in `overrides` are replaced. Every other method is bound
 * to the target itself, so private fields and `this` inside Playwright's classes keep working.
 */
export function overlay<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(t, prop, t) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True for a character Playwright's keyboard layout has a key for: printable ASCII. */
const onKeyboard = (ch: string) => ch.length === 1 && ch >= " " && ch <= "~";

/** What a type action needs to know about its element. Runs in the page. */
function fieldState(el: Element): { text: boolean; focused: boolean; empty: boolean } {
  const TEXT_TYPES = ["", "text", "search", "email", "password", "tel", "url", "number"];
  const active = document.activeElement;
  const focused = active === el || (active !== null && el.contains(active));
  if (el instanceof HTMLTextAreaElement) return { text: true, focused, empty: el.value === "" };
  if (el instanceof HTMLInputElement)
    return { text: TEXT_TYPES.includes(el.type.toLowerCase()), focused, empty: el.value === "" };
  if (el instanceof HTMLElement && el.isContentEditable)
    return { text: true, focused, empty: (el.textContent ?? "") === "" };
  return { text: false, focused, empty: true };
}

function isFocused(el: Element): boolean {
  const active = document.activeElement;
  return active === el || (active !== null && el.contains(active));
}

export class HumanInput {
  readonly persona: Persona;
  private readonly rng: Rng;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Where the pointer is on each page, so the next move starts there. */
  private readonly pointers = new WeakMap<Page, Point>();
  /** The URL each page had when it was last acted on, for the reading pause. */
  private readonly seen = new WeakMap<Page, string>();
  private readonly challenged: Set<string>;
  /** The real locator behind each humanized one (a drag's target). */
  private readonly originals = new WeakMap<object, Locator>();

  constructor(
    readonly settings: HumanizeSettings,
    options: HumanInputOptions = {},
  ) {
    const seed = settings.seed ?? randomInt(0, 2 ** 32);
    this.rng = new Rng(seed);
    this.persona = personaFor(settings.seed ?? (options.persona !== undefined ? hashSeed(options.persona) : seed));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.challenged = new Set(options.challenged ?? []);
  }

  /** A challenge page on this site: `adaptive` uses `full` there from now on. */
  noteChallenge(site: string): void {
    this.challenged.add(site);
  }

  /** The level of an action on this page; `readOnly` for a step that only looks (`auto`). */
  levelFor(page: Page, readOnly = false): ActionLevel {
    const { level } = this.settings;
    if (level === "auto") return autoLevel(page.url(), this.challenged, readOnly);
    if (level !== "adaptive") return level;
    try {
      return this.challenged.has(new URL(page.url()).hostname) ? "full" : "light";
    } catch {
      return "light";
    }
  }

  /** Where the pointer is on this page, if it moved there through this module. */
  pointerOf(page: Page): Point | undefined {
    return this.pointers.get(page);
  }

  /** Waits `ms`, or until the plan's clock catches up (each mouse event takes time of its own). */
  private async waitUntil(start: number, at: number): Promise<void> {
    const lag = at - (this.now() - start);
    if (lag > 0.5) await this.sleep(lag);
  }

  private async viewport(page: Page): Promise<{ width: number; height: number }> {
    const size = page.viewportSize();
    if (size) return size;
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  }

  /** Moves the pointer along a planned path to `to`. */
  async travel(page: Page, to: Point, targetWidth: number, level: "light" | "full"): Promise<void> {
    if (level === "full" && this.seen.get(page) !== page.url()) await this.sleep(readingPause(this.rng));
    this.seen.set(page, page.url());
    let from = this.pointers.get(page);
    if (!from) {
      // A page the pointer has not been on: it comes in from somewhere in the middle, never (0, 0).
      const vp = await this.viewport(page);
      from = { x: vp.width * this.rng.range(0.3, 0.7), y: vp.height * this.rng.range(0.3, 0.7) };
    }
    const steps = planMove(from, to, targetWidth, level, this.rng, this.persona);
    const start = this.now();
    let at = 0;
    for (const step of steps) {
      at += step.wait;
      await this.waitUntil(start, at);
      await page.mouse.move(step.x, step.y);
      this.pointers.set(page, { x: step.x, y: step.y });
    }
    this.pointers.set(page, to);
  }

  /** Scrolls the element into view in wheel notches, with the pointer over the page (`full`). */
  private async wheelIntoView(page: Page, locator: Locator): Promise<void> {
    const vp = await this.viewport(page);
    for (let round = 0; round < 3; round++) {
      const box = await locator.boundingBox({ timeout: PREPARE_TIMEOUT_MS });
      if (!box) return;
      const center = box.y + box.height / 2;
      if (center >= vp.height * 0.1 && center <= vp.height * 0.9) return;
      const dy = Math.round(center - vp.height * this.rng.range(0.35, 0.55));
      if (Math.abs(dy) > MAX_WHEEL_PX) return;
      if (!this.pointers.has(page)) await this.travel(page, this.inside(vp), 200, "full");
      const start = this.now();
      let at = 0;
      for (const step of planWheel(0, dy, this.rng)) {
        at += step.wait;
        await this.waitUntil(start, at);
        await page.mouse.wheel(step.dx, step.dy);
      }
      // Chrome animates a wheel scroll for about 150 ms.
      await this.sleep(200);
      const after = await locator.boundingBox({ timeout: PREPARE_TIMEOUT_MS });
      if (!after || Math.abs(after.y - box.y) < 1) return; // the wheel does not scroll it: Playwright will
    }
  }

  private inside(vp: { width: number; height: number }): Point {
    return { x: vp.width * this.rng.range(0.35, 0.65), y: vp.height * this.rng.range(0.35, 0.65) };
  }

  /**
   * Brings the element into view and the pointer onto a point inside it. Undefined when that
   * cannot be done now (not there, hidden, zero size): the caller then runs Playwright's own call.
   */
  private async aim(
    page: Page,
    locator: Locator,
    level: "light" | "full",
  ): Promise<{ point: Point; box: Box } | undefined> {
    try {
      if (level === "full") await this.wheelIntoView(page, locator);
      await locator.scrollIntoViewIfNeeded({ timeout: PREPARE_TIMEOUT_MS });
      const box = await locator.boundingBox({ timeout: PREPARE_TIMEOUT_MS });
      if (!box || box.width < 1 || box.height < 1) return undefined;
      const point = pickPoint(box, this.rng);
      await this.travel(page, point, Math.min(box.width, box.height), level);
      return { point, box };
    } catch {
      return undefined;
    }
  }

  private static position(at: { point: Point; box: Box }): Point {
    return { x: at.point.x - at.box.x, y: at.point.y - at.box.y };
  }

  /** Types `text` at the focus, key by key. */
  async typeText(page: Page, text: string, level: "light" | "full"): Promise<void> {
    const chars = [...text];
    const delays = keyDelays(text, level, this.rng, this.persona);
    let held = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const hold = keyHold(level, this.rng);
      // The previous key's hold already took part of the gap.
      await this.sleep(Math.max(0, delays[i]! - held));
      held = hold;
      if (ch === "\n") await page.keyboard.press("Enter", { delay: hold });
      else if (onKeyboard(ch)) await page.keyboard.press(ch, { delay: hold });
      else await page.keyboard.insertText(ch); // no key for it on the layout: like an IME commit
    }
  }

  /** Clicks into a field unless it has the focus; false when it still does not have it. */
  private async focus(page: Page, locator: Locator, level: "light" | "full", focused: boolean): Promise<boolean> {
    if (focused) return true;
    const at = await this.aim(page, locator, level);
    if (!at) return false;
    const timing = clickTiming(level, this.rng);
    await this.sleep(timing.beforePress);
    try {
      await locator.click({ position: HumanInput.position(at), delay: timing.press, timeout: PREPARE_TIMEOUT_MS });
      return await locator.evaluate(isFocused, undefined, { timeout: PREPARE_TIMEOUT_MS });
    } catch {
      return false;
    }
  }

  /**
   * A click's options with humanize off: the same click, at a point of the element a person could
   * have aimed at (`pickPoint`, in its inner 60 percent) instead of its exact center, which no
   * person hits time after time. Only the element's size is read, with no wait and no pointer
   * path, so the click costs what Playwright's own does; an element not on the page yet, or too
   * small to aim inside, gets Playwright's center.
   */
  private async offCenter(
    locator: Locator,
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    if (options?.position !== undefined) return options;
    const box = await locator.boundingBox({ timeout: QUICK_BOX_MS }).catch(() => null);
    if (!box || box.width < MIN_AIM_PX || box.height < MIN_AIM_PX) return options;
    const point = pickPoint({ x: 0, y: 0, width: box.width, height: box.height }, this.rng);
    return { ...options, position: point };
  }

  /** A humanized view of one of the page's locators. */
  wrapLocator(locator: Locator, page: Page): Locator {
    const original = locator;
    type Options = Record<string, unknown> | undefined;
    const level = () => this.levelFor(page);
    const wrapped = overlay(locator, {
      click: async (options?: Options) => {
        const l = level();
        if (l === "off") return await original.click(await this.offCenter(original, options));
        const at = await this.aim(page, original, l);
        if (!at) return await original.click(options);
        const timing = clickTiming(l, this.rng);
        await this.sleep(timing.beforePress);
        await original.click({ ...options, position: HumanInput.position(at), delay: timing.press });
      },
      dblclick: async (options?: Options) => {
        const l = level();
        if (l === "off") return await original.dblclick(await this.offCenter(original, options));
        const at = await this.aim(page, original, l);
        if (!at) return await original.dblclick(options);
        const timing = clickTiming(l, this.rng);
        await this.sleep(timing.beforePress);
        await original.dblclick({ ...options, position: HumanInput.position(at), delay: timing.press });
      },
      hover: async (options?: Options) => {
        const l = this.levelFor(page, true);
        const at = l === "off" ? undefined : await this.aim(page, original, l);
        await original.hover(at ? { ...options, position: HumanInput.position(at) } : options);
      },
      setChecked: async (checked: boolean, options?: Options) => {
        const l = level();
        const at = l === "off" ? undefined : await this.aim(page, original, l);
        await original.setChecked(checked, at ? { ...options, position: HumanInput.position(at) } : options);
      },
      selectOption: async (values: never, options?: Options) => {
        const l = level();
        if (l !== "off") await this.aim(page, original, l);
        return await original.selectOption(values, options);
      },
      fill: async (value: string, options?: Options) => {
        const l = level();
        if (l === "off" || [...value].length > MAX_TYPED) return await original.fill(value, options);
        const state = await original
          .evaluate(fieldState, undefined, { timeout: PREPARE_TIMEOUT_MS })
          .catch(() => undefined);
        if (!state?.text || !(await this.focus(page, original, l, state.focused)))
          return await original.fill(value, options);
        if (!state.empty) {
          // Typing over a selection replaces it, as fill does.
          await page.keyboard.press("ControlOrMeta+a", { delay: keyHold(l, this.rng) });
          if (value === "") return await page.keyboard.press("Backspace", { delay: keyHold(l, this.rng) });
        }
        await this.typeText(page, value, l);
      },
      pressSequentially: async (text: string, options?: Options) => {
        const l = level();
        if (l === "off" || [...text].length > MAX_TYPED) return await original.pressSequentially(text, options);
        const focused = await original
          .evaluate(isFocused, undefined, { timeout: PREPARE_TIMEOUT_MS })
          .catch(() => undefined);
        if (focused === undefined || !(await this.focus(page, original, l, focused)))
          return await original.pressSequentially(text, options);
        await this.typeText(page, text, l);
      },
      press: async (key: string, options?: Options) => {
        const l = level();
        if (l === "off") return await original.press(key, options);
        await this.sleep(clickTiming(l, this.rng).beforePress);
        await original.press(key, { ...options, delay: keyHold(l, this.rng) });
      },
      dragTo: async (target: Locator, options?: Options) => {
        const to = this.originals.get(target) ?? target;
        const l = level();
        if (l === "off") return await original.dragTo(to, options);
        const from = await this.aim(page, original, l);
        if (!from) return await original.dragTo(to, options);
        const timing = clickTiming(l, this.rng);
        await this.sleep(timing.beforePress);
        await page.mouse.down();
        let box: Box | null = null;
        try {
          await this.sleep(this.rng.range(80, 200));
          box = await to.boundingBox({ timeout: PREPARE_TIMEOUT_MS });
          if (box) await this.travel(page, pickPoint(box, this.rng), Math.min(box.width, box.height), l);
          await this.sleep(this.rng.range(60, 150));
        } finally {
          await page.mouse.up();
        }
        if (!box) await original.dragTo(to, options);
      },
    });
    this.originals.set(wrapped, original);
    return wrapped;
  }

  /** A humanized view of the page's mouse (the coordinate tools). */
  private wrapMouse(page: Page): Page["mouse"] {
    const mouse = page.mouse;
    return overlay(mouse, {
      move: async (x: number, y: number, options?: { steps?: number }) => {
        const l = this.levelFor(page, true);
        if (l === "off") return await mouse.move(x, y, options);
        await this.travel(page, { x, y }, 40, l);
      },
      click: async (x: number, y: number, options?: { delay?: number }) => {
        const l = this.levelFor(page);
        if (l === "off") return await mouse.click(x, y, options);
        await this.travel(page, { x, y }, 40, l);
        const timing = clickTiming(l, this.rng);
        await this.sleep(timing.beforePress);
        await mouse.click(x, y, { ...options, delay: options?.delay ?? timing.press });
      },
      wheel: async (dx: number, dy: number) => {
        if (this.levelFor(page, true) !== "full") return await mouse.wheel(dx, dy);
        const start = this.now();
        let at = 0;
        for (const step of planWheel(dx, dy, this.rng)) {
          at += step.wait;
          await this.waitUntil(start, at);
          await mouse.wheel(step.dx, step.dy);
        }
      },
    });
  }

  /** A humanized view of the page's keyboard. */
  private wrapKeyboard(page: Page): Page["keyboard"] {
    const keyboard = page.keyboard;
    return overlay(keyboard, {
      press: async (key: string, options?: { delay?: number }) => {
        const l = this.levelFor(page);
        if (l === "off") return await keyboard.press(key, options);
        await keyboard.press(key, { ...options, delay: options?.delay ?? keyHold(l, this.rng) });
      },
      type: async (text: string, options?: { delay?: number }) => {
        const l = this.levelFor(page);
        if (l === "off" || [...text].length > MAX_TYPED) return await keyboard.type(text, options);
        await this.typeText(page, text, l);
      },
    });
  }

  /** A view of one of upstream's tabs whose locators, mouse and keyboard are humanized. */
  wrapTab<T extends object>(tab: T): T {
    const page = (tab as unknown as { page: Page }).page;
    const t = tab as unknown as {
      targetLocator(params: unknown): Promise<TargetResult>;
      targetLocators(params: unknown): Promise<TargetResult[]>;
    };
    const view = overlay(page, { mouse: this.wrapMouse(page), keyboard: this.wrapKeyboard(page) });
    return overlay(tab, {
      page: view,
      targetLocator: async (params: unknown) => {
        const r = await t.targetLocator(params);
        return { ...r, locator: this.wrapLocator(r.locator, page) };
      },
      targetLocators: async (params: unknown) =>
        (await t.targetLocators(params)).map((r) => ({ ...r, locator: this.wrapLocator(r.locator, page) })),
    });
  }

  /** A view of upstream's per-session `Context` whose `ensureTab` hands out humanized tabs. */
  wrapContext<T extends object>(context: T): T {
    const c = context as unknown as { ensureTab(...args: unknown[]): Promise<object> };
    return overlay(context, {
      ensureTab: async (...args: unknown[]) => this.wrapTab(await c.ensureTab(...args)),
    });
  }
}

/**
 * The stock tools of one browser, with the input tools running on humanized tabs. Schemas and
 * every other tool are upstream's own objects.
 */
export function humanizeTools<T extends UpstreamTool>(tools: readonly T[], input: HumanInput): T[] {
  return tools.map((tool) => {
    if (!HUMANIZED_TOOLS.has(tool.schema.name)) return tool;
    const handled = tool as unknown as HandledTool;
    const handle: Handle = (context, params, response, signal) =>
      handled.handle(input.wrapContext(context), params, response, signal);
    return { ...tool, handle };
  });
}
