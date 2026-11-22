/**
 * The page side of a person step (`browser_request_human`): one function the host evaluates in
 * a frame, like the agent cursor's overlay (`agent-cursor-overlay.ts`). It runs in Playwright's
 * utility world (patchright's `page.evaluate` default), so the state it keeps on `window` is out
 * of the page's own scripts' reach, and it must stay self-contained: it is sent as source.
 *
 * Two parts, each in a closed shadow root on a host element under `<html>` (never in `<body>`):
 *
 * - the banner, in the top frame: a card fixed at the bottom of the page with the instruction
 *   and a Done button. It counts the person's clicks in the page and the fields they changed
 *   (never what they typed), and Done only from a trusted event (`isTrusted`), so a page script
 *   cannot press it;
 * - the target, in the frame of the element the agent pointed at: a ring around it, and whether
 *   the person pressed or clicked it, from trusted events only.
 *
 * A new document has neither part: the host evaluates the banner again on each poll, which
 * builds it on the new document. A trusted event is one the browser made from input: the
 * person's own mouse and keys, or the live view's (CDP input). The agent's calls are held while
 * the step lasts, so no agent input reaches the page then.
 */

/** What the banner says, from the host's strings table. */
export interface StepView {
  /** The step this banner belongs to: a new step replaces an old banner. */
  step: string;
  lang: string;
  title: string;
  instruction: string;
  hint: string;
  /** The Done button's label, or null for no button. */
  done: string | null;
}

export type StepCommand = { op: "banner"; view: StepView } | { op: "target"; step: string } | { op: "remove" };

/** What one document reports. Counts are of this document only; the host adds them up. */
export interface StepReport {
  /** A random key of this document's parts: a new document gets a new one. */
  doc: string;
  /** The banner is on the page now. */
  shown: boolean;
  /** The person pressed Done (a trusted click). */
  done: boolean;
  /** Trusted clicks outside the banner. */
  clicks: number;
  /** Fields the person changed (each counted once). */
  fields: number;
  /** One of them was a password or one-time code field. */
  sensitive: boolean;
  /** Where the Done button is, in viewport pixels (tests click it; its DOM is behind a closed root). */
  doneBox: { x: number; y: number; width: number; height: number } | null;
  /** The target's part, in the frame it was evaluated in. */
  target?: { connected: boolean; pressed: boolean; clicked: boolean };
}

