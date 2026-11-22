import type { BrowserContext, Frame, Page } from "patchright-core";
import type { TabPolicy } from "./tuning.js";

/**
 * The tab governor. Chrome keeps every page an agent or a site opened, and each one
 * keeps running scripts, timers and network until somebody closes it; after a long session that
 * is most of the browser's memory and CPU. Per session's browser context it:
 *
 * - caps the pages open at once (`max`): when a new page goes past it, the least recently used
 *   page closes, never the agent's current tab or the new page;
 * - closes a popup (a page with an opener) that opened while no tool call was running, nor in
 *   the moments after one: ads and pop-unders, not the window a click of the agent opened
 *   (`popups: "close"`);
 * - parks a page nobody used for `parkMs`: it goes to about:blank, which stops its scripts, and
 *   keeps its URL; the next call that uses that page (it is the current tab, or `browser_tabs`
 *   selects it) loads the URL again first. After `closeMs` unused the page closes.
 *
 * A page counts as used when it is the current tab at the end of a tool call, and when its main
 * frame navigates (a person using a headed window). The current tab is never parked or closed,
 * and neither is the last page.
 *
 * With `"sharing": "tabs"` several sessions work in one browser: the cap counts each session's
 * pages apart (`owner`) and closes only that session's least recently used page, no session's
 * current tab is parked or closed (`protected`), and each note goes to the session whose page it
 * is about.
 *
 * With `ownedOnly` (attach mode, the user's own Chrome) it governs only the agent's pages:
 * the ones handed to `own` and the ones that open during a tool call or in the moments after
 * one. Pages that were open before, or that open between calls, are the user's: never counted,
 * parked or closed, and no popup is closed.
 */

/** A popup that opens this long after a tool call ended still counts as the call's. */
export const POPUP_GRACE_MS = 2_000;

interface PageState {
  lastUsed: number;
  /** The URL the page showed when it was parked. */
  parkedUrl?: string;
  /** True while the governor itself navigates the page (park, restore). */
  moving?: boolean;
}

/** One session's view of the tabs: its current tab and the indexes `browser_tabs` uses. */
export interface TabView {
  /** The page the stock tools act on (upstream's current tab), if any. */
  current(): Page | undefined;
  /** The pages in upstream's tab order (the indexes `browser_tabs` uses). */
  tabs(): Page[];
}

export interface GovernorOptions extends TabView {
  /** Pages never parked or closed: every session's current tab (default: `current()`). */
  protected?(): Page[];
  /** The session that holds a page; the cap counts each owner's pages apart (default: one group). */
  owner?(page: Page): string | undefined;
  /** Runs first for each page Chrome opens, before the popup check and the cap. */
  adopt?(page: Page): Promise<void>;
  now?: () => number;
  /** Sweep for unused pages on a timer (the default); tests call `sweep()` themselves. */
  timer?: boolean;
  /** Govern only the agent's pages (see the class comment). */
  ownedOnly?: boolean;
  /** Told about each page counted as the agent's, with `ownedOnly`. */
  onOwn?(page: Page): void;
}

/** A URL short enough for one line of a tool result. */
function shortUrl(url: string): string {
  return url.length > 100 ? `${url.slice(0, 97)}...` : url;
}

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const m = Math.round(ms / 60_000);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

export class TabGovernor {
  private readonly pages = new Map<Page, PageState>();
  private calls = 0;
  private lastCallEnd = Number.NEGATIVE_INFINITY;
  /** Notes for the next result, per owner of the page they are about (undefined: whoever calls next). */
  private notes = new Map<string | undefined, string[]>();
  private timer: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly adopting = new Set<Promise<void>>();
  /** Pages opened during a call: the cap is applied once the call returns (`afterCall`). */
  private readonly opened = new Set<Page>();
  private readonly onPage = (page: Page) => {
    const done = this.adopt(page)
      .catch(() => {})
      .finally(() => this.adopting.delete(done));
    this.adopting.add(done);
  };

  constructor(
    private readonly context: BrowserContext,
    private readonly policy: TabPolicy,
    private readonly options: GovernorOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.options.ownedOnly) for (const page of this.context.pages()) this.track(page);
    this.context.on("page", this.onPage);
    const stages = [this.policy.parkMs, this.policy.closeMs].filter((ms) => ms > 0);
    if (stages.length && this.options.timer !== false) {
      const every = Math.min(60_000, Math.max(1_000, Math.min(...stages) / 5));
      this.timer = setInterval(() => void this.sweep().catch(() => {}), every);
      this.timer.unref();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.context.off("page", this.onPage);
  }

