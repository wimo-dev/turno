import type { Locator, Page } from "patchright-core";
import {
  type OverlayBox,
  type OverlayCommand,
  type OverlayReport,
  type OverlayText,
  cursorOverlay,
} from "./agent-cursor-overlay.js";
import { HUMANIZED_TOOLS, overlay as override } from "./human-input.js";
import type { CursorMode } from "./settings.js";
import { type UiLocale, uiStrings } from "./ui-strings.js";
import type { UpstreamTool } from "./upstream.js";

/**
 * The agent cursor: while an agent drives a browser someone can see (a headed Chrome window, or
 * any browser with the live view on), each page shows who is at work and where. A Figma-like
 * arrow with the agent's name glides to each element it acts on, a ring marks the element, a
 * click leaves a ripple, a field being typed into gets a typing bubble, and a thin frame with a
 * badge ("turno · Claude Code at work", "paused · you have the controls") goes around the page
 * while calls run. Several agent sessions on one identity's Chrome (`"sharing": "tabs"`) each
 * get a cursor and a color of their own.
 *
 * The coordinates are the agent's own: the input tools run on a view of the tab (`CursorInput`)
 * that reads the target's box before each action, as `human-input.ts` does for human-like input.
 * Nothing follows the real mouse, so the user's own pointer never moves the agent's cursor.
 * With humanize on, its pointer path goes through the same view, so the arrow follows the curve.
 *
 * What the page draws is the overlay of `agent-cursor-overlay.ts`, built on first use in each
 * document and kept out of the model's view: out of the accessibility tree (snapshots), out of
 * `document.body` (read), never a hit target, and hidden while the model's screenshot is taken
 * (`hiddenDuring`). Recordings and the live view keep it: they are for the person.
 */

/** What the policy needs to know about the browser being launched. */
export interface CursorContext {
  /** Chrome runs without a window. */
  headless: boolean;
  /** The live view is on for the identity. */
  live: boolean;
  /** The engine that runs it; read mode lays out no page to draw on. */
  engine: string;
}

/**
 * Whether the agent cursor is drawn: never in read mode, always with `on`, and with `auto` (the
 * default) when someone can see the browser: a Chrome window, or the live view.
 */
export function resolveCursor(mode: CursorMode | undefined, ctx: CursorContext): boolean {
  if (ctx.engine === "lightpanda") return false;
  const m = mode ?? "auto";
  if (m === "off") return false;
  if (m === "on") return true;
  return !ctx.headless || ctx.live;
}

/** One color per agent session, in order: turno's blue first. */
export const CURSOR_COLORS = ["#2b59ff", "#e8590c", "#2f9e44", "#ae3ec9", "#d6336c", "#0c8599"] as const;

/** The longest glide to a target: long enough to follow, short enough to cost little. */
export const MAX_GLIDE_MS = 420;

export interface Point {
  x: number;
  y: number;
}

/** How long the arrow takes from `from` to `to`: a short base plus the distance, capped. */
export function glideMs(from: Point | undefined, to: Point, max: number = MAX_GLIDE_MS): number {
  if (max <= 0) return 0;
  if (!from) return Math.min(max, 220);
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 2) return 0;
  return Math.round(Math.min(max, 140 + d * 0.35));
}

