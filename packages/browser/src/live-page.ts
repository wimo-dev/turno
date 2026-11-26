import { TOOL_KINDS } from "./live-effects.js";
import { stageScript } from "./live-stage.js";
import { names } from "./names.js";
import { type UiLocale, fill, uiStrings } from "./ui-strings.js";

/**
 * The live view page: one HTML document with its style and script inline, allowed by a nonce
 * in the Content-Security-Policy. It reads the server's events (`/events`: the state, the frames
 * of the tab it shows, the steps of the timeline and the effects of each action), and posts
 * Pause, Hand back, the tab to show and the user's clicks, keys and scrolls (which pause the agent
 * first when it works).
 *
 * Laid out as a panel: a header with the state, then the picture of the tab on a stage, with the
 * "Now" card and the step timeline next to it (under it in a narrow window). Over the picture a
 * canvas draws each kind of action in its own way and color (`live-stage.ts`): a box that
 * converges on the target, a ripple where a click lands, a scan while the agent reads, the
 * picture dissolving as it navigates, an amber band and a card when the agent waits for the
 * person. The agent's named cursor and a label with the action float over it too.
 *
 * New steps and changes of state are announced to screen readers (`aria-live`); the picture and
 * the effects stay out of it. Text from pages (titles, URLs, targets) only ever goes into
 * `textContent`, never into HTML; the only markup the script builds is its own icons. Its words
 * come from the identity's language (`ui-strings.ts`): the script reads them from `T`.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f3f4f7; --panel: #ffffff; --sunk: #e9ebf0; --line: #d8dce5; --fg: #161a22; --muted: #5d6576;
  --agent: #3b5bdb; --read: #0b8ea3; --type: #6a4fd8; --human: #c86a12; --bad: #d23c3c; --ok: #188a55;
  --chrome: #ececea; --chrome-fg: #3b3f47; --shadow: rgba(0, 0, 0, .28);
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0d12; --panel: #12151c; --sunk: #0f1218; --line: #232835; --fg: #e7eaf1; --muted: #8b93a5;
    --agent: #7d9bff; --read: #4fd6e8; --type: #a793ff; --human: #ffb057; --bad: #ff6b6b; --ok: #58dc9c;
    --chrome: #1b1f29; --chrome-fg: #c4c9d4; --shadow: rgba(0, 0, 0, .6);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--sans); }
button { font: inherit; color: inherit; }
button:focus-visible, #frame:focus-visible { outline: 2px solid var(--agent); outline-offset: 2px; }
.wrap { max-width: 1480px; margin: 0 auto; padding: 12px 16px 20px; display: grid; gap: 12px; }

header.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 9px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.brand { font-weight: 600; letter-spacing: -.01em; white-space: nowrap; }
.brand span { color: var(--muted); font-weight: 400; }
.chip { font: 12px/1 var(--mono); padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); max-width: 30ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip:empty { display: none; }
.pill { --c: var(--muted); display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 11px 6px 8px; border-radius: 999px; background: color-mix(in srgb, var(--c) 14%, transparent); color: var(--c); font-weight: 500; transition: background .3s, color .3s; }
#status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pix { flex: none; width: 14px; height: 14px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; }
.pix i { background: currentColor; border-radius: 1px; opacity: .3; }
.pix i:nth-child(5) { opacity: .95; }
.pill.run .pix i:nth-child(odd) { opacity: .7; }
.spacer { flex: 1; }
.btn { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--sunk); }
.btn:disabled { opacity: .4; cursor: default; }
.btn.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.btn.primary:disabled { display: none; }

nav { display: flex; flex-wrap: wrap; gap: 6px; }
nav button { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; }
nav button.on { border-color: var(--agent); color: var(--agent); }

.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
main { min-width: 0; display: grid; gap: 8px; }
#notice { color: var(--human); min-height: 1.4em; }
#notice:empty { display: none; }

.stage { position: relative; padding: clamp(12px, 2.4vw, 30px); border-radius: 16px; background: var(--sunk); border: 1px solid var(--line); overflow: hidden; isolation: isolate; }
.stage.nogl[data-edge="human"] { box-shadow: inset 0 0 0 3px var(--human); }
.stage.nogl[data-edge="bad"] { box-shadow: inset 0 0 0 3px var(--bad); }
#fx { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3; }
.nogl #fx { display: none; }
.browser { position: relative; z-index: 1; width: fit-content; max-width: 100%; min-width: min(100%, 420px); margin: 0 auto; border-radius: 10px; overflow: hidden; background: var(--panel); box-shadow: 0 1px 0 var(--line), 0 20px 50px -24px var(--shadow); }
.browser.shake { animation: shake .4s; }
@keyframes shake { 20%, 60% { transform: translateX(-4px) } 40%, 80% { transform: translateX(4px) } }
.urlbar { display: flex; align-items: center; gap: 10px; padding: 7px 10px; background: var(--chrome); border-bottom: 1px solid var(--line); }
.dots { display: flex; gap: 6px; } .dots i { width: 10px; height: 10px; border-radius: 50%; background: color-mix(in srgb, var(--chrome-fg) 30%, transparent); }
.url { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 6px; background: var(--panel); font: 12px/1 var(--mono); color: var(--chrome-fg); overflow: hidden; white-space: nowrap; }
.url svg { flex: none; }
#url { overflow: hidden; text-overflow: ellipsis; }
#urlprog { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--agent); opacity: 0; transition: width .5s ease, opacity .4s; }
.screen { position: relative; display: grid; place-items: center; min-height: 220px; background: #fff; overflow: hidden; }
#frame { display: block; max-width: 100%; max-height: calc(100vh - 200px); width: auto; height: auto; outline: none; }
#frame:not([src]) { display: none; }
#empty { padding: 48px 24px; color: var(--muted); background: var(--panel); text-align: center; width: 100%; }
#frame[src] ~ #empty { display: none; }
#dim { position: absolute; inset: 0; background: rgba(10, 12, 18, .42); transition: opacity .3s; opacity: 0; pointer-events: none; }
#dim.on { opacity: 1; }

/* Drawn over the picture by the view itself: never part of the page. */
.over { position: absolute; left: 0; top: 0; pointer-events: none; }
#cursor { z-index: 4; opacity: 0; transition: transform .5s cubic-bezier(.3, .8, .25, 1), opacity .3s; will-change: transform; }
#cursor.on { opacity: 1; }
#cursor.dim { opacity: .35; }
#cursor svg { display: block; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .35)); }
#cursor path { fill: var(--c, var(--agent)); stroke: #fff; stroke-width: 1.4; stroke-linejoin: round; }
#cursor .who { position: absolute; left: 16px; top: 18px; font: 11px/1 var(--mono); padding: 4px 6px; border-radius: 5px; color: #fff; background: var(--c, var(--agent)); white-space: nowrap; transition: background .3s; }
#tag { z-index: 4; font: 11px/1 var(--mono); padding: 5px 7px; border-radius: 6px; color: #fff; background: var(--c, var(--agent)); white-space: nowrap; max-width: 46ch; overflow: hidden; text-overflow: ellipsis; opacity: 0; transform: translateY(4px); transition: opacity .2s, transform .2s; }
#tag.on { opacity: 1; transform: none; }
#ring { z-index: 4; border: 2px solid var(--c, var(--agent)); border-radius: 8px; box-shadow: 0 0 0 4px color-mix(in srgb, var(--c, var(--agent)) 20%, transparent); display: none; transition: left .3s, top .3s, width .3s, height .3s; }
.nogl #ring.on { display: block; }
#uline { z-index: 4; height: 2px; width: 0; background: var(--type); opacity: 0; }
#uline.on { opacity: 1; animation: uline var(--d, 1s) linear forwards; }
@keyframes uline { from { width: 0 } to { width: var(--w, 0) } }
.rip { position: absolute; z-index: 4; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid var(--c); background: color-mix(in srgb, var(--c) 25%, transparent); pointer-events: none; animation: rip .65s ease-out forwards; }
@keyframes rip { to { transform: scale(3.4); opacity: 0 } }

