// Public detector pages for the fingerprint bench. They run only when
// TURNO_BENCH_PUBLIC_DETECTORS=1: they are third-party sites that see the visit (the IP address,
// the browser), so the bench never opens them on its own. Every visit uses the run's throwaway
// identity, never a real profile or account. Passing these pages says little about a real
// site's bot scoring; their value is the trend between runs and configurations.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_ENV = "TURNO_BENCH_PUBLIC_DETECTORS";

/** Whether the public detector pages are allowed in this run. */
export function publicDetectorsAllowed(env = process.env) {
  return env[PUBLIC_ENV] === "1";
}

const pct = (re, text) => {
  const m = re.exec(text);
  return m ? Number(m[1]) : undefined;
};

/**
 * The detector pages, each with how long to let its scripts run and how to read its result
 * from the page HTML. `parsers` are turno-browser's own (dist/detectors.js), so this bench and
 * `turno browser bench` read the pages the same way.
 */
export function detectors(parsers) {
  return [
    {
      id: "rebrowser",
      url: "https://bot-detector.rebrowser.net/",
      settleMs: 6000,
      read(html) {
        const r = parsers.parseRebrowser(html);
        if (!r.tests.length) return { ok: false, summary: "no results table found" };
        const failed = r.tests.filter((t) => t.status === "fail").map((t) => t.name);
        return {
          ok: r.failed === 0,
          summary: `${r.passed} pass, ${r.failed} fail${failed.length ? ` (${failed.join(", ")})` : ""}, ${r.warned} warn`,
          score: { passed: r.passed, failed: r.failed, warned: r.warned },
          failed,
        };
      },
    },
    {
      id: "sannysoft",
      url: "https://bot.sannysoft.com/",
      settleMs: 5000,
      read(html) {
        const r = parsers.parseSannysoft(html);
        if (!r.rows.length) return { ok: false, summary: "no result rows found" };
        return {
          ok: r.failed === 0,
          summary: `${r.failed} failed of ${r.rows.length}${r.failed ? ` (${r.failedNames.join(", ")})` : ""}`,
          score: { rows: r.rows.length, failed: r.failed },
          failed: r.failedNames,
        };
      },
    },
    {
      id: "creepjs",
      url: "https://abrahamjuliot.github.io/creepjs/",
      settleMs: 12_000,
      read(html) {
        // CreepJS changes its layout often; read the few numbers it prints in plain text and
        // keep going when they are not there.
        const text = parsers.textOf(html);
        const score = {
          headlessPercent: pct(/(\d+(?:\.\d+)?)% headless/i, text),
          likeHeadlessPercent: pct(/(\d+(?:\.\d+)?)% like headless/i, text),
          lies: pct(/lies\s*\(?(\d+)\)?/i, text),
        };
        const found = Object.values(score).some((v) => v !== undefined);
        return {
          ok: found && (score.headlessPercent ?? 0) === 0 && (score.lies ?? 0) === 0,
          summary: found
            ? Object.entries(score)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")
            : "no scores found (the page layout may have changed)",
          score,
        };
      },
    },
    {
      id: "tls",
      url: "https://tls.browserleaks.com/json",
      settleMs: 1500,
      read(html) {
        let data;
        try {
          data = JSON.parse(parsers.textOf(html));
        } catch {
          return { ok: false, summary: "the page did not return JSON" };
        }
        const score = { ja4: data.ja4, akamai: data.akamai_hash };
        return { ok: Boolean(data.ja4), summary: `ja4 ${data.ja4 ?? "?"}, akamai ${data.akamai_hash ?? "?"}`, score };
      },
    },
  ];
}

/** turno-browser's page parsers from a build (the default build or a configuration's). */
export async function loadParsers(bin) {
  return import(pathToFileURL(join(bin, "..", "..", "detectors.js")).href);
}

/**
 * Compares a configuration's detector result with plain Chrome's. The network fingerprint must
 * match exactly (a different TLS or HTTP/2 fingerprint means a different network stack). On
 * the other pages, a test that fails here but passes in plain Chrome is a warning; the plain
 * Chrome reference runs headless (`--dump-dom`), so its headless-only failures are ignored.
 * Returns undefined when there is nothing to compare.
 */
export function compareDetector(id, result, reference) {
  if (!reference || reference.error || !result || result.error) return undefined;
  if (id === "tls") {
    const same = result.score?.ja4 === reference.score?.ja4 && result.score?.akamai === reference.score?.akamai;
    return same
      ? { status: "pass" }
      : { status: "fail", note: "the TLS or HTTP/2 fingerprint differs from plain Chrome" };
  }
  if (!Array.isArray(result.failed) || !Array.isArray(reference.failed)) return undefined;
  const extra = result.failed.filter((name) => !reference.failed.includes(name));
  return extra.length
    ? { status: "warn", note: `fails where plain Chrome passes: ${extra.join(", ")}` }
    : { status: "pass" };
}

/** The value a browser_evaluate result carries (upstream prints it as JSON under "### Result"). */
function evaluateValue(text) {
  const body = /### Result\n([\s\S]*?)(?:\n### |$)/.exec(text)?.[1]?.trim() ?? "";
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Visits each public detector page through the server and reads its result from the page HTML. */
export async function visitDetectors(agent, list) {
  const out = {};
  for (const d of list) {
    try {
      await agent.must("browser_navigate", { url: d.url });
      await agent.must("browser_wait_for", { time: Math.ceil(d.settleMs / 1000) });
      const html = evaluateValue(
        await agent.must("browser_evaluate", { function: "() => document.documentElement.outerHTML" }),
      );
      out[d.id] = d.read(typeof html === "string" ? html : "");
    } catch (err) {
      out[d.id] = { ok: false, error: String(err?.message ?? err).split("\n")[0] };
    }
  }
  return out;
}
