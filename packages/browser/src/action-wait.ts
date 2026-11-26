import type { Frame, Page, Request } from "patchright-core";
import type { UpstreamTab } from "./upstream.js";

/**
 * The wait after an action, per tab. Playwright's MCP tools wait the same way after every click,
 * key press or typed text (`waitForCompletion`): they sleep `settle` (500 ms by default), wait for
 * the requests the action started (up to 5 s, or for `load` up to 10 s after a navigation), and
 * sleep `settle` again when there were any. On a page that reacts at once, most of a click is
 * that sleep.
 *
 * This wait ends as soon as the page is done with the action:
 *
 * - the requests the action started have finished, and none started for `GRACE_MS`, or none
 *   started at all in that window;
 * - after a navigation of the top document, it has committed and reached `DOMContentLoaded`;
 * - no element, attribute or text of the page changed for two animation frames.
 *
 * Upstream's own wait stays the ceiling: it never waits longer than `waitForCompletion` would.
 * A request counts as the action's when it starts within `settle` of it, as upstream counts
 * them, so a page that polls in the background does not hold the wait open.
 *
 * The DOM check runs in Playwright's utility world (an isolated world), never in the page's own:
 * the page sees no global, no element and no wrapped function, and the observer is gone when the
 * check returns.
 */

/** How long after the action (or its last request) a new request still counts as its. */
const GRACE_MS = 100;
/** Upstream's cap on the requests of an action, and on `load` after a navigation. */
const REQUEST_CAP_MS = 5_000;
const NAVIGATION_CAP_MS = 10_000;
/** Animation frames without a DOM change that make the page still. */
const QUIET_FRAMES = 2;
/** Frames whose DOM the check watches: the top one first. Pages with dozens of ad frames stay cheap. */
const MAX_FRAMES = 8;
/** The longest the wait sleeps without looking at the tab again. */
const POLL_MS = 50;
/** The resource types upstream waits to finish (body read), not only to answer. */
const FINISHED_TYPES = new Set(["document", "stylesheet", "script", "xhr", "fetch"]);

const INSTALLED = Symbol.for("turno.adaptiveWait");

/**
 * Gives one of upstream's tabs the adaptive wait in place of `waitForCompletion`. The method is
 * set on the tab itself, so every tool that waits (and every view of the tab the input layers
 * hand out) uses it. Idempotent.
 */
export function installAdaptiveWait(tab: UpstreamTab): void {
  const marked = tab as unknown as Record<symbol, boolean>;
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;
  tab.waitForCompletion = async (callback) => {
    await tab._initializedPromise;
    await tab._raceAgainstModalStates(() => settleAfter(tab, callback));
  };
}

/** Runs `callback` (the action) and waits for the page to be done with it. */
async function settleAfter<T>(tab: UpstreamTab, callback: () => Promise<T>): Promise<T> {
  const settle = Math.max(0, tab.context.config.timeouts?.settle ?? 500);
  const watch = new ActionWatch(tab.page, settle);
  let result: T;
  try {
    result = await callback();
  } catch (error) {
    watch.dispose();
    throw error;
  }
  try {
    await watch.done(() => tab.modalStates().length > 0);
  } finally {
    watch.dispose();
  }
  return result;
}

/** The requests and navigations of one action, from its start until its wait ends. */
class ActionWatch {
  private actionEnd = 0;
  private readonly pending = new Set<Request>();
  private lastRequest = -1;
  private tracked = 0;
  /** Bumped on every request that starts or ends and every commit: a DOM check older than it is stale. */
  private activity = 0;
  private navigated = false;
  private committed = false;
  private wake: (() => void) | undefined;
  private readonly onRequest = (request: Request) => this.request(request);
  private readonly onNavigated = (frame: Frame) => {
    if (frame !== this.page.mainFrame()) return;
    this.committed = true;
    this.bump();
  };
  private readonly onClose = () => this.bump();

  constructor(
    private readonly page: Page,
    private readonly settle: number,
  ) {
    page.on("request", this.onRequest);
    page.on("framenavigated", this.onNavigated);
    page.on("close", this.onClose);
  }

  dispose(): void {
    this.page.off("request", this.onRequest);
    this.page.off("framenavigated", this.onNavigated);
    this.page.off("close", this.onClose);
    this.wake?.();
  }

  private bump(): void {
    this.activity++;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private request(request: Request): void {
    const now = performance.now();
    // Started too long after the action: the page's own traffic, as upstream sees it.
    if (this.actionEnd && now > this.actionEnd + this.settle) return;
    this.tracked++;
    this.lastRequest = now;
    this.pending.add(request);
    if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) this.navigated = true;
    // A navigation counts once it is answered: its document is waited for through
    // DOMContentLoaded after the commit, and one that turns into a download never finishes.
    const answered =
      FINISHED_TYPES.has(request.resourceType()) && !request.isNavigationRequest()
        ? request.response().then((r) => r?.finished())
        : request.response();
    void answered
      .catch(() => {})
      .then(() => {
        this.pending.delete(request);
        this.bump();
      });
    this.bump();
  }

