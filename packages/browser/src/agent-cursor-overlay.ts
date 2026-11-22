/**
 * The agent cursor's page side: one function the host evaluates in a page with a batch of
 * commands (`agent-cursor.ts`). It runs in Playwright's utility world (patchright's
 * `page.evaluate` default), so the state it keeps on `window` is out of the page's own scripts'
 * reach, and it must stay self-contained: it is sent to the page as source, without imports.
 *
 * What it draws lives in a closed shadow root on one host element under `<html>` (never in
 * `<body>`, so `document.body.innerText` never holds it). The host is `aria-hidden` and `inert`
 * (out of the accessibility tree, so out of every snapshot), `pointer-events: none` (never a
 * target of a click or of `elementFromPoint`, so Playwright's hit test and "covered" check see
 * through it) and `position: fixed` with `contain: strict` (no layout, no scroll of its own).
 * It builds nodes with `createElement` and styles them through the CSSOM, so a page's Trusted
 * Types or style CSP does not stop it.
 */

/** A rectangle in viewport CSS pixels. */
export interface OverlayBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The badge's words, in the person's language (`ui-strings.ts`). `{name}`: the agent's name. */
export interface OverlayText {
  working: string;
  workingAs: string;
  paused: string;
}

/** One instruction for the overlay. `key` names a cursor (one per agent session). */
export type OverlayCommand =
  | { op: "text"; text: OverlayText }
  | { op: "actor"; key: string; label: string; name: string; color: string }
  | { op: "move"; key: string; x: number; y: number; ms: number }
  | { op: "ring"; key: string; box: OverlayBox | null }
  | { op: "ripple"; key: string; x: number; y: number }
  | { op: "typing"; key: string; box: OverlayBox | null }
  | { op: "busy"; key: string; on: boolean }
  /** How many other sessions have a call in flight on this browser, on any page: the badge's "+N". */
  | { op: "others"; n: number }
  | { op: "paused"; on: boolean }
  | { op: "visible"; on: boolean }
  | { op: "remove" };

/** What a batch reports back: the motion preference and the viewport, for the host's glide. */
export interface OverlayReport {
  reducedMotion: boolean;
  width: number;
  height: number;
  /** What the overlay shows now; tests read it, since its DOM is behind a closed shadow root. */
  state: {
    connected: boolean;
    visible: boolean;
    busy: boolean;
    paused: boolean;
    badge: string;
    /** `moves`: how many times the arrow was sent somewhere; `pill`: the side its label is on. */
    cursors: { key: string; label: string; x: number; y: number; moves: number; pill: "right" | "left" }[];
    /** The sessions whose typing bubble shows. */
    typing: string[];
  };
}

/**
 * Applies `commands` to the page's overlay, building it first when the page has none (a new
 * document after a navigation, or a host the page removed). Runs in the page.
 */
