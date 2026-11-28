// The side panel: what the agent does in this window, next to the page. It reads the live
// server of turno-browser-mcp on 127.0.0.1 (`live-server.ts`): the state, the steps of the
// timeline and the typed effect events of each action, never a picture of the page. Its words
// and the kind of each tool come from the server (`boot`), in the identity's language.
//
// The server's address and a one-use code come from this extension's service worker, where the
// host put them over the DevTools protocol; the panel trades the code for a token that lives only
// in this page's memory. Text from pages (titles, URLs, targets) only ever goes into
// `textContent`; the only markup this script builds is its own constant icons.

const $ = (id) => document.getElementById(id);
const ES = (navigator.language || "").toLowerCase().startsWith("es");
let T = null; // the live view's strings (`ui-strings.ts`), with `panel` and `stage`
let S = null; // T.stage
let P = null; // T.panel
let K = {}; // tool name -> kind
let server = "";
let token = "";
let state = null;

function fill(t, v) {
  for (const k in v) t = t.split(`{${k}}`).join(String(v[k]));
  return t;
}
function span(cls, text) {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  return e;
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function duration(ms) {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
function clock(at) {
  return new Date(at).toLocaleTimeString(document.documentElement.lang, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function note(text) {
  $("notice").textContent = text || "";
}
let said = "";
function announce(text) {
  if (text && text !== said) {
    said = text;
    $("announce").textContent = text;
  }
}

// Icons: constant SVG paths, the same as the live view's.
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
  live: '<rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/>',
  other: '<circle cx="8" cy="8" r="2.5"/>',
};
function icon(name, size) {
  const t = document.createElement("template");
  t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.other}</svg>`;
  return t.content.firstChild;
}
const TONE = { read: "read", type: "type", human: "human" };
const toneOf = (kind) => TONE[kind] || "agent";
const kindOf = (tool) => K[tool] || "other";
function setTone(el, name) {
  el.style.setProperty("--c", `var(--${name})`);
}
function actionOf(tool) {
  const name = tool.replace(/^browser_/, "").replace(/_/g, " ");
  return T.actions[tool] || name.charAt(0).toUpperCase() + name.slice(1);
}
function stepText(tool, target) {
  return actionOf(tool) + (target ? ` ${target}` : "");
}
function byName(by) {
  return (
    {
      "the live view": T.byView,
      "the side panel": T.byPanel,
      browser_request_human: T.byStep,
      "the person's input in the browser window": T.byWindow,
    }[by] || by
  );
}

// The state pill and the "Now" card.
function pill(text, tone, running) {
  $("status").textContent = text;
  setTone($("pill"), tone || "muted");
  $("pill").classList.toggle("run", !!running);
}
const card = { since: 0, timer: 0 };
function now(iconName, title, detail, tone, running, ask) {
  const el = $("now");
  setTone(el, tone || "muted");
  el.classList.toggle("ask", !!ask);
  el.classList.toggle("bad", tone === "bad");
  $("now-acts").hidden = !ask;
  $("now-d").textContent = ask && ask.detail ? ask.detail : "";
  $("now-ic").replaceChildren(icon(iconName, 17));
  $("now-v").textContent = title;
  $("now-t").textContent = detail || "";
  // The elapsed time of what runs or waits: one text update a second, never an animation.
  clearInterval(card.timer);
  $("now-e").textContent = "";
  if (running || ask) {
    card.since = Date.now();
    card.timer = setInterval(() => {
      $("now-e").textContent = duration(Date.now() - card.since);
    }, 1000);
  }
}

// What the agent does now, from the effect events (fx), and the gaps between them (thinking).
const THINK_AFTER_MS = 450;
const RUN_IDLE_MS = 20000;
const run = {
  open: null,
  began: 0,
  steps: 0,
  lastEnd: 0,
  mode: "waiting",
  human: null,
  taken: false,
  think: 0,
  done: 0,
};
function paused() {
  return !!(state && state.paused) || run.taken || !!run.human;
}
function startStep(e) {
  clearTimeout(run.think);
  clearTimeout(run.done);
  if (run.mode !== "working" && run.mode !== "thinking") {
    run.began = e.at;
    run.steps = 0;
  }
  run.open = e;
  run.mode = "working";
  const tone = toneOf(e.kind);
  let detail = S.running;
  if (e.vault) detail = S.fromVault;
  else if (e.chars !== undefined) detail = fill(S.typed, { n: e.chars });
  else if (e.dir) detail = S.scroll[e.dir];
  if (e.agent) detail = `${detail} · ${e.agent}`;
  if (!run.human) now(e.kind, stepText(e.tool, e.target), detail, tone, true);
  if (!paused()) pill(S.kinds[e.kind] || S.kinds.other, tone, true);
}
function endStep(e) {
  const mine = run.open && e.step !== 0 && run.open.step === e.step ? run.open : null;
  if (mine) run.open = null;
  run.steps++;
  run.lastEnd = e.at;
  if (run.human) return;
  const title = mine ? stepText(mine.tool, mine.target) : $("now-v").textContent;
  if (e.outcome === "handed") {
    const what = mine && mine.target ? fill(S.handedLine, { what: mine.target }) : S.handedPlain;
    now("human", what, S.handed, "human", false);
    if (!paused()) pill(S.handed, "human", false);
  } else if (e.outcome === "error") {
    const failed = e.code ? fill(S.failedCode, { code: e.code }) : S.failedPlain;
    now("error", title, failed, "bad", false);
    if (!paused()) pill(e.stuck ? S.looksStuck : failed, "bad", false);
  } else {
    const kind = mine ? mine.kind : "other";
    now(kind, title, duration(e.ms), toneOf(kind), false);
  }
  if (!run.open) idleSoon();
}
/** After a call: thinking once no call starts for a moment, done once none starts for a while. */
function idleSoon() {
  clearTimeout(run.think);
  clearTimeout(run.done);
  run.think = setTimeout(() => {
    if (run.open || paused()) return;
    run.mode = "thinking";
    if (!(state && state.stuck)) pill(S.thinking, "agent", true);
    now("think", S.thinking, S.thinkingHint, "agent", true);
  }, THINK_AFTER_MS);
  run.done = setTimeout(() => {
    if (run.open || paused()) return;
    run.mode = "done";
    if (run.steps > 0) {
      pill(S.done, "ok", false);
      now("done", S.done, fill(S.doneHint, { n: run.steps, t: duration(run.lastEnd - run.began) }), "ok", false);
    }
  }, RUN_IDLE_MS);
}
function humanTurn(e) {
  clearTimeout(run.think);
  clearTimeout(run.done);
  run.human = e;
  run.mode = "human";
  const title = S.human[e.cue] || S.human.step;
  $("take").hidden = true;
  pill(title, "human", false);
  now("human", title, e.text || P.humanHint, "human", false, { detail: e.detail || "" });
  announce(title);
}
function takeOver() {
  clearTimeout(run.think);
  clearTimeout(run.done);
  run.taken = true;
  run.mode = "taken";
  $("take").hidden = false;
  pill(S.takeOver, "human", false);
  now("human", S.takeOver, P.takeOverHint, "human", false);
}
function handBack(e) {
  run.human = null;
  run.taken = false;
  run.mode = "working";
  $("take").hidden = true;
  now("navigate", fill(S.backAfter, { t: duration(e.ms) }), "", "human", false);
  if (state) render(state);
  idleSoon();
}
function onFx(e) {
  if (e.type === "start") startStep(e);
  else if (e.type === "end") endStep(e);
  else if (e.type === "human") humanTurn(e);
  else if (e.type === "take-over") takeOver(e);
  else if (e.type === "hand-back") handBack(e);
}

// The timeline: one line per call, the person's turns, the site it moved to, the gaps for thinking.
const list = $("steps");
let lastEnd = 0;
let lastHost = "";
let calls = 0;
function line(cls, iconName, tone) {
  const li = document.createElement("li");
  li.className = cls;
  setTone(li, tone);
  const ic = span("ic", "");
  ic.append(icon(iconName, 14));
  li.append(ic);
  return li;
}
function stepLines(s) {
  const out = [];
  if (s.kind === "call") {
    const kind = kindOf(s.tool);
    const bad = s.outcome === "error";
    const handed = s.outcome === "handed";
    const li = line(
      s.outcome + (s.stuck ? " stuck" : ""),
      s.stuck ? "stuck" : bad ? "error" : handed ? "human" : kind,
      bad ? "bad" : s.outcome === "not-run" || handed ? "human" : toneOf(kind),
    );
    const what = span("what", handed ? "" : actionOf(s.tool) + (s.target ? " " : ""));
    if (handed) {
      const [before, after] = (s.target ? S.handedLine : S.handedPlain).split("{what}");
      what.append(before);
      if (s.target && after !== undefined) what.append(span("target", s.target), after);
    } else if (s.target) what.append(span("target", s.target));
    what.title = s.tool;
    li.append(what, span("d", duration(s.ms)));
    const parts = [clock(s.at)];
    if (s.waited) parts.push(T.waited);
    if (bad) parts.push(T.failed + (s.detail ? `: ${s.detail}` : ""));
    if (s.outcome === "not-run") parts.push(T.notRun);
    if (handed) parts.push(S.handed + (s.detail ? `: ${s.detail}` : ""));
    if (s.stuck) parts.push(fill(T.stuck, { action: stepText(s.tool, s.target), n: s.stuck }));
    if (s.agent) parts.push(s.agent);
    li.append(span("meta", parts.join(" · ")));
    const gap = lastEnd ? s.at - s.ms - lastEnd : 0;
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
  if (s.kind === "pause")
    what.textContent = s.step
      ? T.stepEntry
      : fill(
          s.by === "the live view" || s.by === "the side panel" || s.by === "the person's input in the browser window"
            ? T.tookOverEntry
            : T.pausedEntry,
          { by: byName(s.by) },
        );
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
  for (const s of steps) for (const li of stepLines(s)) list.prepend(li);
  while (list.children.length > 300) list.lastElementChild.remove();
  $("count").textContent = String(calls);
  if (quiet) setTimeout(() => list.setAttribute("aria-live", "polite"), 0);
}

function render(s) {
  state = s;
  $("id").textContent = s.identity;
  const by = s.paused ? byName(s.paused.by) : "";
  let text = s.paused
    ? (s.paused.idleMs
        ? `${fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) })} `
        : fill(T.paused, { by })) +
      (s.waiting ? (s.waiting === 1 ? T.waitingOne : fill(T.waitingMany, { n: s.waiting })) : "") +
      (s.paused.idleMs ? "" : s.busy ? T.stillRunning : T.yourControls)
    : (s.busy ? T.working : T.idle) + (s.browser ? "" : T.noBrowser);
  if (s.stuck) text += ` ${fill(T.stuck, { action: stepText(s.stuck.tool, s.stuck.target), n: s.stuck.count })}`;
  $("pill").title = text;
  // A panel that opens during a pause gets no fx event for it: the state says which it is.
  const step = s.paused && (s.paused.by === "browser_request_human" || s.paused.by === "a passkey prompt");
  if (s.paused && step && !run.human) humanTurn({ cue: s.paused.by === "a passkey prompt" ? "passkey" : "step" });
  else if (s.paused && !step && !run.taken) takeOver();
  else if (!s.paused && (run.human || run.taken)) {
    run.human = null;
    run.taken = false;
    $("take").hidden = true;
    now("navigate", S.idle, "", "muted", false);
  }
  if (s.paused && !run.human) $("now-t").textContent = text;
  else if (s.stuck && !run.human) {
    pill(S.looksStuck, "bad", false);
    now("stuck", S.looksStuck, text, "bad", false);
  }
  if (!s.paused && !s.stuck) {
    if (run.open) pill(S.kinds[run.open.kind] || S.kinds.other, toneOf(run.open.kind), true);
    else if (run.mode === "thinking") pill(S.thinking, "agent", true);
    else if (run.mode === "done") pill(S.done, "ok", false);
    else if (run.mode === "waiting") pill(S.waiting, "muted", false);
    else if (!s.busy) pill(S.idle, "muted", false);
  }
  announce(
    s.paused
      ? s.paused.idleMs
        ? fill(T.tookOver, { by, s: Math.round(s.paused.idleMs / 1000) })
        : fill(T.paused, { by }) + T.yourControls
      : s.stuck
        ? fill(T.stuck, { action: actionOf(s.stuck.tool), n: s.stuck.count })
        : "",
  );
  $("pause").disabled = !!s.paused && !s.paused.idleMs;
  $("resume").disabled = !s.paused;
  $("live").hidden = !s.view.available || !s.browser;
}

// The connection: the code from the service worker, the token, then the event stream.
async function post(path, body) {
  try {
    const res = await fetch(server + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (data.error) note(data.error);
    else {
      note("");
      if (data.identity) render(data);
    }
    return data;
  } catch (error) {
    note(String(error));
    return { error: String(error) };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The token outlives a reload of this panel page (never the panel itself): this page's own
// session storage, which no site can read.
const KEPT = "turno-panel";
function keep(value) {
  try {
    if (value) sessionStorage.setItem(KEPT, JSON.stringify(value));
    else sessionStorage.removeItem(KEPT);
  } catch {
    /* not kept */
  }
}
async function session() {
  try {
    const kept = JSON.parse(sessionStorage.getItem(KEPT) || "null");
    if (kept && typeof kept.server === "string" && typeof kept.token === "string") {
      server = kept.server;
      token = kept.token;
      return;
    }
  } catch {
    /* none */
  }
  for (;;) {
    const offer = await chrome.runtime.sendMessage({ type: "connect" }).catch(() => null);
    if (offer) {
      try {
        const res = await fetch(`${offer.server}/panel/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: offer.code }),
        });
        const data = await res.json();
        if (res.ok && typeof data.token === "string") {
          server = offer.server;
          token = data.token;
          keep({ server, token });
          return;
        }
      } catch {
        /* the server went away: wait for the next offer */
      }
    }
    await sleep(1000);
  }
}
function boot(b) {
  T = b.strings;
  S = T.stage;
  P = T.panel;
  K = b.kinds || {};
  document.documentElement.lang = b.locale || "en";
  document.title = P.title;
  $("now-k").textContent = S.now;
  $("steps-title").textContent = T.steps;
  $("pause").textContent = T.pause;
  $("resume").textContent = T.resume;
  $("takeback").textContent = T.resume;
  $("take-t").textContent = S.takeOver;
  $("now-done").textContent = S.humanDone;
  $("now-hint").textContent = P.doneHint;
  const live = $("live");
  live.replaceChildren(icon("live", 13), document.createTextNode(P.openLive));
  live.title = P.openLiveHint;
  if (!run.human && !run.open) now("think", S.waiting, P.waitingHint, "muted", false);
}
function onEvent(name, data) {
  const value = JSON.parse(data);
  if (name === "boot") boot(value);
  else if (!T) return;
  else if (name === "state") render(value);
  else if (name === "steps") {
    list.replaceChildren();
    lastEnd = 0;
    lastHost = "";
    calls = 0;
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = T.noSteps;
    list.append(empty);
    $("count").textContent = "0";
    addSteps(value, true);
  } else if (name === "step") addSteps([value], false);
  else if (name === "fx") onFx(value);
}
/** Reads the server's event stream (text/event-stream) until it ends; false when the token is refused. */
async function stream() {
  const res = await fetch(`${server}/panel/events`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok || !res.body) return true;
  note("");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return true;
    buf += value;
    let cut = buf.indexOf("\n\n");
    while (cut >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let name = "message";
      const data = [];
      for (const l of block.split("\n")) {
        if (l.startsWith("event: ")) name = l.slice(7);
        else if (l.startsWith("data: ")) data.push(l.slice(6));
      }
      if (data.length) onEvent(name, data.join("\n"));
      cut = buf.indexOf("\n\n");
    }
  }
}
async function main() {
  pill(ES ? "Conectando..." : "Connecting...", "muted", false);
  for (;;) {
    if (!token) await session();
    const ok = await stream().catch(() => true);
    if (!ok) {
      token = "";
      keep(null);
    }
    if (T) pill(P.disconnected, "muted", false);
    await sleep(2000);
  }
}

$("pause").onclick = () => post("/pause");
$("resume").onclick = () => post("/resume");
$("takeback").onclick = () => post("/resume");
$("now-done").onclick = () => post("/resume");
$("live").onclick = () => post("/panel/live");
main();
