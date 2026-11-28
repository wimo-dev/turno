// Turns a probe report into checks a person can read. Pure functions over the report, so the
// unit tests feed them synthetic reports.
//
// Status, from best to worst: pass, info (a fact worth knowing, not a problem), warn (something a
// detector can see), fail (a contradiction or a plain automation marker). The event checks
// describe how input arrives today; a configuration that changes input (human-like levels)
// states in `expect` which checks it must turn into a pass.

const RANK = { pass: 0, info: 1, warn: 2, fail: 3 };

/** Fields compared with the same Chrome started without automation, and between runs. */
const COMPARED_FIELDS = [
  "userAgent",
  "platform",
  "vendor",
  "languages",
  "hardwareConcurrency",
  "deviceMemory",
  "maxTouchPoints",
  "webdriver",
  "pdfViewerEnabled",
  "plugins",
  "mimeTypes",
  "uaData.brands",
  "uaData.platform",
  "uaData.high.fullVersionList",
  "uaData.high.platformVersion",
  "uaData.high.architecture",
  "timezone",
  "locale",
  "chrome",
  "notification",
  "notificationQuery",
  "webgl",
  "csp",
  "documentAttributes",
  "media",
  "natives",
];

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Fields of `COMPARED_FIELDS` that differ between two static fingerprints. */
export function diffStatic(current, other) {
  const out = [];
  for (const field of COMPARED_FIELDS) {
    const a = get(other, field);
    const b = get(current, field);
    if (!same(a, b)) out.push({ field, reference: a ?? null, value: b ?? null });
  }
  return out;
}

const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const round1 = (n) => (n === undefined ? undefined : Math.round(n * 10) / 10);

function check(id, layer, status, value, note) {
  return { id, layer, status, ...(value !== undefined ? { value } : {}), ...(note ? { note } : {}) };
}

function platformOfUa(ua) {
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chrome OS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return undefined;
}