export function cursorOverlay(commands: OverlayCommand[]): OverlayReport {
  // The global the overlay keeps its parts under, in the utility world only.
  const GLOBAL = "__turnoAgentCursor";
  type Cursor = {
    el: HTMLElement;
    pill: HTMLElement;
    label: string;
    name: string;
    color: string;
    x: number;
    y: number;
    moves: number;
  };
  type Parts = {
    doc: Document;
    host: HTMLElement;
    root: ShadowRoot;
    shell: HTMLElement;
    frame: HTMLElement;
    badge: HTMLElement;
    badgeText: HTMLElement;
    layer: HTMLElement;
    cursors: Map<string, Cursor>;
    rings: Map<string, HTMLElement>;
    typing: Map<string, HTMLElement>;
    timers: Map<string, number>;
    busy: Set<string>;
    /** The other sessions at work on this browser's other pages (`others`). */
    others: number;
    lastBusy: string;
    paused: boolean;
    visible: boolean;
    reduced: boolean;
    text: OverlayText;
  };
  const w = window as unknown as Record<string, Parts | undefined>;
  const important = (el: HTMLElement, props: Record<string, string>) => {
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
  };
  const CSS = `
    *{box-sizing:border-box}
    .shell{position:fixed;inset:0;pointer-events:none;font:600 12px/16px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em}
    .frame{position:fixed;inset:0;border:2px solid var(--c);border-radius:2px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),inset 0 0 28px color-mix(in srgb,var(--c) 22%,transparent);opacity:0;transition:opacity .35s ease}
    .badge{position:fixed;top:10px;left:50%;display:flex;align-items:center;gap:7px;padding:5px 11px 5px 9px;border-radius:999px;background:var(--c);color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.22),0 0 0 1px rgba(255,255,255,.25);white-space:nowrap;opacity:0;transform:translate(-50%,-8px);transition:opacity .35s ease,transform .35s ease}
    .dot{width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 0 0 rgba(255,255,255,.7);animation:pulse 1.4s ease-out infinite}
    .on .frame{opacity:1}
    .on .badge{opacity:1;transform:translate(-50%,0)}
    .paused .frame{border-style:dashed}
    .paused .dot{animation:none;border-radius:1px;width:6px;height:8px;background:linear-gradient(90deg,#fff 0 35%,transparent 35% 65%,#fff 65%)}
    .cursor{position:fixed;left:0;top:0;transform:translate(var(--x),var(--y));transition:transform var(--ms) cubic-bezier(.22,.61,.36,1),opacity .4s ease;will-change:transform}
    .cursor svg{display:block;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}
    .pill{position:absolute;left:15px;top:19px;padding:3px 8px;border-radius:3px 10px 10px 10px;background:var(--c);color:#fff;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.2)}
    .fx .pill{left:auto;right:calc(100% - 4px);border-radius:10px 3px 10px 10px}
    .fy .pill{top:auto;bottom:calc(100% - 6px);border-radius:10px 10px 10px 3px}
    .fx.fy .pill{border-radius:10px 10px 3px 10px}
    .idle .cursor{opacity:.6}
    .ring{position:fixed;border:2px solid var(--c);border-radius:7px;box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 20%,transparent);opacity:0;transition:opacity .25s ease,left .2s ease,top .2s ease,width .2s ease,height .2s ease}
    .ring.show{opacity:1}
    .ripple{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid var(--c);background:color-mix(in srgb,var(--c) 25%,transparent);animation:ripple .6s ease-out forwards}
    .typing{position:fixed;display:flex;align-items:center;gap:3px;padding:4px 7px;border-radius:10px;background:var(--c);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.2)}
    .typing i{width:4px;height:4px;border-radius:50%;background:#fff;animation:blink 1s infinite}
    .typing i:nth-child(2){animation-delay:.15s}
    .typing i:nth-child(3){animation-delay:.3s}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.7)}70%{box-shadow:0 0 0 6px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
    @keyframes ripple{to{transform:scale(3.4);opacity:0}}
    @keyframes blink{0%,100%{opacity:.35}50%{opacity:1}}
    @media (prefers-reduced-motion: reduce){
      .frame,.badge,.cursor,.ring{transition:none}
      .dot,.typing i{animation:none}
      .ripple{animation-duration:.01s}
    }`;

  const build = (): Parts => {
    const host = document.createElement("turno-agent-cursor");
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    important(host, {
      all: "initial",
      display: "block",
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      margin: "0",
      padding: "0",
      border: "0",
      "z-index": "2147483647",
      "pointer-events": "none",
      contain: "strict",
      overflow: "hidden",
      background: "transparent",
    });
    const root = host.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = CSS;
      root.append(style);
    }
    const shell = document.createElement("div");
    shell.className = "shell idle";
    const frame = document.createElement("div");
    frame.className = "frame";
    const badge = document.createElement("div");
    badge.className = "badge";
    const dot = document.createElement("span");
    dot.className = "dot";
    const badgeText = document.createElement("span");
    badge.append(dot, badgeText);
    const layer = document.createElement("div");
    shell.append(frame, layer, badge);
    root.append(shell);
    document.documentElement.append(host);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    return {
      doc: document,
      host,
      root,
      shell,
      frame,
      badge,
      badgeText,
      layer,
      cursors: new Map(),
      rings: new Map(),
      typing: new Map(),
      timers: new Map(),
      busy: new Set(),
      others: 0,
      lastBusy: "",
      paused: false,
      visible: true,
      reduced,
      // Every batch from the host starts with the words (`text`).
      text: { working: "", workingAs: "", paused: "" },
    };
  };

  let p = w[GLOBAL];
  if (!p || p.doc !== document) {
    p = build();
    w[GLOBAL] = p;
  } else if (!p.host.isConnected) {
    // The page replaced <html>'s children (or the host itself): put it back.
    document.documentElement.append(p.host);
  }
  const parts = p;

  const later = (name: string, ms: number, fn: () => void) => {
    const old = parts.timers.get(name);
    if (old !== undefined) clearTimeout(old);
    parts.timers.set(
      name,
      window.setTimeout(() => {
        parts.timers.delete(name);
        fn();
      }, ms),
    );
  };

  const cursorFor = (key: string): Cursor => {
    let c = parts.cursors.get(key);
    if (c) return c;
    const el = document.createElement("div");
    el.className = "cursor";
    el.style.setProperty("--c", "#2b59ff");
    el.style.setProperty("--x", "-40px");
    el.style.setProperty("--y", "-40px");
    el.style.setProperty("--ms", "0ms");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "26");
    svg.setAttribute("viewBox", "0 0 22 26");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // A Figma-like arrow, its tip at (2, 2).
    path.setAttribute("d", "M2 2 L2 21 L7.2 16.3 L10.6 23.6 L14 22.1 L10.6 14.9 L17.6 14.9 Z");
    path.setAttribute("fill", "var(--c)");
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    const pill = document.createElement("div");
    pill.className = "pill";
    el.append(svg, pill);
    parts.layer.append(el);
    c = { el, pill, label: "", name: "", color: "#2b59ff", x: -40, y: -40, moves: 0 };
    parts.cursors.set(key, c);
    return c;
  };

  const colorOf = (key: string) => parts.cursors.get(key)?.color ?? "#2b59ff";

  const paintBadge = () => {
    const on = parts.busy.size > 0 || parts.paused;
    parts.shell.classList.toggle("on", on);
    parts.shell.classList.toggle("idle", !on);
    parts.shell.classList.toggle("paused", parts.paused);
    const key = parts.busy.has(parts.lastBusy) ? parts.lastBusy : ([...parts.busy][0] ?? parts.lastBusy);
    const color = parts.paused ? "#5c5f66" : colorOf(key);
    parts.frame.style.setProperty("--c", color);
    parts.badge.style.setProperty("--c", color);
    const name = parts.cursors.get(key)?.name;
    // The other sessions at work: those on this page, or on the browser's other pages (shared
    // tabs), whichever says more.
    const n = Math.max(parts.busy.size - 1, parts.others);
    const others = n > 0 ? ` +${n}` : "";
    parts.badgeText.textContent = parts.paused
      ? parts.text.paused
      : `${name ? parts.text.workingAs.split("{name}").join(name) : parts.text.working}${others}`;
  };

  for (const cmd of commands) {
    switch (cmd.op) {
      case "text":
        parts.text = cmd.text;
        paintBadge();
        break;
      case "actor": {
        const c = cursorFor(cmd.key);
        c.label = cmd.label;
        c.name = cmd.name;
        c.color = cmd.color;
        c.pill.textContent = cmd.label;
        c.el.style.setProperty("--c", cmd.color);
        break;
      }
      case "move": {
        const c = cursorFor(cmd.key);
        c.x = cmd.x;
        c.y = cmd.y;
        c.el.style.setProperty("--ms", `${parts.reduced ? 0 : Math.max(0, Math.round(cmd.ms))}ms`);
        // The arrow's tip is 2px into its box.
        c.el.style.setProperty("--x", `${Math.round(cmd.x - 2)}px`);
        c.el.style.setProperty("--y", `${Math.round(cmd.y - 2)}px`);
        c.moves++;
        // The label goes left of the arrow near the right edge, and above it near the bottom, so
        // it stays inside the page.
        const pw = c.pill.offsetWidth || 8 * c.label.length + 16;
        const ph = c.pill.offsetHeight || 22;
        c.el.classList.toggle("fx", cmd.x + 13 + pw + 4 > window.innerWidth);
        c.el.classList.toggle("fy", cmd.y + 17 + ph + 4 > window.innerHeight);
        break;
      }
      case "ring": {
        let ring = parts.rings.get(cmd.key);
        if (!cmd.box) {
          ring?.classList.remove("show");
          break;
        }
        if (!ring) {
          ring = document.createElement("div");
          ring.className = "ring";
          parts.layer.prepend(ring);
          parts.rings.set(cmd.key, ring);
        }
        const pad = 4;
        ring.style.setProperty("--c", colorOf(cmd.key));
        ring.style.left = `${Math.round(cmd.box.x - pad)}px`;
        ring.style.top = `${Math.round(cmd.box.y - pad)}px`;
        ring.style.width = `${Math.round(cmd.box.width + 2 * pad)}px`;
        ring.style.height = `${Math.round(cmd.box.height + 2 * pad)}px`;
        ring.classList.add("show");
        const r = ring;
        later(`ring:${cmd.key}`, 1600, () => r.classList.remove("show"));
        break;
      }
      case "ripple": {
        const dot = document.createElement("div");
        dot.className = "ripple";
        dot.style.setProperty("--c", colorOf(cmd.key));
        dot.style.left = `${Math.round(cmd.x)}px`;
        dot.style.top = `${Math.round(cmd.y)}px`;
        parts.layer.append(dot);
        window.setTimeout(() => dot.remove(), 700);
        break;
      }
      case "typing": {
        const old = parts.typing.get(cmd.key);
        if (!cmd.box) {
          if (!old) break;
          // A fill ends within a frame: the bubble stays up a moment so a person sees it at all.
          const drop = () => {
            old.remove();
            if (parts.typing.get(cmd.key) === old) parts.typing.delete(cmd.key);
          };
          const wait = 900 - (Date.now() - Number(old.dataset.since ?? 0));
          if (wait > 0) later(`typing:${cmd.key}`, wait, drop);
          else drop();
          break;
        }
        const pending = parts.timers.get(`typing:${cmd.key}`);
        if (pending !== undefined) {
          clearTimeout(pending);
          parts.timers.delete(`typing:${cmd.key}`);
        }
        const bubble = old ?? document.createElement("div");
        if (!old) {
          bubble.dataset.since = String(Date.now());
          bubble.className = "typing";
          bubble.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
          parts.layer.append(bubble);
          parts.typing.set(cmd.key, bubble);
        }
        bubble.style.setProperty("--c", colorOf(cmd.key));
        const right = cmd.box.x + cmd.box.width;
        bubble.style.left = `${Math.round(Math.min(right + 6, window.innerWidth - 40))}px`;
        bubble.style.top = `${Math.round(Math.max(cmd.box.y + cmd.box.height / 2 - 9, 2))}px`;
        break;
      }
      case "busy": {
        if (cmd.on) {
          parts.busy.add(cmd.key);
          parts.lastBusy = cmd.key;
          const t = parts.timers.get(`idle:${cmd.key}`);
          if (t !== undefined) {
            clearTimeout(t);
            parts.timers.delete(`idle:${cmd.key}`);
          }
          paintBadge();
        } else {
          // The frame stays a moment after a call, so a run of calls reads as one stretch of work.
          later(`idle:${cmd.key}`, 2500, () => {
            parts.busy.delete(cmd.key);
            paintBadge();
          });
        }
        break;
      }
      case "paused":
        parts.paused = cmd.on;
        paintBadge();
        break;
      case "others":
        if (parts.others !== cmd.n) {
          parts.others = cmd.n;
          paintBadge();
        }
        break;
      case "visible":
        parts.visible = cmd.on;
        parts.host.style.setProperty("visibility", cmd.on ? "visible" : "hidden", "important");
        break;
      case "remove":
        for (const t of parts.timers.values()) clearTimeout(t);
        parts.host.remove();
        w[GLOBAL] = undefined;
        break;
    }
  }

  const current = w[GLOBAL];
  return {
    reducedMotion: parts.reduced,
    width: window.innerWidth,
    height: window.innerHeight,
    state: {
      connected: current !== undefined && parts.host.isConnected,
      visible: parts.visible,
      busy: parts.busy.size > 0,
      paused: parts.paused,
      badge: parts.badgeText.textContent ?? "",
      cursors: [...parts.cursors.entries()].map(([key, c]) => ({
        key,
        label: c.label,
        x: c.x,
        y: c.y,
        moves: c.moves,
        pill: c.el.classList.contains("fx") ? ("left" as const) : ("right" as const),
      })),
      typing: [...parts.typing.keys()],
    },
  };
}
