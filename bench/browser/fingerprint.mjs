#!/usr/bin/env node
// Fingerprint and event bench for turno-browser: what a page can observe about the browser the
// server drives, compared with the same Chrome started without automation, across
// configurations, and against an earlier run to catch regressions after a Patchright or
// Chrome update.
//
//   pnpm build && pnpm bench:fingerprint                              # default config, headless
//   pnpm bench:fingerprint --configs default,headed                   # compare configurations
//   pnpm bench:fingerprint --out fp.json && ...update... && pnpm bench:fingerprint --baseline fp.json
//   TURNO_BENCH_PUBLIC_DETECTORS=1 pnpm bench:fingerprint             # also the public detector pages
//
// Options:
//   --configs <a,b>       configurations to run (default: default); see --list
//   --config-file <file>  more configurations, a JSON list (see bench/browser/lib/configs.mjs)
//   --headed              visible Chrome windows (default headless; a configuration can override)
//   --no-reference        skip the plain Chrome reference
//   --chrome <path>       the Chrome executable for the reference (default: the usual install path)
//   --baseline <file>     an earlier --out report: list checks that got worse and fields that changed
//   --json                print the JSON report instead of tables
//   --out <file>          also write the JSON report to a file
//   --list                list the configurations and checks
//
// For each configuration it starts the built turno-browser-mcp on a throwaway identity in a
// throwaway HOME, opens a local probe page and runs fixed steps through the stock tools (click,
// hover, type, type slowly, click a button below the fold). The page records navigator fields,
// automation markers, DevTools protocol side effects and every input event, and posts them to
// the bench's own server. The reference is the installed Chrome started directly on the same
// page with a throwaway profile and no automation. Public detector pages (rebrowser
// bot-detector, CreepJS, Sannysoft, the TLS fingerprint at browserleaks) run only with
// TURNO_BENCH_PUBLIC_DETECTORS=1, always on the throwaway identity, never with an account.
//
// Exit code 1 when a check fails (including a check a configuration's `expect` promised), or
// with --baseline when a check got worse; 2 for a usage error.

import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { parseArgs } from "node:util";
import { checkReport, compareWithBaseline, pointerPath } from "./lib/checks.mjs";
import { dumpDom, findChrome, startPlainChrome } from "./lib/chrome.mjs";
import { isHeaded, knownConfigs, readConfigsFile, resolveConfig } from "./lib/configs.mjs";
import { probeSteps, startProbeSite } from "./lib/probe.mjs";
import {
  PUBLIC_ENV,
  compareDetector,
  detectors,
  loadParsers,
  publicDetectorsAllowed,
  visitDetectors,
} from "./lib/public.mjs";
import { DEFAULT_BIN, UnsupportedConfig, buildVersions, startServer, warmUp } from "./lib/server.mjs";

