import type { Page } from "patchright-core";
import { DEFAULT_LIVE_WAIT_MS, PauseGate, type PauseHold, type TabState } from "./live.js";
import type { LiveBrowser } from "./live-server.js";

/**
 * What the host holds calls with and compares the tabs by: the pause gate of one browser, the
 * tab each session worked on last, and the calls in flight. With the live view on it is the live
 * server (`live-server.ts`), which also streams the page and takes the user's own pause. Without
 * it, a `PlainWatch` does the same for the pauses a call can start itself: a person step
 * (`browser_request_human`) holds every session of the browser while the person acts.
 */
export interface BrowserWatch {
  readonly gate: PauseGate;
  readonly paused: boolean;
  /** How long a call held by the user's own pause waits. */
  readonly waitMs: number;
  /** Agent calls running now. */
  readonly inFlight: number;
  /** A browser launched; returns what to call when it goes away. */
  bind(browser: LiveBrowser): () => void;
  /** The page a call of `session` worked on. */
  follow(session: string, page: Page | undefined): void;
  /** The page the last call of `session` worked on (it may have closed since). */
  lastPage(session: string): Page | undefined;
  /** The id the notes give a tab. */
  idOf(page: Page): number;
  /** The tabs now, as the notes compare them. */
  tabStates(): Promise<TabState[]>;
  /** An agent call starts; returns what to call when it ends. */
  begin(): () => void;
  /** Starts a pause (false when one is on); `front` brings the shown tab to the front. */
  pause(by: string, front?: boolean, hold?: PauseHold): Promise<boolean>;
  /** Ends the pause and lets the held calls go; false when there was none. */
  resume(): boolean;
}

/** The tab's title, or "" when the page does not answer within a second. */
export async function titleOf(page: Page): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((r) => {
    timer = setTimeout(() => r(""), 1_000);
  });
  try {
    return await Promise.race([page.title().catch(() => ""), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The watch of a browser without the live view: no stream, no socket, no user pause. */
export class PlainWatch implements BrowserWatch {
  readonly gate = new PauseGate();
  private browser: LiveBrowser | undefined;
  private heldBrowser: LiveBrowser | undefined;
  private readonly lastBySession = new Map<string, Page>();
  private readonly ids = new WeakMap<Page, number>();
  private nextId = 1;
  private busy = 0;

  constructor(readonly waitMs: number = DEFAULT_LIVE_WAIT_MS) {}

  get paused(): boolean {
    return this.gate.paused !== undefined;
  }

  get inFlight(): number {
    return this.busy;
  }

  bind(browser: LiveBrowser): () => void {
    this.browser = browser;
    this.lastBySession.clear();
    if (this.paused && this.heldBrowser !== browser) {
      this.heldBrowser = browser;
      void browser.onPause?.().catch(() => {});
    }
    return () => {
      if (this.browser !== browser) return;
      this.browser = undefined;
      if (this.heldBrowser === browser) this.heldBrowser = undefined;
    };
  }

  follow(session: string, page: Page | undefined): void {
    if (page && !page.isClosed()) this.lastBySession.set(session, page);
  }

  lastPage(session: string): Page | undefined {
    return this.lastBySession.get(session);
  }

  idOf(page: Page): number {
    let id = this.ids.get(page);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(page, id);
    }
    return id;
  }

  /** The agent's pages: every page, or in attach mode only those the agent worked on. */
  private pages(): Page[] {
    const b = this.browser;
    if (!b) return [];
    if (b.userBrowser) return [...new Set(this.lastBySession.values())].filter((p) => !p.isClosed());
    try {
      return b.context.pages().filter((p) => !p.isClosed());
    } catch {
      return [];
    }
  }

  async tabStates(): Promise<TabState[]> {
    return await Promise.all(
      this.pages().map(async (p) => ({
        id: this.idOf(p),
        url: this.browser?.urlOf?.(p) ?? p.url(),
        title: await titleOf(p),
      })),
    );
  }

  begin(): () => void {
    this.busy++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.busy--;
    };
  }

  async pause(by: string, _front = false, hold: PauseHold = {}): Promise<boolean> {
    if (!this.gate.start(by, this.tabStates(), hold)) return false;
    const b = this.browser;
    if (b) {
      this.heldBrowser = b;
      await b.onPause?.().catch(() => {});
    }
    return true;
  }

  resume(): boolean {
    if (!this.gate.resume()) return false;
    const b = this.heldBrowser;
    this.heldBrowser = undefined;
    b?.onResume?.();
    return true;
  }
}
