import { type Server, createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Browser, type Page, chromium } from "patchright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { type StepReport, type StepView, humanStepOverlay } from "../src/human-step-overlay.js";
import { StepBanner } from "../src/human-step.js";
import { addIdentity } from "../src/identities.js";
import { liveLink, liveStatus } from "../src/live-client.js";
import { SESSION_META_KEY } from "../src/session.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The person step (`browser_request_human`) on a real Google Chrome, headless:
 *
 * - the banner by itself (patchright, no server): Done counts only a trusted click, a click on the
 *   target counts only when trusted, the banner comes back on a new document and goes on remove;
 * - the tool through the built server with the live view open, as a person with a headless
 *   Chrome uses it: the person's clicks and keys go in through the view (trusted CDP input), and
 *   the step ends on a URL change, a selector or a resume; another session's call waits; a click
 *   on the target counts; the result never holds what the person typed.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();
const PASSWORD = "Person Pa55 w0rd&<secret>";

async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (path === "/a")
      res.end(`<title>A</title><a href="/b" style="position:fixed;inset:0;display:block;font-size:40px">Go to B</a>`);
    else if (path === "/b") res.end("<title>B</title><h1>Page B</h1>");
    else if (path === "/terms")
      res.end(`<title>Terms</title><h1>Terms</h1>
        <button id="accept" style="position:fixed;left:100px;top:100px;width:300px;height:120px"
          onclick="const p = document.createElement('p'); p.id = 'accepted'; p.textContent = 'Accepted'; document.body.append(p)">Accept</button>`);
    else if (path === "/login")
      res.end(`<title>Sign in</title><h1>Sign in</h1>
        <input id="pw" name="password" type="password" autocomplete="current-password"
          style="position:fixed;left:100px;top:100px;width:300px;height:40px">`);
    else res.end("<title>404</title>");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    }),
  );
}

async function until<T>(get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)?.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(reason)(`the person step's banner on a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  let browser: Browser;
  let web: { url: string; close(): Promise<void> };
  // Chrome's own files (fontconfig cache, crash reports) go to a sandbox HOME, never the run's.
  let home: Sandbox | undefined;
  beforeAll(async () => {
    home = sandbox();
    const env = Object.fromEntries(Object.entries(home.env).filter((e): e is [string, string] => e[1] !== undefined));
    browser = await chromium.launch({ channel: "chrome", headless: true, env });
    web = await site();
  });
  afterAll(async () => {
    await browser?.close();
    await web?.close();
    home?.cleanup();
  });

  const view = (step: string, done: string | null = "Done"): StepView => ({
    step,
    lang: "en",
    title: "Your turn",
    instruction: "Accept the terms yourself.",
    hint: "Press Done when you have finished.",
    done,
  });
  /** The banner's report, read without changing it (the same step). */
  const report = (page: Page, v: StepView) =>
    page.evaluate(humanStepOverlay as unknown as (a: unknown) => StepReport, { cmd: { op: "banner", view: v } });
  const inPage = (page: Page, fn: string) => page.evaluate(fn, undefined, undefined, false);

  it("counts Done only from a trusted click, and comes back on a new document", async () => {
    const page = await browser.newPage();
    onTestFinished(() => page.close());
    await page.goto(`${web.url}/terms`);
    const v = view("s1");
    const banner = new StepBanner(page, v);
    await banner.show();
    // The page itself cannot reach the banner: its root is closed.
    expect(await inPage(page, `document.querySelector("turno-human-step").shadowRoot === null`)).toBe(true);
    expect(await inPage(page, `document.body.innerText.includes("Your turn")`)).toBe(false);

    // A click a script dispatches on the button itself (from the banner's own world) is not trusted.
    await page.evaluate(() => {
      const w = window as unknown as { __turnoHumanStep: { banner: { button: HTMLElement } } };
      w.__turnoHumanStep.banner.button.click();
    });
    await inPage(page, `document.querySelector("turno-human-step").click()`);
    await banner.poll();
    expect(banner.totals().done).toBe(false);

    // The person's click (CDP input, as the browser's own) is.
    const box = (await report(page, v)).doneBox!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await banner.poll();
    expect(banner.totals().done).toBe(true);

    await page.goto(`${web.url}/b`);
    expect(await inPage(page, `document.querySelector("turno-human-step")`)).toBe(null);
    await banner.poll();
    expect(await inPage(page, `document.querySelectorAll("turno-human-step").length`)).toBe(1);
    expect((await report(page, v)).done).toBe(false);
    await banner.remove();
    expect(await inPage(page, `document.querySelector("turno-human-step")`)).toBe(null);
  });

  it("counts a click on the target only when the person made it", async () => {
    const page = await browser.newPage();
    onTestFinished(() => page.close());
    await page.goto(`${web.url}/terms`);
    const handle = (await page.locator("#accept").elementHandle())!;
    const banner = new StepBanner(page, view("s2", null), { handle, frame: page.mainFrame() });
    await banner.show();
    expect(await inPage(page, `document.querySelectorAll("turno-human-target").length`)).toBe(1);
    await inPage(page, `document.getElementById("accept").click()`);
    await inPage(
      page,
      `document.getElementById("accept").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`,
    );
    await banner.poll();
    expect(banner.totals()).toMatchObject({ targetClicked: false, clicks: 0 });
    await page.mouse.click(500, 400); // elsewhere: a click, not on the target
    await banner.poll();
    expect(banner.totals()).toMatchObject({ targetClicked: false, clicks: 1 });
    await page.mouse.click(250, 160);
    await banner.poll();
    expect(banner.totals()).toMatchObject({ targetClicked: true, clicks: 2 });
    await banner.remove();
    expect(await inPage(page, `document.querySelector("turno-human-target, turno-human-step")`)).toBe(null);
  });
});

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

async function start(id: string, flags: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless", ...flags],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "step-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, session?: string) {
  const res = await client.callTool(
    { name, arguments: args, ...(session ? { _meta: { [SESSION_META_KEY]: session } } : {}) },
    undefined,
    { timeout: 120_000 },
  );
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot);
  if (!m) throw new Error(`no ${role} "${name}" in the snapshot`);
  return m[1]!;
}

function post(port: number, cookie: string, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          cookie,
          origin: `http://127.0.0.1:${port}`,
          "x-turno-live": "1",
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** Opens the live view as the person does: signs in with a one-time link and watches its stream. */
async function openView(id: string): Promise<{ input(body: unknown): Promise<void>; resume(): Promise<void> }> {
  const link = new URL(await liveLink(id, sb.env));
  const port = Number(link.port);
  const cookie = await new Promise<string>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: `/${link.search}`, headers: { host: link.host } }, (res) => {
      res.resume();
      resolve(String(res.headers["set-cookie"]).split(";")[0]!);
    })
      .on("error", reject)
      .end();
  });
  const stream = request({ host: "127.0.0.1", port, path: "/events", headers: { host: `127.0.0.1:${port}`, cookie } });
  stream.on("response", (res) => res.resume());
  stream.on("error", () => {});
  stream.end();
  onTestFinished(() => {
    stream.destroy();
  });
  await until(
    () => liveStatus(id, sb.env),
    (s) => (s?.viewers ?? 0) > 0,
  );
  return {
    async input(body) {
      const res = await post(port, cookie, "/input", body);
      expect(res.status, res.body).toBe(200);
    },
    async resume() {
      expect((await post(port, cookie, "/resume", {})).status).toBe(200);
    },
  };
}

