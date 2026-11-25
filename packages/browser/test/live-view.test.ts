import { type Server, createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { addIdentity } from "../src/identities.js";
import { liveLink, livePause, liveResume, liveStatus } from "../src/live-client.js";
import { writeIdentitySettings } from "../src/settings.js";
import { vaultAdd, vaultSetSubmit } from "../src/vault.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The live view and take-over against a real Google Chrome (headless, throwaway profile),
 * through the server dist/ the global setup builds: a pause holds the agent's call, the user
 * acts through the view, and the resumed call says what changed; frames stop while a page holds
 * a vault value. The vault uses a fake `security`/`secret-tool`, never a real Keychain.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const EMAIL = "alice.live@example.com";
const PASSWORD = "Live Pa55 w0rd&<secret>";

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  fakeSecretStore(sb);
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
  const client = new Client({ name: "live-view", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot);
  if (!m) throw new Error(`no ${role} "${name}" in the snapshot`);
  return m[1]!;
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

const TICK = `<h2 id="t">0</h2><script>let n = 0; setInterval(() => { document.getElementById("t").textContent = ++n; }, 100);</script>`;

async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST") {
      req.resume();
      req.on("end", () => res.end(`<title>Welcome</title><h1>Signed in</h1>${TICK}`));
      return;
    }
    if (path === "/a")
      res.end(`<title>A</title><a href="/b" style="position:fixed;inset:0;display:block;font-size:40px">Go to B</a>`);
    else if (path === "/b") res.end("<title>B</title><h1>Page B</h1>");
    else if (path === "/login")
      res.end(`<title>Sign in</title><h1>Sign in</h1>
        <form method="post" action="/session">
          <label>Email <input name="email" type="email" autocomplete="username"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password"></label>
          <button>Sign in</button>
        </form>${TICK}`);
    else res.end("<title>404</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** Signs in to the view with a one-time link; returns the port and the cookie header. */
async function signIn(id: string): Promise<{ port: number; cookie: string }> {
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
  return { port, cookie };
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

/** The view's event stream: every event as it comes. */
function events(port: number, cookie: string): { list: { event: string; data: string }[]; close(): void } {
  const list: { event: string; data: string }[] = [];
  let buffer = "";
  const req = request(
    { host: "127.0.0.1", port, path: "/events", headers: { host: `127.0.0.1:${port}`, cookie } },
    (res) => {
      res.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        let at = buffer.indexOf("\n\n");
        while (at >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data !== undefined) list.push({ event, data });
          at = buffer.indexOf("\n\n");
        }
      });
    },
  );
  req.on("error", () => {});
  req.end();
  return { list, close: () => req.destroy() };
}

