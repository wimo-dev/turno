// The probe page of the fingerprint bench: what any page can observe about the browser that
// opens it and about the input it receives. It records navigator fields, automation markers,
// side effects of the DevTools protocol, and every input event with its timing, isTrusted,
// coordinates and coalesced events, and POSTs all of it to /report/<run> on its own server.
// The server adds what the page cannot see itself: the headers of the page's own request, and
// what a dedicated worker the page starts reads (a worker has its own navigator). The
// page never needs the automation to read it back, so reading the report cannot disturb what
// it measured.

import { createServer } from "node:http";
import { refOf } from "./tasks.mjs";

const NONCE = "turno-probe";

// Runs in the page. Plain ES2020, no dependencies.
const PROBE_SCRIPT = String.raw`
(() => {
  const run = new URLSearchParams(location.search).get('run') || 'unnamed';
  const report = { run, static: null, events: [], traps: [], foreignNodes: [], legacyRuntimeLeak: false, boxes: {} };
  const post = window.fetch.bind(window);
  const stringify = JSON.stringify;
  const rectOf = Element.prototype.getBoundingClientRect;

  // Calls into the page's DOM API that no page script made: code an automation tool runs in
  // the page's own world (the probe itself keeps its own references and never calls these).
  const trap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function (...args) {
      if (report.traps.length < 50) report.traps.push({ api: label, stack: String(new Error().stack || '').split('\n').slice(2, 6).join(' | ').slice(0, 400) });
      schedule();
      return original.apply(this, args);
    };
  };
  trap(Document.prototype, 'querySelector', 'document.querySelector');
  trap(Document.prototype, 'querySelectorAll', 'document.querySelectorAll');
  trap(Document.prototype, 'getElementById', 'document.getElementById');
  trap(Element.prototype, 'querySelector', 'Element.querySelector');
  trap(Element.prototype, 'querySelectorAll', 'Element.querySelectorAll');
  trap(Element.prototype, 'getBoundingClientRect', 'Element.getBoundingClientRect');

  // Elements no page script made, added next to <head> and <body>: where an automation tool's
  // overlay (a cursor, a banner) goes when it keeps out of the page's own content. Any page can
  // watch for them with a MutationObserver, as this one does.
  new MutationObserver((records) => {
    for (const r of records)
      for (const node of r.addedNodes)
        if (node.nodeType === 1 && node !== document.head && node !== document.body && report.foreignNodes.length < 20) {
          report.foreignNodes.push({ tag: node.tagName.toLowerCase(), t: Math.round(performance.now()) });
          schedule();
        }
  }).observe(document.documentElement, { childList: true });

  // The classic Runtime.enable side effect: a client that serializes console arguments reads
  // the error's stack. V8 changed this in 2025, so a clean result here proves little.
  const bait = new Error('probe');
  Object.defineProperty(bait, 'stack', { configurable: true, get() { report.legacyRuntimeLeak = true; return ''; } });
  console.debug(bait);

  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, 150);
  }
  function flush() {
    post('/report/' + encodeURIComponent(run), { method: 'POST', body: stringify(report) }).catch(() => {});
  }

  const t = (e) => Math.round(e.timeStamp * 10) / 10;
  const box = (el) => { const r = rectOf.call(el); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  // pointerrawupdate fires for raw pointer input (secure contexts only, like this page on
  // 127.0.0.1); focus, blur and visibilitychange say whether the page had the window's focus.
  const types = ['pointermove', 'pointerrawupdate', 'pointerdown', 'pointerup', 'pointerover', 'mousemove', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'input', 'focusin', 'wheel', 'focus', 'blur', 'visibilitychange'];
  for (const type of types) {
    (type === 'visibilitychange' ? document : window).addEventListener(type, (e) => {
      if (report.events.length >= 5000) return;
      if ((type === 'focus' || type === 'blur') && e.target !== window) return;
      const target = e.target && e.target.id ? e.target.id : (e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '');
      const ev = { type, t: t(e), trusted: e.isTrusted, target };
      if (type === 'click' || type === 'pointerdown' || type === 'keydown' || type === 'visibilitychange') Object.assign(ev, { focused: document.hasFocus(), visibility: document.visibilityState });
      if ('clientX' in e) Object.assign(ev, { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY });
      if (type.startsWith('pointer')) {
        ev.pointerType = e.pointerType;
        if (typeof e.getCoalescedEvents === 'function') ev.coalesced = e.getCoalescedEvents().length;
      }
      if (type === 'pointerdown' && e.target && e.target.id) report.boxes[e.target.id] = box(e.target);
      // While the automation acts on the page: methods it might wrap only around its actions.
      if ((type === 'pointerdown' || type === 'keydown') && !report.inputNatives) report.inputNatives = natives();
      if (type === 'keydown' || type === 'keyup') ev.key = e.key.length === 1 ? 'char' : e.key;
      if (type === 'input') { ev.inputType = e.inputType; ev.length = e.data ? e.data.length : 0; }
      if (type === 'wheel') { ev.dy = e.deltaY; ev.mode = e.deltaMode; }
      ev.scrollY = Math.round(window.scrollY);
      report.events.push(ev);
      schedule();
    }, { capture: true, passive: true });
  }
  window.addEventListener('scroll', () => {
    if (report.events.length < 5000) report.events.push({ type: 'scroll', t: Math.round(performance.now() * 10) / 10, scrollY: Math.round(window.scrollY), trusted: true });
    schedule();
  }, { passive: true });

  const nativeFn = (fn) => typeof fn === 'function' && /\[native code\]/.test(Function.prototype.toString.call(fn));
  // How the page's methods print: a native method names itself, a Proxy or a wrapper does not.
  const fnToString = Function.prototype.toString;
  function natives() {
    const cc = window.CredentialsContainer && CredentialsContainer.prototype;
    const show = (fn) => { try { return typeof fn === 'function' ? fnToString.call(fn) : null; } catch (e) { return 'throws'; } };
    return cc ? { 'CredentialsContainer.get': show(cc.get), 'CredentialsContainer.create': show(cc.create) } : {};
  }
  const media = (q) => window.matchMedia(q).matches;
  const AUTOMATION = /^(cdc_|\$cdc_|__playwright|__pw|__puppeteer|_selenium|__selenium|__webdriver|__driver|__fxdriver|callPhantom|_phantom|domAutomation|__nightmare|__lastWatirAlert)/;

  async function collect() {
    const nav = navigator;
    let high = null;
    if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
      try { high = await nav.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64']); } catch (e) { high = { error: String(e) }; }
    }
    let webgl = null;
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      webgl = gl ? { vendor: gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) } : null;
    } catch (e) { webgl = { error: String(e) }; }
    let notificationQuery = null;
    try { notificationQuery = (await nav.permissions.query({ name: 'notifications' })).state; } catch (e) { notificationQuery = null; }
    let csp = 'blocked';
    try { (0, eval)('1'); csp = 'allowed'; } catch (e) { csp = 'blocked'; }
    const getter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    const globals = Object.getOwnPropertyNames(window).sort();
    const intl = Intl.DateTimeFormat().resolvedOptions();
    report.static = {
      userAgent: nav.userAgent,
      platform: nav.platform,
      vendor: nav.vendor,
      languages: Array.from(nav.languages || []),
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory === undefined ? null : nav.deviceMemory,
      maxTouchPoints: nav.maxTouchPoints,
      webdriver: nav.webdriver,
      webdriverOwnProperty: Object.prototype.hasOwnProperty.call(nav, 'webdriver'),
      webdriverGetterNative: getter ? nativeFn(getter.get) : null,
      pdfViewerEnabled: nav.pdfViewerEnabled,
      plugins: nav.plugins.length,
      mimeTypes: nav.mimeTypes.length,
      uaData: nav.userAgentData ? { brands: nav.userAgentData.brands.map((b) => b.brand + ' ' + b.version), mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform, high } : null,
      timezone: intl.timeZone,
      locale: intl.locale,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio },
      media: {
        colorScheme: media('(prefers-color-scheme: dark)') ? 'dark' : media('(prefers-color-scheme: light)') ? 'light' : null,
        reducedMotion: media('(prefers-reduced-motion: reduce)'),
        forcedColors: media('(forced-colors: active)'),
        contrastMore: media('(prefers-contrast: more)'),
      },
      natives: natives(),
      window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight },
      chrome: typeof window.chrome === 'object' && window.chrome ? Object.keys(window.chrome).sort() : null,
      notification: typeof Notification === 'function' ? Notification.permission : null,
      notificationQuery,
      webgl,
      csp,
      documentAttributes: Array.from(document.documentElement.attributes).map((a) => a.name),
      automationGlobals: globals.filter((g) => AUTOMATION.test(g)).concat(Object.getOwnPropertyNames(document).filter((g) => AUTOMATION.test(g))),
      globals,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      pointerRawUpdate: 'onpointerrawupdate' in window,
    };
    flush();
  }
  // A person doing the steps by hand (the bench's --human reference) sees them listed.
  if (new URLSearchParams(location.search).get('human')) document.addEventListener('DOMContentLoaded', () => document.body.classList.add('human'));
  collect();
  try { new Worker('/probe-worker.js?run=' + encodeURIComponent(run)); } catch (e) { /* no workers */ }
})();
`;

