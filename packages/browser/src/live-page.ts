import { names } from "./names.js";
import { type UiLocale, fill, uiStrings } from "./ui-strings.js";
/**
 * The live view page: one HTML document with its style and script inline, allowed by a nonce
 * in the Content-Security-Policy. It reads the server's events (`/events`: the state and the
 * frames of the tab it shows), and posts Pause, Resume, the tab to show and, while the agent is
 * paused, the user's clicks, keys and scrolls. Text from pages (titles, URLs) only ever goes into
 * `textContent`, never into HTML. Its words come from the identity's language (`ui-strings.ts`):
 * the script reads them from `T`.
 */

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1c1c1a; --muted: #6b6b66; --line: #d9d9d4; --accent: #2b5fd9; --warn: #b4561a; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a94; --line: #34342f; --accent: #7aa2ff; --warn: #f0a060; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
header strong { font-weight: 600; }
#status { color: var(--muted); flex: 1 1 200px; }
#status.paused { color: var(--warn); }
button { font: inherit; padding: 4px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
button.on { border-color: var(--accent); color: var(--accent); }
nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
nav button { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
main { padding: 12px 16px; }
#notice { color: var(--warn); margin-bottom: 8px; min-height: 1.4em; }
#frame { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); outline: none; }
#frame:focus { border-color: var(--accent); }
#frame:not([src]) { display: none; }
footer { padding: 0 16px 16px; color: var(--muted); font-size: 13px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
function fill(t, v) { for (const k in v) t = t.split("{" + k + "}").join(String(v[k])); return t; }
const frame = $("frame");
let state = null;
let size = { w: 0, h: 0 };
function note(text) { $("notice").textContent = text || ""; }
async function post(path, body) {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-turno-live": "1" }, body: JSON.stringify(body || {}) });
    const data = await res.json();
    if (data.error) note(data.error);
    else if (data.identity) render(data);
  } catch (error) { note(String(error)); }
}
function render(s) {
  state = s;
  $("id").textContent = s.identity;
  const status = $("status");
  status.className = s.paused ? "paused" : "";
  const by = s.paused ? ({ "the live view": T.byView, browser_request_human: T.byStep })[s.paused.by] || s.paused.by : "";
  status.textContent = s.paused
    ? fill(T.paused, { by }) + (s.waiting ? (s.waiting === 1 ? T.waitingOne : fill(T.waitingMany, { n: s.waiting })) : "") + (s.busy ? T.stillRunning : T.yourControls)
    : (s.busy ? T.working : T.idle) + (s.browser ? "" : T.noBrowser);
  $("pause").disabled = !!s.paused;
  $("resume").disabled = !s.paused;
  const tabs = $("tabs");
  tabs.replaceChildren();
  const follow = document.createElement("button");
  follow.textContent = T.follow;
  follow.className = s.pinned ? "" : "on";
  follow.onclick = () => post("/follow", { tab: null });
  tabs.append(follow);
  for (const t of s.tabs) {
    const b = document.createElement("button");
    b.textContent = (t.session ? "[" + t.session + "] " : "") + (t.title || t.url || T.blank);
    b.title = t.url;
    b.className = t.id === s.showing ? "on" : "";
    b.onclick = () => post("/follow", { tab: t.id });
    tabs.append(b);
  }
  let why = "";
  if (!s.view.available) why = fill(T.noView, { reason: s.view.reason });
  else if (s.hidden) why = T.hidden;
  else if (!s.browser) why = T.notStarted;
  if (why) frame.removeAttribute("src");
  note(why);
  $("help").textContent = s.view.available
    ? (s.paused ? T.helpPaused : fill(T.helpRunning, { s: Math.round(s.wait / 1000) }))
    : T.helpNoView;
}
const events = new EventSource("/events");
events.addEventListener("state", (e) => render(JSON.parse(e.data)));
events.addEventListener("frame", (e) => {
  const f = JSON.parse(e.data);
  if (!state || !state.view.available || state.hidden) return;
  size = { w: f.w, h: f.h };
  frame.src = "data:image/jpeg;base64," + f.data;
});
events.onerror = () => { $("status").textContent = T.disconnected; };
$("pause").onclick = () => post("/pause");
$("resume").onclick = () => post("/resume");
function point(e) {
  const r = frame.getBoundingClientRect();
  return { x: Math.round(((e.clientX - r.left) * size.w) / r.width), y: Math.round(((e.clientY - r.top) * size.h) / r.height) };
}
function canAct() {
  if (state && state.paused) return true;
  note(T.pauseFirst);
  return false;
}
frame.addEventListener("click", (e) => { frame.focus(); if (canAct()) post("/input", { type: "click", ...point(e) }); });
frame.addEventListener("dblclick", (e) => { if (canAct()) post("/input", { type: "dblclick", ...point(e) }); });
let wheel = null;
frame.addEventListener("wheel", (e) => {
  if (!state || !state.paused) return;
  e.preventDefault();
  if (wheel) { wheel.dx += e.deltaX; wheel.dy += e.deltaY; return; }
  wheel = { type: "wheel", ...point(e), dx: e.deltaX, dy: e.deltaY };
  setTimeout(() => { const w = wheel; wheel = null; post("/input", { ...w, dx: Math.round(w.dx), dy: Math.round(w.dy) }); }, 80);
}, { passive: false });
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
frame.addEventListener("keydown", (e) => {
  if (!state || !state.paused || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length === 1) { e.preventDefault(); post("/input", { type: "text", text: e.key }); }
  else if (KEYS.has(e.key)) { e.preventDefault(); post("/input", { type: "key", key: e.key }); }
});
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/** The page, with the nonce the response's Content-Security-Policy allows, in the person's language. */
export function livePage(nonce: string, locale: UiLocale = "en"): string {
  const t = uiStrings(locale).live;
  // JSON in a script element: "<" escaped so no string can close the element.
  const strings = JSON.stringify(t).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(t.title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header><strong>${escapeHtml(t.heading)}</strong><span id="id"></span><span id="status">${escapeHtml(t.connecting)}</span><button id="pause" type="button">${escapeHtml(t.pause)}</button><button id="resume" type="button" disabled>${escapeHtml(t.resume)}</button></header>
<nav id="tabs" aria-label="${escapeHtml(t.tabs)}"></nav>
<main><div id="notice" role="status"></div><img id="frame" alt="${escapeHtml(t.frameAlt)}" tabindex="0"></main>
<footer id="help"></footer>
<script nonce="${nonce}">const T = ${strings};${SCRIPT}</script>
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