  /** Resolves once every page opened so far has been looked at (popup check, cap). */
  async settled(): Promise<void> {
    await Promise.all([...this.adopting]);
  }

  /**
   * The stock call returned: apply the cap to the pages it opened. Not during the call, since
   * upstream reads every tab (title, console) to build the result and a page closed under it
   * fails the call.
   */
  async afterCall(): Promise<void> {
    await this.settled();
    const opened = [...this.opened];
    this.opened.clear();
    for (const page of opened) if (!page.isClosed()) await this.enforceCap(page);
  }

  /** A tool call starts: nothing is swept and popups count as asked for until it ends. */
  beginCall(): void {
    this.calls++;
  }

  /**
   * Resolves once nothing the governor started before the call is still in flight: a popup
   * check or a sweep may be closing a page right now, and upstream reads every tab (title,
   * console) to build a result, so a page closing under the call fails it with "Target page,
   * context or browser has been closed". Call after `beginCall`, which keeps new work from
   * starting.
   */
  async quiet(): Promise<void> {
    await Promise.all([...this.adopting, this.sweeping]);
  }

  /** A tool call ended: its current tab (of `view`, by default the governor's) was used now. */
  endCall(view: TabView = this.options): void {
    this.calls = Math.max(0, this.calls - 1);
    this.lastCallEnd = this.now();
    const current = view.current();
    if (!current || current.isClosed()) return;
    // A tab of the user's that the agent selected stays the user's.
    if (this.options.ownedOnly && !this.pages.has(current)) return;
    this.track(current).lastUsed = this.now();
  }

  /** True for a page the governor counts as the agent's (with `ownedOnly`, not the user's own tabs). */
  governs(page: Page): boolean {
    return this.pages.has(page);
  }

  /** Counts a page as the agent's (attach mode: the tab the host opens at connect). */
  own(page: Page): void {
    this.track(page);
    this.options.onOwn?.(page);
  }

  /** What the governor did since the last call, one line each, for the next tool result of `owner`. */
  takeNotes(owner?: string): string[] {
    const out = [...(this.notes.get(owner) ?? []), ...(owner === undefined ? [] : (this.notes.get(undefined) ?? []))];
    this.notes.delete(owner);
    this.notes.delete(undefined);
    return out;
  }

  /** The URL a parked page will load again, or undefined when it is not parked. */
  parkedUrl(page: Page): string | undefined {
    return this.pages.get(page)?.parkedUrl;
  }

  /**
   * Before a stock tool runs: when the page it is about to use is parked, load its URL again.
   * That page is the tab `browser_tabs` is about to select, else the current tab.
   */
  async prepare(name: string, args: Record<string, unknown>, view: TabView = this.options): Promise<void> {
    if (name === "browser_tabs") {
      if (args.action !== "select" || typeof args.index !== "number") return;
      const page = view.tabs()[args.index];
      if (page) await this.restore(page);
      return;
    }
    const current = view.current();
    if (!current) return;
    if (name === "browser_navigate") {
      // The call replaces the page anyway.
      const state = this.pages.get(current);
      if (state) state.parkedUrl = undefined;
      return;
    }
    await this.restore(current);
  }

