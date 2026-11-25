#!/usr/bin/env node
// Reputation bench for turno-browser: the leak and consistency detectors anti-bot vendors build
// on, and a page that records the input events a site sees, each run against turno's Chrome and
// against the same Chrome started without any automation, on this machine. It is what a
// patchright-core or Chrome update is checked with before turno-browser ships it.
//
//   pnpm build && pnpm bench:reputation                         # both modes, every suite
//   pnpm bench:reputation --modes headless --out rep.json       # one mode, keep the JSON
//   pnpm bench:reputation --history bench-history.json          # add the run to a history file
//   pnpm bench:reputation --human                               # also record your own input
//
// Suites, all served by the bench itself on 127.0.0.1 from pinned, hash-checked copies
// (lib/sources.mjs; downloaded once into bench/browser/.cache):
//
//   rebrowser  rebrowser-bot-detector: every test, the automation-triggered ones included
//   creepjs    CreepJS: the headless section (its percentages and the signals behind them) and lies
//   botd       BotD (@fingerprintjs/botd): the verdict and the detectors that fired
//   probe      the fingerprint bench's probe page (navigator, automation markers, protocol side
//              effects, consistency) plus its input events: mousemove rate, clicks with no
//              movement before them, coalesced and pointerrawupdate events, isTrusted, focus
//              and visibility
//
// The public detector pages of the fingerprint bench (Sannysoft, the TLS fingerprint and the
// hosted copies) are added only with TURNO_BENCH_PUBLIC_DETECTORS=1.
//
// Options:
//   --modes <a,b>         headed, headless or both (default: headed,headless)
//   --suites <a,b>        rebrowser, creepjs, botd, probe (default: all)
//   --config <name>       the turno configuration (default: default; see pnpm bench:browser --list)
//   --config-file <file>  more configurations, a JSON list
//   --chrome <path>       the Chrome executable for the plain reference (default: the usual install path)
//   --human               headed only: also open plain Chrome on the probe page for you to do its
//                         steps by hand, the reference for the input events
//   --offline             do not ask chromiumdash for the latest Chrome (one rebrowser test then
//                         cannot tell) and fail instead of downloading a missing source
//   --cache <dir>         where the pinned sources are kept (default: bench/browser/.cache)
//   --update-sources      download the sources again and print their hashes (moving a pin)
//   --history <file>      add this run to a history file, keyed by Chrome and patchright-core version
//   --json                print the JSON report instead of tables
//   --out <file>          also write the JSON report to a file
//
// Every turno run uses the built turno-browser-mcp on a throwaway identity in a throwaway HOME;
// every plain Chrome gets a throwaway profile and the mock keychain. Exit code 1 when a suite
// errored or turno got a detector verdict plain Chrome did not (a `fail` finding); 2 for a usage
// error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { checkReport } from "./lib/checks.mjs";
import { findChrome, startPlainChrome } from "./lib/chrome.mjs";
import { knownConfigs, readConfigsFile, resolveConfig } from "./lib/configs.mjs";
import { probeSteps, startProbeSite } from "./lib/probe.mjs";
import { detectors, loadParsers, publicDetectorsAllowed, visitDetectors } from "./lib/public.mjs";
import { compareMode, eventMetrics, mergeHistory, summarizeRebrowser } from "./lib/reputation.mjs";
import { latestStableRelease, startReputationSite } from "./lib/reputation-site.mjs";
import { DEFAULT_BIN, buildVersions, startServer, warmUp } from "./lib/server.mjs";
import { DEFAULT_CACHE, SOURCES, loadSources } from "./lib/sources.mjs";

const SUITES = ["rebrowser", "creepjs", "botd", "probe"];
const MODES = ["headed", "headless"];
// How long each detector page may take, and how long its result must stay unchanged.
const WAIT = {
  rebrowser: { quietMs: 2500, maxMs: 25_000 },
  creepjs: { quietMs: 500, maxMs: 50_000 },
  botd: { quietMs: 500, maxMs: 20_000 },
};
const HUMAN_MS = 180_000;

