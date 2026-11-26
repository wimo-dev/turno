import type { Page } from "patchright-core";

/**
 * The person's own input in the agent's Chrome window: a click, a key or a scroll they make
 * between two calls of the agent, so the agent's next call waits instead of typing over them
 * (`live.ts`, the automatic pause).
 *
 * The browser cannot say who made an input: the agent's clicks and keys go through CDP and are
 * trusted events, like the person's. So the count is of trusted input in the top document, and
 * the host only counts what came after the agent's last call ended (and after the last pause),
 * with no call running. A click into a frame of another site shows up as the top window losing
 * the focus to that frame. Input inside such a frame that does not move the focus, and input
 * while a call runs, are not seen.
 *
 * The listeners are added in Playwright's utility world (patchright's `page.evaluate` default),
 * so the page's own scripts cannot see or remove them and nothing is added to the DOM. They are
 * added again on a new document after the next call.
 */

/** What one document reports: the latest trusted input (epoch ms, 0 when none) and how many. */
export interface ActivityReport {
  last: number;
  count: number;
}

/** Adds the listeners once per document and reports. Runs in the page; it must stay self-contained. */
function pageActivity(): ActivityReport {
  const KEY = "__turnoActivity";
  const w = window as unknown as Record<string, ActivityReport | undefined>;
  const existing = w[KEY];
  if (existing) return { last: existing.last, count: existing.count };
  const state: ActivityReport = { last: 0, count: 0 };
  w[KEY] = state;
  const note = (e: Event) => {
    if (!e.isTrusted) return;
    state.last = Date.now();
    state.count++;
  };
  const options = { capture: true, passive: true } as const;
  for (const type of ["pointerdown", "keydown", "wheel"]) window.addEventListener(type, note, options);
  // A click into a cross-site frame reaches only that frame; the top window sees its focus go there.
  window.addEventListener(
    "blur",
    () => {
      if (document.activeElement?.tagName === "IFRAME") {
        state.last = Date.now();
        state.count++;
      }
    },
    options,
  );
  return { last: 0, count: 0 };
}

/** Reads the person's input on a page, adding the listeners where a new document has none. */
export class PageActivity {
  /** Per page: the count already handed out, so each read returns only new input. */
  private readonly counted = new WeakMap<Page, { count: number; last: number }>();

  /**
   * Adds the listeners to the page's current document and counts from now: called after each
   * call of the agent, so the agent's own input in that call is never taken for the person's.
   */
  async arm(page: Page | undefined): Promise<void> {
    const r = await this.report(page);
    if (r && page) this.counted.set(page, { count: r.count, last: r.last });
  }

  private async report(page: Page | undefined): Promise<ActivityReport | undefined> {
    if (!page || page.isClosed()) return undefined;
    return await page.evaluate(pageActivity).catch(() => undefined);
  }

  /**
   * The person's input on `page` after `after` (epoch ms) that this reader has not handed out
   * yet: its latest time and how many, or undefined when there was none.
   */
  async since(page: Page | undefined, after: number): Promise<{ at: number; count: number } | undefined> {
    const r = await this.report(page);
    if (!r || !page) return undefined;
    const seen = this.counted.get(page);
    // A new document starts counting from zero.
    const base = seen && r.count >= seen.count && r.last >= seen.last ? seen.count : 0;
    this.counted.set(page, { count: r.count, last: r.last });
    const fresh = r.count - base;
    if (fresh <= 0 || r.last <= after) return undefined;
    return { at: r.last, count: fresh };
  }
}