/** Applies one command in this frame and reports. Runs in the page. */
export function humanStepOverlay(arg: { cmd: StepCommand; el?: Element }): StepReport {
  const GLOBAL = "__turnoHumanStep";
  const COLOR = "#2b59ff";
  type Banner = {
    doc: Document;
    step: string;
    key: string;
    host: HTMLElement;
    button: HTMLElement | null;
    done: boolean;
    clicks: number;
    fields: number;
    seen: WeakSet<EventTarget>;
    sensitive: boolean;
    off: () => void;
  };
  type Target = {
    doc: Document;
    step: string;
    key: string;
    el: Element;
    host: HTMLElement;
    ring: HTMLElement;
    pressed: boolean;
    clicked: boolean;
    off: () => void;
  };
  type State = { banner?: Banner; target?: Target };
  const w = window as unknown as Record<string, State | undefined>;
  const state: State = w[GLOBAL] ?? {};
  w[GLOBAL] = state;
  const { cmd } = arg;

  const randomKey = () => Math.random().toString(36).slice(2, 10);
  const important = (el: HTMLElement, props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
  };
  const makeHost = (tag: string, inert: boolean): { host: HTMLElement; root: ShadowRoot } => {
    const host = document.createElement(tag);
    if (inert) {
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("inert", "");
    }
    important(host, {
      all: "initial",
      display: "block",
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      overflow: "visible",
      "z-index": "2147483647",
      "pointer-events": "none",
      background: "transparent",
    });
    return { host, root: host.attachShadow({ mode: "closed" }) };
  };
  const style = (root: ShadowRoot, css: string) => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const el = document.createElement("style");
      el.textContent = css;
      root.append(el);
    }
  };
  const el = (tag: string, cls: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const isEditable = (node: EventTarget | null): node is HTMLElement => {
    if (!node || !(node as Element).tagName) return false;
    const tag = (node as Element).tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (node as HTMLElement).isContentEditable;
  };
  const isSensitive = (node: HTMLElement) => {
    if (node.tagName !== "INPUT") return false;
    const input = node as HTMLInputElement;
    return input.type === "password" || /password|one-time-code/.test(input.autocomplete || "");
  };
  const firstOf = (e: Event) => (e.composedPath()[0] ?? e.target) as EventTarget | null;

  const removeBanner = () => {
    state.banner?.off();
    state.banner?.host.remove();
    state.banner = undefined;
  };
  const removeTarget = () => {
    state.target?.off();
    state.target?.host.remove();
    state.target = undefined;
  };

  const BANNER_CSS = `
    *{box-sizing:border-box}
    .card{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);width:min(560px,calc(100vw - 32px));display:flex;gap:14px;align-items:flex-end;padding:14px 16px 14px 14px;border-radius:12px;border:1px solid rgba(0,0,0,.1);border-left:4px solid ${COLOR};background:#fff;color:#1b1d22;box-shadow:0 12px 32px rgba(0,0,0,.24);font:400 14px/20px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;pointer-events:auto;text-align:left}
    .text{flex:1;min-width:0}
    .title{font-weight:700;font-size:13px;line-height:18px;color:${COLOR};margin:0 0 2px}
    .instruction{font-size:15px;line-height:21px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;margin:0}
    .hint{margin:6px 0 0;font-size:12px;line-height:16px;color:#5c5f66}
    button{flex:none;padding:8px 18px;border:0;border-radius:8px;background:${COLOR};color:#fff;font:600 14px/20px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer}
    button:hover{filter:brightness(1.08)}
    button:focus-visible{outline:3px solid rgba(43,89,255,.45);outline-offset:2px}
    @media (prefers-color-scheme: dark){
      .card{background:#1f2126;color:#f1f2f4;border-color:rgba(255,255,255,.12);border-left-color:${COLOR}}
      .hint{color:#a4a8b0}
      .title{color:#7d9bff}
    }`;
  const TARGET_CSS = `
    .ring{position:fixed;border:3px solid ${COLOR};border-radius:8px;box-shadow:0 0 0 6px rgba(43,89,255,.22);pointer-events:none;animation:pulse 1.6s ease-in-out infinite}
    @keyframes pulse{50%{box-shadow:0 0 0 11px rgba(43,89,255,.06)}}
    @media (prefers-reduced-motion: reduce){.ring{animation:none}}`;

  const buildBanner = (view: StepView): Banner => {
    const { host, root } = makeHost("turno-human-step", false);
    style(root, BANNER_CSS);
    const card = el("div", "card");
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", view.title);
    card.setAttribute("lang", view.lang);
    const text = el("div", "text");
    const instruction = el("p", "instruction", view.instruction);
    instruction.setAttribute("aria-live", "polite");
    text.append(el("p", "title", view.title), instruction, el("p", "hint", view.hint));
    card.append(text);
    const banner: Banner = {
      doc: document,
      step: view.step,
      key: randomKey(),
      host,
      button: null,
      done: false,
      clicks: 0,
      fields: 0,
      seen: new WeakSet(),
      sensitive: false,
      off: () => {},
    };
    if (view.done !== null) {
      const button = el("button", "", view.done);
      button.setAttribute("type", "button");
      // Only the browser's own input counts: a click a script dispatches is not trusted.
      button.addEventListener("click", (e) => {
        if (e.isTrusted) banner.done = true;
      });
      card.append(button);
      banner.button = button;
    }
    root.append(card);
    const onClick = (e: Event) => {
      if (!e.isTrusted || e.composedPath().includes(host)) return;
      banner.clicks++;
    };
    const onField = (e: Event) => {
      const node = firstOf(e);
      if (!e.isTrusted || !isEditable(node)) return;
      if (isSensitive(node)) banner.sensitive = true;
      if (banner.seen.has(node)) return;
      banner.seen.add(node);
      banner.fields++;
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("input", onField, true);
    window.addEventListener("change", onField, true);
    banner.off = () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("input", onField, true);
      window.removeEventListener("change", onField, true);
    };
    document.documentElement.append(host);
    return banner;
  };

  const placeRing = (t: Target) => {
    const r = t.el.isConnected ? t.el.getBoundingClientRect() : undefined;
    if (!r || (r.width === 0 && r.height === 0)) {
      t.ring.style.display = "none";
      return;
    }
    const pad = 5;
    t.ring.style.display = "block";
    t.ring.style.left = `${Math.round(r.left - pad)}px`;
    t.ring.style.top = `${Math.round(r.top - pad)}px`;
    t.ring.style.width = `${Math.round(r.width + 2 * pad)}px`;
    t.ring.style.height = `${Math.round(r.height + 2 * pad)}px`;
  };

  const buildTarget = (step: string, target: Element): Target => {
    const { host, root } = makeHost("turno-human-target", true);
    style(root, TARGET_CSS);
    const ring = el("div", "ring");
    root.append(ring);
    const t: Target = {
      doc: document,
      step,
      key: randomKey(),
      el: target,
      host,
      ring,
      pressed: false,
      clicked: false,
      off: () => {},
    };
    const on = (e: Event) => e.isTrusted && e.composedPath().includes(target);
    const onDown = (e: Event) => {
      if (on(e)) t.pressed = true;
    };
    const onClick = (e: Event) => {
      if (on(e)) t.clicked = true;
    };
    const onMove = () => placeRing(t);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("scroll", onMove, { capture: true, passive: true });
    window.addEventListener("resize", onMove, { passive: true });
    t.off = () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
    document.documentElement.append(host);
    placeRing(t);
    return t;
  };

  switch (cmd.op) {
    case "banner": {
      const b = state.banner;
      if (!b || b.doc !== document || b.step !== cmd.view.step) {
        if (b && b.doc === document) removeBanner();
        state.banner = buildBanner(cmd.view);
      } else if (!b.host.isConnected) {
        // The page replaced <html>'s children (or the host itself): put it back.
        document.documentElement.append(b.host);
      }
      break;
    }
    case "target": {
      const t = state.target;
      if (t && t.doc === document && t.step === cmd.step && (!arg.el || t.el === arg.el)) {
        if (!t.host.isConnected) document.documentElement.append(t.host);
      } else if (arg.el) {
        if (t && t.doc === document) removeTarget();
        state.target = buildTarget(cmd.step, arg.el);
      }
      if (state.target && state.target.doc === document) placeRing(state.target);
      break;
    }
    case "remove":
      removeBanner();
      removeTarget();
      w[GLOBAL] = undefined;
      break;
  }

  const b = state.banner && state.banner.doc === document ? state.banner : undefined;
  const r = b?.button?.isConnected ? b.button.getBoundingClientRect() : undefined;
  const t = state.target && state.target.doc === document ? state.target : undefined;
  return {
    doc: b?.key ?? t?.key ?? "",
    shown: b !== undefined && b.host.isConnected,
    done: b?.done ?? false,
    clicks: b?.clicks ?? 0,
    fields: b?.fields ?? 0,
    sensitive: b?.sensitive ?? false,
    doneBox: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    ...(t ? { target: { connected: t.el.isConnected, pressed: t.pressed, clicked: t.clicked } } : {}),
  };
}
