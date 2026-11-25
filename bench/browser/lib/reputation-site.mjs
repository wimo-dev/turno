// The local site of the reputation bench: rebrowser-bot-detector, CreepJS and BotD served from
// pinned copies (lib/sources.mjs) on 127.0.0.1, with localhost as the second site some tests
// need. Each page gets a small reporter script of the bench's own that POSTs the detector's
// result to /report/<suite>/<run>, so reading a result never needs the automation (a plain
// Chrome reports the same way as turno's) and never disturbs what the detector measured: the
// reporter only reads the detector's own result object and calls a saved `fetch`.
//
// Two upstream lines are changed when served, both to keep the browser on this machine: the
// script rebrowser loads from w3schools.com to see whether the page's Content Security Policy
// holds comes from the second site here (the policy forbids it the same way), and the latest
// Chrome release rebrowser reads from chromiumdash.appspot.com is fetched once by the bench
// and served locally (or not at all, and that one test reports it cannot tell).

import { createServer } from "node:http";

const W3SCHOOLS = "https://www.w3schools.com/js/myScript.js";
const CHROMIUMDASH = "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1&offset=0";

// Each reporter keeps its own references before the detector runs, so a detector that wraps a
// DOM method does not see the reporter call it.
const REPORTER_HEAD = String.raw`
const run = new URLSearchParams(location.search).get('run') || 'unnamed';
const post = window.fetch.bind(window);
const stringify = JSON.stringify;
let last = '';
const send = (suite, value) => {
  const body = stringify(value);
  if (body === last) return;
  last = body;
  post('/report/' + suite + '/' + encodeURIComponent(run), { method: 'POST', body }).catch(() => {});
};
const plain = (html) => String(html == null ? '' : html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
`;

const REBROWSER_REPORTER = String.raw`<script>(() => {${REPORTER_HEAD}
setInterval(() => {
  const list = window.detections;
  if (!Array.isArray(list)) return;
  send('rebrowser', list.map((d) => ({ type: d.type, rating: d.rating, note: plain(d.note) })));
}, 250);
})();</script>`;

// CreepJS sets window.Fingerprint when it has finished. The headless section holds groups of
// boolean signals and one percentage per group; they are read generically, by shape, so a
// renamed or added group still shows up.
const CREEPJS_REPORTER = String.raw`<script>(() => {${REPORTER_HEAD}
const started = performance.now();
const timer = setInterval(() => {
  const fp = window.Fingerprint;
  if (!fp) {
    if (performance.now() - started > 45000) { clearInterval(timer); send('creepjs', { error: 'CreepJS did not finish in 45 s' }); }
    return;
  }
  clearInterval(timer);
  const h = fp.headless || {};
  const ratings = {};
  const signals = {};
  for (const key of Object.keys(h)) {
    const v = h[key];
    if (typeof v === 'number' && /Rating$/.test(key)) ratings[key] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const flags = Object.keys(v).filter((k) => typeof v[k] === 'boolean');
      if (flags.length) signals[key] = flags.filter((k) => v[k]);
    }
  }
  const lies = (fp.lies && fp.lies.data) || {};
  const lieList = {};
  for (const key of Object.keys(lies)) lieList[key] = (Array.isArray(lies[key]) ? lies[key] : []).slice(0, 12).map(String);
  send('creepjs', {
    chromium: h.chromium === true,
    ratings,
    signals,
    totalLies: fp.lies ? fp.lies.totalLies : null,
    lies: lieList,
    errors: fp.capturedErrors && Array.isArray(fp.capturedErrors.data) ? fp.capturedErrors.data.length : null,
  });
}, 250);
})();</script>`;

