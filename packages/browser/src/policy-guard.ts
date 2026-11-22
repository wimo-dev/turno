import type { BrowserContext, Page, Request, Route } from "patchright-core";
import { type HostPattern, navigationVerdict } from "./policy.js";

/**
 * The domain check of a policy (`policy.ts`) in a running browser: every main-frame navigation of
 * every tab, whoever started it (a tool, a link, a form, a script, a popup), shows only a page of
 * an allowed host. Two layers, because Playwright routes the first request of a navigation but
 * not the hops of a redirect (patchright continues those itself, before any route or event):
 *
 * 1. A route on the whole context, registered after every other one so it runs first, aborts
 *    the main-frame document request of a host the policy does not allow, before it leaves the
 *    browser. Chrome then shows its error page, and the tab is taken back as in 2. New tabs and
 *    popups belong to the context, so they are covered from their first request. (An empty 204
 *    would keep the tab on its page, but Playwright then waits for a navigation that never ends,
 *    and a click hangs until its timeout.)
 * 2. A check on every main-frame commit takes the tab back when it shows a page the route did
 *    not stop: a redirect to another host (that request has reached the host), a `data:` or
 *    `file:` URL, history. The tab goes back to its last allowed page (in history, else loaded
 *    again); a popup that never showed one is closed, any other tab goes to about:blank.
 *
 * Subresources (scripts, images, XHR) and frames inside a page are not checked.
 */

/** A navigation the guard stopped or took back. */
export interface PolicyViolation {
  /** `performance.now()` when it happened. */
  at: number;
  /** The host (or scheme) that was refused. */
  target: string;
}

/** Longest a tool result waits for a tab being taken back. */
const REVERT_WAIT_MS = 5_000;
/** How soon after an abort an error page is that abort's (a popup's request has no page yet). */
const ABORT_ERROR_MS = 3_000;

function isMainFrameNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    // A popup's first navigation comes before its frame exists, and only a main frame has none.
    return true;
  }
}

export class NavigationGuard {
  private violations: PolicyViolation[] = [];
  private readonly pending = new Set<Promise<void>>();
  /** The last allowed http(s) page each tab showed. */
  private readonly lastGood = new WeakMap<Page, string>();
  private readonly reverting = new WeakSet<Page>();
  /** Tabs whose navigation the route aborted: Chrome's error page comes next. */
  private readonly aborted = new WeakSet<Page>();
  private lastAbort = Number.NEGATIVE_INFINITY;

  private constructor(private readonly patterns: readonly HostPattern[]) {}

  /** Installs the guard on a context; call it after every other route of the context. */
  static async install(context: BrowserContext, patterns: readonly HostPattern[]): Promise<NavigationGuard> {
    const guard = new NavigationGuard(patterns);
    await context.route("**", (route) => guard.route(route));
    for (const page of context.pages()) guard.watch(page);
    context.on("page", (page) => guard.watch(page));
    return guard;
  }

  /** What was stopped since the last call, oldest first. */
  take(): PolicyViolation[] {
    const out = this.violations;
    this.violations = [];
    return out;
  }

  /** Resolves once every tab being taken back is done (or after a few seconds). */
  async settled(): Promise<void> {
    if (!this.pending.size) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.pending]),
      new Promise<void>((r) => {
        timer = setTimeout(r, REVERT_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  private note(target: string): void {
    this.violations.push({ at: performance.now(), target });
  }

  private async route(route: Route): Promise<void> {
    const request = route.request();
    if (isMainFrameNavigation(request)) {
      const verdict = navigationVerdict(this.patterns, request.url());
      if (verdict.allowed === false) {
        this.note(verdict.target);
        this.lastAbort = performance.now();
        try {
          this.aborted.add(request.frame().page());
        } catch {
          /* a popup's first request: its error page is matched by time */
        }
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
    }
    await route.fallback().catch(() => {});
  }

  private watch(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.committed(page, frame.url());
    });
    // A popup can commit before the context reports it.
    this.committed(page, page.url());
  }

  private committed(page: Page, url: string): void {
    if (!url) return;
    const verdict = navigationVerdict(this.patterns, url);
    if (verdict.allowed === true) {
      if (/^https?:/.test(url)) this.lastGood.set(page, url);
      return;
    }
    if (verdict.allowed === "error-page") {
      // Chrome's error page after the route's abort goes; one for a network error stays.
      const ours = this.aborted.delete(page) || performance.now() - this.lastAbort < ABORT_ERROR_MS;
      if (ours) this.revert(page);
      return;
    }
    this.note(verdict.target);
    this.revert(page);
  }

  private revert(page: Page): void {
    if (this.reverting.has(page) || page.isClosed()) return;
    this.reverting.add(page);
    const run: Promise<void> = (async () => {
      const good = this.lastGood.get(page);
      if (!good) {
        if (await page.opener().catch(() => null)) await page.close();
        else if (page.url() !== "about:blank") await page.goto("about:blank");
        return;
      }
      const back = () => !page.isClosed() && navigationVerdict(this.patterns, page.url()).allowed === true;
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
      // History can be gone or busy with the navigation that brought the tab here: load the page.
      if (!back()) await page.goto(good, { waitUntil: "domcontentloaded" }).catch(() => null);
      if (!back() && !page.isClosed()) await page.goto("about:blank");
    })()
      .catch(() => {})
      .finally(() => {
        this.reverting.delete(page);
        this.pending.delete(run);
      });
    this.pending.add(run);
  }
}
