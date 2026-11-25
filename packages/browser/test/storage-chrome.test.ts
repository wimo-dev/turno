import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity } from "../src/identities.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The `storage` capability, on by default, against a real Google Chrome through the built
 * server: a site on 127.0.0.1 sets an HttpOnly session cookie, a script-readable CSRF cookie, a
 * short HttpOnly cookie and a sign-in token in localStorage, then shows and logs them. No tool
 * result, and no file a tool writes, may hold any of those values, whichever path reads them;
 * and writing a mask back keeps the real value, which the site still receives.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const servers: Server[] = [];
const sockets = new Set<Socket>();
const running: StdioClientTransport[] = [];
let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  for (const s of sockets) s.destroy();
  sockets.clear();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  sb.cleanup();
});

const token = () => randomBytes(24).toString("base64url");

/** The site: `/` sets the values and shows them, `/api` echoes the session cookie, `/seen` records the cookies it gets. */
async function site() {
  const sid = token();
  const csrf = token();
  const access = token();
  const short = "k9x2";
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const cookies = req.headers.cookie ?? "";
    if (req.url === "/api") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ echo: /sid=([^;]+)/.exec(cookies)?.[1] ?? null }));
      return;
    }
    if (req.url === "/seen") {
      seen.push(cookies);
      res.end("ok");
      return;
    }
    res.setHeader("set-cookie", [
      `sid=${sid}; Path=/; HttpOnly`,
      `sess=${short}; Path=/; HttpOnly`,
      `csrftoken=${csrf}; Path=/`,
      "theme=dark; Path=/",
    ]);
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Storage</title><p id="c"></p><p id="t"></p><script>
      localStorage.setItem("auth", JSON.stringify({ access_token: ${JSON.stringify(access)}, expires_at: 1767225600 }));
      localStorage.setItem("lang", "es-MX");
      document.getElementById("c").textContent = document.cookie;
      document.getElementById("t").textContent = ${JSON.stringify(access)};
      console.log("signed in with " + ${JSON.stringify(access)} + " and " + document.cookie);
      fetch("/api");
    </script>`);
  });
  servers.push(server);
  server.on("connection", (s) => {
    s.on("error", () => {});
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, sid, csrf, access, short, seen };
}

async function start(id: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless"],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "storage-chrome", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { name, text, error: Boolean(res.isError) };
}

describe.skipIf(reason)("the storage capability with a real Chrome", () => {
  it("lists the storage tools and never shows a session value, from any tool, while writes keep working", async () => {
    const s = await site();
    addIdentity("store", sb.env);
    const client = await start("store");
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(["browser_cookie_list", "browser_localstorage_get", "browser_storage_state"]),
    );

    const results = [await call(client, "browser_navigate", { url: `${s.url}/` })];
    await call(client, "browser_wait_for", { time: 1 });
    const list = await call(client, "browser_cookie_list");
    results.push(list);
    // Names, domains and plain values stay; session values are masked, the short HttpOnly one too.
    expect(list.text).toContain("sid=[masked] (domain: 127.0.0.1, path: /)");
    expect(list.text).toContain("sess=[masked]");
    expect(list.text).toContain("csrftoken=[masked]");
    expect(list.text).toContain("theme=dark");
    const get = await call(client, "browser_cookie_get", { name: "sid" });
    expect(get.text).toContain("httpOnly: true");
    results.push(get);
    const local = await call(client, "browser_localstorage_list");
    expect(local.text).toContain('"expires_at":1767225600');
    expect(local.text).toContain("lang=es-MX");
    results.push(local);
    results.push(await call(client, "browser_localstorage_get", { key: "auth" }));
    results.push(await call(client, "browser_evaluate", { function: "() => document.cookie" }));
    results.push(await call(client, "browser_evaluate", { function: "() => localStorage.getItem('auth')" }));
    results.push(await call(client, "browser_console_messages"));
    results.push(await call(client, "browser_snapshot"));
    const requests = await call(client, "browser_network_requests");
    results.push(requests);
    const api = /(\d+)\. \[GET\] [^\n]*\/api/.exec(requests.text)?.[1];
    expect(api, requests.text).toBeDefined();
    results.push(await call(client, "browser_network_request", { index: Number(api) }));
    results.push(await call(client, "browser_network_request", { index: Number(api), part: "response-body" }));
    results.push(await call(client, "browser_network_request", { index: 1, part: "response-headers" }));
    results.push(
      await call(client, "browser_run_code_unsafe", { code: "async (page) => await page.context().cookies()" }),
    );
    results.push(
      await call(client, "browser_batch", {
        actions: [{ tool: "browser_cookie_list" }, { tool: "browser_localstorage_list" }],
      }),
    );
    const saved = await call(client, "browser_storage_state", { filename: "state.json" });
    results.push(saved);
    const file = readFileSync(join(sb.home, "state.json"), "utf8");
    expect(file).toContain('"name": "sid"');

    for (const r of [...results, { name: "state.json", text: file, error: false }]) {
      for (const secret of [s.sid, s.csrf, s.access]) expect(r.text.includes(secret), r.name).toBe(false);
      if (r.name.startsWith("browser_cookie") || r.name === "state.json")
        expect(r.text.includes(s.short), r.name).toBe(false);
    }

    // Writing back what a read showed keeps the real values: a mask stands for the value it hides.
    expect((await call(client, "browser_cookie_set", { name: "sid", value: "[masked]" })).error).toBe(false);
    expect((await call(client, "browser_set_storage_state", { filename: "state.json" })).error).toBe(false);
    const json = JSON.parse(
      (await call(client, "browser_localstorage_get", { key: "auth" })).text.match(/auth=(\{.*\})/)![1]!,
    ) as Record<string, unknown>;
    await call(client, "browser_localstorage_set", { key: "auth", value: JSON.stringify({ ...json, expires_at: 1 }) });
    const kept = await call(client, "browser_evaluate", {
      function: `() => JSON.parse(localStorage.getItem('auth')).access_token === ${JSON.stringify(s.access)}`,
    });
    expect(kept.text).toContain("true");
    await call(client, "browser_navigate", { url: `${s.url}/seen` });
    expect(s.seen.at(-1)).toContain(`sid=${s.sid}`);
    // A mask cannot move a value to another cookie or site.
    const moved = await call(client, "browser_cookie_set", { name: "sid", value: "[masked]", domain: "other.test" });
    expect(moved.error).toBe(true);
    expect((await call(client, "browser_cookie_set", { name: "copy", value: "[masked]" })).error).toBe(true);
    // A plain write and a delete work as before.
    expect((await call(client, "browser_cookie_set", { name: "theme", value: "light" })).error).toBe(false);
    expect((await call(client, "browser_cookie_delete", { name: "theme" })).error).toBe(false);
    expect((await call(client, "browser_cookie_list")).text).not.toContain("theme=");
  }, 120_000);
});