const BOTD_PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BotD</title></head>
<body><h1>BotD</h1><p id="out">Running</p>
<script type="module">
import { load } from './botd.esm.js';
${REPORTER_HEAD}
try {
  // monitoring: false keeps BotD from reporting its own use to its vendor.
  const botd = await load({ monitoring: false });
  const result = botd.detect();
  const detections = botd.getDetections() || {};
  const fired = Object.keys(detections).filter((k) => detections[k] && detections[k].bot)
    .map((k) => k + (detections[k].botKind ? ' (' + detections[k].botKind + ')' : ''));
  send('botd', { bot: result.bot === true, botKind: result.botKind || null, fired, detectors: Object.keys(detections).length });
  document.getElementById('out').textContent = result.bot ? 'bot' : 'not a bot';
} catch (e) {
  send('botd', { error: String(e && e.message || e) });
}
</script></body></html>`;

const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css" };
const typeOf = (path) => TYPES[path.split(".").pop()] ?? "application/octet-stream";

const inject = (html, script) => {
  const s = html.toString("utf8");
  return s.includes("</body>") ? s.replace("</body>", `${script}\n</body>`) : `${s}${script}`;
};

/**
 * The latest stable Chrome release as chromiumdash answers it, fetched by the bench (not the
 * browser) so rebrowser's version test can run with the browser on this machine. Undefined when
 * offline; the test then says it could not tell.
 */
export async function latestStableRelease() {
  try {
    const res = await fetch(CHROMIUMDASH, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts the site. `sources` is what loadSources returned; `release` the chromiumdash answer or
 * undefined. `reports` maps "<suite>/<run>" to the last report and when it last changed.
 */
export async function startReputationSite(sources, { release } = {}) {
  const reports = new Map();
  let port = 0;
  const rebrowserJs = () =>
    sources.rebrowser
      .get("index.js")
      .toString("utf8")
      .replace(W3SCHOOLS, `http://localhost:${port}/csp-probe.js`)
      .replace(CHROMIUMDASH, "/chromiumdash");
  const routes = new Map([
    ["/", () => inject(sources.rebrowser.get("index.html"), REBROWSER_REPORTER)],
    ["/index.js", rebrowserJs],
    ["/index.css", () => sources.rebrowser.get("index.css")],
    ["/aba/mid/", () => sources.rebrowser.get("aba/mid/index.html")],
    ["/aba/leaf/", () => sources.rebrowser.get("aba/leaf/index.html")],
    ["/creepjs/", () => inject(sources.creepjs.get("index.html"), CREEPJS_REPORTER)],
    ["/creepjs/creep.js", () => sources.creepjs.get("creep.js")],
    ["/creepjs/style.min.css", () => sources.creepjs.get("style.min.css")],
    ["/botd/", () => BOTD_PAGE],
    ["/botd/botd.esm.js", () => sources.botd.get("botd.esm.js")],
    ["/blank", () => "<!doctype html><title>Ready</title><p>Ready</p>"],
  ]);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname.startsWith("/report/")) {
      let body = "";
      req.on("data", (d) => {
        if (body.length < 4 * 1024 * 1024) body += d;
      });
      req.on("end", () => {
        const key = url.pathname.slice("/report/".length).split("/").map(decodeURIComponent).join("/");
        try {
          reports.set(key, { value: JSON.parse(body), at: Date.now() });
        } catch {
          /* a truncated report; the next one replaces it */
        }
        res.end("ok");
      });
      return;
    }
    if (url.pathname === "/chromiumdash") {
      res.setHeader("content-type", "application/json");
      if (release) res.end(release);
      else {
        res.statusCode = 503;
        res.end("[]");
      }
      return;
    }
    if (url.pathname === "/csp-probe.js") {
      res.setHeader("content-type", TYPES.js);
      res.end("void 0;\n");
      return;
    }
    if (url.pathname === "/favicon.ico" || url.pathname === "/creepjs/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const route = routes.get(url.pathname);
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", url.pathname.endsWith("/") ? TYPES.html : typeOf(url.pathname));
    res.end(route());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const paths = { rebrowser: "/", creepjs: "/creepjs/", botd: "/botd/" };
  return {
    url: base,
    pageUrl: (suite, run) => `${base}${paths[suite]}?run=${encodeURIComponent(run)}`,
    /**
     * Waits for a suite's report: once one arrived, until it has not changed for `quietMs`
     * (detectors add results as their async tests finish), at most `maxMs` in all.
     */
    async waitFor(suite, run, { quietMs = 2500, maxMs = 30_000 } = {}) {
      const key = `${suite}/${run}`;
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        const r = reports.get(key);
        if (r && Date.now() - r.at >= quietMs) return r.value;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      return reports.get(key)?.value;
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