  /** The time upstream's wait would end by at the latest, from what the action started so far. */
  private ceiling(): number {
    if (!this.tracked) return this.actionEnd + this.settle;
    return this.actionEnd + this.settle + (this.navigated ? NAVIGATION_CAP_MS : REQUEST_CAP_MS) + this.settle;
  }

  /** The requests are done: none pending and none started in the last `GRACE_MS` (capped by `settle`). */
  private networkDone(now: number): boolean {
    if (this.pending.size) return false;
    const grace = Math.min(GRACE_MS, this.settle);
    const since = Math.max(this.actionEnd, this.lastRequest);
    return now >= since + grace || now >= this.actionEnd + this.settle;
  }

  /** Resolves on the next request event or commit, or after `ms`. */
  private next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.wake = undefined;
          resolve();
        },
        Math.max(0, ms),
      );
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Waits until the action's work is done, the ceiling passes, or `modal` holds. */
  async done(modal: () => boolean): Promise<void> {
    this.actionEnd = performance.now();
    const stop = () => this.page.isClosed() || modal() || performance.now() >= this.ceiling();
    while (!stop()) {
      // The DOM check runs while the network settles: on a page that reacts at once both end
      // within a few frames.
      const before = this.activity;
      const dom = domQuiet(this.page, Math.max(0, this.ceiling() - performance.now()));
      while (!stop() && !this.networkDone(performance.now())) {
        const now = performance.now();
        const grace = Math.min(GRACE_MS, this.settle);
        const graceEnd = Math.min(Math.max(this.actionEnd, this.lastRequest) + grace, this.actionEnd + this.settle);
        // In slices, so a dialog that opens meanwhile (upstream answers the call at once) ends it too.
        await this.next(Math.min(POLL_MS, (this.pending.size ? this.ceiling() : graceEnd) - now));
      }
      if (stop()) return;
      if (this.committed) {
        await this.page
          .waitForLoadState("domcontentloaded", { timeout: Math.max(1, this.ceiling() - performance.now()) })
          .catch(() => {});
        this.committed = false;
        this.bump();
      }
      const quiet = await dom;
      if (stop()) return;
      // Still for two frames, with nothing started or finished since the check began.
      if (quiet === "quiet" && this.activity === before && this.networkDone(performance.now())) return;
      // The page is busy past the ceiling (an endless animation): upstream would stop here too.
      if (quiet === "busy") return;
      if (quiet === "gone") await this.next(16);
    }
  }
}

/**
 * Runs in the utility world of a frame: resolves `true` once no node of the document (or of an
 * open shadow root in it) changed for `frames` animation frames, `false` at `maxMs`. A hidden
 * page renders no frames, so it counts 16 ms timer ticks instead. Self-contained, as Playwright
 * serializes it.
 */
function stillFor({ frames, maxMs }: { frames: number; maxMs: number }): Promise<boolean> {
  return new Promise((resolve) => {
    let dirty = false;
    let calm = 0;
    const observer = new MutationObserver(() => {
      dirty = true;
    });
    const options = { subtree: true, childList: true, attributes: true, characterData: true };
    const roots: Node[] = [document];
    while (roots.length) {
      const root = roots.pop() as Node;
      observer.observe(root, options);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const shadow = (n as Element).shadowRoot;
        if (shadow) roots.push(shadow);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (still: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(still);
    };
    timer = setTimeout(() => finish(false), maxMs);
    const tick = () => {
      if (dirty) {
        dirty = false;
        calm = 0;
      } else calm++;
      if (calm >= frames) finish(true);
      else next();
    };
    const next = () => {
      if (document.visibilityState === "hidden") setTimeout(tick, 16);
      else requestAnimationFrame(tick);
    };
    next();
  });
}

/**
 * Whether the page's frames are still: `quiet` when every watched frame was still for two frames,
 * `busy` when one kept changing until `maxMs`, `gone` when a check could not run (a navigation
 * replaced the document).
 */
async function domQuiet(page: Page, maxMs: number): Promise<"quiet" | "busy" | "gone"> {
  if (page.isClosed()) return "gone";
  const frames = page.frames().slice(0, MAX_FRAMES);
  const arg = { frames: QUIET_FRAMES, maxMs: Math.max(1, Math.round(maxMs)) };
  const looks = await Promise.all(
    frames.map(async (frame, i) => {
      try {
        // The fourth argument is patchright's: true runs it in the utility world.
        return (await frame.evaluate(stillFor, arg, undefined, true)) ? "quiet" : "busy";
      } catch {
        // A child frame that went away does not make the page busy; the top document does.
        return i === 0 ? "gone" : "quiet";
      }
    }),
  );
  if (looks.includes("gone")) return "gone";
  return looks.includes("busy") ? "busy" : "quiet";
}