const { values } = parseArgs({
  options: {
    configs: { type: "string", default: "default" },
    "config-file": { type: "string" },
    headed: { type: "boolean", default: false },
    "no-reference": { type: "boolean", default: false },
    chrome: { type: "string" },
    baseline: { type: "string" },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const log = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  log(`fingerprint: ${msg}`);
  process.exit(2);
};

let known;
let configs;
let baseline;
try {
  known = knownConfigs(values["config-file"] ? readConfigsFile(values["config-file"]) : []);
  configs = values.configs
    .split(",")
    .filter(Boolean)
    .map((n) => resolveConfig(n, known));
  if (values.baseline) baseline = JSON.parse(readFileSync(values.baseline, "utf8"));
} catch (err) {
  fail(err.message);
}
if (baseline && baseline.kind !== "turno-browser-fingerprint") fail(`${values.baseline} is not a fingerprint report`);

if (values.list) {
  console.log("Configurations:");
  for (const c of known.values())
    console.log(`  ${c.name.padEnd(22)} ${c.description}${c.needs ? ` (needs ${c.needs})` : ""}`);
  console.log(
    "\nChecks: webdriver, headless-token, client-hints-match, automation-globals, extra-globals,\n" +
      "notification-permission, webgl, window-size, plugins, chrome-object, csp-enforced, main-world-calls,\n" +
      "legacy-runtime-leak, headers-match-navigator, worker-matches-page, intl-matches-languages,\n" +
      "matches-plain-chrome, events-trusted, pointer-moves-before-click, click-at-center,\n" +
      "press-duration, hover-dwell, screen-offset, coalesced-events, typing-key-events, typing-interval,\n" +
      "key-hold, focus-before-keys, scroll-steps, and public-<detector> with the public pages.",
  );
  process.exit(0);
}

const allowPublic = publicDetectorsAllowed();
const startedAt = new Date();
const site = await startProbeSite();
const chrome = findChrome(values.chrome);
const parsers = allowPublic ? await loadParsers(DEFAULT_BIN) : undefined;
const detectorList = parsers ? detectors(parsers) : [];
const references = {};
const referencePublic = {};
const results = [];

try {
  if (!values["no-reference"]) {
    const modes = [...new Set(configs.map((c) => isHeaded(c, values.headed)))];
    for (const headed of modes) {
      const key = headed ? "headed" : "headless";
      if (!chrome) {
        references[key] = { skipped: "Google Chrome was not found (use --chrome <path>)" };
        continue;
      }
      log(`reference: plain Chrome, ${key}`);
      const run = `reference-${key}`;
      const plain = startPlainChrome(chrome, site.probeUrl(run), { headed });
      try {
        const r = await site.waitFor(run);
        references[key] = r?.static ? { static: r.static } : { skipped: "the probe page did not report in 15 s" };
      } finally {
        await plain.stop();
      }
    }
    if (allowPublic && chrome) {
      for (const d of detectorList) {
        log(`reference: plain Chrome on ${d.url}`);
        const dom = await dumpDom(chrome, d.url);
        referencePublic[d.id] = dom.error ? { ok: false, error: dom.error } : d.read(dom.html);
      }
    }
  }

  for (const config of configs) {
    const headed = isHeaded(config, values.headed);
    const base = { name: config.name, headed, versions: buildVersions(config.bin ?? DEFAULT_BIN) };
    log(`${config.name}: ${headed ? "headed" : "headless"}`);
    let server;
    try {
      server = await startServer(config, { headed });
    } catch (err) {
      results.push({
        ...base,
        status: err instanceof UnsupportedConfig ? "unsupported" : "error",
        detail: String(err.message),
      });
      continue;
    }
    try {
      const { browser } = await warmUp(server.client, `${site.url}/blank`);
      const agent = server.agent();
      await probeSteps(agent, site.probeUrl(config.name));
      const report = await site.waitFor(config.name, (r) =>
        r.events.some((e) => e.type === "pointerdown" && e.target === "far-button"),
      );
      // Let the last events (the release and click on the far button) reach the report.
      await new Promise((r) => setTimeout(r, 400));
      const final = site.reports.get(config.name) ?? report;
      const ref = references[headed ? "headed" : "headless"];
      const checks = checkReport(final, { headed, reference: ref?.static, expect: config.expect });
      let pub;
      if (detectorList.length) {
        pub = await visitDetectors(agent, detectorList);
        for (const d of detectorList) {
          const vs = compareDetector(d.id, pub[d.id], referencePublic[d.id]);
          const r = pub[d.id];
          const refSummary = referencePublic[d.id]?.summary;
          const note = [vs?.note, refSummary ? `plain Chrome (headless): ${refSummary}` : undefined].filter(Boolean);
          checks.push({
            id: `public-${d.id}`,
            layer: "public",
            status: r.error ? "warn" : (vs?.status ?? (r.ok ? "pass" : "info")),
            value: r.summary ?? r.error,
            ...(note.length ? { note: note.join("; ") } : {}),
          });
        }
      }
      const { globals, ...staticFields } = final.static ?? {};
      results.push({
        ...base,
        status: "ran",
        browser,
        static: { ...staticFields, globalsCount: globals?.length },
        checks,
        clickPath: pointerPath(final.events ?? [], "click-target"),
        events: final.events?.length ?? 0,
        ...(pub ? { public: pub } : {}),
        ...(config.expect ? { expect: config.expect } : {}),
      });
    } catch (err) {
      results.push({ ...base, status: "error", detail: String(err?.message ?? err) });
    } finally {
      await server.stop();
    }
  }
} finally {
  await site.close();
}

const report = {
  version: 1,
  kind: "turno-browser-fingerprint",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  },
  node: process.version,
  publicDetectors: allowPublic,
  reference: Object.fromEntries(
    Object.entries(references).map(([k, v]) => {
      if (!v.static) return [k, v];
      const { globals, ...rest } = v.static;
      return [k, { static: { ...rest, globalsCount: globals?.length } }];
    }),
  ),
  ...(allowPublic ? { referencePublic } : {}),
  configs: results,
};
if (baseline) report.baseline = compareWithBaseline(report, baseline);

if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);