/** Checks on what the page reads from navigator, window and the DOM. */
function staticChecks(s, { headed, reference }) {
  const out = [];
  const ua = s.userAgent ?? "";
  const isChrome = /Chrome\//.test(ua);

  if (s.webdriver === true) out.push(check("webdriver", "automation", "fail", true, "navigator.webdriver is true"));
  else if (s.webdriverOwnProperty || s.webdriverGetterNative === false)
    out.push(check("webdriver", "automation", "warn", false, "navigator.webdriver is patched in JavaScript"));
  else out.push(check("webdriver", "automation", "pass", false));

  if (/HeadlessChrome/.test(ua))
    out.push(
      check("headless-token", "navigator", headed ? "fail" : "warn", "HeadlessChrome", "the user agent says headless"),
    );
  else out.push(check("headless-token", "navigator", "pass"));

  if (!isChrome) out.push(check("client-hints-match", "navigator", "info", undefined, "not Chrome"));
  else if (!s.uaData)
    out.push(check("client-hints-match", "navigator", "warn", undefined, "no navigator.userAgentData"));
  else {
    const major = /Chrome\/(\d+)/.exec(ua)?.[1];
    const brandOk = s.uaData.brands.some((b) => b === `Google Chrome ${major}` || b === `Chromium ${major}`);
    const platformOk = s.uaData.platform === platformOfUa(ua);
    out.push(
      brandOk && platformOk
        ? check("client-hints-match", "navigator", "pass")
        : check(
            "client-hints-match",
            "navigator",
            "fail",
            { brands: s.uaData.brands, platform: s.uaData.platform },
            `client hints contradict the user agent (${brandOk ? "" : "version"}${!brandOk && !platformOk ? ", " : ""}${platformOk ? "" : "platform"})`,
          ),
    );
  }

  out.push(
    s.automationGlobals?.length
      ? check("automation-globals", "automation", "fail", s.automationGlobals.slice(0, 10))
      : check("automation-globals", "automation", "pass"),
  );

  if (!reference) out.push(check("extra-globals", "automation", "info", undefined, "no plain Chrome to compare with"));
  else {
    const known = new Set(reference.globals ?? []);
    const extra = (s.globals ?? []).filter((g) => !known.has(g));
    out.push(
      extra.length
        ? check("extra-globals", "automation", "warn", extra.slice(0, 10), `${extra.length} name(s) plain Chrome lacks`)
        : check("extra-globals", "automation", "pass"),
    );
  }

  out.push(
    s.notification === "denied" && s.notificationQuery === "prompt"
      ? check("notification-permission", "navigator", "fail", "denied/prompt", "the two permission APIs disagree")
      : check("notification-permission", "navigator", "pass", `${s.notification}/${s.notificationQuery}`),
  );

  const renderer = s.webgl?.renderer;
  if (!renderer) out.push(check("webgl", "navigator", "warn", null, "no WebGL"));
  else if (/SwiftShader|llvmpipe|Software/i.test(renderer))
    out.push(check("webgl", "navigator", "warn", renderer, "a software renderer, typical of servers and headless"));
  else out.push(check("webgl", "navigator", "pass", renderer));

  const w = s.window ?? {};
  if (!w.outerWidth || !w.outerHeight) out.push(check("window-size", "navigator", "fail", w, "the window has no size"));
  else if (w.outerWidth < w.innerWidth || w.outerHeight < w.innerHeight)
    out.push(check("window-size", "navigator", "warn", w, "the page is larger than its window"));
  else if (w.outerHeight === w.innerHeight)
    out.push(
      check("window-size", "navigator", headed ? "warn" : "info", w, "no browser toolbar around the page (headless)"),
    );
  else out.push(check("window-size", "navigator", "pass", w));

  const scr = s.screen ?? {};
  if (!w.outerWidth || !scr.width)
    out.push(check("window-in-screen", "consistency", "info", undefined, "no window or screen size"));
  else if (w.outerWidth > scr.availWidth || w.outerHeight > scr.availHeight)
    out.push(
      check(
        "window-in-screen",
        "consistency",
        "warn",
        { window: w, screen: scr },
        "the window is larger than the screen's work area",
      ),
    );
  else if (w.innerWidth === scr.width && w.innerHeight === scr.height)
    out.push(
      check(
        "window-in-screen",
        "consistency",
        "warn",
        { window: w, screen: scr },
        "the page is exactly the size of the screen",
      ),
    );
  else out.push(check("window-in-screen", "consistency", "pass"));

  out.push(
    s.plugins === 0
      ? check("plugins", "navigator", "warn", 0, "no plugins, unlike a desktop Chrome")
      : check("plugins", "navigator", "pass", s.plugins),
  );

  if (isChrome)
    out.push(
      s.chrome
        ? check("chrome-object", "navigator", "pass", s.chrome)
        : check("chrome-object", "navigator", "warn", null, "window.chrome is missing"),
    );

  out.push(
    s.csp === "allowed"
      ? check("csp-enforced", "protocol", "warn", "allowed", "eval ran despite the page's Content Security Policy")
      : check("csp-enforced", "protocol", "pass"),
  );
  return out;
}

const base = (tag) => (typeof tag === "string" ? tag.split("-")[0].toLowerCase() : undefined);

/**
 * Checks that the parts of one identity agree with each other: the headers of the page's
 * request with what the page reads, a dedicated worker with its page, and the language dates
 * are formatted in with the first language. An override applied to one layer only (a typed
 * user agent, an emulated time zone on pages only) shows up here.
 */