/** Waits until the step holds the browser, and a moment more for its banner to be drawn. */
async function stepStarted(id: string): Promise<void> {
  await until(
    () => liveStatus(id, sb.env),
    (s) => s?.paused?.by === "browser_request_human",
  );
  await new Promise((r) => setTimeout(r, 500));
}

describe.skipIf(reason)(`browser_request_human with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("ends when the URL changes, holds another session's call, and removes the banner", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    addIdentity("work", sb.env);
    const client = await start("work", ["--live"]);
    await call(client, "browser_navigate", { url: `${web.url}/a` });
    const noView = await call(client, "browser_request_human", { instruction: "Go to B." });
    expect(noView.error).toBe(true);
    expect(noView.text).toContain("Ask the person to run `turno-browser live work`");

    const view = await openView("work");
    const step = call(client, "browser_request_human", {
      instruction: "Open page B.",
      until: { urlChanges: true, done: false },
    });
    await stepStarted("work");
    const other = call(client, "browser_snapshot", {}, "other-session");
    await until(
      () => liveStatus("work", sb.env),
      (s) => s?.waiting === 1,
    );
    await view.input({ type: "click", x: 200, y: 200 });
    const out = await step;
    expect(out.error, out.text).toBe(false);
    expect(out.text).toMatch(/^### Person step\nThe step ended after \d+s: the tab's URL changed\./);
    expect(out.text).toContain(`Current tab: ${web.url}/b ("B")`);
    expect(out.text).toContain(`- Current tab: ${web.url}/a -> ${web.url}/b`);
    expect(out.text).toContain("- The user clicked, typed or scrolled 1 time through the live view.");
    const held = await other;
    expect(held.text).toContain("### Waited for the person");
    expect(held.text).toContain('heading "Page B"');
    const left = await call(client, "browser_evaluate", {
      function: `() => document.querySelectorAll("turno-human-step, turno-human-target").length`,
    });
    expect(left.text).toMatch(/### Result\n0/);
    expect((await liveStatus("work", sb.env))?.paused).toBeNull();
  });

  it("ends on a selector the person's click shows, never returns what they typed, and holds the page", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    addIdentity("secret", sb.env);
    const client = await start("secret", ["--live"]);
    const view = await openView("secret");

    await call(client, "browser_navigate", { url: `${web.url}/terms` });
    const target = ref((await call(client, "browser_snapshot")).text, "button", "Accept");
    const accept = call(client, "browser_request_human", {
      instruction: "Read the terms and press Accept if you agree.",
      element: "Accept",
      target,
      requireHumanClick: true,
      until: { selector: "#accepted", done: false },
    });
    await stepStarted("secret");
    await view.input({ type: "click", x: 250, y: 160 });
    const accepted = await accept;
    expect(accepted.error, accepted.text).toBe(false);
    expect(accepted.text).toContain("#accepted is visible");
    expect(accepted.text).toContain("The person clicked the target themselves.");

    await call(client, "browser_navigate", { url: `${web.url}/login` });
    const step = call(client, "browser_request_human", { instruction: "Type your password." });
    await stepStarted("secret");
    await view.input({ type: "click", x: 250, y: 120 });
    await view.input({ type: "text", text: PASSWORD });
    await view.resume();
    const out = await step;
    expect(out.error, out.text).toBe(false);
    expect(out.text).toContain("the person resumed the agent");
    expect(out.text).toContain("changed 1 field");
    expect(out.text).toContain("- The user clicked, typed or scrolled 2 times through the live view.");
    expect(out.text).not.toContain(PASSWORD);
    const read = await call(client, "browser_evaluate", { function: `() => document.getElementById("pw").value` });
    expect(read.error).toBe(true);
    expect(read.text).toContain("browser_evaluate is refused on this page");
    expect(read.text).not.toContain(PASSWORD);
  });
});
