import type { CDPSession, Page } from "patchright-core";
import { AgentCursor, type AgentCursorOptions } from "./agent-cursor.js";
import type { OverlayBox, OverlayCommand, OverlayReport } from "./agent-cursor-overlay.js";
import type { HumanCue } from "./live-effects.js";

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
 *
 * The box takes the color of the action, as the live view draws it: blue for a click, a hover or
 * a drag, violet while the agent types, red for a moment when the call fails, and amber while the
 * browser waits for the person (a pause, or a person step: the step's target, else an outline
 * around the page). Chrome draws one highlight at a time, so each replaces the last.
 */

/** The tones of the highlight, from the live view's light theme. */
const TONES = {
  agent: [43, 89, 255],
  type: [106, 79, 216],
  bad: [210, 60, 60],
  human: [200, 106, 18],
} as const;
type Tone = keyof typeof TONES;

/** How long a failed call's box stays red. */
const FAILED_MS = 700;

interface Drawn {
  cdp: CDPSession;
  /** The ring shown now and its tone, to show again after a screenshot. */
  box: OverlayBox | null;
  tone: Tone;
  /** The box is an outline around the page (no fill), while the browser waits for the person. */
  outline: boolean;
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
          return { cdp, box: null, tone: "agent" as Tone, outline: false };
        } catch {
          return false;
        }
      })();
      this.sessions.set(page, s);
    }
    return s;
  }

  private async show(d: Drawn, box: OverlayBox | null, tone: Tone = "agent", outline = false): Promise<void> {
    d.box = box;
    d.tone = tone;
    d.outline = outline;
    if (!box) {
      await d.cdp.send("Overlay.hideHighlight").catch(() => {});
      return;
    }
    const [r, g, b] = TONES[tone];
    await d.cdp
      .send("Overlay.highlightRect", {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
        color: { r, g, b, a: outline ? 0 : 0.12 },
        outlineColor: { r, g, b, a: 0.9 },
      })
      .catch(() => {});
  }

  /** What the page would report: its viewport and scroll, from the protocol rather than the page. */
  private async report(d: Drawn): Promise<OverlayReport | undefined> {
    try {
      const m = (await d.cdp.send("Page.getLayoutMetrics")) as {
        cssVisualViewport: { clientWidth: number; clientHeight: number };
        cssLayoutViewport?: { pageX: number; pageY: number };
      };
      const scroll = m.cssLayoutViewport ? { x: m.cssLayoutViewport.pageX, y: m.cssLayoutViewport.pageY } : undefined;
      return {
        reducedMotion: true,
        width: m.cssVisualViewport.clientWidth,
        height: m.cssVisualViewport.clientHeight,
        ...(scroll ? { scroll } : {}),
        state: { connected: false, visible: false, busy: false, paused: false, badge: "", cursors: [], typing: [] },
      } as OverlayReport;
    } catch {
      return undefined;
    }
  }

  /** A failed call: its box turns red a moment, unless another box replaced it meanwhile. */
  private flashFailed(d: Drawn): void {
    const box = d.box;
    if (!box || d.outline) {
      void this.show(d, null);
      return;
    }
    void this.show(d, box, "bad");
    const timer = setTimeout(() => {
      if (d.box === box && d.tone === "bad") void this.show(d, null);
    }, FAILED_MS);
    timer.unref?.();
  }

  override async send(page: Page, commands: OverlayCommand[], key?: string): Promise<OverlayReport | undefined> {
    // A page's dialog holds its renderer, and the protocol calls with it.
    if (page.isClosed() || this.blocked?.(page)) return undefined;
    const d = await this.session(page);
    if (!d) return await super.send(page, commands, key);
    for (const c of commands) {
      if (c.op === "ring") await this.show(d, c.box, c.kind === "type" ? "type" : "agent");
      // The call ended: the element is no longer the agent's (a failed one shows red a moment).
      else if (c.op === "busy" && !c.on) {
        if (c.failed) this.flashFailed(d);
        else if (!d.outline) await this.show(d, null);
      } else if (c.op === "remove") await this.show(d, null);
    }
    return await this.report(d);
  }

  /**
   * While the browser waits for the person, an amber box: around the step's target when it has
   * one, else an outline just inside the page's edges. Pages with no session yet get none, except
   * the step's own page.
   */
  override async setPaused(pages: readonly Page[], on: boolean, cue?: HumanCue): Promise<void> {
    await super.setPaused(pages, on, cue);
    for (const page of pages) {
      if (page.isClosed() || this.blocked?.(page)) continue;
      const mine = cue?.page === page;
      if (!mine && !this.sessions.has(page)) continue;
      const d = await this.session(page);
      if (!d) continue;
      if (!on) {
        if (d.tone === "human") await this.show(d, null);
        continue;
      }
      if (mine && cue?.box) {
        await this.show(d, cue.box, "human");
        continue;
      }
      const view = await this.report(d);
      if (view) await this.show(d, { x: 1, y: 1, width: view.width - 2, height: view.height - 2 }, "human", true);
    }
  }

  override async hiddenDuring<T>(page: Page | undefined, fn: () => Promise<T>): Promise<T> {
    const d = page ? await this.session(page) : false;
    if (!d) return await super.hiddenDuring(page, fn);
    const { box, tone, outline } = d;
    if (box) await this.show(d, null);
    try {
      return await fn();
    } finally {
      if (box && d.box === null) await this.show(d, box, tone, outline);
    }
  }
}