export function consistencyChecks(report) {
  const out = [];
  const s = report.static ?? {};
  const h = report.request;
  if (!h) out.push(check("headers-match-navigator", "consistency", "info", undefined, "no request headers recorded"));
  else {
    const wrong = [];
    if (h["user-agent"] !== undefined && h["user-agent"] !== s.userAgent) wrong.push("User-Agent");
    const firstLang =
      typeof h["accept-language"] === "string" ? h["accept-language"].split(",")[0].split(";")[0].trim() : undefined;
    if (firstLang && s.languages?.length && firstLang !== s.languages[0]) wrong.push("Accept-Language");
    if (h["sec-ch-ua-platform"] !== undefined && s.uaData && h["sec-ch-ua-platform"] !== `"${s.uaData.platform}"`)
      wrong.push("Sec-CH-UA-Platform");
    const major = /Chrome\/(\d+)/.exec(s.userAgent ?? "")?.[1];
    if (major && typeof h["sec-ch-ua"] === "string" && !h["sec-ch-ua"].includes(`v="${major}"`))
      wrong.push("Sec-CH-UA");
    out.push(
      wrong.length
        ? check(
            "headers-match-navigator",
            "consistency",
            "warn",
            wrong,
            "the request headers say something else than the page reads",
          )
        : check("headers-match-navigator", "consistency", "pass"),
    );
  }
  const w = report.worker;
  if (!w) out.push(check("worker-matches-page", "consistency", "info", undefined, "no worker report"));
  else {
    const fields = ["userAgent", "platform", "languages", "timezone", "locale"].filter(
      (f) => w[f] !== undefined && !same(w[f], s[f]),
    );
    if (s.uaData && w.uaPlatform !== s.uaData.platform) fields.push("uaData.platform");
    out.push(
      fields.length
        ? check("worker-matches-page", "consistency", "warn", fields, "a worker reads other values than its page")
        : check("worker-matches-page", "consistency", "pass"),
    );
  }
  const lang = base(s.languages?.[0]);
  const intl = base(s.locale);
  out.push(
    !lang || !intl
      ? check("intl-matches-languages", "consistency", "info", undefined, "no languages or Intl locale")
      : lang === intl
        ? check("intl-matches-languages", "consistency", "pass", s.locale)
        : check(
            "intl-matches-languages",
            "consistency",
            "warn",
            { languages: s.languages, locale: s.locale },
            "dates and numbers are formatted in another language than the first of navigator.languages",
          ),
  );
  return out;
}

/** A native method prints its own name; a Proxy or a wrapper over it does not. */
const NATIVE_METHOD = /^function (\w+)\(\) \{ \[native code\] \}$/;

/** Methods that do not print as the native method of their name, at load and during input. */
function wrappedMethods(report) {
  const out = [];
  for (const [when, natives] of [
    ["load", report.static?.natives],
    ["input", report.inputNatives],
  ]) {
    for (const [name, text] of Object.entries(natives ?? {})) {
      const m = NATIVE_METHOD.exec(text ?? "");
      if (text !== null && (!m || m[1] !== name.split(".").pop())) out.push(`${name} (${when})`);
    }
  }
  return out;
}

/** Checks on side effects the page sees while the automation works on it. */
function protocolChecks(report) {
  const out = [];
  const wrapped = wrappedMethods(report);
  out.push(
    wrapped.length
      ? check("native-methods", "protocol", "warn", wrapped, "a method the page reads is not the native one")
      : check("native-methods", "protocol", "pass", report.inputNatives ? "at load and during input" : "at load"),
  );
  out.push(
    report.traps?.length
      ? check(
          "main-world-calls",
          "protocol",
          "warn",
          report.traps.length,
          `DOM calls from outside the page's scripts, first: ${report.traps[0].api} (${report.traps[0].stack})`,
        )
      : check("main-world-calls", "protocol", "pass", 0),
  );
  out.push(
    report.foreignNodes?.length
      ? check(
          "page-nodes",
          "protocol",
          "warn",
          report.foreignNodes.length,
          `elements no page script made, under <html>: ${[...new Set(report.foreignNodes.map((n) => n.tag))].join(", ")}`,
        )
      : check("page-nodes", "protocol", "pass", 0),
  );
  // turno-browser's side panel extension has no web accessible resources: no page can load one
  // of its files, exactly as for an id no extension has.
  const ext = report.static?.extension;
  out.push(
    !ext
      ? check("extension-resources", "protocol", "info", undefined, "not measured")
      : ext.turno.image || ext.turno.fetch || ext.none.image || ext.none.fetch
        ? check("extension-resources", "protocol", "fail", ext, "a page loaded a file of an extension")
        : check("extension-resources", "protocol", "pass", 0, "no file of the side panel extension loads"),
  );
  out.push(
    report.legacyRuntimeLeak
      ? check("legacy-runtime-leak", "protocol", "fail", true, "console arguments were serialized (Runtime.enable)")
      : check("legacy-runtime-leak", "protocol", "pass", false, "V8 changed this signal in 2025; a pass proves little"),
  );
  return out;
}

/** The pointer path before the first press on an element: points, length, straightness. */
export function pointerPath(events, targetId) {
  const down = events.findIndex((e) => e.type === "pointerdown" && e.target === targetId);
  if (down < 0) return undefined;
  const moves = events.slice(0, down).filter((e) => e.type === "pointermove");
  const points = moves.map((e) => ({ x: e.x, y: e.y, t: e.t }));
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  const first = points[0];
  const last = points[points.length - 1];
  const direct = first && last ? Math.hypot(last.x - first.x, last.y - first.y) : 0;
  return {
    moves: points.length,
    points: points.slice(-200),
    lengthPx: Math.round(length),
    straightness: direct > 0 ? Math.round((length / direct) * 100) / 100 : undefined,
    durationMs: first && last ? round1(last.t - first.t) : 0,
  };
}

