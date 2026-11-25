#!/usr/bin/env node
// Evaluation suite for turno-browser: a fixed set of browser tasks on local fixture pages, run
// through the real MCP server, with paired A/B runs so a change can be judged.
//
//   pnpm build && pnpm bench:browser                       # every task, the default config
//   pnpm bench:browser --b settle-100 --rounds 5           # A/B: default against settle-100
//   pnpm bench:browser --smoke                             # the quick subset CI runs
//   pnpm bench:browser --list                              # tasks and configurations
//
// Options:
//   --a <config>          configuration A (default: default)
//   --b <config>          configuration B; with it every task runs in both, in pairs, and the
//                         one that goes first alternates by round
//   --rounds <n>          runs of each task per configuration (default 3)
//   --tasks <a,b>         only these tasks
//   --smoke               only the smoke tasks, one round (unless --rounds is given)
//   --config-file <file>  more configurations, a JSON list (see bench/browser/lib/configs.mjs)
//   --headed              visible Chrome windows (default headless; a configuration can override)
//   --json                print the JSON report instead of tables
//   --out <file>          also write the JSON report to a file
//   --seed <n>            seed of the bootstrap intervals (default 1)
//   --driver <module>     drive the tasks with a module instead of their scripts (a model, say);
//                         see "Model-driven runs" below
//
// Every run starts the built turno-browser-mcp on a throwaway identity in a throwaway HOME and
// a fresh fixture site, launches Chrome before measuring (a browser_evaluate that reads the
// user agent), then runs the task and records: success (from what the site received), tool
// calls, tool errors, wall time of the task, result bytes and estimated tokens (bytes / 4), and
// the peak resident memory of the server and its Chrome processes. It also records the bytes of
// the page snapshots the model reads (observation tokens), the wall time of each call by tool,
// and, from the input events the fixture pages record, actions that landed on another element
// than the one named (wrong-element actions per 1,000) and how a click's time splits around its
// input events (before the press, the press, after the click event: the settle wait). Exit code 1
// when any run failed or errored; configurations the server does not support are skipped and
// reported.
//
// Model-driven runs: --driver <module> loads an ES module whose default export is
// `{ name, async run({ goal, startUrl, agent, tools }) }`. For every task it gets the request in
// words (`goal`), the page to start on, the run's Agent (lib/server.mjs: `agent.call(tool, args)`
// calls a tool and records it like the scripted runs do) and the server's tool list, and it
// returns the answer for read-only tasks (`find`). The check is the same as for scripted runs, so
// success, steps, time, tokens and wrong-element actions compare directly. The suite ships no
// driver and needs no model: scripted runs are the default.

import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { auditActions, clickTimings } from "./lib/audit.mjs";
import { isHeaded, knownConfigs, readConfigsFile, resolveConfig } from "./lib/configs.mjs";
import { startSite } from "./lib/fixtures.mjs";
import { DEFAULT_BIN, UnsupportedConfig, buildVersions, memorySampler, startServer, warmUp } from "./lib/server.mjs";
import { median, paired, schedule } from "./lib/stats.mjs";
import { TASKS, pickTasks } from "./lib/tasks.mjs";