describe.skipIf(reason)(`live view and take-over with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("holds the agent's call while the user acts through the view, and says what changed on resume", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    addIdentity("work", sb.env);
    const client = await start("work", ["--live", "--live-wait", "30s"]);
    expect((await call(client, "browser_navigate", { url: `${web.url}/a` })).error).toBe(false);
    const link = ref((await call(client, "browser_snapshot")).text, "link", "Go to B");

    await livePause("work", sb.env);
    const held = call(client, "browser_click", { element: "Go to B", target: link });
    await until(
      () => liveStatus("work", sb.env),
      (s) => s?.waiting === 1,
    );
    const { port, cookie } = await signIn("work");
    const clicked = await post(port, cookie, "/input", { type: "click", x: 200, y: 200 });
    expect(clicked.status, clicked.body).toBe(200);
    await until(
      () => liveStatus("work", sb.env),
      (s) => s?.tabs.some((t) => t.url === `${web.url}/b`) === true,
    );
    await liveResume("work", sb.env);
    const out = await held;
    expect(out.error, out.text).toBe(true);
    expect(out.text).toMatch(
      /^### Error\nbrowser_click was not run: the user changed the browser while you waited \(below\)\.\n\n### Paused by the user\nThe user paused this browser \(turno-browser pause\) for \d+s/,
    );
    expect(out.text).toContain(`- Current tab: ${web.url}/a -> ${web.url}/b`);
    expect(out.text).toContain('- Title: "A" -> "B"');
    expect(out.text).toContain("- The user clicked, typed or scrolled 1 time through the live view.");
    expect(out.text).toContain("Your browser_click call was not run");
    expect(out.text).toContain('heading "Page B"');

    // A call that only reads runs after a pause in which nothing changed.
    await livePause("work", sb.env);
    const snap = call(client, "browser_snapshot");
    await until(
      () => liveStatus("work", sb.env),
      (s) => s?.waiting === 1,
    );
    await liveResume("work", sb.env);
    const read = await snap;
    expect(read.text).toContain("Nothing changed in the browser's tabs");
    expect(read.text).toContain("Your browser_snapshot call ran after the resume");
    expect(read.text).toContain('heading "Page B"');
  });

  it("fails a held call after the wait, and does not hold a tool that needs no browser", async () => {
    addIdentity("slow", sb.env);
    const client = await start("slow", ["--live", "--live-wait", "5s"]);
    await livePause("slow", sb.env);
    const flows = await call(client, "browser_flows");
    expect(flows.error, flows.text).toBe(false);
    const began = Date.now();
    const out = await call(client, "browser_navigate", { url: "about:blank" });
    expect(Date.now() - began).toBeGreaterThanOrEqual(4_900);
    expect(out.error).toBe(true);
    expect(out.text).toContain('The user paused browser identity "slow"');
    expect(out.text).toContain("has not resumed it within 5s, so browser_navigate was not run");
    expect((await liveStatus("slow", sb.env))?.paused).not.toBeNull();
  });

  it.each([
    ["", undefined],
    [", typed key by key with humanize on", { level: "full" as const }],
  ])("streams the agent's tab and sends no frame of a page that holds a vault value%s", async (_, humanize) => {
    const web = await site();
    onTestFinished(() => web.close());
    addIdentity("vault", sb.env);
    writeIdentitySettings("vault", { live: { enabled: true }, ...(humanize ? { humanize } : {}) }, sb.env);
    await vaultAdd(
      "vault",
      "local",
      { urls: [`${web.url}/login`], username: EMAIL, password: PASSWORD },
      { env: sb.env },
    );
    // The agent presses Sign in itself here, so the page keeps the filled values until then.
    vaultSetSubmit("vault", "confirm", { env: sb.env });
    const client = await start("vault");
    await call(client, "browser_navigate", { url: `${web.url}/login` });
    const { port, cookie } = await signIn("vault");
    const stream = events(port, cookie);
    onTestFinished(() => stream.close());
    const frames = () => stream.list.filter((e) => e.event === "frame");
    await until(
      () => frames().length,
      (n) => n >= 2,
    );
    const first = JSON.parse(frames()[0]!.data) as { data: string; w: number };
    expect(first.data.startsWith("/9j/")).toBe(true); // a JPEG
    expect(first.w).toBeGreaterThan(0);

    const before = stream.list.length;
    const filled = await call(client, "browser_login", { site: "local" });
    expect(filled.error, filled.text).toBe(false);
    // The view hides the page before the first key goes in, so no frame follows that state.
    const during = stream.list.slice(before);
    const hiddenAt = during.findIndex((e) => e.event === "state" && (JSON.parse(e.data) as { hidden: boolean }).hidden);
    expect(hiddenAt).toBeGreaterThanOrEqual(0);
    expect(during.slice(hiddenAt).filter((e) => e.event === "frame")).toEqual([]);
    const after = stream.list.length;
    await new Promise((r) => setTimeout(r, 1_500));
    // The page ticks ten times a second, so frames would keep coming if they were sent.
    expect(stream.list.slice(after).filter((e) => e.event === "frame")).toEqual([]);
    const states = stream.list.filter((e) => e.event === "state").map((e) => JSON.parse(e.data) as { hidden: boolean });
    expect(states.at(-1)?.hidden).toBe(true);
    expect(stream.list.map((e) => e.data).join("\n")).not.toContain(PASSWORD);

    const snap = (await call(client, "browser_snapshot")).text;
    await call(client, "browser_click", { element: "Sign in", target: ref(snap, "button", "Sign in") });
    const resumed = stream.list.length;
    await until(
      () => stream.list.slice(resumed).filter((e) => e.event === "frame").length,
      (n) => n >= 1,
    );
    expect((await liveStatus("vault", sb.env))?.hidden).toBe(false);
  });
});