const { values } = parseArgs({
  options: {
    modes: { type: "string", default: MODES.join(",") },
    suites: { type: "string", default: SUITES.join(",") },
    config: { type: "string", default: "default" },
    "config-file": { type: "string" },
    chrome: { type: "string" },
    human: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    cache: { type: "string", default: DEFAULT_CACHE },
    "update-sources": { type: "boolean", default: false },
    history: { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const log = (msg) => process.stderr.write(`${msg}\n`);
const usage = (msg) => {
  log(`reputation: ${msg}`);
  process.exit(2);
};
const list = (raw, known, what) => {
  const out = raw.split(",").filter(Boolean);
  for (const x of out) if (!known.includes(x)) usage(`unknown ${what} "${x}" (known: ${known.join(", ")})`);
  return out;
};

const modes = list(values.modes, MODES, "mode");
const suites = list(values.suites, SUITES, "suite");
let config;
try {
  config = resolveConfig(
    values.config,
    knownConfigs(values["config-file"] ? readConfigsFile(values["config-file"]) : []),
  );
} catch (err) {
  usage(err.message);
}
if (values.human && !modes.includes("headed")) usage("--human needs the headed mode");

if (values["update-sources"]) {
  await loadSources({ cache: values.cache, update: true, log });
  log("reputation: paste the hashes above into bench/browser/lib/sources.mjs");
  process.exit(0);
}

const chrome = findChrome(values.chrome);
if (!chrome) usage("Google Chrome was not found (use --chrome <path>)");

let sources;
try {
  if (values.offline) {
    const missing = Object.entries(SOURCES).flatMap(([id, s]) =>
      s.files.filter((f) => !existsSync(`${values.cache}/${id}/${f.path}`)).map((f) => `${id}/${f.path}`),
    );
    if (missing.length) usage(`--offline and not in the cache: ${missing.join(", ")}`);
  }
  sources = await loadSources({ cache: values.cache, log });
} catch (err) {
  log(`reputation: ${err.message}`);
  process.exit(1);
}

const release = values.offline ? undefined : await latestStableRelease();
const allowPublic = publicDetectorsAllowed();
const parsers = allowPublic ? await loadParsers(config.bin ?? DEFAULT_BIN) : undefined;
const publicList = parsers ? detectors(parsers) : [];
const startedAt = new Date();
const site = await startReputationSite(sources, { release });
const probe = await startProbeSite();
const DETECTOR_SUITES = suites.filter((s) => s !== "probe");

function summarize(suite, raw) {
  if (raw === undefined) return { error: "the page did not report" };
  if (suite === "rebrowser") return summarizeRebrowser(raw);
  return raw;
}

/** The full Chrome version a probe report shows (client hints), like "157.0.7712.62". */
const chromeVersionOf = (staticFields) =>
  staticFields?.uaData?.high?.fullVersionList?.find((b) => b.brand === "Google Chrome")?.version;

async function plainRun(mode) {
  const headed = mode === "headed";
  const out = {};
  for (const suite of DETECTOR_SUITES) {
    const run = `plain-${mode}-${suite}`;
    log(`plain Chrome, ${mode}: ${suite}`);
    const p = startPlainChrome(chrome, site.pageUrl(suite, run), { headed });
    try {
      out[suite] = summarize(suite, await site.waitFor(suite, run, WAIT[suite]));
    } finally {
      await p.stop();
    }
  }
  if (suites.includes("probe")) {
    const run = `plain-${mode}`;
    log(`plain Chrome, ${mode}: probe`);
    const p = startPlainChrome(chrome, probe.probeUrl(run), { headed });
    try {
      const r = await probe.waitFor(run);
      // Give the page a moment for the focus and visibility events of its first second.
      await new Promise((resolveWait) => setTimeout(resolveWait, 800));
      const final = probe.reports.get(run) ?? r;
      out.probeStatic = final?.static;
      out.events = final?.static ? eventMetrics(final.events ?? []) : undefined;
      out.chrome = chromeVersionOf(final?.static);
    } finally {
      await p.stop();
    }
  }
  if (values.human && headed && suites.includes("probe")) {
    const run = "human";
    log(`plain Chrome, headed: do the steps listed on the page by hand (up to ${HUMAN_MS / 1000} s)`);
    const p = startPlainChrome(chrome, `${probe.probeUrl(run)}&human=1`, { headed: true });
    try {
      const r = await probe.waitFor(
        run,
        (x) => x.events.some((e) => e.type === "click" && e.target === "far-button"),
        HUMAN_MS,
      );
      out.events = r ? eventMetrics(r.events ?? []) : out.events;
      out.human = Boolean(r?.events?.some((e) => e.type === "click" && e.target === "far-button"));
    } finally {
      await p.stop();
    }
  }
  return out;
}

// What rebrowser asks an automation script to run once the page is open, so its tests that need
// one (main world access, the source URL of evaluated code, calls from the main world) report.
// The function says which world it ran in: only the page's main world sees window.dummyFn.
const REBROWSER_TRIGGERS =
  "() => { const main = typeof window.dummyFn === 'function'; if (main) window.dummyFn(); document.getElementById('detections-json'); document.getElementsByClassName('div'); return main ? 'main world' : 'isolated world'; }";

async function turnoRun(mode, plainStatic) {
  const headed = mode === "headed";
  const out = {};
  let server;
  try {
    server = await startServer(config, { headed });
  } catch (err) {
    return { error: String(err.message) };
  }
  try {
    const warm = await warmUp(server.client, `${site.url}/blank`);
    out.browser = warm.browser;
    out.chrome = /Chrome ([\d.]+)/.exec(warm.browser)?.[1];
    const agent = server.agent();
    for (const suite of DETECTOR_SUITES) {
      const run = `turno-${mode}`;
      let triggers;
      log(`turno, ${mode}: ${suite}`);
      try {
        await agent.must("browser_navigate", { url: site.pageUrl(suite, run) });
        if (suite === "rebrowser") {
          // The page's tests start on load; let them register before the calls they wait for.
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
          const r = await agent.call("browser_evaluate", { function: REBROWSER_TRIGGERS });
          triggers = r.error
            ? `error: ${r.text.split("\n")[0]}`
            : /"main world"/.test(r.text)
              ? "main world"
              : "isolated world";
        }
        out[suite] = summarize(suite, await site.waitFor(suite, run, WAIT[suite]));
        if (triggers) out[suite].triggers = triggers;
      } catch (err) {
        out[suite] = { error: String(err?.message ?? err).split("\n")[0] };
      }
    }
    if (suites.includes("probe")) {
      const run = `turno-${mode}`;
      log(`turno, ${mode}: probe`);
      try {
        await probeSteps(agent, probe.probeUrl(run));
        await probe.waitFor(run, (r) => r.events.some((e) => e.type === "click" && e.target === "far-button"));
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
        const final = probe.reports.get(run);
        const checks = checkReport(final ?? {}, { headed, reference: plainStatic, expect: config.expect });
        out.probe = { checks };
        out.events = eventMetrics(final?.events ?? []);
        out.chrome = chromeVersionOf(final?.static) ?? out.chrome;
      } catch (err) {
        out.probe = { error: String(err?.message ?? err).split("\n")[0] };
      }
    }
    if (publicList.length) {
      log(`turno, ${mode}: public detector pages`);
      out.public = await visitDetectors(agent, publicList);
    }
  } catch (err) {
    out.error = String(err?.message ?? err).split("\n")[0];
  } finally {
    await server.stop();
  }
  return out;
}

const modeReports = [];
try {
  for (const mode of modes) {
    const plain = await plainRun(mode);
    const turno = await turnoRun(mode, plain.probeStatic);
    const compared = turno.error
      ? { passed: false, errors: [turno.error], findings: [] }
      : compareMode(turno, plain, { human: Boolean(plain.human) });
    const { probeStatic, ...plainOut } = plain;
    modeReports.push({ mode, ...compared, turno, plain: plainOut });
  }
} finally {
  await site.close();
  await probe.close();
}

const versions = buildVersions(config.bin ?? DEFAULT_BIN);
const chromeVersion = modeReports.map((m) => m.turno.chrome ?? m.plain.chrome).find(Boolean) ?? "unknown";
const report = {
  version: 1,
  kind: "turno-browser-reputation",
  key: {
    chrome: chromeVersion,
    patchrightCore: versions.patchrightCore ?? "unknown",
    turnoBrowser: versions.turnoBrowser,
  },
  passed: modeReports.every((m) => m.passed),
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  node: process.version,
  config: config.name,
  sources: Object.fromEntries(Object.entries(SOURCES).map(([id, s]) => [id, s.origin])),
  latestStableRelease: release ? "fetched" : "not fetched",
  publicDetectors: allowPublic,
  suites,
  modes: modeReports,
};

if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
if (values.history) {
  const old = existsSync(values.history) ? JSON.parse(readFileSync(values.history, "utf8")) : undefined;
  writeFileSync(values.history, `${JSON.stringify(mergeHistory(old, report), null, 2)}\n`);
}

const show = (v) => {
  if (v === undefined || v === null) return "-";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => String(c ?? "").padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function suiteRows(m) {
  const rows = [["SUITE", "TURNO", "PLAIN CHROME"]];
  const rb = (r) =>
    r?.counts
      ? `${r.counts.pass} pass, ${r.counts.warn} warn, ${r.counts.fail} fail, ${r.counts.untriggered} not triggered`
      : (r?.error ?? "-");
  if (suites.includes("rebrowser")) rows.push(["rebrowser", rb(m.turno.rebrowser), rb(m.plain.rebrowser)]);
  const cj = (r) =>
    r?.ratings
      ? `${Object.entries(r.ratings)
          .map(([k, v]) => `${k.replace(/Rating$/, "")} ${v}%`)
          .join(", ")}, lies ${r.totalLies}`
      : (r?.error ?? "-");
  if (suites.includes("creepjs")) rows.push(["creepjs", cj(m.turno.creepjs), cj(m.plain.creepjs)]);
  const bd = (r) =>
    r && !r.error
      ? `${r.bot ? `bot${r.botKind ? ` (${r.botKind})` : ""}` : "not a bot"}${r.fired?.length ? `, fired: ${r.fired.join(", ")}` : ""}`
      : (r?.error ?? "-");
  if (suites.includes("botd")) rows.push(["botd", bd(m.turno.botd), bd(m.plain.botd)]);
  if (suites.includes("probe")) {
    const t = m.turno.events;
    const p = m.plain.events;
    const ev = (e, human) =>
      e
        ? [
            `mousemove ${e.mousemoves} at ${e.mousemoveRateHz ?? "-"} Hz`,
            `clicks without movement ${e.clicksWithoutMovement}/${e.clicks}`,
            `coalesced ${e.coalescedMoves}/${e.pointermoves}`,
            `pointerrawupdate ${e.pointerRawUpdates}`,
            `untrusted ${e.untrusted}`,
            `input without focus ${e.inputWithoutFocus}`,
            human === false ? "(no input)" : "",
          ]
            .filter(Boolean)
            .join(", ")
        : "-";
    rows.push(["events", ev(t), ev(p, Boolean(m.plain.human))]);
  }
  return rows;
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `\nturno-browser ${report.key.turnoBrowser ?? "?"}, patchright-core ${report.key.patchrightCore}, Chrome ${report.key.chrome}, configuration ${config.name}`,
  );
  for (const m of modeReports) {
    console.log(`\n${m.mode}: ${m.passed ? "PASSED" : "NOT PASSED"}\n`);
    if (!m.turno.error) console.log(table(suiteRows(m)));
    for (const e of m.errors) console.log(`  error: ${e}`);
    const shown = m.findings.filter((f) => f.severity !== "info" || f.suite !== "events");
    if (shown.length) {
      console.log("\nDifferences from plain Chrome:");
      for (const f of shown)
        console.log(
          `  ${f.severity.toUpperCase().padEnd(4)} ${f.suite} ${f.item}: turno ${show(f.turno)}, plain ${show(f.plain)}${f.note ? ` (${show(f.note)})` : ""}`,
        );
    }
  }
  if (!allowPublic) console.log("\nPublic detector pages skipped (set TURNO_BENCH_PUBLIC_DETECTORS=1 to visit them).");
}

process.exit(report.passed ? 0 : 1);