  /** Marks parked tabs in a tab list of a tool result (`- 2: [](about:blank)`). */
  annotateTabs(text: string, view: TabView = this.options): string {
    if (!text.includes("](about:blank)")) return text;
    const tabs = view.tabs();
    return text.replace(/^(- (\d+):.*\]\(about:blank\))$/gm, (line, _all, index: string) => {
      const page = tabs[Number(index)];
      const url = page ? this.parkedUrl(page) : undefined;
      return url ? `${line} (parked, was ${shortUrl(url)}: selecting it loads that page again)` : line;
    });
  }

  /** Parks and closes pages that went unused too long. Never while a tool call runs. */
  async sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepOnce(): Promise<void> {
    const { parkMs, closeMs } = this.policy;
    const kept = this.protectedPages();
    for (const [page, state] of [...this.pages]) {
      if (this.calls > 0) return;
      if (kept.includes(page) || page.isClosed() || state.moving) continue;
      const unused = this.now() - state.lastUsed;
      if (closeMs > 0 && unused >= closeMs && this.openPages().length > 1) {
        const url = state.parkedUrl ?? page.url();
        const owner = this.options.owner?.(page);
        await page.close().catch(() => {});
        this.note(`closed a tab unused for ${minutes(unused)} (${shortUrl(url)})`, owner);
        continue;
      }
      if (parkMs > 0 && unused >= parkMs && state.parkedUrl === undefined) await this.park(page, state, unused);
    }
  }

  private openPages(): Page[] {
    return [...this.pages.keys()].filter((p) => !p.isClosed());
  }

  private protectedPages(): Page[] {
    if (this.options.protected) return this.options.protected();
    const current = this.options.current();
    return current ? [current] : [];
  }

  private track(page: Page): PageState {
    let state = this.pages.get(page);
    if (state) return state;
    const created: PageState = { lastUsed: this.now() };
    state = created;
    this.pages.set(page, created);
    page.once("close", () => this.pages.delete(page));
    page.on("framenavigated", (frame: Frame) => {
      if (created.moving || frame !== page.mainFrame()) return;
      // Navigated by someone else (the agent through a stock tool, or a person): in use again.
      created.lastUsed = this.now();
      created.parkedUrl = undefined;
    });
    return created;
  }

  /** A page Chrome just opened. */
  private async adopt(page: Page): Promise<void> {
    const asked = this.calls > 0 || this.now() - this.lastCallEnd < POPUP_GRACE_MS;
    if (this.options.ownedOnly) {
      if (!asked) return;
      this.own(page);
    } else this.track(page);
    if (this.options.adopt) await this.options.adopt(page);
    if (this.policy.popups === "close" && !asked) {
      const opener = await page.opener().catch(() => null);
      if (opener) {
        await page.close().catch(() => {});
        this.note(`closed a popup that ${shortUrl(opener.url())} opened while no tool call was running`);
        return;
      }
    }
    if (this.calls > 0) this.opened.add(page);
    else await this.enforceCap(page);
  }

  private async enforceCap(added: Page): Promise<void> {
    const { max } = this.policy;
    if (max <= 0) return;
    const owner = this.options.owner?.(added);
    const open = this.openPages().filter((p) => this.options.owner?.(p) === owner);
    const excess = open.length - max;
    if (excess <= 0) return;
    const kept = this.protectedPages();
    const lastUsed = (p: Page) => this.pages.get(p)?.lastUsed ?? 0;
    const victims = open
      .filter((p) => !kept.includes(p) && p !== added)
      .sort((a, b) => lastUsed(a) - lastUsed(b))
      .slice(0, excess);
    for (const page of victims) {
      const url = this.pages.get(page)?.parkedUrl ?? page.url();
      await page.close().catch(() => {});
      this.note(
        `closed the least recently used tab (${shortUrl(url)}): more than ${max} were open; tab numbers changed, list them again before selecting one`,
        owner,
      );
    }
  }

  private async park(page: Page, state: PageState, unused: number): Promise<void> {
    const url = page.url();
    if (!url || url.startsWith("about:")) return;
    state.moving = true;
    try {
      await page.goto("about:blank", { timeout: 5_000 });
      state.parkedUrl = url;
      this.note(
        `parked a tab unused for ${minutes(unused)} on about:blank (${shortUrl(url)}); using it again loads that page`,
        this.options.owner?.(page),
      );
    } catch {
      /* the page would not leave (a slow unload): try again on the next sweep */
    } finally {
      state.moving = false;
    }
  }

  private async restore(page: Page): Promise<void> {
    const state = this.pages.get(page);
    const url = state?.parkedUrl;
    if (!state || url === undefined || page.isClosed()) return;
    state.moving = true;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      this.note(`loaded ${shortUrl(url)} again in a tab that was parked`, this.options.owner?.(page));
    } catch (error) {
      this.note(
        `could not load ${shortUrl(url)} again in a parked tab: ${String((error as Error).message ?? error).split("\n")[0]}`,
        this.options.owner?.(page),
      );
    } finally {
      state.moving = false;
      state.parkedUrl = undefined;
      state.lastUsed = this.now();
    }
  }

  private note(text: string, owner?: string): void {
    const list = this.notes.get(owner) ?? [];
    list.push(text);
    if (list.length > 20) list.splice(0, list.length - 20);
    this.notes.set(owner, list);
  }
}