/** Checks on the input events the probe recorded for the bench's fixed steps. */
function eventChecks(events, boxes, { headed }) {
  const out = [];
  const input = events.filter((e) => e.type !== "scroll");
  const untrusted = input.filter((e) => !e.trusted);
  out.push(
    !input.length
      ? check("events-trusted", "events", "fail", 0, "no input events reached the page")
      : untrusted.length
        ? check("events-trusted", "events", "fail", untrusted.length, `${untrusted.length} event(s) not isTrusted`)
        : check("events-trusted", "events", "pass", input.length),
  );

  const downIdx = events.findIndex((e) => e.type === "pointerdown" && e.target === "click-target");
  if (downIdx < 0) {
    out.push(check("pointer-moves-before-click", "events", "fail", 0, "the click target got no press"));
  } else {
    const down = events[downIdx];
    const path = pointerPath(events, "click-target");
    out.push(
      path.moves >= 3
        ? check("pointer-moves-before-click", "events", "pass", path.moves)
        : check(
            "pointer-moves-before-click",
            "events",
            "warn",
            path.moves,
            "the cursor jumps to the target with no path before it",
          ),
    );
    const box = boxes?.["click-target"];
    if (box) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      out.push(
        Math.abs(down.x - cx) <= 0.5 && Math.abs(down.y - cy) <= 0.5
          ? check("click-at-center", "events", "warn", { x: down.x, y: down.y }, "the press lands on the exact center")
          : check("click-at-center", "events", "pass", { dx: round1(down.x - cx), dy: round1(down.y - cy) }),
      );
    }
    const up = events.slice(downIdx).find((e) => e.type === "pointerup");
    const press = up ? round1(up.t - down.t) : undefined;
    out.push(
      press === undefined
        ? check("press-duration", "events", "fail", undefined, "no release after the press")
        : press < 10
          ? check("press-duration", "events", "warn", press, "pressed and released within 10 ms")
          : check("press-duration", "events", "pass", press),
    );
    const over = events.slice(0, downIdx).find((e) => e.type === "pointerover" && e.target === "click-target");
    const dwell = over ? round1(down.t - over.t) : undefined;
    out.push(
      dwell === undefined || dwell < 10
        ? check("hover-dwell", "events", "warn", dwell, "pressed as soon as the pointer arrived")
        : check("hover-dwell", "events", "pass", dwell),
    );
    const zero = down.sx === down.x && down.sy === down.y;
    out.push(
      zero
        ? check(
            "screen-offset",
            "events",
            headed ? "warn" : "info",
            0,
            "screenX equals clientX, a known CDP input trait",
          )
        : check("screen-offset", "events", "pass", { dx: down.sx - down.x, dy: down.sy - down.y }),
    );
  }

  const moves = events.filter((e) => e.type === "pointermove" && e.trusted);
  const noCoalesced = moves.filter((e) => e.coalesced === 0);
  out.push(
    !moves.length
      ? check("coalesced-events", "events", "info", 0, "no pointer moves to inspect")
      : noCoalesced.length
        ? check("coalesced-events", "events", "warn", noCoalesced.length, "moves without coalesced events")
        : check("coalesced-events", "events", "pass", moves.length),
  );

  const fastKeys = events.filter((e) => e.type === "keydown" && e.target === "type-fast").length;
  const fastInputs = events.filter((e) => e.type === "input" && e.target === "type-fast");
  out.push(
    fastKeys === 0 && fastInputs.some((e) => e.length > 1)
      ? check("typing-key-events", "events", "info", 0, "the text arrives in one input event with no key events")
      : fastKeys > 0
        ? check("typing-key-events", "events", "pass", fastKeys)
        : check("typing-key-events", "events", "fail", 0, "no text reached the field"),
  );

  const slow = events.filter((e) => e.target === "type-slow");
  const downs = slow.filter((e) => e.type === "keydown");
  const gaps = downs.slice(1).map((e, i) => e.t - downs[i].t);
  const gap = round1(median(gaps));
  out.push(
    gap === undefined
      ? check("typing-interval", "events", "fail", undefined, "no key events in the slow field")
      : gap < 5
        ? check("typing-interval", "events", "warn", gap, "median ms between keys, faster than anyone types")
        : gap < 30
          ? check("typing-interval", "events", "info", gap, "median ms between keys")
          : check("typing-interval", "events", "pass", gap),
  );
  const holds = [];
  for (const [i, e] of slow.entries()) {
    if (e.type !== "keydown") continue;
    const up = slow.slice(i + 1).find((x) => x.type === "keyup");
    if (up) holds.push(up.t - e.t);
  }
  const hold = round1(median(holds));
  out.push(
    hold === undefined
      ? check("key-hold", "events", "fail", undefined, "no key releases in the slow field")
      : hold < 5
        ? check("key-hold", "events", "warn", hold, "median ms a key is held, shorter than a finger")
        : check("key-hold", "events", "pass", hold),
  );
  const focusIdx = events.findIndex((e) => e.type === "focusin" && e.target === "type-slow");
  const keyIdx = events.findIndex((e) => e.type === "keydown" && e.target === "type-slow");
  out.push(
    keyIdx >= 0 && focusIdx >= 0 && focusIdx < keyIdx
      ? check("focus-before-keys", "events", "pass")
      : check("focus-before-keys", "events", keyIdx < 0 ? "fail" : "warn", undefined, "keys arrived before focus"),
  );

  const farIdx = events.findIndex((e) => e.type === "pointerdown" && e.target === "far-button");
  const slowEnd = keyIdx >= 0 ? events.findLastIndex((e) => e.target === "type-slow") : 0;
  if (farIdx < 0) out.push(check("scroll-steps", "events", "fail", undefined, "the far button got no press"));
  else {
    const wheels = events.slice(slowEnd, farIdx).filter((e) => e.type === "wheel").length;
    out.push(
      wheels >= 2
        ? check("scroll-steps", "events", "pass", wheels)
        : check("scroll-steps", "events", "info", wheels, "scrolled in one jump, no wheel events"),
    );
  }
  return out;
}