// Runs in a dedicated worker the probe page starts: the navigator and Intl a worker sees, which
// an override applied to pages only leaves as it was.
const WORKER_SCRIPT = `
const run = new URLSearchParams(location.search).get('run') || 'unnamed';
fetch('/worker-report/' + encodeURIComponent(run), { method: 'POST', body: JSON.stringify({
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  languages: Array.from(navigator.languages || []),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
}) }).catch(() => {});
`;

/** The request headers of the probe page the checks compare with what the page reads. */
const HEADERS = ["user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"];

const PROBE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Probe</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 0; padding: 24px; min-height: 2600px }
  #click-target { position: absolute; left: 340px; top: 420px; width: 180px; height: 56px }
  #hover-target { position: absolute; left: 60px; top: 160px; width: 160px; height: 48px }
  #fields { position: absolute; left: 60px; top: 260px }
  #far-button { position: absolute; left: 120px; top: 2300px; width: 160px; height: 48px }
  #steps { display: none; position: absolute; left: 600px; top: 120px; width: 300px; border: 1px solid #888; padding: 8px 16px }
  .human #steps { display: block }
</style>
<script nonce="${NONCE}">${PROBE_SCRIPT}</script>
</head><body>
<h1>Probe</h1>
<button id="hover-target">Hover target</button>
<div id="fields">
  <label>Type here <input id="type-fast" autocomplete="off"></label>
  <label>Type slowly <input id="type-slow" autocomplete="off"></label>
