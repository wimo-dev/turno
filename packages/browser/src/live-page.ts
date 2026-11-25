import { names } from "./names.js";
import { type UiLocale, fill, uiStrings } from "./ui-strings.js";
/**
 * The live view page: one HTML document with its style and script inline, allowed by a nonce
 * in the Content-Security-Policy. It reads the server's events (`/events`: the state, the frames
 * of the tab it shows and the steps of the timeline), and posts Pause, Hand back, the tab to show
 * and the user's clicks, keys and scrolls (which pause the agent first when it works). Laid out as
 * a panel: the picture, with the step timeline next to it (under it in a narrow window). New steps
 * and changes of state are announced to screen readers (`aria-live`); the picture stays out of it. Text from pages (titles, URLs) only ever goes into
 * `textContent`, never into HTML. Its words come from the identity's language (`ui-strings.ts`):
 * the script reads them from `T`.
 */

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1c1c1a; --muted: #6b6b66; --line: #d9d9d4; --accent: #2b5fd9; --warn: #b4561a; --bad: #c0392b; --panel: #ecece8; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecece8; --muted: #9a9a94; --line: #34342f; --accent: #7aa2ff; --warn: #f0a060; --bad: #ff7b6b; --panel: #1d1d1b; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
header strong { font-weight: 600; }
#status { color: var(--muted); flex: 1 1 200px; }
#status.paused { color: var(--warn); }
#status.stuck { color: var(--bad); }
button { font: inherit; padding: 4px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
button.on { border-color: var(--accent); color: var(--accent); }
button:focus-visible, #frame:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
nav button { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; align-items: start; }
@media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } }
main { padding: 12px 16px; min-width: 0; }
#notice { color: var(--warn); margin-bottom: 8px; min-height: 1.4em; }
#frame { display: block; max-width: 100%; max-height: calc(100vh - 150px); height: auto; border: 1px solid var(--line); outline: none; }
#frame:not([src]) { display: none; }
aside { border-left: 1px solid var(--line); background: var(--panel); height: calc(100vh - 92px); min-height: 240px; overflow-y: auto; position: sticky; top: 0; }
@media (max-width: 860px) { aside { border-left: 0; border-top: 1px solid var(--line); height: auto; max-height: 50vh; position: static; } }
aside h2 { font-size: 13px; font-weight: 600; margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
#steps { list-style: none; margin: 0; padding: 0; }
#steps li { padding: 8px 14px; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 8px; }
#steps .t { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; padding-top: 1px; }
#steps .what { overflow-wrap: anywhere; }
#steps .target { color: var(--fg); font-weight: 500; }
#steps .meta { grid-column: 2; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
#steps li.error .meta, #steps li.not-run .meta { color: var(--warn); }
#steps li.stuck { box-shadow: inset 3px 0 0 var(--bad); }
#steps li.stuck .meta { color: var(--bad); }
#steps li.pause, #steps li.resume { background: color-mix(in srgb, var(--warn) 10%, transparent); }
#steps li.empty { display: block; color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
footer { padding: 0 16px 16px; color: var(--muted); font-size: 13px; }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
function fill(t, v) { for (const k in v) t = t.split("{" + k + "}").join(String(v[k])); return t; }
const frame = $("frame");
const list = $("steps");
let state = null;
let size = { w: 0, h: 0 };
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
function stepLine(s) {
  const li = document.createElement("li");
  li.append(span("t", clock(s.at)));
  const what = span("what", "");
  const meta = span("meta", "");
  if (s.kind === "call") {
    li.className = s.outcome + (s.stuck ? " stuck" : "");
    what.append(actionOf(s.tool) + (s.target ? " " : ""));
    if (s.target) what.append(span("target", s.target));
    what.title = s.tool;
    const parts = [duration(s.ms)];
    if (s.waited) parts.push(T.waited);
    if (s.outcome === "error") parts.push(T.failed + (s.detail ? ": " + s.detail : ""));
    if (s.outcome === "not-run") parts.push(T.notRun);
    if (s.stuck) parts.push(fill(T.stuck, { action: actionOf(s.tool) + (s.target ? " " + s.target : ""), n: s.stuck }));
    if (s.agent) parts.push(s.agent);
    meta.textContent = parts.join(" · ");
  } else if (s.kind === "pause") {
    li.className = "pause";
    what.textContent = s.step ? T.stepEntry : fill(s.by === "the live view" || s.by === "the person's input in the browser window" ? T.tookOverEntry : T.pausedEntry, { by: byName(s.by) });
  } else {
    li.className = "resume";
    what.textContent = fill(T.resumedEntry, { t: duration(s.ms) });
    meta.textContent = s.lines.length ? s.lines.join(" · ") : T.nothingChanged;
  }
  li.append(what);
  if (meta.textContent) li.append(meta);
  return li;
}
function addSteps(steps, quiet) {
  if (!steps.length) return;
  // The first fill is history: a screen reader hears only steps that come after it.
  if (quiet) list.removeAttribute("aria-live");
  list.querySelector(".empty")?.remove();
  for (const s of steps) list.prepend(stepLine(s));
  while (list.children.length > 300) list.lastElementChild.remove();
  if (quiet) setTimeout(() => list.setAttribute("aria-live", "polite"), 0);
}
function render(s) {
  state = s;
  $("id").textContent = s.identity;
  const status = $("status");
  status.className = s.stuck ? "stuck" : s.paused ? "paused" : "";
  const by = s.paused ? byName(s.paused.by) : "";
  let text = s.paused
    ? (s.paused.idleMs ? fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) }) + " " : fill(T.paused, { by })) + (s.waiting ? (s.waiting === 1 ? T.waitingOne : fill(T.waitingMany, { n: s.waiting })) : "") + (s.paused.idleMs ? "" : s.busy ? T.stillRunning : T.yourControls)
    : (s.busy ? T.working : T.idle) + (s.browser ? "" : T.noBrowser);
  if (s.stuck) text += " " + fill(T.stuck, { action: actionOf(s.stuck.tool) + (s.stuck.target ? " " + s.stuck.target : ""), n: s.stuck.count });
  status.textContent = text;
  announce(s.paused ? (s.paused.idleMs ? fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) }) : fill(T.paused, { by }) + T.yourControls) : s.stuck ? fill(T.stuck, { action: actionOf(s.stuck.tool), n: s.stuck.count }) : s.busy ? T.working : "");
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
events.addEventListener("steps", (e) => { list.replaceChildren(); const empty = document.createElement("li"); empty.className = "empty"; empty.textContent = T.noSteps; list.append(empty); addSteps(JSON.parse(e.data), true); });
events.addEventListener("step", (e) => addSteps([JSON.parse(e.data)], false));
events.addEventListener("frame", (e) => {
  const f = JSON.parse(e.data);
  if (!state || !state.view.available || state.hidden) return;
  size = { w: f.w, h: f.h };
  frame.src = "data:image/jpeg;base64," + f.data;
});
events.onerror = () => { $("status").textContent = T.disconnected; announce(T.disconnected); };
$("pause").onclick = () => post("/pause");
$("resume").onclick = () => post("/resume");
function point(e) {
  const r = frame.getBoundingClientRect();
  return { x: Math.round(((e.clientX - r.left) * size.w) / r.width), y: Math.round(((e.clientY - r.top) * size.h) / r.height) };
}
// Input while the agent works takes the controls: the server pauses it first.
function canAct() { return !!state && state.view.available && !state.hidden; }
frame.addEventListener("click", (e) => { frame.focus(); if (canAct()) post("/input", { type: "click", ...point(e) }); });
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
<div class="layout">
<main><div id="notice" role="status"></div><img id="frame" alt="${escapeHtml(t.frameAlt)}" tabindex="0"></main>
<aside aria-labelledby="steps-title"><h2 id="steps-title">${escapeHtml(t.steps)}</h2><ol id="steps" aria-live="polite" aria-relevant="additions"><li class="empty">${escapeHtml(t.noSteps)}</li></ol></aside>
</div>
<div id="announce" class="sr" role="status" aria-live="polite"></div>
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