/** The center of a box. */
export function centerOf(box: OverlayBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** True when some of the box is inside a viewport of this size. */
export function inView(box: OverlayBox, view: { width: number; height: number }): boolean {
  return box.x + box.width > 0 && box.y + box.height > 0 && box.x < view.width && box.y < view.height;
}

/**
 * The agent's name as people know it, from the client name it sends in `initialize`
 * (`clientInfo.name`): "claude-code" reads "Claude Code", "codex-mcp-client" reads "Codex". A
 * name turno does not know is shown as sent; a "(2)" turno added to tell sessions apart stays.
 */
export function agentName(client: string): string {
  const raw = client.trim();
  const m = /^(.*?)(\s\(\d+\))?$/.exec(raw);
  const base = (m?.[1] ?? raw).trim();
  const suffix = m?.[2] ?? "";
  const known: [RegExp, string][] = [
    [/^claude[-_ ]?code$/i, "Claude Code"],
    [/^claude[-_ ]?ai$/i, "Claude"],
    [/^codex([-_ ]mcp[-_ ]client)?$/i, "Codex"],
    [/^cursor([-_ ]vscode)?$/i, "Cursor"],
    [/^(github[-_ ])?copilot([-_ ]cli)?$/i, "Copilot"],
    [/^gemini([-_ ]cli)?([-_ ]mcp[-_ ]client)?$/i, "Gemini CLI"],
    [/^windsurf([-_ ]client)?$/i, "Windsurf"],
    [/^(visual studio code|vscode)$/i, "VS Code"],
  ];
  const pretty = known.find(([re]) => re.test(base))?.[1];
  return `${pretty ?? base}${suffix}`;
}

/** The pill of a session's cursor: the client's name, and the identity when there is one. */
export function cursorLabel(client: string, identity?: string): string {
  const name = client.trim() || "Agent";
  return identity ? `${name} · ${identity}` : name;
}

interface Actor {
  key: string;
  /** The agent's name without the "(2)" that tells sessions apart. */
  base: string;
  /** The client's name: the badge says it is at work. */
  name: string;
  /** The cursor's pill: the name and the identity. */
  label: string;
  color: string;
}

export interface AgentCursorOptions {
  /** The client name of the session that launched the browser (its window title). */
  title: string;
  identity?: string;
  sleep?: (ms: number) => Promise<void>;
  /** The longest glide; 0 places the arrow without a glide. */
  maxGlideMs?: number;
  /** The language of the badge (`ui-strings.ts`); English without it. */
  locale?: UiLocale;
  /**
   * Whether a page runs no script now (an alert, confirm or prompt is open): the overlay leaves it
   * alone, or the call that answers the dialog would wait on its own page.
   */
  blocked?: (page: Page) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The agent cursor of one running browser: its actors and what each page shows. */
export class AgentCursor {
  private readonly actors = new Map<string, Actor>();
  /** The session acting on each page now (set when a call begins on it). */
  private readonly owners = new WeakMap<Page, string>();
  /** Where each session's arrow is on each page, so a new document puts it back. */
  private readonly points = new WeakMap<Page, Map<string, Point>>();
  private readonly reports = new WeakMap<Page, OverlayReport>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxGlideMs: number;
  private lastKey = "";
  private paused = false;
  /** The sessions with a call in flight on this browser, whatever their page. */
  private readonly busy = new Set<string>();
  /** The pages the overlay has been on, so a call starting elsewhere updates their badge. */
  private readonly pages = new Set<Page>();
  /** The badge's words, and the name of an agent that sent none. */
  private readonly text: OverlayText & { agent: string };

  constructor(private readonly options: AgentCursorOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.maxGlideMs = options.maxGlideMs ?? MAX_GLIDE_MS;
    this.text = uiStrings(options.locale).cursor;
  }

  /**
   * The actor of a session, with its label and color, made on first use. `client` is the name
   * of the session's own agent when the call said it (mcpd, or a shared host's connection);
   * without it the session takes the launching client's name, with "(2)" and up after the first.
   */
  actor(key: string, client?: string): Actor {
    let a = this.actors.get(key);
    if (a) return a;
    const n = this.actors.size;
    let name: string;
    if (client) {
      const base = agentName(client);
      const same = [...this.actors.values()].filter((o) => o.base === base).length;
      name = same === 0 ? base : `${base} (${same + 1})`;
    } else name = agentName(n === 0 ? this.options.title : `${this.options.title} (${n + 1})`);
    name = name.trim() || this.text.agent;
    a = {
      key,
      base: name.replace(/\s\(\d+\)$/, ""),
      name,
      label: cursorLabel(name, this.options.identity),
      color: CURSOR_COLORS[n % CURSOR_COLORS.length]!,
    };
    this.actors.set(key, a);
    return a;
  }

  /** The session acting on this page now, or the last one that acted anywhere. */
  ownerOf(page: Page): string {
    return this.owners.get(page) ?? this.lastKey;
  }

  /** Where the session's arrow is on this page, if it has been there. */
  pointOf(page: Page, key: string = this.ownerOf(page)): Point | undefined {
    return this.points.get(page)?.get(key);
  }

  /** The viewport and motion preference the page last reported. */
  reportOf(page: Page): OverlayReport | undefined {
    return this.reports.get(page);
  }

  /**
   * Sends commands to the page's overlay, with the actor and the arrow's last place first, so a
   * document the overlay has not been on yet shows the same thing. Never throws: a page that
   * closed or navigated away just misses one frame.
   */
  async send(
    page: Page,
    commands: OverlayCommand[],
    key: string = this.ownerOf(page),
  ): Promise<OverlayReport | undefined> {
    if (page.isClosed() || this.options.blocked?.(page)) return undefined;
    // The direct session's key is "" (`DIRECT_SESSION`): every key, that one too, is an actor.
    const a = this.actor(key);
    const { working, workingAs, paused } = this.text;
    const prelude: OverlayCommand[] = [
      { op: "text", text: { working, workingAs, paused } },
      { op: "actor", key, label: a.label, name: a.name, color: a.color },
    ];
    const at = this.pointOf(page, key);
    if (at) prelude.push({ op: "move", key, x: at.x, y: at.y, ms: 0 });
    prelude.push({ op: "paused", on: this.paused }, { op: "others", n: this.othersThan(key) });
    try {
      const report = await page.evaluate(cursorOverlay, [...prelude, ...commands]);
      this.reports.set(page, report);
      this.pages.add(page);
      return report;
    } catch {
      return undefined;
    }
  }

  private remember(page: Page, key: string, point: Point): void {
    let m = this.points.get(page);
    if (!m) {
      m = new Map();
      this.points.set(page, m);
    }
    m.set(key, point);
  }

  /** How many sessions other than `key` have a call in flight on this browser: the badge's "+N". */
  private othersThan(key: string): number {
    return this.busy.size - (this.busy.has(key) ? 1 : 0);
  }

  /** Tells the other pages the overlay is on how many sessions are at work now. */
  private recount(except: Page | undefined): void {
    for (const page of this.pages) {
      if (page.isClosed()) {
        this.pages.delete(page);
        continue;
      }
      if (page === except) continue;
      const owner = this.ownerOf(page);
      void this.send(page, [], owner);
    }
  }

  /**
   * A call of session `key` begins on this page: the frame and badge come on. `client` names the
   * session's own agent when the call said it.
   */
  async begin(page: Page | undefined, key: string, client?: string): Promise<void> {
    this.actor(key, client);
    this.busy.add(key);
    this.recount(page);
    if (!page) return;
    this.owners.set(page, key);
    this.lastKey = key;
    await this.send(page, [{ op: "busy", key, on: true }], key);
  }

  /** The call ended (on this page, which may be a new one): the frame fades after a moment. */
  async end(page: Page | undefined, key: string): Promise<void> {
    this.busy.delete(key);
    this.recount(page);
    if (!page) return;
    this.owners.set(page, key);
    await this.send(page, [{ op: "busy", key, on: false }], key);
  }

  /** Glides the arrow to `to` and waits for it to arrive. */
  async glideTo(page: Page, to: Point): Promise<void> {
    const key = this.ownerOf(page);
    const report = this.reports.get(page);
    const ms = report?.reducedMotion ? 0 : glideMs(this.pointOf(page, key), to, this.maxGlideMs);
    // Sent from the last place (the batch's prelude puts the arrow there), then remembered.
    await this.send(page, [{ op: "move", key, x: to.x, y: to.y, ms }], key);
    this.remember(page, key, to);
    if (ms > 0) await this.sleep(ms);
  }

  /** Moves the arrow along with a pointer path someone else plays (humanize): a short ease per step. */
  async track(page: Page, to: Point): Promise<void> {
    const key = this.ownerOf(page);
    // Remembered first: the steps are sent without waiting, so the next step's batch must not
    // put the arrow back where this one started.
    this.remember(page, key, to);
    await this.send(page, [{ op: "move", key, x: to.x, y: to.y, ms: 40 }], key);
  }

  /** Puts the arrow at `to` without a glide. */
  async place(page: Page, to: Point): Promise<void> {
    const key = this.ownerOf(page);
    await this.send(page, [{ op: "move", key, x: to.x, y: to.y, ms: 0 }], key);
    this.remember(page, key, to);
  }

  async ring(page: Page, box: OverlayBox | null): Promise<void> {
    const key = this.ownerOf(page);
    await this.send(page, [{ op: "ring", key, box }], key);
  }

  async ripple(page: Page, at: Point): Promise<void> {
    const key = this.ownerOf(page);
    await this.send(page, [{ op: "ripple", key, x: at.x, y: at.y }], key);
  }

  async typing(page: Page, box: OverlayBox | null): Promise<void> {
    const key = this.ownerOf(page);
    await this.send(page, [{ op: "typing", key, box }], key);
  }

  /** The live view's pause: every page says the user has the controls. */
  async setPaused(pages: readonly Page[], on: boolean): Promise<void> {
    this.paused = on;
    await Promise.all(pages.map((page) => this.send(page, [])));
  }

  /** Runs `fn` with the page's overlay hidden: the model's screenshot shows the page alone. */
  async hiddenDuring<T>(page: Page | undefined, fn: () => Promise<T>): Promise<T> {
    if (!page || !this.reports.has(page)) return await fn();
    await this.send(page, [{ op: "visible", on: false }]);
    try {
      return await fn();
    } finally {
      await this.send(page, [{ op: "visible", on: true }]);
    }
  }
}

type Handle = (context: object, params: unknown, response: unknown, signal?: AbortSignal) => Promise<unknown>;
interface HandledTool extends UpstreamTool {
  handle: Handle;
}
type TargetResult = { locator: Locator; [key: string]: unknown };
type Options = Record<string, unknown> | undefined;

/** How long the cursor waits for an element's box before it lets the action run without it. */
const BOX_TIMEOUT_MS = 500;

/** The kind of mark an action leaves. */
type Kind = "click" | "hover" | "type" | "drag";

/** The locator methods the input tools call, and the mark each leaves. */
const LOCATOR_KINDS: Record<string, Kind> = {
  click: "click",
  dblclick: "click",
  tap: "click",
  check: "click",
  uncheck: "click",
  setChecked: "click",
  selectOption: "click",
  hover: "hover",
  fill: "type",
  pressSequentially: "type",
  press: "type",
  dragTo: "drag",
};

/**
 * The input tools' view of a tab that moves the agent cursor: each locator action glides the
 * arrow to its target first, and the coordinate tools' mouse does the same. With humanize on
 * (`humanized`), the pointer path humanize plays goes through this view's mouse, so the arrow
 * follows it step by step instead of gliding on its own.
 */
export class CursorInput {
  /** One view per page, so humanize, which keys its pointer state by page, sees the same one. */
  private readonly views = new WeakMap<Page, Page>();
  /** The last element marked on each page: where keys typed through the keyboard go. */
  private readonly marked = new WeakMap<Page, OverlayBox>();
  private readonly typingTimers = new WeakMap<Page, NodeJS.Timeout>();
  /** Pages where humanize moved the pointer since the last action: the arrow is already there. */
  private readonly moved = new WeakSet<Page>();

  constructor(
    readonly cursor: AgentCursor,
    private readonly humanized: boolean,
  ) {}

  private async boxOf(locator: Locator, timeout: number = BOX_TIMEOUT_MS): Promise<OverlayBox | null> {
    try {
      const box = await locator.boundingBox({ timeout });
      return box && box.width > 0 && box.height > 0 ? box : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether humanize just played a pointer path on this page (and forgets it): then the arrow
   * followed it there, and the action gets no glide of its own. When humanize went straight to
   * the action (no box to aim at), the arrow glides as without humanize.
   */
  private followed(page: Page): boolean {
    if (!this.humanized || !this.moved.has(page)) return false;
    this.moved.delete(page);
    return true;
  }

  /** Marks the target of an action, runs it, and leaves the mark of its kind. */
  private async act<T>(page: Page, locator: Locator, kind: Kind, run: () => Promise<T>, to?: Locator): Promise<T> {
    const c = this.cursor;
    const followed = this.followed(page);
    let box = await this.boxOf(locator);
    const view = c.reportOf(page) ?? (await c.send(page, []));
    if (box && view && !inView(box, view)) box = null; // Playwright scrolls it in: mark it after
    if (box) {
      this.marked.set(page, box);
      void c.ring(page, box);
      if (!followed) await c.glideTo(page, centerOf(box));
      if (kind === "type") void c.typing(page, box);
      if (kind === "click" && !followed) void c.ripple(page, centerOf(box));
    }
    try {
      const result = await run();
      if (kind === "drag" && to) {
        const end = await this.boxOf(to, 200);
        if (end) {
          void c.ring(page, end);
          await c.place(page, centerOf(end));
        }
      } else if (!box || (kind === "click" && followed)) {
        // Marked after: the element came into view during the action, or humanize moved there.
        const after = box ?? (await this.boxOf(locator, 200));
        const center = after ? centerOf(after) : undefined;
        const at = followed ? (c.pointOf(page) ?? center) : center;
        if (after && !box) {
          this.marked.set(page, after);
          void c.ring(page, after);
        }
        if (at) {
          if (!followed) await c.place(page, at);
          if (kind === "click") void c.ripple(page, at);
        }
      }
      return result;
    } finally {
      if (kind === "type") void c.typing(page, null);
    }
  }

  /** The cursor view of one of the page's locators. */
  wrapLocator(locator: Locator, page: Page): Locator {
    const original = locator as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const overrides: Record<string, unknown> = {};
    for (const [method, kind] of Object.entries(LOCATOR_KINDS)) {
      overrides[method] = (...args: unknown[]) => {
        const to = method === "dragTo" ? (args[0] as Locator) : undefined;
        return this.act(page, locator, kind, () => original[method]!.apply(locator, args), to);
      };
    }
    return override(locator, overrides);
  }

  /** The cursor view of the page's mouse (the coordinate tools, and humanize's pointer path). */
  private wrapMouse(page: Page): Page["mouse"] {
    const mouse = page.mouse;
    const c = this.cursor;
    return override(mouse, {
      move: async (x: number, y: number, options?: { steps?: number }) => {
        if (this.humanized) {
          // A step of humanize's pointer path: the arrow follows it.
          this.moved.add(page);
          void c.track(page, { x, y });
        } else await c.glideTo(page, { x, y });
        await mouse.move(x, y, options);
      },
      click: async (x: number, y: number, options?: Options) => {
        if (!this.followed(page)) await c.glideTo(page, { x, y });
        void c.ripple(page, { x, y });
        await mouse.click(x, y, options);
      },
      dblclick: async (x: number, y: number, options?: Options) => {
        if (!this.followed(page)) await c.glideTo(page, { x, y });
        void c.ripple(page, { x, y });
        await mouse.dblclick(x, y, options);
      },
      down: async (options?: Options) => {
        const at = c.pointOf(page);
        if (at) void c.ripple(page, at);
        await mouse.down(options);
      },
    });
  }

  /** Keys typed through the keyboard (humanize's typing, browser_press_key): a typing bubble a moment. */
  private keys(page: Page): void {
    const box = this.marked.get(page);
    if (!box) return;
    const old = this.typingTimers.get(page);
    if (old) clearTimeout(old);
    else void this.cursor.typing(page, box);
    const timer = setTimeout(() => {
      this.typingTimers.delete(page);
      void this.cursor.typing(page, null);
    }, 900);
    timer.unref?.();
    this.typingTimers.set(page, timer);
  }

  /** The cursor view of the page's keyboard. */
  private wrapKeyboard(page: Page): Page["keyboard"] {
    const keyboard = page.keyboard;
    return override(keyboard, {
      press: async (key: string, options?: Options) => {
        this.keys(page);
        await keyboard.press(key, options);
      },
      type: async (text: string, options?: Options) => {
        this.keys(page);
        await keyboard.type(text, options);
      },
      insertText: async (text: string) => {
        this.keys(page);
        await keyboard.insertText(text);
      },
    });
  }

  /** The cursor view of the page itself: the same object for every call on that page. */
  private viewOf(page: Page): Page {
    let v = this.views.get(page);
    if (!v) {
      v = override(page, { mouse: this.wrapMouse(page), keyboard: this.wrapKeyboard(page) });
      this.views.set(page, v);
    }
    return v;
  }

  /** A view of one of upstream's tabs whose locators and mouse move the agent cursor. */
  wrapTab<T extends object>(tab: T): T {
    const page = (tab as unknown as { page: Page }).page;
    const t = tab as unknown as {
      targetLocator(params: unknown): Promise<TargetResult>;
      targetLocators(params: unknown): Promise<TargetResult[]>;
    };
    return override(tab, {
      page: this.viewOf(page),
      targetLocator: async (params: unknown) => {
        const r = await t.targetLocator(params);
        return { ...r, locator: this.wrapLocator(r.locator, page) };
      },
      targetLocators: async (params: unknown) =>
        (await t.targetLocators(params)).map((r) => ({ ...r, locator: this.wrapLocator(r.locator, page) })),
    });
  }

  /** A view of upstream's per-session `Context` whose `ensureTab` hands out cursor tabs. */
  wrapContext<T extends object>(context: T): T {
    const c = context as unknown as { ensureTab(...args: unknown[]): Promise<object> };
    return override(context, {
      ensureTab: async (...args: unknown[]) => this.wrapTab(await c.ensureTab(...args)),
    });
  }
}

/**
 * The stock tools of one browser, with the input tools running on cursor tabs. It goes over
 * `humanizeTools` (applied to its result): the outer wrapper's view is the one next to the page,
 * so humanize's pointer path runs through the cursor's mouse. Schemas and every other tool are
 * upstream's own objects.
 */
export function cursorTools<T extends UpstreamTool>(tools: readonly T[], input: CursorInput): T[] {
  return tools.map((tool) => {
    if (!HUMANIZED_TOOLS.has(tool.schema.name)) return tool;
    const handled = tool as unknown as HandledTool;
    const handle: Handle = (context, params, response, signal) =>
      handled.handle(input.wrapContext(context), params, response, signal);
    return { ...tool, handle };
  });
}