const { values } = parseArgs({
  options: {
    a: { type: "string", default: "default" },
    b: { type: "string" },
    rounds: { type: "string" },
    tasks: { type: "string" },
    smoke: { type: "boolean", default: false },
    "config-file": { type: "string" },
    headed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    driver: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const log = (msg) => process.stderr.write(`${msg}\n`);

function fail(msg) {
  log(`eval: ${msg}`);
  process.exit(2);
}

let known;
let tasks;
let configs;
try {
  known = knownConfigs(values["config-file"] ? readConfigsFile(values["config-file"]) : []);
  tasks = pickTasks(values.tasks?.split(",").filter(Boolean), { smoke: values.smoke });
  configs = [resolveConfig(values.a, known), ...(values.b ? [resolveConfig(values.b, known)] : [])];
} catch (err) {
  fail(err.message);
}

if (values.list) {
  console.log("Tasks (* runs in --smoke):");
  for (const t of TASKS) console.log(`  ${t.smoke ? "*" : " "} ${t.id.padEnd(8)} ${t.title}`);
  console.log("\nConfigurations:");
  for (const c of known.values())
    console.log(`    ${c.name.padEnd(15)} ${c.description}${c.needs ? ` (needs ${c.needs})` : ""}`);
  process.exit(0);
}

const rounds = Number(values.rounds ?? (values.smoke ? 1 : 3));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) fail("--rounds must be a whole number from 1 to 100");
if (configs.length === 2 && configs[0].name === configs[1].name) {
  // An A/A run: the differences show this machine's noise. B gets its own label in the report.
  configs[1] = { ...configs[1], name: `${configs[1].name}-b` };
  log("eval: A and B are the same configuration; the differences show the noise of this machine");
}

let driver;
if (values.driver) {
  try {
    driver = (await import(pathToFileURL(resolve(values.driver)).href)).default;
  } catch (err) {
    fail(`--driver: ${err.message}`);
  }
  if (typeof driver?.run !== "function") fail("--driver: the module's default export has no run function");
}

async function runOne({ task, config, round }) {
  const base = { task: task.id, config: config.name, round };
  const site = await startSite();
  let server;
  try {
    try {
      server = await startServer(config, { headed: isHeaded(config, values.headed) });
    } catch (err) {
      if (err instanceof UnsupportedConfig) return { ...base, status: "unsupported", detail: err.message };
      return { ...base, status: "error", detail: err.message };
    }
    let browser;
    try {
      browser = (await warmUp(server.client, `${site.url}/blank`)).browser;
    } catch (err) {
      return { ...base, status: "error", detail: err.message };
    }
    const sampler = memorySampler(server.pid, server.home);
    const agent = server.agent();
    const ctx = { agent, site };
    const tools = driver ? (await server.client.listTools()).tools : undefined;
    const t0 = performance.now();
    let failure;
    try {
      if (driver)
        ctx.answer = await driver.run({ goal: task.goal, startUrl: `${site.url}${task.start}`, agent, tools });
      else await task.run(ctx);
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    const wallMs = Math.round(performance.now() - t0);
    const check = failure
      ? { ok: false, detail: failure }
      : await task.check(ctx).catch((err) => ({ ok: false, detail: String(err?.message ?? err) }));
    const peakMiB = await sampler.stop();
    // The pages send their input events in batches; let the last one arrive.
    await new Promise((r) => setTimeout(r, 200));
    const audit = auditActions(agent.steps, site.actions);
    const count = (o) => audit.filter((a) => a.outcome === o).length;
    return {
      ...base,
      status: check.ok ? "ok" : "failed",
      ...(check.detail ? { detail: check.detail } : {}),
      wallMs,
      ...agent.summary(),
      peakMiB,
      browser,
      actions: audit.length - count("refused"),
      wrongElement: count("wrong"),
      noEffect: count("none"),
      ...(count("wrong") ? { wrong: audit.filter((a) => a.outcome === "wrong") } : {}),
      clicks: clickTimings(agent.steps, site.actions, site.requests),
      steps: agent.steps,
    };
  } finally {
    await server?.stop();
    await site.close();
  }
}

const startedAt = new Date();
const plan = schedule(tasks, configs, rounds);
const unsupported = new Map();
const results = [];
log(
  `eval: ${tasks.length} task(s) x ${configs.length} configuration(s) x ${rounds} round(s), ${values.headed ? "headed" : "headless"}`,
);
for (const [i, item] of plan.entries()) {
  if (unsupported.has(item.config.name)) {
    results.push({ task: item.task.id, config: item.config.name, round: item.round, status: "unsupported" });
    continue;
  }
  const r = await runOne(item);
  if (r.status === "unsupported") unsupported.set(item.config.name, r.detail);
  results.push(r);
  const what =
    r.status === "ok" || r.status === "failed"
      ? `${r.status === "ok" ? "ok" : `FAILED (${r.detail})`} ${r.wallMs} ms, ${r.calls} calls, ~${r.tokens} tokens, ${r.peakMiB} MiB`
      : `${r.status.toUpperCase()} (${r.detail})`;
  log(`[${i + 1}/${plan.length}] round ${item.round + 1} ${item.task.id} ${item.config.name}: ${what}`);
}

const measured = (r) => r.status === "ok" || r.status === "failed";
const METRICS = ["wallMs", "calls", "errors", "tokens", "observationTokens", "peakMiB"];

/** Wrong-element actions per 1,000 actions that reached the page, over a set of runs. */
function wrongPer1000(runs) {
  const actions = runs.reduce((n, r) => n + (r.actions ?? 0), 0);
  return actions ? Math.round((runs.reduce((n, r) => n + (r.wrongElement ?? 0), 0) / actions) * 1000 * 10) / 10 : NaN;
}

function cell(task, config) {
  const runs = results.filter((r) => r.task === task && r.config === config && measured(r));
  const out = { runs: runs.length, ok: runs.filter((r) => r.status === "ok").length };
  out.successRate = runs.length ? out.ok / runs.length : NaN;
  for (const m of METRICS) out[m] = median(runs.map((r) => r[m]));
  out.actions = runs.reduce((n, r) => n + (r.actions ?? 0), 0);
  out.wrongPer1000 = wrongPer1000(runs);
  out.noEffect = runs.reduce((n, r) => n + (r.noEffect ?? 0), 0);
  return out;
}

/** Over every run of a configuration: success, wrong elements, and the median wall time of a call, by tool. */
function configTotals(config) {
  const runs = results.filter((r) => r.config === config && measured(r));
  const byTool = {};
  for (const s of runs.flatMap((r) => r.steps ?? [])) {
    byTool[s.tool] ??= [];
    byTool[s.tool].push(s.ms);
  }
  const clicks = runs.flatMap((r) => r.clicks ?? []);
  const split = (list) => ({
    n: list.length,
    beforeMs: median(list.map((c) => c.beforeMs)),
    inputMs: median(list.map((c) => c.inputMs)),
    afterMs: median(list.map((c) => c.afterMs)),
    totalMs: median(list.map((c) => c.beforeMs + c.inputMs + c.afterMs)),
  });
  return {
    runs: runs.length,
    successRate: runs.length ? runs.filter((r) => r.status === "ok").length / runs.length : NaN,
    actions: runs.reduce((n, r) => n + (r.actions ?? 0), 0),
    wrongPer1000: wrongPer1000(runs),
    noEffect: runs.reduce((n, r) => n + (r.noEffect ?? 0), 0),
    perTool: Object.fromEntries(
      Object.entries(byTool).map(([tool, ms]) => [tool, { calls: ms.length, medianMs: median(ms) }]),
    ),
    clicks: {
      all: split(clicks),
      withoutRequests: split(clicks.filter((c) => !c.requests)),
      withRequests: split(clicks.filter((c) => c.requests)),
    },
  };
}

function pairsOf(task, metric) {
  const out = [];
  for (let round = 0; round < rounds; round++) {
    const find = (c) => results.find((r) => r.task === task && r.config === c && r.round === round && measured(r));
    const a = find(configs[0].name);
    const b = find(configs[1].name);
    if (a && b) out.push({ a: a[metric], b: b[metric] });
  }
  return out;
}

function totalsPairs(metric) {
  const out = [];
  for (let round = 0; round < rounds; round++) {
    const sum = (c) => {
      const rs = tasks.map((t) =>
        results.find((r) => r.task === t.id && r.config === c && r.round === round && measured(r)),
      );
      if (rs.some((r) => !r)) return undefined;
      return metric === "peakMiB" ? Math.max(...rs.map((r) => r[metric])) : rs.reduce((n, r) => n + r[metric], 0);
    };
    const a = sum(configs[0].name);
    const b = sum(configs[1].name);
    if (a !== undefined && b !== undefined) out.push({ a, b });
  }
  return out;
}

const seed = Number(values.seed);
const summary = {
  cells: Object.fromEntries(
    tasks.map((t) => [t.id, Object.fromEntries(configs.map((c) => [c.name, cell(t.id, c.name)]))]),
  ),
  configs: Object.fromEntries(configs.map((c) => [c.name, configTotals(c.name)])),
};
if (configs.length === 2) {
  summary.paired = {};
  for (const t of tasks) {
    summary.paired[t.id] = Object.fromEntries(METRICS.map((m) => [m, paired(pairsOf(t.id, m), { seed })]));
  }
  summary.paired.all = Object.fromEntries(METRICS.map((m) => [m, paired(totalsPairs(m), { seed })]));
}

const firstBrowser = results.find((r) => r.browser)?.browser;
const report = {
  version: 1,
  kind: "turno-browser-eval",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  node: process.version,
  browser: firstBrowser,
  headed: values.headed,
  rounds,
  driver: driver?.name ?? "scripted",
  tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
  configs: configs.map((c) => ({
    ...c,
    bin: c.bin ? "(another build)" : undefined,
    versions: buildVersions(c.bin ?? DEFAULT_BIN),
  })),
  unsupported: Object.fromEntries(unsupported),
  results,
  summary,
};

if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-");

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => String(c).padEnd(widths[i]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function deltaCell(p) {
  if (!p || !p.n) return "-";
  const rel = p.relative === undefined ? "" : ` (${p.relative > 0 ? "+" : ""}${Math.round(p.relative * 100)}%)`;
  const ci = p.interval ? ` [${fmt(p.interval[0])}, ${fmt(p.interval[1])}]` : "";
  return `${p.delta > 0 ? "+" : ""}${fmt(p.delta)}${rel} ${p.lower}/${p.higher}${ci}`;
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const v = report.configs[0].versions;
  console.log(
    `\nturno-browser ${v.turnoBrowser ?? "?"} (patchright-core ${v.patchrightCore ?? "?"}), ${firstBrowser ?? "browser unknown"}, ${values.headed ? "headed" : "headless"}, ${rounds} round(s), medians:\n`,
  );
  const rows = [["TASK", "CONFIG", "OK", "STEPS", "ERRORS", "WALL ms", "TOKENS", "OBS TOKENS", "WRONG/1k", "PEAK MiB"]];
  for (const t of tasks) {
    for (const [j, c] of configs.entries()) {
      const s = summary.cells[t.id][c.name];
      if (unsupported.has(c.name)) {
        rows.push([j ? "" : t.id, c.name, "unsupported", "", "", "", "", "", "", ""]);
        continue;
      }
      rows.push([
        j ? "" : t.id,
        c.name,
        `${s.ok}/${s.runs}`,
        fmt(s.calls),
        fmt(s.errors),
        fmt(s.wallMs),
        fmt(s.tokens),
        fmt(s.observationTokens),
        Number.isFinite(s.wrongPer1000) ? String(s.wrongPer1000) : "-",
        fmt(s.peakMiB),
      ]);
    }
  }
  console.log(table(rows));
  const measuredConfigs = configs.filter((c) => !unsupported.has(c.name));
  if (measuredConfigs.length) {
    console.log("\nEvery run of each configuration:\n");
    const trow = [["CONFIG", "SUCCESS", "ACTIONS", "WRONG/1k", "NO EFFECT"]];
    for (const c of measuredConfigs) {
      const t = summary.configs[c.name];
      trow.push([
        c.name,
        `${Math.round(t.successRate * 100)}%`,
        fmt(t.actions),
        Number.isFinite(t.wrongPer1000) ? String(t.wrongPer1000) : "-",
        fmt(t.noEffect),
      ]);
    }
    console.log(table(trow));
    const tools = [...new Set(measuredConfigs.flatMap((c) => Object.keys(summary.configs[c.name].perTool)))].sort();
    console.log("\nMedian wall time of one call, ms (calls):\n");
    const prow = [["TOOL", ...measuredConfigs.map((c) => c.name)]];
    for (const tool of tools)
      prow.push([
        tool,
        ...measuredConfigs.map((c) => {
          const x = summary.configs[c.name].perTool[tool];
          return x ? `${fmt(x.medianMs)} (${x.calls})` : "-";
        }),
      ]);
    console.log(table(prow));
    console.log(
      "\nA click, from the page's clock, medians in ms: before the press (find, wait, scroll, move), the press, after the click event (settle wait, requests, result):\n",
    );
    const crow = [["CONFIG", "CLICKS", "BEFORE", "PRESS", "AFTER", "TOTAL"]];
    for (const c of measuredConfigs) {
      const k = summary.configs[c.name].clicks;
      for (const [label, x] of [
        ["all", k.all],
        ["no request", k.withoutRequests],
        ["with requests", k.withRequests],
      ]) {
        if (!x.n) continue;
        crow.push([
          `${c.name}, ${label}`,
          fmt(x.n),
          fmt(x.beforeMs),
          Number.isFinite(x.inputMs) ? x.inputMs.toFixed(1) : "-",
          fmt(x.afterMs),
          fmt(x.totalMs),
        ]);
      }
    }
    console.log(table(crow));
  }
  if (summary.paired && !unsupported.size) {
    console.log(
      `\n${configs[1].name} minus ${configs[0].name}, median of paired differences (relative to A), then pairs where B was lower/higher${rounds >= 5 ? ", then a 95% bootstrap interval" : ""}:\n`,
    );
    const prow = [["TASK", "WALL ms", "CALLS", "TOKENS", "OBS TOKENS", "PEAK MiB"]];
    for (const id of [...tasks.map((t) => t.id), "all"]) {
      const p = summary.paired[id];
      prow.push([
        id,
        deltaCell(p.wallMs),
        deltaCell(p.calls),
        deltaCell(p.tokens),
        deltaCell(p.observationTokens),
        deltaCell(p.peakMiB),
      ]);
    }
    console.log(table(prow));
    if (rounds < 5) console.log("\nUse --rounds 5 or more before trusting a difference.");
  }
  for (const [name, why] of unsupported) console.log(`\n${name}: not supported by this server (${why})`);
  const failed = results.filter((r) => r.status === "failed" || r.status === "error");
  if (failed.length) {
    console.log("\nFailed runs:");
    for (const r of failed) console.log(`  round ${r.round + 1} ${r.task} ${r.config}: ${r.detail}`);
  }
}

process.exit(results.some((r) => r.status === "failed" || r.status === "error") ? 1 : 0);
