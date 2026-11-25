// Unit tests for what the reputation bench and the A/B harness compute from their recordings.
// Run by `pnpm check` (node --test); no browser, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { auditActions, clickTimings } from "./lib/audit.mjs";
import { compareMode, eventMetrics, summarizeRebrowser } from "./lib/reputation.mjs";
import { SOURCES, verified } from "./lib/sources.mjs";

const click = (name, start, end) => ({
  tool: "browser_click",
  start,
  end,
  error: false,
  intents: [{ role: "button", name }],
});
const ev = (type, t, name) => ({ type, t, names: [name] });

test("an action that lands on another element than the one named counts as wrong; a refused one does not", () => {
  const steps = [
    click("Save", 1000, 1600),
    { ...click("Download report", 1600, 6600), error: true },
    click("Accept all", 6600, 7200),
    { tool: "browser_snapshot", start: 7200, end: 7210, error: false },
  ];
  const events = [
    ev("pointerdown", 1100, "Save"),
    ev("click", 1101, "Save"),
    // The second click hit the banner's other button.
    ev("pointerdown", 6700, "Reject all"),
    ev("click", 6701, "Reject all"),
  ];
  assert.deepEqual(
    auditActions(steps, events).map((a) => a.outcome),
    ["ok", "refused", "wrong"],
  );
  assert.deepEqual(auditActions(steps, events)[2].landed, ["Reject all"]);
  // Each call owns the events from its start to the next call's start, even when one call
  // starts in the millisecond the previous one caused its last event.
  assert.deepEqual(
    auditActions([click("A", 0, 100), click("B", 100, 200)], [ev("click", 99, "A"), ev("click", 100, "B")]).map(
      (a) => a.outcome,
    ),
    ["ok", "ok"],
  );
});

test("a click's time splits at the press and the click event, and says whether it sent a request", () => {
  const steps = [click("Save 1", 1000, 1620)];
  const events = [ev("pointerdown", 1080, "Save 1"), ev("click", 1082.4, "Save 1")];
  assert.deepEqual(clickTimings(steps, events, [{ t: 1090, path: "/submit/x" }]), [
    { beforeMs: 80, inputMs: 2.4, afterMs: 538, requests: true },
  ]);
  assert.equal(clickTimings(steps, events, [])[0].requests, false);
});

test("event metrics count clicks with no pointer movement before them, raw and coalesced moves, focus", () => {
  const m = eventMetrics([
    { type: "pointermove", t: 100, trusted: true, coalesced: 0 },
    { type: "mousemove", t: 100, trusted: true },
    { type: "pointerrawupdate", t: 100, trusted: true },
    { type: "click", t: 110, trusted: true, focused: true, visibility: "visible" },
    { type: "click", t: 900, trusted: true, focused: false, visibility: "visible" },
    { type: "keydown", t: 950, trusted: false, focused: true, visibility: "hidden" },
  ]);
  assert.equal(m.clicks, 2);
  assert.equal(m.clicksWithoutMovement, 1);
  assert.deepEqual(m.movesBeforeClick, [1, 0]);
  assert.equal(m.coalescedMoves, 0);
  assert.equal(m.pointerRawUpdates, 1);
  assert.equal(m.untrusted, 1);
  assert.equal(m.inputWithoutFocus, 1);
  assert.equal(m.inputWhileHidden, 1);
  const rate = eventMetrics([0, 10, 20, 30].map((t) => ({ type: "mousemove", t, trusted: true })));
  assert.equal(rate.mousemoveRateHz, 100);
});

test("turno fails a mode only where a detector flags it and plain Chrome is clean", () => {
  const rb = (headless, viewport) =>
    summarizeRebrowser([
      { type: "headless", rating: headless },
      { type: "viewport", rating: viewport },
    ]);
  const creep = (headlessRating, totalLies) => ({ ratings: { headlessRating }, signals: {}, totalLies, lies: {} });
  const same = compareMode(
    { rebrowser: rb(1, -1), creepjs: creep(67, 0), botd: { bot: true, fired: [] } },
    { rebrowser: rb(1, -1), creepjs: creep(67, 0), botd: { bot: true, fired: [] } },
  );
  assert.equal(same.passed, true);
  assert.deepEqual(same.findings, []);
  const worse = compareMode(
    { rebrowser: rb(-1, 0.5), creepjs: creep(33, 2), botd: { bot: true, fired: ["detectWindowSize"] } },
    { rebrowser: rb(-1, -1), creepjs: creep(0, 0), botd: { bot: false, fired: [] } },
  );
  assert.equal(worse.passed, false);
  assert.deepEqual(
    worse.findings.map((f) => `${f.severity} ${f.suite} ${f.item}`),
    [
      "fail creepjs headlessRating",
      "fail creepjs totalLies",
      "fail botd bot",
      "warn rebrowser viewport",
      "warn botd detectors",
    ],
  );
});

test("a detector source is never served when its hash differs from the pin", () => {
  const file = SOURCES.botd.files[0];
  assert.throws(() => verified(file, Buffer.from("export const load = () => {}")), /refusing to serve it/);
});
