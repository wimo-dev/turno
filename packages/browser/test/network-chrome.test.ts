import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity } from "../src/identities.js";
import { liveStatus } from "../src/live-client.js";
import { listRecordings, recordingsDir, zipTexts } from "../src/recordings.js";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { localProxy } from "./helpers/local-proxy.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * identity.json `userAgent` and `proxy` against a real Google Chrome, through the built server:
 * what a page and a worker read and what the server receives in the headers, and a proxy the
 * test starts on 127.0.0.1 (never a real proxy service) whose password comes from a fake
 * `security`/`secret-tool` on the sandbox PATH. Every Chrome runs headless on a throwaway
 * profile; secret values are compared, never printed.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const PASSWORD = "Pr0xy pass&<word>";
const servers: Server[] = [];
const sockets = new Set<Socket>();
let sb: Sandbox;
let store: FakeSecretStore;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  sb.cleanup();
});

/** Starts the server for `id`; `sampling` answers MCP sampling requests (the act model) with the prompt's text. */
async function start(id: string, sampling?: (prompt: string) => string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless"],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client(
    { name: "network-chrome", version: "0.0.0" },
    { capabilities: sampling ? { sampling: {} } : {} },
  );
  if (sampling)
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const prompt = [
        request.params.systemPrompt ?? "",
        ...request.params.messages.map((m) => (m.content as { text?: string }).text ?? ""),
      ].join("\n");
      return { role: "assistant", model: "test-client-model", content: { type: "text", text: sampling(prompt) } };
    });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (s) => {
    s.on("error", () => {});
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

/** What the page and its worker read, posted back so no automation reads it from the page. */
const READ = `(navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'architecture', 'platformVersion']) : Promise.resolve(null)).then((high) => fetch('/report', { method: 'POST', body: JSON.stringify({
  high,
  where: self.document ? 'page' : 'worker',
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  uaPlatform: navigator.userAgentData && navigator.userAgentData.platform,
  brands: navigator.userAgentData && navigator.userAgentData.brands.map((b) => b.brand + ' ' + b.version),
  languages: Array.from(navigator.languages),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}) }))`;

interface Report {
  where: string;
  high: { fullVersionList: { brand: string; version: string }[]; architecture: string; platformVersion: string } | null;
  userAgent: string;
  platform: string;
  uaPlatform: string;
  brands: string[];
  languages: string[];
  timezone: string;
}

/** A page that reports what it reads and starts a worker that does the same; it keeps the headers of each request. */
async function probeSite() {
  const reports: Report[] = [];
  const headers = new Map<string, IncomingHttpHeaders>();
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "POST" && path === "/report") {
        let body = "";
        req.on("data", (d) => {
          body += d;
        });
        req.on("end", () => {
          reports.push(JSON.parse(body) as Report);
          res.end("ok");
        });
        return;
      }
      headers.set(path, req.headers);
      if (path === "/worker.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(READ);
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(`<title>probe</title><p>probe</p><script>${READ}; new Worker('/worker.js');</script>`);
    }),
  );
  const until = async (n: number) => {
    const end = Date.now() + 10_000;
    while (reports.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  // localhost, not 127.0.0.1: a secure context, where Chrome sends and exposes client hints.
  return { url: `http://localhost:${port}/probe`, reports, headers, until };
}

/** Every file under `dir` as text, the files inside trace zips included. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += allText(p);
    else {
      const buf = readFileSync(p);
      out += buf.toString("utf8");
      if (name.endsWith(".zip")) for (const t of zipTexts(buf)) out += t.text;
    }
  }
  return out;
}

describe.skipIf(reason)("identity.json userAgent with a real Chrome", () => {
  it("a headless Chrome says HeadlessChrome by default, and presents the headed Chrome's own user agent with coherent", async () => {
    const zone =
      Intl.DateTimeFormat().resolvedOptions().timeZone === "Pacific/Auckland" ? "Europe/Berlin" : "Pacific/Auckland";
    addIdentity("plain", sb.env);
    const plain = await probeSite();
    const before = await start("plain");
    expect((await call(before, "browser_navigate", { url: plain.url })).error).toBe(false);
    await plain.until(2);
    expect(plain.reports.find((r) => r.where === "page")?.userAgent).toMatch(/HeadlessChrome\//);

    addIdentity("same", sb.env);
    writeIdentitySettings("same", { userAgent: "coherent", timezone: zone }, sb.env);
    const site = await probeSite();
    const client = await start("same");
    const nav = await call(client, "browser_navigate", { url: site.url });
    expect(nav.error, nav.text).toBe(false);
    await site.until(2);
    const page = site.reports.find((r) => r.where === "page")!;
    const worker = site.reports.find((r) => r.where === "worker")!;
    expect(page.userAgent).not.toMatch(/HeadlessChrome/);
    const major = /Chrome\/(\d+)\.0\.0\.0/.exec(page.userAgent)?.[1];
    expect(major).toBeDefined();
    expect(page.brands).toContain(`Google Chrome ${major}`);
    // The network sees the same set as the page, and the worker the same as its page.
    const sent = site.headers.get("/probe")!;
    expect(sent["user-agent"]).toBe(page.userAgent);
    expect(sent["sec-ch-ua"]).toContain(`"Google Chrome";v="${major}"`);
    expect(sent["sec-ch-ua-platform"]).toBe(`"${page.uaPlatform}"`);
    expect(site.headers.get("/worker.js")?.["user-agent"]).toBe(page.userAgent);
    expect(worker).toMatchObject({
      userAgent: page.userAgent,
      platform: page.platform,
      uaPlatform: page.uaPlatform,
      languages: page.languages,
      timezone: zone,
    });
    expect(page.timezone).toBe(zone);
    // The client hints' high entropy values stay the real ones, in the page and its worker.
    const real = plain.reports.find((r) => r.where === "page")!.high!;
    expect(real.fullVersionList.length).toBeGreaterThan(0);
    expect(page.high).toEqual(real);
    expect(worker.high).toEqual(real);
    // A tab a tool opens gets them too.
    const second = await probeSite();
    const tab = await call(client, "browser_tabs", { action: "new", url: second.url });
    expect(tab.error, tab.text).toBe(false);
    await second.until(2);
    expect(second.reports.find((r) => r.where === "page")?.high).toEqual(real);
    expect(second.reports.find((r) => r.where === "page")?.userAgent).toBe(page.userAgent);
  });
});

describe.skipIf(reason)("identity.json proxy with a real Chrome and a local proxy", () => {
  it("sends the traffic through the proxy with the password from the secret store, which no tool result shows", async () => {
    const proxy = await localProxy("alice", PASSWORD, listen);
    store.write("proxy-pass", PASSWORD);
    addIdentity("px", sb.env);
    writeIdentitySettings(
      "px",
      { proxy: { server: proxy.server, username: "alice", password: "keychain:proxy-pass" } },
      sb.env,
    );
    const site = await probeSite();
    const client = await start("px");
    // http://127.0.0.1, not localhost: Playwright sends loopback through the proxy too, and a
    // plain http:// request carries Proxy-Authorization, the case a header could leak in.
    const target = site.url.replace("localhost", "127.0.0.1");
    const results = [await call(client, "browser_navigate", { url: target })];
    expect(results[0]!.error, results[0]!.text).toBe(false);
    await site.until(2);
    expect(proxy.seen.relayed).toContain("/probe");
    expect(proxy.seen.relayed).toContain("/worker.js");
    expect(proxy.seen.wrongCredentials).toBe(0);
    results.push(await call(client, "browser_network_requests", { static: true }));
    for (let i = 1; i <= 3; i++) results.push(await call(client, "browser_network_request", { index: i }));
    results.push(await call(client, "browser_snapshot"));
    results.push(await call(client, "browser_evaluate", { function: "() => document.title" }));
    const basic = Buffer.from(`alice:${PASSWORD}`).toString("base64");
    for (const r of results) {
      expect(r.text.includes(PASSWORD)).toBe(false);
      expect(r.text.includes(basic)).toBe(false);
    }
  });

  it("refuses to start without the secret, naming the item and never a value", async () => {
    const proxy = await localProxy("alice", PASSWORD, listen);
    addIdentity("nokey", sb.env);
    writeIdentitySettings(
      "nokey",
      { proxy: { server: proxy.server, username: "alice", password: "keychain:absent" } },
      sb.env,
    );
    const site = await probeSite();
    const client = await start("nokey");
    const r = await call(client, "browser_navigate", { url: site.url });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(
      /the secret store has no item "absent" for the proxy password \(store it with: turno-browser secret set absent\)/,
    );
    expect(proxy.seen.relayed).toEqual([]);
    expect(site.reports).toEqual([]);
  });

  it("records flows and screenshots behind a proxy with a password, and no recording holds it", async () => {
    const proxy = await localProxy("alice", PASSWORD, listen);
    store.write("proxy-pass", PASSWORD);
    addIdentity("rec", sb.env);
    writeIdentitySettings(
      "rec",
      {
        proxy: { server: proxy.server, username: "alice", password: "keychain:proxy-pass" },
        record: { flows: true, screenshots: true },
      },
      sb.env,
    );
    const site = await probeSite();
    const client = await start("rec");
    const target = site.url.replace("localhost", "127.0.0.1");
    expect((await call(client, "browser_navigate", { url: target })).error).toBe(false);
    await site.until(2);
    await call(client, "browser_navigate", { url: `${target}?again` });
    await call(client, "browser_close");
    expect(await waitFor(() => listRecordings("rec", sb.env)[0]?.ended !== undefined, 15_000)).toBe(true);
    expect(proxy.seen.relayed).toContain("/probe");
    expect(listRecordings("rec", sb.env)[0]?.screenshots).toBeGreaterThan(0);
    const recorded = allText(recordingsDir("rec", sb.env));
    const basic = Buffer.from(`alice:${PASSWORD}`).toString("base64");
    expect(recorded.includes(PASSWORD)).toBe(false);
    expect(recorded.includes(basic)).toBe(false);
  });

  it("keeps the proxy credentials out of the act model's prompt and the live view's tab list", async () => {
    const proxy = await localProxy("alice", PASSWORD, listen);
    store.write("proxy-pass", PASSWORD);
    addIdentity("act", sb.env);
    writeIdentitySettings(
      "act",
      {
        proxy: { server: proxy.server, username: "alice", password: "keychain:proxy-pass" },
        act: {},
        live: { enabled: true },
      },
      sb.env,
    );
    // A page that shows the credentials, as a page that echoed them would.
    const basic = Buffer.from(`alice:${PASSWORD}`).toString("base64");
    const shown = PASSWORD.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const port = await listen(
      createServer((_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(`<title>echo ${shown}</title><p>alice:${shown}</p><p>${basic}</p><button>Go</button>`);
      }),
    );
    const prompts: string[] = [];
    const client = await start("act", (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ done: true, success: true, summary: "read the page" });
    });
    const nav = await call(client, "browser_navigate", { url: `http://127.0.0.1:${port}/echo` });
    expect(nav.error, nav.text).toBe(false);
    expect(proxy.seen.relayed).toContain("/echo");
    const acted = await call(client, "browser_act", { instruction: "Read the page" });
    expect(acted.error, acted.text).toBe(false);
    expect(prompts.length).toBeGreaterThan(0);
    const status = JSON.stringify(await liveStatus("act", sb.env));
    expect(status).toContain("/echo");
    for (const text of [...prompts, acted.text, nav.text, status]) {
      expect(text.includes(PASSWORD)).toBe(false);
      expect(text.includes(basic)).toBe(false);
    }
  });

  it("works with userAgent coherent, humanize and tab sharing on one identity", async () => {
    const proxy = await localProxy("alice", PASSWORD, listen);
    store.write("proxy-pass", PASSWORD);
    addIdentity("all", sb.env);
    writeIdentitySettings(
      "all",
      {
        userAgent: "coherent",
        proxy: { server: proxy.server, username: "alice", password: "keychain:proxy-pass" },
        humanize: { level: "light", seed: 1 },
        sharing: "tabs",
      },
      sb.env,
    );
    const site = await probeSite();
    const client = await start("all");
    const nav = await call(client, "browser_navigate", { url: site.url.replace("localhost", "127.0.0.1") });
    expect(nav.error, nav.text).toBe(false);
    await site.until(2);
    expect(proxy.seen.relayed).toContain("/probe");
    const snap = (await call(client, "browser_snapshot")).text;
    expect(snap).toContain("probe");
    const page = site.reports.find((r) => r.where === "page")!;
    expect(page.userAgent).not.toMatch(/HeadlessChrome/);
    expect(site.reports.find((r) => r.where === "worker")?.userAgent).toBe(page.userAgent);
  });
});