</div>
<button id="click-target">Click target</button>
<button id="far-button">Far button</button>
<ol id="steps"><li>Click "Click target"</li><li>Move onto "Hover target"</li><li>Type hello world in "Type here"</li>
<li>Type hello world in "Type slowly"</li><li>Scroll down and click "Far button"</li></ol>
</body></html>`;

/**
 * Starts the probe site on 127.0.0.1. The page is served with a Content Security Policy that
 * forbids eval, so a browser launched with CSP checks turned off shows up. `reports` maps a run
 * name to the last report its page sent.
 */
export async function startProbeSite() {
  const reports = new Map();
  const requests = new Map();
  const workers = new Map();
  // The page's report, with the request headers and the worker's report of the same run.
  const store = (run, report) => {
    if (!report) return;
    if (requests.has(run)) report.request = requests.get(run);
    if (workers.has(run)) report.worker = workers.get(run);
    reports.set(run, report);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname.startsWith("/worker-report/")) {
      let body = "";
      req.on("data", (d) => {
        if (body.length < 64 * 1024) body += d;
      });
      req.on("end", () => {
        const run = decodeURIComponent(url.pathname.slice("/worker-report/".length));
        try {
          workers.set(run, JSON.parse(body));
          store(run, reports.get(run));
        } catch {
          /* a truncated report */
        }
        res.end("ok");
      });
      return;
    }
    if (url.pathname === "/probe-worker.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.end(WORKER_SCRIPT);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/report/")) {
      let body = "";
      req.on("data", (d) => {
        if (body.length < 8 * 1024 * 1024) body += d;
      });
      req.on("end", () => {
        try {
          store(decodeURIComponent(url.pathname.slice("/report/".length)), JSON.parse(body));
        } catch {
          /* a truncated report; the next flush replaces it */
        }
        res.end("ok");
      });
      return;
    }
    if (url.pathname === "/probe") {
      const run = url.searchParams.get("run") ?? "unnamed";
      requests.set(
        run,
        Object.fromEntries(HEADERS.filter((h) => req.headers[h] !== undefined).map((h) => [h, req.headers[h]])),
      );
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", `script-src 'nonce-${NONCE}'; worker-src 'self'`);
      res.end(PROBE_HTML);
      return;
    }
    if (url.pathname === "/blank") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Ready</title><p>Ready</p>");
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    probeUrl: (run) => `${url}/probe?run=${encodeURIComponent(run)}`,
    reports,
    /** Waits until a run's report has its static part and `until(report)` holds. */
    async waitFor(run, until = () => true, ms = 15_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = reports.get(run);
        if (r?.static && until(r)) return r;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      return reports.get(run);
    },
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const TEXT = "hello world";

/** The fixed steps on the probe page. The first click comes before any other pointer action. */
export async function probeSteps(agent, url) {
  await agent.must("browser_navigate", { url });
  const snap = await agent.must("browser_snapshot");
  await agent.must("browser_click", { target: refOf(snap, "button", "Click target") });
  await agent.must("browser_hover", { target: refOf(snap, "button", "Hover target") });
  await agent.must("browser_type", { target: refOf(snap, "textbox", "Type here"), text: TEXT });
  await agent.must("browser_type", { target: refOf(snap, "textbox", "Type slowly"), text: TEXT, slowly: true });
  await agent.must("browser_click", { target: refOf(snap, "button", "Far button") });
}