const short = (v) => {
  if (v === undefined || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 28 ? `${s.slice(0, 25)}...` : s;
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

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ran = results.filter((r) => r.status === "ran");
  const first = ran[0];
  if (first)
    console.log(
      `\nturno-browser ${first.versions.turnoBrowser ?? "?"} (patchright-core ${first.versions.patchrightCore ?? "?"}), ${first.browser}${allowPublic ? ", public detectors on" : ""}\n`,
    );
  for (const [k, v] of Object.entries(references))
    if (v.skipped) console.log(`reference (${k}): skipped, ${v.skipped}`);
  if (ran.length) {
    const ids = [...new Set(ran.flatMap((r) => r.checks.map((c) => c.id)))];
    const rows = [["CHECK", ...ran.map((r) => `${r.name} (${r.headed ? "headed" : "headless"})`)]];
    for (const id of ids) {
      rows.push([
        id,
        ...ran.map((r) => {
          const c = r.checks.find((x) => x.id === id);
          return c ? `${c.status.toUpperCase()} ${short(c.value)}`.trim() : "";
        }),
      ]);
    }
    console.log(table(rows));
    // One line per check and note, with the configurations that share it.
    const notes = new Map();
    for (const r of ran) {
      for (const c of r.checks.filter((x) => x.status !== "pass" && x.note)) {
        const key = `${c.id}: ${c.note}`;
        notes.set(key, [...(notes.get(key) ?? []), r.name]);
      }
    }
    if (notes.size) {
      console.log("\nNotes:");
      for (const [note, names] of notes) console.log(`  ${note}${ran.length > 1 ? ` (${names.join(", ")})` : ""}`);
    }
    for (const r of ran) {
      const p = r.clickPath;
      if (p)
        console.log(
          `\n${r.name}: ${p.moves} pointer move(s) before the click, path ${p.lengthPx} px over ${p.durationMs} ms${p.straightness ? `, ${p.straightness}x the straight line` : ""}`,
        );
    }
  }
  for (const r of results.filter((x) => x.status !== "ran"))
    console.log(`\n${r.name}: ${r.status === "unsupported" ? "not supported by this server" : "error"} (${r.detail})`);
  if (!allowPublic) console.log(`\nPublic detector pages skipped (set ${PUBLIC_ENV}=1 to visit them).`);
  if (report.baseline) {
    const { regressions, changes } = report.baseline;
    console.log(
      `\nAgainst ${values.baseline}: ${regressions.length} regression(s), ${changes.length} changed field(s)`,
    );
    for (const g of regressions) console.log(`  REGRESSION ${g.config} ${g.check}: ${g.from} -> ${g.to}`);
    for (const c of changes) console.log(`  changed ${c.config} ${c.field}: ${short(c.from)} -> ${short(c.to)}`);
  }
}

const failed =
  results.some((r) => r.status === "error" || r.checks?.some((c) => c.status === "fail")) ||
  (report.baseline?.regressions.length ?? 0) > 0;
process.exit(failed ? 1 : 0);
