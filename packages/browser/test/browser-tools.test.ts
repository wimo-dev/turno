import { writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { POPUP_GRACE_MS } from "../src/governor.js";
import { identityStateDir } from "../src/ids.js";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

/**
 * The browser tools against a real Google Chrome, through the built server: the tab
 * governor (popups, cap, parking), background throttling, the click diagnosis, browser_batch
 * and the wait after an action. Every Chrome runs on a profile in
 * the test's sandbox HOME; cleanup only signals processes whose command line names it.
 *
 * Skipped, with the reason in the suite name, when Chrome is missing or cannot start (or with
 * TURNO_SKIP_CHROME=1).
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

async function start(id: string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Headless: on CI runners a headed Chrome stalls on new windows (a click on a target=_blank
    // link waits out its timeout).
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "browser-tools", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return textOf(res);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `browser_tabs list` after `wait` ms, then every half second until `done` holds or 30 s pass.
 * `all` keeps every list it read, so a note the server gives only once (a tab parked or closed)
 * is found even when it came with an earlier list than `last`, the one that met `done`.
 */
async function listUntil(
  client: Client,
  done: (text: string) => boolean,
  wait: number,
): Promise<{ all: string; last: string }> {
  await sleep(wait);
  const seen: string[] = [];
  const end = Date.now() + 30_000;
  for (;;) {
    const text = await call(client, "browser_tabs", { action: "list" });
    seen.push(text);
    if (done(text) || Date.now() > end) return { all: seen.join("\n"), last: text };
    await sleep(500);
  }
}

/** Static files for the resource tests: body, content type and caching headers. */
const STATIC: Record<string, { body: string; type: string; headers: Record<string, string> }> = {
  "/static/app.css": {
    body: "h1 { color: green }",
    type: "text/css",
    headers: { "cache-control": "public, max-age=3600" },
  },
  "/static/nostore.css": { body: "p { color: red }", type: "text/css", headers: { "cache-control": "no-store" } },
  "/static/cookie.js": {
    body: "window.cookieScript = 1;",
    type: "text/javascript",
    headers: { "cache-control": "max-age=3600", "set-cookie": "seen=1; Path=/" },
  },
  "/static/logo.svg": {
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    type: "image/svg+xml",
    headers: { "cache-control": "max-age=3600" },
  },
  "/promo/ad.js": { body: "window.ad = 1;", type: "text/javascript", headers: { "cache-control": "max-age=3600" } },
};

/**
 * Pages for the tests, on 127.0.0.1. `requested` maps each path and query to when it was last
 * asked for, and `count` to how many times.
 */
async function site(): Promise<{
  url: string;
  requested: Map<string, number>;
  count: Map<string, number>;
  close(): Promise<void>;
}> {
  const requested = new Map<string, number>();
  const count = new Map<string, number>();
  const pages: Record<string, string> = {
    "/plain": "<title>plain</title><p>plain page</p>",
    "/a": "<title>page A</title><h1>Page A</h1>",
    "/b": "<title>page B</title><h1>Page B</h1>",
    // A page that opens a window 3.5 s after it loads, when the tool call that loaded it is
    // usually over (the test turns Chrome's popup blocker off, so no click is needed).
    "/delayed-popup": `<title>delayed</title><script>setTimeout(() => window.open('/plain?ad'), 3500)</script>delayed`,
    "/link": `<title>link</title><a href="/b" target="_blank">Open B</a><button onclick="document.title='clicked'">Press</button>`,
    "/covered": `<title>covered</title><button id="save" onclick="document.title='saved'">Save</button>
      <div class="cookie-banner" role="dialog" aria-label="We use cookies" style="position:fixed;inset:0;background:#fff">
        <p>We use cookies</p><button>Accept all</button><button>Reject</button></div>`,
    "/fading": `<title>fading</title><button id="go" onclick="document.title='clicked'">Go</button>
      <div id="veil" style="position:fixed;inset:0;background:#fff"></div>
      <script>setTimeout(() => document.getElementById("veil").remove(), 150);</script>`,
    "/disabled": `<title>disabled</title><button id="go" disabled>Continue</button>`,
    "/hidden": `<title>hidden</title><nav class="menu" aria-label="Menu" style="display:none"><a id="settings" href="/b">Settings</a></nav>`,
    "/form": `<title>Sign up</title><h1>Sign up</h1>
      <form onsubmit="event.preventDefault(); fetch('/api/save').then(() => document.getElementById('out').textContent = 'Saved ' + document.getElementById('name').value)">
        <label>Name <input id="name"></label>
        <label>Plan <select id="plan"><option>Free</option><option>Pro</option></select></label>
        <label><input id="agree" type="checkbox"> I agree</label>
        <button id="submit">Save</button>
      </form><p id="out"></p>`,
    "/api/save": "{}",
    // The page notes any change to its body in the title: the wait after an action must not make one.
    "/still": `<title>quiet</title><button id="noop">Noop</button>
      <button id="load" onclick="fetch('/api/slow').then((r) => r.text()).then((t) => { document.title = t; })">Load</button>
      <a id="file" href="/api/file">Export</a>
      <button id="ask" onclick="if (confirm('Delete it?')) document.title = 'confirmed'">Delete</button>
      <script>new MutationObserver(() => { document.title = "mutated"; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });</script>`,
    "/res": `<title>resources</title><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/nostore.css">
      <script src="/static/cookie.js"></script><script src="/promo/ad.js"></script><img src="/static/logo.svg" alt="logo"><h1>Resources</h1>`,
    // Timer ticks in each of the last whole seconds (oldest first, the running second left out),
    // and whether the page was ever hidden, kept in the DOM (a stock tool's evaluate runs in an
    // isolated world).
    "/busy": `<title>busy</title><script>
      document.addEventListener("visibilitychange", () => { if (document.hidden) document.documentElement.dataset.hidden = "seen"; });
      const counts = new Map();
      (function tick() {
        const second = Math.floor(performance.now() / 1000);
        counts.set(second, (counts.get(second) ?? 0) + 1);
        for (const s of counts.keys()) if (s < second - 6) counts.delete(s);
        const done = [];
        for (let s = second - 6; s < second; s++) done.push(counts.get(s) ?? 0);
        document.documentElement.dataset.seconds = done.join(",");
        setTimeout(tick, 4);
      })();
    </script>busy`,
  };
  const server: Server = createServer((req, res) => {
    requested.set(req.url ?? "/", Date.now());
    count.set(req.url ?? "/", (count.get(req.url ?? "/") ?? 0) + 1);
    if (req.url === "/api/file") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="export.csv"' });
      res.end("a,b\n");
      return;
    }
    if (req.url === "/api/slow") {
      // Answers a while after the click that asked for it, as a busy API does.
      setTimeout(() => res.end("loaded"), 1200);
      return;
    }
    const file = STATIC[req.url ?? ""];
    if (file) {
      res.writeHead(200, { "content-type": file.type, ...file.headers });
      res.end(file.body);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[new URL(req.url ?? "/", "http://x").pathname] ?? "<title>404</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requested,
    count,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

describe.skipIf(reason !== undefined)(
  reason ? `browser tools on real Chrome (skipped: ${reason})` : "browser tools on real Chrome",
  () => {
    it("closes a popup that opens after the tool call ended, and keeps the window a click opened", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      // New windows can take seconds on CI runners: give the clicks that open one time. Chrome's
      // popup blocker would make the delayed popup depend on a click's user activation, which
      // expires on a slow runner; turned off here, the page opens it from a timer.
      const config = join(sb.home, "popup-config.json");
      writeFileSync(config, JSON.stringify({ browser: { launchOptions: { args: ["--disable-popup-blocking"] } } }));
      const client = await start("popups", ["--timeout-action", "20000", "--config", config]);
      await call(client, "browser_navigate", { url: `${web.url}/link` });
      const opened = await call(client, "browser_click", { target: "a", element: "Open B link" });
      expect(opened).toMatch(/^- 1: /m);

      await call(client, "browser_navigate", { url: `${web.url}/delayed-popup` });
      const ended = Date.now();
      // Wait for the popup's request without a tool call (a call would make it the agent's).
      const deadline = ended + 30_000;
      while (!web.requested.has("/plain?ad") && Date.now() < deadline) await sleep(100);
      const at = web.requested.get("/plain?ad");
      expect(at, "the page opened its popup").toBeDefined();
      await sleep(1_000);
      const list = await call(client, "browser_tabs", { action: "list" });
      if (at! - ended > POPUP_GRACE_MS + 250) {
        expect(list).toContain(`closed a popup that ${web.url}/delayed-popup opened while no tool call was running`);
        expect(list).not.toContain("?ad");
        expect(list.match(/^- \d+:/gm)).toHaveLength(2);
      } else {
        // A slow runner ended the click late: the popup came within the grace period, so it is the
        // agent's and stays.
        expect(list).toContain("?ad");
      }
    }, 120_000);

    it("keeps at most --max-tabs pages, closing the least recently used", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("cap", ["--max-tabs", "2"]);
      await call(client, "browser_navigate", { url: `${web.url}/a` });
      await call(client, "browser_tabs", { action: "new", url: `${web.url}/b` });
      const third = await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
      expect(third).toContain(`closed the least recently used tab (${web.url}/a): more than 2 were open`);
      const list = await call(client, "browser_tabs", { action: "list" });
      expect(list.match(/^- \d+:/gm)).toHaveLength(2);
      expect(list).toContain("[page B]");
      expect(list).toContain("(current) [plain]");
    }, 60_000);

    it("parks an unused tab on about:blank, loads it again when selected, and closes a tab unused past close", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      writeIdentitySettings("parking", { tabs: { park: "2s", close: "8s" } }, sb.env);
      const client = await start("parking");
      await call(client, "browser_navigate", { url: `${web.url}/a` });
      await call(client, "browser_tabs", { action: "new", url: `${web.url}/b` });
      // The tab governor runs on a timer: on a loaded runner the park can come seconds late, so
      // list the tabs until it shows (listing never uses the tab that should park).
      const list = await listUntil(client, (t) => t.includes("(parked, was"), 2_000);
      expect(list.last).toContain(
        `- 0: [](about:blank) (parked, was ${web.url}/a: selecting it loads that page again)`,
      );
      expect(list.all).toContain(`parked a tab unused for`);

      const selected = await call(client, "browser_tabs", { action: "select", index: 0 });
      expect(selected).toContain(`loaded ${web.url}/a again in a tab that was parked`);
      expect(selected).toContain("- 0: (current) [page A]");
      const snap = await call(client, "browser_snapshot");
      expect(snap).toContain('heading "Page A"');

      // Tab 1 (page B) is not used from here on; tab 0 stays current.
      const after = await listUntil(client, (t) => t.match(/^- \d+:/gm)?.length === 1, 8_000);
      expect(after.all).toMatch(/closed a tab unused for \d+ seconds \(/);
      expect(after.last.match(/^- \d+:/gm)).toHaveLength(1);
    }, 90_000);

    it("says which element covers the target of a failed click, and what the page offers to close it", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("diagnose", ["--timeout-action", "1500"]);
      await call(client, "browser_navigate", { url: `${web.url}/covered` });
      const res = await client.callTool({
        name: "browser_click",
        arguments: { target: "#save", element: "Save button" },
      });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain(
        '### Error\nELEMENT_COVERED: Could not click button "Save" (button#save), #save: dialog "We use cookies" (div.cookie-banner) covers it and would get the click instead.',
      );
      expect(text).toContain('Next: close or answer that element first (it has "Accept all", "Reject")');
      // Named before the call ran, not after Playwright's action timeout.
      expect(text).toContain("turno: the call did not run: the target is covered");

      // Not in the way: an overlay that goes within 300 ms.
      await call(client, "browser_navigate", { url: `${web.url}/fading` });
      const fading = await client.callTool({ name: "browser_click", arguments: { target: "#go" } });
      expect(fading.isError, textOf(fading)).toBeFalsy();
      expect(await call(client, "browser_evaluate", { function: "() => document.title" })).toContain("clicked");

      await call(client, "browser_navigate", { url: `${web.url}/disabled` });
      expect(textOf(await client.callTool({ name: "browser_click", arguments: { target: "#go" } }))).toContain(
        'ELEMENT_DISABLED: Could not click button "Continue" (button#go), #go: it is disabled.',
      );
      await call(client, "browser_navigate", { url: `${web.url}/hidden` });
      expect(textOf(await client.callTool({ name: "browser_click", arguments: { target: "#settings" } }))).toContain(
        'ELEMENT_HIDDEN: Could not click link "Settings" (a#settings), #settings: it is not visible (navigation "Menu" (nav.menu) hides it).',
      );

      // JSON results keep their shape.
      await call(client, "browser_navigate", { url: `${web.url}/covered` });
      const json = await client.callTool({
        name: "browser_click",
        arguments: { target: "#save", _meta: { json: true } },
      });
      const payload = JSON.parse(textOf(json)) as { isError: boolean; code: string; error: string; cover: unknown };
      expect(payload).toMatchObject({
        isError: true,
        code: "ELEMENT_COVERED",
        cover: { role: "dialog", name: "We use cookies", selector: "div.cookie-banner" },
      });
      expect(payload.error).toMatch(/^ELEMENT_COVERED: Could not click button "Save" .* covers it/);
    }, 60_000);

    it("runs a batch of actions in one call, with one snapshot at the end", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("batch");
      const text = await call(client, "browser_batch", {
        actions: [
          { tool: "browser_navigate", arguments: { url: `${web.url}/form` } },
          { tool: "browser_type", arguments: { target: "#name", text: "Alice" }, expect: { value: "Alice" } },
          { tool: "browser_select_option", arguments: { target: "#plan", values: ["Pro"] }, expect: { value: "Pro" } },
          { tool: "browser_click", arguments: { target: "#agree" }, expect: { value: "true" } },
          { tool: "browser_click", arguments: { target: "#submit" }, expect: { text: "Saved Alice" } },
          { tool: "browser_wait_for", arguments: { text: "Saved Alice" } },
        ],
        snapshot: true,
      });
      expect(text).toMatch(/### Batch\n1\. browser_navigate http:\/\/127\.0\.0\.1:\d+\/form: ok/);
      expect(text).toContain("6. browser_wait_for Saved Alice: ok");
      expect(text.match(/### Snapshot/g)).toHaveLength(1);
      expect(text).toContain("Saved Alice");
      expect(text).toMatch(/checkbox "I agree" \[checked\]/);

      const failed = await client.callTool({
        name: "browser_batch",
        arguments: {
          actions: [
            { tool: "browser_navigate", arguments: { url: `${web.url}/covered` } },
            { tool: "browser_click", arguments: { target: "#save" } },
            { tool: "browser_press_key", arguments: { key: "Enter" } },
          ],
        },
      });
      expect(failed.isError).toBe(true);
      expect(textOf(failed)).toMatch(
        /^### Error\nAction 2 of 3 \(browser_click #save\) failed; the last action did not run\.\nELEMENT_COVERED: Could not click button "Save"/,
      );
    }, 90_000);

    it("waits after an action only until the page is done with it, and for the request it started", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      // A settle of 3 s: a fixed wait would hold every click at least that long.
      writeIdentitySettings("adaptive", { settle: "3s" }, sb.env);
      const client = await start("adaptive");
      await call(client, "browser_navigate", { url: `${web.url}/still` });
      const elapsed = async (target: string) => {
        const t0 = performance.now();
        const text = await call(client, "browser_click", { target });
        return { text, ms: performance.now() - t0 };
      };
      const { text: quick, ms } = await elapsed("#noop");
      expect(ms).toBeLessThan(2500);
      // The wait looked at the page without changing it.
      expect(quick).toContain("- Page Title: quiet");
      // The request the click started answers 1.2 s later; the result shows what it brought.
      expect(await call(client, "browser_click", { target: "#load" })).toContain("- Page Title: loaded");
      // A link that downloads a file navigates nowhere: its request never finishes as a page.
      expect((await elapsed("#file")).ms).toBeLessThan(2500);
    }, 90_000);

    it("answers a dialog a click opened while the agent cursor draws and steps are recorded", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      // The page runs no script while the dialog is open: nothing may wait on it until it is answered.
      writeIdentitySettings("asks", { cursor: "on", record: { screenshots: true } }, sb.env);
      const client = await start("asks");
      await call(client, "browser_navigate", { url: `${web.url}/still` });
      const t0 = performance.now();
      expect(await call(client, "browser_click", { target: "#ask" })).toContain('"confirm" dialog');
      expect(performance.now() - t0).toBeLessThan(4000);
      expect(await call(client, "browser_handle_dialog", { accept: true })).toContain("- Page Title: confirmed");
    }, 90_000);

    it("blocks what identity.json lists and serves cacheable static files from the identity's own disk cache", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const n = (path: string) => web.count.get(path) ?? 0;
      writeIdentitySettings("res-a", { block: { types: ["image"], patterns: ["*/promo/*"] }, cache: {} }, sb.env);
      const load = async (client: Client) => {
        await call(client, "browser_navigate", { url: `${web.url}/res` });
        await sleep(500); // the body is stored when the request finishes
      };
      let client = await start("res-a");
      await load(client);
      await load(client);
      expect(n("/res")).toBe(2);
      expect(n("/static/app.css")).toBe(1);
      expect(n("/static/nostore.css")).toBe(2);
      expect(n("/static/cookie.js")).toBe(2);
      expect(n("/static/logo.svg")).toBe(0);
      expect(n("/promo/ad.js")).toBe(0);
      // The cached stylesheet still applies.
      expect(
        await call(client, "browser_evaluate", {
          function: "() => getComputedStyle(document.querySelector('h1')).color",
        }),
      ).toContain("rgb(0, 128, 0)");

      // The cache is on disk: a new server for the same identity uses it.
      await client.close();
      client = await start("res-a");
      await load(client);
      expect(n("/static/app.css")).toBe(1);
      const dir = join(identityStateDir("res-a", sb.env), "resource-cache");
      expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
      expectMode(dir, 0o700);

      // Never across identities, and nothing blocked without a block setting.
      writeIdentitySettings("res-b", { cache: {} }, sb.env);
      const other = await start("res-b");
      await load(other);
      expect(n("/static/app.css")).toBe(2);
      expect(n("/static/logo.svg")).toBe(1);
      expect(n("/promo/ad.js")).toBe(1);
    }, 90_000);

    it("keeps background tabs at full speed by default", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("fullspeed");
      await call(client, "browser_navigate", { url: `${web.url}/busy` });
      await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
      await sleep(4_000);
      await call(client, "browser_tabs", { action: "select", index: 0 });
      const state = await call(client, "browser_evaluate", {
        function: "() => JSON.stringify(document.documentElement.dataset)",
      });
      // Focus emulation keeps it visible, so Chrome never throttles its timers: the page must never
      // have seen itself hidden, which is the condition Chrome throttles on. The tick rate does not
      // tell the two apart on a loaded CI runner (its CPU can starve the timer chain for a whole
      // second, and a throttled tab gets 1 to 10 ticks a second), so it is only checked to show the
      // timer chain kept running while the tab was in the background.
      expect(state).not.toContain("hidden");
      const seconds = (/seconds\\":\\"([\d,]+)/.exec(state)?.[1] ?? "").split(",").map(Number);
      expect(seconds.slice(-4, -1).reduce((a, n) => a + n, 0)).toBeGreaterThan(0);
    }, 60_000);

    it("with --background-throttling, slows a tab in the background and still acts at once on the current tab", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("throttled", ["--background-throttling"]);
      await call(client, "browser_navigate", { url: `${web.url}/busy` });
      await call(client, "browser_tabs", { action: "new", url: `${web.url}/plain` });
      await sleep(4_000);
      await call(client, "browser_tabs", { action: "select", index: 0 });
      // Chrome saw it hidden, so it throttled it (1 to 10 timer ticks a second locally; how much is
      // Chrome's budget, which varies on CI runners).
      expect(
        await call(client, "browser_evaluate", { function: "() => document.documentElement.dataset.hidden" }),
      ).toContain('"seen"');

      // A click that opens a window puts that window in front while the agent stays on its tab;
      // the next action on the agent's tab must not wait for a frame that never comes.
      await call(client, "browser_navigate", { url: `${web.url}/link` });
      await call(client, "browser_click", { target: "a", element: "Open B link" });
      const t0 = Date.now();
      await call(client, "browser_click", { target: "button", element: "Press button" });
      // A click that waited for that frame would hang until a timeout and fail; the bound is loose
      // so a loaded CI runner, which can take a few seconds for any click, does not fail it.
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await call(client, "browser_evaluate", { function: "() => document.title" })).toContain('"clicked"');
    }, 60_000);
  },
);