/**
 * Applies a configuration's `expect`: a check below the status the configuration promises
 * becomes a failure.
 */
export function applyExpectations(checks, expect = {}) {
  return checks.map((c) => {
    const want = expect[c.id];
    if (!want || RANK[c.status] <= RANK[want]) return c;
    return { ...c, status: "fail", note: `${c.note ? `${c.note}; ` : ""}expected ${want} with this configuration` };
  });
}

/** Every check of one probe report. */
export function checkReport(report, { headed, reference, expect }) {
  const checks = [
    ...staticChecks(report.static ?? {}, { headed, reference }),
    ...protocolChecks(report),
    ...consistencyChecks(report),
    ...eventChecks(report.events ?? [], report.boxes, { headed }),
  ];
  if (reference) {
    const diff = diffStatic(report.static ?? {}, reference);
    checks.push(
      diff.length
        ? check(
            "matches-plain-chrome",
            "navigator",
            "warn",
            diff.map((d) => d.field),
            "fields that differ from the same Chrome without automation",
          )
        : check("matches-plain-chrome", "navigator", "pass"),
    );
  }
  return applyExpectations(checks, expect);
}

/**
 * Compares a run with an earlier one (a baseline): checks that got worse, per configuration,
 * and compared fields that changed. A changed field is not a regression by itself (a Chrome
 * update changes the version), so it is listed separately.
 */
export function compareWithBaseline(current, baseline) {
  const regressions = [];
  const changes = [];
  for (const cfg of current.configs ?? []) {
    const old = (baseline.configs ?? []).find((c) => c.name === cfg.name && c.headed === cfg.headed);
    if (!old || !cfg.checks || !old.checks) continue;
    for (const c of cfg.checks) {
      const before = old.checks.find((o) => o.id === c.id);
      if (before && RANK[c.status] > RANK[before.status])
        regressions.push({ config: cfg.name, check: c.id, from: before.status, to: c.status, note: c.note });
    }
    if (cfg.static && old.static) {
      for (const d of diffStatic(cfg.static, old.static))
        changes.push({ config: cfg.name, field: d.field, from: d.reference, to: d.value });
    }
  }
  return { regressions, changes };
}