#gate { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); z-index: 5; width: min(92%, 480px); background: var(--panel); color: var(--fg); border: 1px solid color-mix(in srgb, var(--human) 55%, var(--line)); border-radius: 12px; padding: 12px 14px; display: grid; gap: 8px; box-shadow: 0 16px 40px -18px var(--shadow); }
#gate[hidden], #take[hidden] { display: none; }
#gate .k { font: 11px/1 var(--mono); color: var(--human); letter-spacing: .06em; text-transform: uppercase; }
#gate-what { font-weight: 600; overflow-wrap: anywhere; }
#gate-detail { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
#gate-detail:empty { display: none; }
#gate .acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
#gate .go { background: var(--human); color: #1b1206; border-color: var(--human); font-weight: 500; }
#gate .hint { color: var(--muted); font-size: 12px; }
#take { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; align-items: center; gap: 10px; padding: 5px 5px 5px 12px; border-radius: 999px; background: var(--panel); border: 1px solid color-mix(in srgb, var(--human) 55%, var(--line)); color: var(--human); white-space: nowrap; font-weight: 500; box-shadow: 0 10px 30px -16px var(--shadow); }

aside { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; display: grid; grid-template-rows: auto auto minmax(0, 1fr); max-height: calc(100vh - 110px); min-height: 280px; position: sticky; top: 12px; }
@media (max-width: 900px) { aside { position: static; max-height: 60vh; } }
.now { --c: var(--muted); padding: 14px; border-bottom: 1px solid var(--line); display: grid; gap: 9px; }
.now .k { font: 11px/1 var(--mono); color: var(--muted); letter-spacing: .06em; text-transform: uppercase; }
.now .main { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.now .ic { flex: none; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
#now-v { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
#now-t { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.bar8 { height: 6px; display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; }
.bar8 i { border-radius: 1px; background: var(--c); opacity: .15; }
.bar8.run i:nth-child(3n+1) { opacity: .7; }
aside h2 { margin: 0; padding: 9px 14px; font-size: 12px; font-weight: 500; color: var(--muted); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
#steps { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
#steps li { --c: var(--agent); display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 2px 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); }
#steps li.fresh { animation: in .3s ease; }
@keyframes in { from { opacity: 0; transform: translateY(-4px) } }
#steps .ic { color: var(--c); padding-top: 2px; }
#steps .what { min-width: 0; overflow-wrap: anywhere; }
#steps .target { font-weight: 500; }
#steps .d { color: var(--muted); font: 12px/1.6 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
#steps .meta { grid-column: 2 / 4; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
#steps li.error, #steps li.stuck { box-shadow: inset 3px 0 0 var(--bad); }
#steps li.error .meta, #steps li.stuck .meta { color: var(--bad); }
#steps li.not-run .meta { color: var(--human); }
#steps li.pause, #steps li.resume { background: color-mix(in srgb, var(--human) 9%, transparent); }
#steps li.think { color: var(--muted); font-size: 12px; padding-block: 5px; }
#steps li.sep { display: block; padding: 5px 14px; font: 11px/1.4 var(--mono); color: var(--muted); background: var(--sunk); overflow-wrap: anywhere; }
#steps li.empty { display: block; color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
footer { color: var(--muted); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

/** The view's script after `T` (the strings) and `K` (the kind of each tool) are set. */
const SCRIPT = `
const $ = (id) => document.getElementById(id);
function fill(t, v) { for (const k in v) t = t.split("{" + k + "}").join(String(v[k])); return t; }
const S = T.stage;
const frame = $("frame");
const list = $("steps");
const stageEl = $("stage");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
let state = null;
let geom = { w: 0, h: 0, sx: 0, sy: 0, scale: 1, top: 0 };
let said = "";
function note(text) { $("notice").textContent = text || ""; }
// What changes the state for a screen reader: said once, not on every update.
function announce(text) { if (text && text !== said) { said = text; $("announce").textContent = text; } }
async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-turno-live": "1" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (data.error) note(data.error);
    else if (data.identity) render(data);
  } catch (error) { note(String(error)); }
}
function byName(by) { return ({ "the live view": T.byView, browser_request_human: T.byStep, "the person's input in the browser window": T.byWindow })[by] || by; }
function actionOf(tool) { return T.actions[tool] || tool.replace(/^browser_/, "").replace(/_/g, " "); }
function duration(ms) {
  if (ms < 1000) return (ms / 1000).toFixed(1) + " s";
  const s = Math.round(ms / 1000);
  return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
}
function clock(at) { return new Date(at).toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function span(cls, text) { const e = document.createElement("span"); e.className = cls; e.textContent = text; return e; }
function hostOf(url) { try { return new URL(url).host; } catch { return ""; } }

// Icons: the script's own constant SVG paths, the only markup it builds.
const ICONS = {
  think: '<circle cx="8" cy="8" r="5.5"/><path d="M6 6.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M8 11.2v.3"/>',
  navigate: '<path d="M2.5 8h11M9.5 4l4 4-4 4"/>',
  read: '<path d="M2 3.5h5a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H2zM14 3.5H9.5A1.5 1.5 0 0 0 8 5"/><path d="M14 3.5v8H9a1 1 0 0 0-1 1"/>',
  locate: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  click: '<path d="M6 2.5v2M2.5 6h2M3.4 3.4l1.4 1.4M7 7l6.5 2.4-2.8 1.3-1.3 2.8z"/>',
  hover: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2"/>',
  type: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 7h1M7 7h2M11 7h1M5 9.5h6"/>',
  select: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="m5 8.2 2 2 4-4.4"/>',
  scroll: '<rect x="5" y="1.5" width="6" height="13" rx="3"/><path d="M8 4.5v3"/>',
  drag: '<path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
  upload: '<path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>',
  download: '<path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>',
  dialog: '<rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="M1.5 6h13"/>',
  wait: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  script: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  tabs: '<rect x="1.5" y="4.5" width="10" height="9" rx="1.5"/><path d="M4.5 4.5v-2h10v9h-3"/>',
  run: '<path d="M2.5 4h7M2.5 8h7M2.5 12h4M11.5 9.5v5l3.5-2.5z"/>',
  human: '<circle cx="8" cy="5" r="2.6"/><path d="M2.8 14a5.2 5.2 0 0 1 10.4 0"/>',
  error: '<path d="M8 1.8 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.4v.2"/>',
  stuck: '<circle cx="8" cy="8" r="6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  done: '<circle cx="8" cy="8" r="6"/><path d="m5.2 8.3 1.9 1.9 3.8-4.2"/>',
  other: '<circle cx="8" cy="8" r="2.5"/>',
};
function icon(name, size) {
  const t = document.createElement("template");
  t.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.other) + "</svg>";
  return t.content.firstChild;
}
const TONE = { read: "read", type: "type", human: "human" };
const toneOf = (kind) => TONE[kind] || "agent";
const kindOf = (tool) => K[tool] || "other";
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim(); }
function rgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function tone(name) { return rgb(cssVar(name) || "#7d9bff"); }

/** The picture's rectangle on the stage, in CSS pixels (zero before a frame shows). */
function view() {
  if (!frame.getAttribute("src")) return { x: 0, y: 0, w: 0, h: 0 };
  const s = stageEl.getBoundingClientRect();
  const r = frame.getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

/** The browser window drawn around the picture (with its address bar), on the stage. */
function shell() {
  const s = stageEl.getBoundingClientRect();
  const r = $("browser").getBoundingClientRect();
  return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
}

// The cursor, the label, the CSS ring and the typing line: placed on each draw.
const cursorEl = $("cursor"), tagEl = $("tag"), ringEl = $("ring"), ulineEl = $("uline");
const cur = { at: null, scroll: null };
function setTone(el, name) { el.style.setProperty("--c", "var(--" + name + ")"); }
const css = {
  fallback(on) { stageEl.classList.toggle("nogl", on); },
  place(box) {
    if (cur.at) {
      const p = pageToStage(cur.at, cur.scroll, geom, view());
      if (p) cursorEl.style.transform = "translate(" + Math.round(p.x) + "px, " + Math.round(p.y) + "px)";
    }
    if (box) {
      ringEl.style.left = box.x + "px"; ringEl.style.top = box.y + "px";
      ringEl.style.width = box.w + "px"; ringEl.style.height = box.h + "px";
      tagEl.style.left = Math.max(6, box.x) + "px";
      tagEl.style.top = Math.max(6, box.y - 26) + "px";
      ulineEl.style.left = box.x + 3 + "px";
      ulineEl.style.top = box.y + box.h - 5 + "px";
      ulineEl.style.setProperty("--w", Math.max(0, box.w - 6) + "px");
    }
  },
  ring(name) { ringEl.classList.toggle("on", !!name); if (name) setTone(ringEl, name); },
  ripple(p, name) {
    const d = document.createElement("i");
    d.className = "rip";
    d.style.left = p.x + "px"; d.style.top = p.y + "px";
    setTone(d, name);
    stageEl.append(d);
    setTimeout(() => d.remove(), 700);
  },
  edge(name) { stageEl.dataset.edge = name || ""; },
};
${stageScript()}
const FX = createStage({ stage: stageEl, canvas: $("fx"), view, shell, frame: () => geom, reduce, tone, css });
let mood = ["agent", 0.18, ""];
function setMood(t, amb, how) { mood = [t, amb, how]; FX.mood(t, amb, how); }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setMood(mood[0], mood[1], mood[2]));

// The state pill and the "Now" card.
function pill(text, t, running) {
  $("status").textContent = text;
  setTone($("pill"), t || "muted");
  $("pill").classList.toggle("run", !!running);
}
function now(iconName, title, detail, t, running) {
  setTone($("now"), t || "muted");
  $("now-ic").replaceChildren(icon(iconName, 18));
  $("now-v").textContent = title;
  $("now-t").textContent = detail || "";
  $("now-bar").classList.toggle("run", !!running);
}
function stepText(tool, target) { return actionOf(tool) + (target ? " " + target : ""); }
function moveCursor(at, scroll, t) {
  cur.at = at; cur.scroll = scroll || null;
  cursorEl.classList.add("on");
  cursorEl.classList.remove("dim");
  setTone(cursorEl, t);
  FX.wake();
}
function label(text, t) {
  if (!text) { tagEl.classList.remove("on"); return; }
  tagEl.textContent = text;
  setTone(tagEl, t);
  tagEl.classList.add("on");
}
function unfocus() { FX.focus(null); label(null); ulineEl.classList.remove("on"); }

// What the agent does now, from the effect events (fx), and the gaps between them (thinking).
const THINK_AFTER_MS = 450;
const RUN_IDLE_MS = 20000;
const run = { marked: 0, open: null, began: 0, steps: 0, lastEnd: 0, mode: "waiting", human: null, taken: false, think: 0, done: 0 };
function paused() { return !!(state && state.paused) || run.taken || !!run.human; }
function navigating(on) {
  const bar = $("urlprog");
  if (on) { bar.style.opacity = "1"; bar.style.width = "35%"; setTimeout(() => { if (run.open && run.open.kind === "navigate") bar.style.width = "80%"; }, 250); return; }
  bar.style.width = "100%";
  setTimeout(() => { bar.style.opacity = "0"; setTimeout(() => { bar.style.width = "0"; }, 400); }, 250);
}
function startStep(e) {
  clearTimeout(run.think); clearTimeout(run.done);
  if (run.mode !== "working" && run.mode !== "thinking") { run.began = e.at; run.steps = 0; }
  run.open = e;
  run.mode = "working";
  if (e.agent) cursorEl.querySelector(".who").textContent = e.agent + (state ? " · " + state.identity : "");
  const t = toneOf(e.kind);
  setMood(t, 0.38, "live");
  let detail = S.running;
  if (e.vault) detail = S.fromVault;
  else if (e.chars !== undefined) detail = fill(S.typed, { n: e.chars });
  else if (e.dir) detail = S.scroll[e.dir];
  now(e.kind, stepText(e.tool, e.target), detail, t, true);
  if (!paused()) pill(S.kinds[e.kind] || S.kinds.other, t, true);
  if (e.kind === "navigate") { navigating(true); FX.dissolve(); unfocus(); }
  else if (e.kind === "read" || e.kind === "locate") FX.scan(e.kind === "read" ? 1.1 : 0.7);
  else if (e.kind === "wait") setMood("agent", 0.5, "breathe");
  else if (e.kind === "dialog") $("dim").classList.add("on");
  else if (e.kind === "scroll") {
    const dir = e.dir || "down";
    for (let i = 0; i < 4; i++) setTimeout(() => FX.ripple(dir === "down" || dir === "up" ? { u: 0.985, v: dir === "down" ? 0.2 + i * 0.2 : 0.8 - i * 0.2 } : { u: dir === "right" ? 0.2 + i * 0.2 : 0.8 - i * 0.2, v: 0.985 }, "agent", 120), i * 110);
  } else if (e.kind === "upload") flow(true);
}
/** Pixels that flow from the picture's corner to its middle (a file in), or back (a file out). */
function flow(inward) {
  for (let i = 0; i <= 5; i++) {
    const k = inward ? i / 5 : 1 - i / 5;
    setTimeout(() => FX.ripple({ u: 0.96 - 0.46 * k, v: 0.94 - 0.44 * k }, "agent", 90), i * 90);
  }
}
function markStep(e) {
  if (!state || e.tab !== state.showing) return;
  const open = run.open && run.open.step === e.step ? run.open : null;
  const k = open ? open.kind : "other";
  const t = e.mark === "type" ? "type" : toneOf(k);
  const what = open ? stepText(open.tool, open.target) : "";
  if (e.mark === "click") {
    FX.ripple({ at: e.point, scroll: e.scroll }, t, 240);
    moveCursor(e.point, e.scroll, t);
    return;
  }
  if (e.mark === "download") {
    flow(false);
    now("download", fill(S.download, { name: e.name || "" }), "", "agent", false);
    return;
  }
  if (!e.box) return;
  const before = FX.focused();
  const center = { x: e.box.x + e.box.width / 2, y: e.box.y + e.box.height / 2 };
  FX.focus(e.box, e.scroll, t, e.mark === "box");
  run.marked = e.step;
  if (e.mark === "drag" && before) {
    const a = { x: before.box.x + before.box.width / 2, y: before.box.y + before.box.height / 2 };
    for (let i = 0; i <= 4; i++) setTimeout(() => FX.ripple({ at: { x: a.x + (center.x - a.x) * i / 4, y: a.y + (center.y - a.y) * i / 4 }, scroll: e.scroll }, t, 90), i * 80);
  }
  moveCursor({ x: e.box.x + Math.min(e.box.width * 0.5, 40), y: center.y }, e.scroll, t);
  label(open && open.vault ? what + " · vault" : what, t);
  if (e.mark === "type") {
    const n = open && open.chars ? open.chars : 12;
    ulineEl.classList.remove("on");
    ulineEl.style.setProperty("--d", Math.min(1.6, Math.max(0.3, n * 0.04)) + "s");
    void ulineEl.offsetWidth;
    ulineEl.classList.add("on");
  }
}
function endStep(e) {
  const mine = run.open && e.step !== 0 && run.open.step === e.step ? run.open : null;
  if (mine) run.open = null;
  run.steps++;
  run.lastEnd = e.at;
  if (e.kind === "dialog") $("dim").classList.remove("on");
  if (e.kind === "navigate") navigating(false);
  const title = mine ? stepText(mine.tool, mine.target) : $("now-v").textContent;
  if (e.outcome === "error") {
    // Red where it failed: ripples on the step's box, or a red pulse around the window without one.
    const box = run.marked === e.step ? FX.focused() : null;
    if (box) {
      FX.focusTone("bad");
      const c = { x: box.box.x + box.box.width / 2, y: box.box.y + box.box.height / 2 };
      for (let i = 0; i < 3; i++) setTimeout(() => FX.ripple({ at: { x: c.x + (Math.random() - 0.5) * 60, y: c.y + (Math.random() - 0.5) * 30 }, scroll: box.scroll }, "bad", 180), i * 120);
    } else {
      FX.edge(0.8, "bad");
      setTimeout(() => { if (!run.human && !(state && state.stuck)) FX.edge(0); }, 900);
    }
    if (!reduce) { const b = $("browser"); b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); }
    now("error", title, e.code ? fill(S.failedCode, { code: e.code }) : S.failedPlain, "bad", false);
    if (!paused()) pill(e.stuck ? S.looksStuck : e.code ? fill(S.failedCode, { code: e.code }) : S.failedPlain, "bad", false);
    setTimeout(() => { if (!run.open && !run.human) unfocus(); }, 900);
  } else {
    now(mine ? mine.kind : kindOf(""), title, duration(e.ms), toneOf(mine ? mine.kind : "other"), false);
    setTimeout(() => { if (!run.open && !run.human) unfocus(); }, 260);
  }
  if (!run.open) idleSoon();
}
/** After a call: thinking once no call starts for a moment, done once none starts for a while. */
function idleSoon() {
  clearTimeout(run.think); clearTimeout(run.done);
  run.think = setTimeout(() => {
    if (run.open || paused()) return;
    run.mode = "thinking";
    setMood("agent", 0.7, "breathe");
    if (!(state && state.stuck)) pill(S.thinking, "agent", true);
    now("think", S.thinking, S.thinkingHint, "agent", true);
  }, THINK_AFTER_MS);
  run.done = setTimeout(() => {
    if (run.open || paused()) return;
    run.mode = "done";
    cursorEl.classList.remove("on");
    unfocus();
    if (run.steps > 0) {
      setMood("ok", 0.45, "");
      FX.ripple({ u: 0.5, v: 0.5 }, "ok", 520);
      pill(S.done, "ok", false);
      now("done", S.done, fill(S.doneHint, { n: run.steps, t: duration(run.lastEnd - run.began) }), "ok", false);
    }
    setTimeout(() => { if (run.mode === "done") setMood("agent", 0.16, ""); }, 2500);
  }, RUN_IDLE_MS);
}
function humanTurn(e) {
  clearTimeout(run.think); clearTimeout(run.done);
  run.human = e;
  run.mode = "human";
  const title = S.human[e.cue] || S.human.step;
  setMood("human", 0.3, "live");
  FX.edge(0.85, "human");
  label(null);
  if (e.box && (!state || e.tab === undefined || e.tab === state.showing)) {
    FX.focus(e.box, e.scroll || null, "human", true);
    moveCursor({ x: e.box.x + e.box.width / 2, y: e.box.y - 24 }, e.scroll, "human");
  } else unfocus();
  $("gate-k").textContent = title;
  $("gate-what").textContent = e.text || S.humanHint;
  $("gate-detail").textContent = e.detail || "";
  $("gate").hidden = false;
  $("take").hidden = true;
  pill(title, "human", false);
  now("human", title, e.text || S.humanHint, "human", false);
}
function takeOver() {
  clearTimeout(run.think); clearTimeout(run.done);
  run.taken = true;
  run.mode = "taken";
  FX.edge(0.35, "human");
  unfocus();
  setMood("human", 0.18, "");
  cursorEl.classList.add("dim");
  $("take").hidden = false;
  $("gate").hidden = true;
  pill(S.takeOver, "human", false);
  now("human", S.takeOver, $("help").textContent, "human", false);
}
function handBack(e) {
  run.human = null;
  run.taken = false;
  run.mode = "working";
  $("gate").hidden = true;
  $("take").hidden = true;
  FX.edge(0);
  unfocus();
  cursorEl.classList.remove("dim");
  setTone(cursorEl, "agent");
  setMood("agent", 0.25, "");
  now("navigate", fill(S.backAfter, { t: duration(e.ms) }), "", "human", false);
  if (state) render(state);
  idleSoon();
}
function onFx(e) {
  if (e.type === "start") startStep(e);
  else if (e.type === "mark") markStep(e);
  else if (e.type === "end") endStep(e);
  else if (e.type === "human") humanTurn(e);
  else if (e.type === "take-over") takeOver(e);
  else if (e.type === "hand-back") handBack(e);
}

// The timeline: one line per call, the person's turns, the site it moved to, the gaps for thinking.
let lastEnd = 0;
let lastHost = "";
let calls = 0;
function line(cls, iconName, t) {
  const li = document.createElement("li");
  li.className = cls;
  setTone(li, t);
  const ic = span("ic", "");
  ic.append(icon(iconName, 16));
  li.append(ic);
  return li;
}
function stepLines(s) {
  const out = [];
  if (s.kind === "call") {
    const kind = kindOf(s.tool);
    const bad = s.outcome === "error";
    const li = line(s.outcome + (s.stuck ? " stuck" : ""), s.stuck ? "stuck" : bad ? "error" : kind, bad ? "bad" : s.outcome === "not-run" ? "human" : toneOf(kind));
    const what = span("what", actionOf(s.tool) + (s.target ? " " : ""));
    if (s.target) what.append(span("target", s.target));
    what.title = s.tool;
    li.append(what, span("d", duration(s.ms)));
    const parts = [clock(s.at)];
    if (s.waited) parts.push(T.waited);
    if (bad) parts.push(T.failed + (s.detail ? ": " + s.detail : ""));
    if (s.outcome === "not-run") parts.push(T.notRun);
    if (s.stuck) parts.push(fill(T.stuck, { action: actionOf(s.tool) + (s.target ? " " + s.target : ""), n: s.stuck }));
    if (s.agent) parts.push(s.agent);
    li.append(span("meta", parts.join(" · ")));
    const started = s.at - s.ms;
    const gap = lastEnd ? started - lastEnd : 0;
    if (gap > 1500 && gap < RUN_IDLE_MS) {
      const think = line("think", "think", "agent");
      think.append(span("what", fill(S.thought, { t: duration(gap) })));
      out.push(think);
    }
    lastEnd = s.at;
    calls++;
    out.push(li);
    if (kind === "navigate" && s.outcome === "ok") {
      const host = hostOf(s.target);
      if (host && host !== lastHost) {
        lastHost = host;
        const sep = document.createElement("li");
        sep.className = "sep";
        sep.textContent = host;
        out.push(sep);
      }
    }
    return out;
  }
  lastEnd = 0;
  const li = line(s.kind, s.kind === "pause" ? "human" : "navigate", "human");
  const what = span("what", "");
  if (s.kind === "pause") what.textContent = s.step ? T.stepEntry : fill(s.by === "the live view" || s.by === "the person's input in the browser window" ? T.tookOverEntry : T.pausedEntry, { by: byName(s.by) });
  else what.textContent = fill(T.resumedEntry, { t: duration(s.ms) });
  li.append(what, span("d", clock(s.at)));
  if (s.kind === "resume") li.append(span("meta", s.lines.length ? s.lines.join(" · ") : T.nothingChanged));
  out.push(li);
  return out;
}
function addSteps(steps, quiet) {
  if (!steps.length) return;
  // The first fill is history: a screen reader hears only steps that come after it.
  if (quiet) list.removeAttribute("aria-live");
  list.querySelector(".empty")?.remove();
  for (const s of steps) for (const li of stepLines(s)) { if (!quiet) li.classList.add("fresh"); list.prepend(li); }
  while (list.children.length > 400) list.lastElementChild.remove();
  $("count").textContent = String(calls);
  if (quiet) setTimeout(() => list.setAttribute("aria-live", "polite"), 0);
}

function render(s) {
  state = s;
  $("id").textContent = fill(S.identity, { id: s.identity });
  const by = s.paused ? byName(s.paused.by) : "";
  let text = s.paused
    ? (s.paused.idleMs ? fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) }) + " " : fill(T.paused, { by })) + (s.waiting ? (s.waiting === 1 ? T.waitingOne : fill(T.waitingMany, { n: s.waiting })) : "") + (s.paused.idleMs ? "" : s.busy ? T.stillRunning : T.yourControls)
    : (s.busy ? T.working : T.idle) + (s.browser ? "" : T.noBrowser);
  if (s.stuck) text += " " + fill(T.stuck, { action: actionOf(s.stuck.tool) + (s.stuck.target ? " " + s.stuck.target : ""), n: s.stuck.count });
  $("pill").title = text;
  announce(s.paused ? (s.paused.idleMs ? fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) }) : fill(T.paused, { by }) + T.yourControls) : s.stuck ? fill(T.stuck, { action: actionOf(s.stuck.tool), n: s.stuck.count }) : s.busy ? T.working : "");
  // A view that opens during a pause gets no fx event for it: the state says which it is.
  const step = s.paused && (s.paused.by === "browser_request_human" || s.paused.by === "a passkey prompt");
  if (s.paused && step && !run.human) humanTurn({ cue: s.paused.by === "a passkey prompt" ? "passkey" : "step" });
  else if (s.paused && !step && !run.taken) takeOver();
  else if (!s.paused && (run.human || run.taken)) { run.human = null; run.taken = false; $("gate").hidden = true; $("take").hidden = true; FX.edge(0); }
  if (s.paused) $("now-t").textContent = text;
  else if (s.stuck) { FX.edge(0.9, "bad"); pill(S.looksStuck, "bad", false); now("stuck", S.looksStuck, text, "bad", false); }
  else if (!run.human) FX.edge(0);
  if (!s.paused && !s.stuck) {
    if (run.open) pill(S.kinds[run.open.kind] || S.kinds.other, toneOf(run.open.kind), true);
    else if (run.mode === "thinking") pill(S.thinking, "agent", true);
    else if (run.mode === "done") pill(S.done, "ok", false);
    else if (run.mode === "waiting") pill(S.waiting, "muted", false);
    else if (!s.busy && run.mode !== "working") pill(S.idle, "muted", false);
  }
  $("pause").disabled = !!s.paused && !s.paused.idleMs;
  $("resume").disabled = !s.paused;
  const tabs = $("tabs");
  tabs.replaceChildren();
  const follow = document.createElement("button");
  follow.textContent = T.follow;
  follow.className = s.pinned ? "" : "on";
  follow.setAttribute("aria-pressed", String(!s.pinned));
  follow.onclick = () => post("/follow", { tab: null });
  tabs.append(follow);
  for (const t of s.tabs) {
    const b = document.createElement("button");
    b.textContent = (t.session ? "[" + t.session + "] " : "") + (t.title || t.url || T.blank);
    b.title = t.url;
    b.className = t.id === s.showing ? "on" : "";
    b.setAttribute("aria-pressed", String(t.id === s.showing));
    b.onclick = () => post("/follow", { tab: t.id });
    tabs.append(b);
  }
  const shown = s.tabs.find((t) => t.id === s.showing);
  $("url").textContent = shown ? shown.url || T.blank : "";
  $("url").title = shown ? shown.url : "";
  let why = "";
  if (!s.view.available) why = fill(T.noView, { reason: s.view.reason });
  else if (s.hidden) why = T.hidden;
  else if (!s.browser) why = T.notStarted;
  if (why) frame.removeAttribute("src");
  $("empty").textContent = why || T.notStarted;
  note(s.hidden ? why : "");
  $("help").textContent = s.view.available
    ? (s.paused ? T.helpPaused : fill(T.helpRunning, { s: Math.round(s.wait / 1000) }))
    : T.helpNoView;
}
const events = new EventSource("/events");
events.addEventListener("state", (e) => render(JSON.parse(e.data)));
events.addEventListener("steps", (e) => {
  list.replaceChildren();
  lastEnd = 0; lastHost = ""; calls = 0;
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = T.noSteps;
  list.append(empty);
  $("count").textContent = "0";
  addSteps(JSON.parse(e.data), true);
});
events.addEventListener("step", (e) => addSteps([JSON.parse(e.data)], false));
events.addEventListener("fx", (e) => onFx(JSON.parse(e.data)));
events.addEventListener("frame", (e) => {
  const f = JSON.parse(e.data);
  if (!state || !state.view.available || state.hidden) return;
  geom = { w: f.w, h: f.h, sx: f.sx || 0, sy: f.sy || 0, scale: f.scale || 1, top: f.top || 0 };
  frame.src = "data:image/jpeg;base64," + f.data;
  // The boxes follow their elements as the page scrolls.
  if (FX.focused() || cur.at) FX.wake();
});
frame.addEventListener("load", () => FX.wake());
events.onerror = () => { pill(T.disconnected, "muted", false); announce(T.disconnected); };
$("pause").onclick = () => post("/pause");
$("resume").onclick = () => post("/resume");
$("takeback").onclick = () => post("/resume");
$("gate-done").onclick = () => post("/resume");
function point(e) {
  const r = frame.getBoundingClientRect();
  return { x: Math.round(((e.clientX - r.left) * geom.w) / r.width), y: Math.round(((e.clientY - r.top) * geom.h) / r.height) };
}
// Input while the agent works takes the controls: the server pauses it first.
function canAct() { return !!state && state.view.available && !state.hidden; }
function yours(e) {
  const r = frame.getBoundingClientRect();
  FX.ripple({ u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height }, "human", 200);
}
frame.addEventListener("click", (e) => { frame.focus(); if (canAct()) { yours(e); post("/input", { type: "click", ...point(e) }); } });
frame.addEventListener("dblclick", (e) => { if (canAct()) post("/input", { type: "dblclick", ...point(e) }); });
let wheel = null;
frame.addEventListener("wheel", (e) => {
  if (!canAct()) return;
  e.preventDefault();
  if (wheel) { wheel.dx += e.deltaX; wheel.dy += e.deltaY; return; }
  wheel = { type: "wheel", ...point(e), dx: e.deltaX, dy: e.deltaY };
  setTimeout(() => { const w = wheel; wheel = null; post("/input", { ...w, dx: Math.round(w.dx), dy: Math.round(w.dy) }); }, 80);
}, { passive: false });
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
frame.addEventListener("keydown", (e) => {
  if (!canAct() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) { e.preventDefault(); post("/input", { type: "text", text: e.key }); }
  else if (KEYS.has(e.key)) { e.preventDefault(); post("/input", { type: "key", key: e.key }); }
});
$("now-bar").replaceChildren(...Array.from({ length: 24 }, () => document.createElement("i")));
now("think", S.waiting, S.waitingHint, "muted", false);
// #stats: the effects' cost, for measuring (frames drawn a second and the script's time per frame).
if (location.hash === "#stats") {
  let last = { frames: 0, ms: 0 };
  setInterval(() => {
    const f = FX.stats.frames - last.frames, ms = FX.stats.ms - last.ms;
    last = { frames: FX.stats.frames, ms: FX.stats.ms };
    $("stats").textContent = "fx " + (FX.gl() ? "webgl2" : "css") + " · " + f + " frames/s · " + (f ? (ms / f).toFixed(2) : "0") + " ms/frame";
  }, 1000);
}
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** JSON in a script element: "<" escaped so no string can close the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The page, with the nonce the response's Content-Security-Policy allows, in the person's language. */
export function livePage(nonce: string, locale: UiLocale = "en"): string {
  const t = uiStrings(locale).live;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${e(t.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div class="wrap">
<header class="bar">
<div class="brand">turno <span>· ${e(t.heading)}</span></div>
<span class="chip" id="id"></span>
<span class="pill" id="pill"><span class="pix" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span><span id="status">${e(t.connecting)}</span></span>
<span class="spacer"></span>
<button class="btn" id="pause" type="button">${e(t.pause)}</button>
<button class="btn primary" id="resume" type="button" disabled>${e(t.resume)}</button>
</header>
<nav id="tabs" aria-label="${e(t.tabs)}"></nav>
<div class="layout">
<main>
<div id="notice" role="status"></div>
<div class="stage" id="stage">
<canvas id="fx" aria-hidden="true"></canvas>
<div class="browser" id="browser">
<div class="urlbar" aria-hidden="true"><span class="dots"><i></i><i></i><i></i></span><div class="url"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg><span id="url"></span><i id="urlprog"></i></div></div>
<div class="screen" id="screen"><img id="frame" alt="${e(t.frameAlt)}" tabindex="0"><div id="empty">${e(t.notStarted)}</div><div id="dim"></div></div>
</div>
<div class="over" id="ring" aria-hidden="true"></div>
<div class="over" id="uline" aria-hidden="true"></div>
<div class="over" id="tag" aria-hidden="true"></div>
<div class="over" id="cursor" aria-hidden="true"><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1.5 1.5v16.2l4.3-3.9 2.9 6.6 2.9-1.3-2.8-6.4 5.9-.2z"/></svg><span class="who">${e(t.stage.agent)}</span></div>
<div id="gate" role="group" aria-labelledby="gate-k" hidden><div class="k" id="gate-k"></div><div id="gate-what"></div><div id="gate-detail"></div><div class="acts"><button class="btn go" id="gate-done" type="button">${e(t.stage.humanDone)}</button><span class="hint">${e(t.stage.humanHint)}</span></div></div>
<div id="take" hidden><span>${e(t.stage.takeOver)}</span><button class="btn" id="takeback" type="button">${e(t.resume)}</button></div>
</div>
</main>
<aside aria-labelledby="steps-title">
<div class="now" id="now"><div class="k">${e(t.stage.now)}</div><div class="main"><div class="ic" id="now-ic"></div><div><div id="now-v"></div><div id="now-t"></div></div></div><div class="bar8" id="now-bar" aria-hidden="true"></div></div>
<h2 id="steps-title"><span>${e(t.steps)}</span><span id="count">0</span></h2>
<ol id="steps" aria-live="polite" aria-relevant="additions"><li class="empty">${e(t.noSteps)}</li></ol>
</aside>
</div>
<div id="announce" class="sr" role="status" aria-live="polite"></div>
<footer><span id="help"></span> <span id="stats"></span></footer>
</div>
<script nonce="${nonce}">const T = ${scriptJson(t)};const K = ${scriptJson(TOOL_KINDS)};${SCRIPT}</script>
</body>
</html>
`;
}

/** What a browser without the view's cookie sees. */
export function deniedPage(identity: string, locale: UiLocale = "en"): string {
  const t = uiStrings(locale).live;
  const command = `<code>${escapeHtml(`${names().browser} live ${identity}`)}</code>`;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(t.title)}</title></head>
<body><p>${fill(escapeHtml(t.denied), { command })}</p></body></html>
`;
}
