import type { CDPSession, Page } from "patchright-core";
import { AgentCursor, type AgentCursorOptions } from "./agent-cursor.js";
import type { OverlayBox, OverlayCommand, OverlayReport } from "./agent-cursor-overlay.js";

/**
 * The agent cursor drawn by Chrome itself, the default (`cursor: "auto"`): nothing goes into the
 * page. Over the DevTools protocol, the element the agent acts on gets Chrome's own highlight
 * (`Overlay.highlightRect`), and each click of the agent leaves Chrome's own ripple
 * (`Page.setInputVisualization`, Chrome 158 and later). Both are painted by the browser above the
 * page, so no page script can see them: the page's DOM, its mutation observers and its layout
 * stay as they would be without turno. They show in the window and in the live view, and the
 * highlight is hidden while the model's screenshot is taken.
 *
 * What it does not draw: the named arrow that glides to the target, the frame and badge around
 * the page, and the typing bubble. Those are elements in the page (`agent-cursor-overlay.ts`),
 * drawn with `cursor: "on"`, and as a fallback here when Chrome refuses the protocol calls (an
 * engine without them, or a Chrome too old for the ripple keeps the highlight).
 *
 * Measured on Chrome 158: `Overlay.highlightNode` is not painted into screencast frames, so the
 * live view would not show it; `highlightRect` is, which is why the box is drawn as a rectangle.
 * The ripple lasts under 150 ms and is painted into frames and screenshots alike.
 */

/** turno's blue, as the highlight draws it. */
const FILL = { r: 43, g: 89, b: 255, a: 0.12 };
const OUTLINE = { r: 43, g: 89, b: 255, a: 0.9 };

interface Drawn {
  cdp: CDPSession;
  /** The ring shown now, to show again after a screenshot. */
  box: OverlayBox | null;
}

export class BrowserDrawnCursor extends AgentCursor {
  /** Each page's protocol session, or false when Chrome refused it (then the DOM cursor draws). */
  private readonly sessions = new WeakMap<Page, Promise<Drawn | false>>();

  private readonly blocked: AgentCursorOptions["blocked"];

  constructor(options: AgentCursorOptions) {
    super({ ...options, maxGlideMs: 0 });
    this.blocked = options.blocked;
  }

  private session(page: Page): Promise<Drawn | false> {
    let s = this.sessions.get(page);
    if (!s) {
      s = (async (): Promise<Drawn | false> => {
        try {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("DOM.enable");
          await cdp.send("Overlay.enable");
          // Chrome 158's experimental ripple; an older Chrome still gets the highlight.
          const send = cdp.send.bind(cdp) as (method: string, params?: object) => Promise<unknown>;
          await send("Page.setInputVisualization", { clicks: true }).catch(() => {});
          return { cdp, box: null };
        } catch {
          return false;
        }
      })();
      this.sessions.set(page, s);
    }
    return s;
  }

  private async show(d: Drawn, box: OverlayBox | null): Promise<void> {
    d.box = box;
    if (!box) {
      await d.cdp.send("Overlay.hideHighlight").catch(() => {});
      return;
    }
    await d.cdp
      .send("Overlay.highlightRect", {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
        color: FILL,
        outlineColor: OUTLINE,
      })
      .catch(() => {});
  }

  /** What the page would report: its viewport, from the protocol rather than the page. */
  private async report(d: Drawn): Promise<OverlayReport | undefined> {
    try {
      const m = (await d.cdp.send("Page.getLayoutMetrics")) as {
        cssVisualViewport: { clientWidth: number; clientHeight: number };
      };
      return {
        reducedMotion: true,
        width: m.cssVisualViewport.clientWidth,
        height: m.cssVisualViewport.clientHeight,
        state: { connected: false, visible: false, busy: false, paused: false, badge: "", cursors: [], typing: [] },
      } as OverlayReport;
    } catch {
      return undefined;
    }
  }

  override async send(page: Page, commands: OverlayCommand[], key?: string): Promise<OverlayReport | undefined> {
    // A page's dialog holds its renderer, and the protocol calls with it.
    if (page.isClosed() || this.blocked?.(page)) return undefined;
    const d = await this.session(page);
    if (!d) return await super.send(page, commands, key);
    for (const c of commands) {
      if (c.op === "ring") await this.show(d, c.box);
      // The call ended: the element is no longer the agent's.
      else if (c.op === "busy" && !c.on) await this.show(d, null);
      else if (c.op === "remove") await this.show(d, null);
    }
    return await this.report(d);
  }

  override async hiddenDuring<T>(page: Page | undefined, fn: () => Promise<T>): Promise<T> {
    const d = page ? await this.session(page) : false;
    if (!d) return await super.hiddenDuring(page, fn);
    const box = d.box;
    if (box) await this.show(d, null);
    try {
      return await fn();
    } finally {
      if (box && d.box === null) await this.show(d, box);
    }
  }
}
