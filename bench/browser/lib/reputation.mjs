// Turns what the reputation bench collected into numbers and findings. Pure functions over the
// reports, so the unit tests feed them synthetic ones.
//
// A finding compares turno's Chrome with the same Chrome started without automation, in the
// same mode (headed or headless), on the same machine: `fail` is a detector verdict turno gets
// and plain Chrome does not, `warn` a softer signal of the same kind, `info` a difference worth
// knowing that no detector scores (or one in turno's favor). The suite passes when nothing fails.

const RANK = { info: 0, warn: 1, fail: 2 };

/** rebrowser-bot-detector's rating as a status: -1 green, 0 not triggered or not conclusive, 0.5 yellow, 1 red. */
function rebrowserStatus(rating) {
  if (rating < 0) return "pass";
  if (rating === 0) return "untriggered";
  if (rating < 1) return "warn";
  return "fail";
}

/** One row per rebrowser test, and how many tests are in each status. */
export function summarizeRebrowser(list) {
  if (!Array.isArray(list)) return { error: list?.error ?? "no result" };
  const tests = {};
  const counts = { pass: 0, untriggered: 0, warn: 0, fail: 0 };
  for (const d of list) {
    const status = rebrowserStatus(d.rating);
    tests[d.type] = { status, rating: d.rating, ...(status === "pass" ? {} : { note: d.note }) };
    counts[status]++;
  }
  return { tests, counts };
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const round1 = (n) => (n === undefined ? undefined : Math.round(n * 10) / 10);

/**
 * What the event recording page saw, in numbers: how fast and how densely the pointer moves,
 * whether clicks come with movement before them, the raw and coalesced pointer events Chrome
 * delivers for real input, isTrusted, and whether the page had focus and was visible when input
 * arrived. `windowMs` is how far back "movement before a click" looks.
 */
export function eventMetrics(events = [], { windowMs = 500, burstGapMs = 100 } = {}) {
  const input = events.filter((e) => e.type !== "scroll");
  const mouse = events.filter((e) => e.type === "mousemove");
  // A burst is a run of mousemoves with no gap above burstGapMs; its rate is moves per second.
  const rates = [];
  let burst = [];
  const close = () => {
    if (burst.length >= 3) {
      const span = burst[burst.length - 1].t - burst[0].t;
      if (span > 0) rates.push(((burst.length - 1) * 1000) / span);
    }
    burst = [];
  };
  for (const e of mouse) {
    if (burst.length && e.t - burst[burst.length - 1].t > burstGapMs) close();
    burst.push(e);
  }
  close();
  const pointer = events.filter((e) => e.type === "pointermove");
  const clicks = events.filter((e) => e.type === "click");
  const movesBeforeClick = clicks.map(
    (c) => pointer.filter((m) => m.t <= c.t && m.t >= c.t - windowMs && m.trusted).length,
  );
  const inputs = events.filter((e) => e.type === "click" || e.type === "keydown");
  return {
    events: input.length,
    untrusted: input.filter((e) => !e.trusted).length,
    mousemoves: mouse.length,
    mousemoveRateHz: round1(median(rates)),
    pointermoves: pointer.length,
    // Real input carries its coalesced samples (at least the event itself); CDP input carries none.
    coalescedMoves: pointer.filter((e) => (e.coalesced ?? 0) >= 1).length,
    pointerRawUpdates: events.filter((e) => e.type === "pointerrawupdate").length,
    clicks: clicks.length,
    clicksWithoutMovement: movesBeforeClick.filter((n) => n === 0).length,
    movesBeforeClick,
    inputWithoutFocus: inputs.filter((e) => e.focused === false).length,
    inputWhileHidden: inputs.filter((e) => e.visibility && e.visibility !== "visible").length,
    focusEvents: events.filter((e) => e.type === "focus").length,
    blurEvents: events.filter((e) => e.type === "blur").length,
    visibilityChanges: events.filter((e) => e.type === "visibilitychange").length,
  };
}

const finding = (suite, item, severity, turno, plain, note) => ({
  suite,
  item,
  severity,
  turno,
  plain,
  ...(note ? { note } : {}),
});

const STATUS_RANK = { pass: 0, untriggered: 1, warn: 2, fail: 3 };

function compareRebrowser(t, p) {
  if (!t?.tests || !p?.tests) return [];
  const out = [];
  for (const type of new Set([...Object.keys(t.tests), ...Object.keys(p.tests)])) {
    const a = t.tests[type]?.status ?? "missing";
    const b = p.tests[type]?.status ?? "missing";
    if (a === b) continue;
    const worse = (STATUS_RANK[a] ?? 1) > (STATUS_RANK[b] ?? 1);
    const severity = worse && a === "fail" ? "fail" : worse && a === "warn" ? "warn" : "info";
    out.push(finding("rebrowser", type, severity, a, b, t.tests[type]?.note));
  }
  return out;
}

function compareCreep(t, p) {
  if (!t || !p || t.error || p.error) return [];
  const out = [];
  for (const key of new Set([...Object.keys(t.ratings ?? {}), ...Object.keys(p.ratings ?? {})])) {
    const a = t.ratings?.[key];
    const b = p.ratings?.[key];
    if (a === b) continue;
    // The headless group is direct evidence of automation; the other groups are softer.
    const severity = (a ?? 0) > (b ?? 0) ? (key === "headlessRating" ? "fail" : "warn") : "info";
    out.push(finding("creepjs", key, severity, a, b));
  }
  for (const group of new Set([...Object.keys(t.signals ?? {}), ...Object.keys(p.signals ?? {})])) {
    const extra = (t.signals?.[group] ?? []).filter((s) => !(p.signals?.[group] ?? []).includes(s));
    if (extra.length) out.push(finding("creepjs", `signals.${group}`, "info", extra, p.signals?.[group] ?? []));
  }
  const lt = t.totalLies ?? 0;
  const lp = p.totalLies ?? 0;
  if (lt !== lp) {
    const extra = Object.keys(t.lies ?? {}).filter((k) => !(k in (p.lies ?? {})));
    out.push(finding("creepjs", "totalLies", lt > lp ? "fail" : "info", lt, lp, extra.length ? extra.join(", ") : ""));
  }
  return out;
}

function compareBotd(t, p) {
  if (!t || !p || t.error || p.error) return [];
  const out = [];
  if (t.bot !== p.bot)
    out.push(finding("botd", "bot", t.bot ? "fail" : "info", t.botKind ?? t.bot, p.botKind ?? p.bot));
  const extra = (t.fired ?? []).filter((f) => !(p.fired ?? []).includes(f));
  if (extra.length) out.push(finding("botd", "detectors", "warn", extra, p.fired ?? []));
  return out;
}

/**
 * Event numbers side by side. Without a person's input on the plain Chrome (the --human
 * reference) there is nothing to score, so these are facts; with one, a metric where turno is far
 * from the person is a warning.
 */
function compareEvents(t, p, { human }) {
  if (!t) return [];
  const out = [];
  const keys = ["mousemoveRateHz", "coalescedMoves", "pointerRawUpdates", "clicksWithoutMovement", "untrusted"];
  for (const key of keys) {
    if (t[key] === undefined && p?.[key] === undefined) continue;
    const severity =
      human && key !== "pointerRawUpdates" && p?.[key] !== undefined && t[key] !== p[key] ? "warn" : "info";
    out.push(finding("events", key, severity, t[key] ?? null, human ? (p?.[key] ?? null) : "no input"));
  }
  if (t.inputWithoutFocus) out.push(finding("events", "inputWithoutFocus", "info", t.inputWithoutFocus, 0));
  if (t.inputWhileHidden) out.push(finding("events", "inputWhileHidden", "warn", t.inputWhileHidden, 0));
  return out;
}

/** Fields of the probe page that differ from plain Chrome, and probe checks that fail. */
function compareProbe(t) {
  if (!t?.checks) return [];
  const out = [];
  for (const c of t.checks) {
    if (c.status === "fail") out.push(finding("probe", c.id, "fail", c.value ?? null, null, c.note));
    else if (c.id === "matches-plain-chrome" && c.status !== "pass")
      out.push(finding("probe", c.id, "warn", c.value ?? null, null, c.note));
  }
  return out;
}

/** Every finding of one mode, worst first, and whether the mode passes. */
export function compareMode(turno, plain, { human = false } = {}) {
  const findings = [
    ...compareRebrowser(turno.rebrowser, plain.rebrowser),
    ...compareCreep(turno.creepjs, plain.creepjs),
    ...compareBotd(turno.botd, plain.botd),
    ...compareProbe(turno.probe),
    ...compareEvents(turno.events, plain.events, { human }),
  ].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const errors = Object.entries(turno)
    .filter(([, v]) => v?.error)
    .map(([k, v]) => `${k}: ${v.error}`);
  return { passed: !errors.length && !findings.some((f) => f.severity === "fail"), errors, findings };
}

/**
 * Adds a report to a history file's entries, keyed by Chrome version, then patchright-core
 * version: what a later run, or a patchright-core update, is compared with.
 */
export function mergeHistory(history, report) {
  const out =
    history?.kind === "turno-browser-reputation-history"
      ? history
      : { kind: "turno-browser-reputation-history", entries: {} };
  const { chrome, patchrightCore } = report.key;
  out.entries[chrome] ??= {};
  out.entries[chrome][patchrightCore] = {
    turnoBrowser: report.key.turnoBrowser,
    finishedAt: report.finishedAt,
    passed: report.passed,
    modes: Object.fromEntries(
      report.modes.map((m) => [
        m.mode,
        { passed: m.passed, findings: m.findings.filter((f) => f.severity !== "info") },
      ]),
    ),
  };
  return out;
}
