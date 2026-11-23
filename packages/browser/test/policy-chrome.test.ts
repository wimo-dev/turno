import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The policy's domain check against a real Google Chrome, through the built server, in one
 * launch. One local HTTP server answers on two host names: `localhost` is allowed and
 * `127.0.0.1` is not, so no network is needed.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

let sb: Sandbox;
let server: Server | undefined;
let transport: StdioClientTransport | undefined;
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  await transport?.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
  sb.cleanup();
});

/** Every request the server saw, as `host path`. */
const seen: string[] = [];

async function site(): Promise<number> {
  seen.length = 0;
  server = createServer((req, res) => {
    const port = (server!.address() as AddressInfo).port;
    seen.push(`${(req.headers.host ?? "").split(":")[0]} ${req.url}`);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
      res.end();
      return;
    }
    if (req.url === "/landed") {
      // Never finishes loading: the tab is taken back before this page's DOMContentLoaded, so
      // the call that navigated must not wait for one.
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<!doctype html><title>landed</title>");
      return;
    }
    if (req.url === "/pixel.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>shop</title>
<img src="http://127.0.0.1:${port}/pixel.svg" alt="pixel">
<a id="out" href="http://127.0.0.1:${port}/linked">out</a>
<button id="pop" onclick="window.open('http://127.0.0.1:${port}/popup')">pop</button>`);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

describe.skipIf(reason)(`policy domain check in Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("opens allowed pages, refuses every other main-frame navigation, and loads subresources", async () => {
    const port = await site();
    writeIdentitySettings(
      "shop",
      { policy: { allowedDomains: ["localhost:*"], disabled: ["captcha", "evaluate"] } },
      sb.env,
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--identity", "shop", "--headless"],
      env: sb.env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    const client = new Client({ name: "policy-chrome", version: "0.0.0" });
    await client.connect(transport);

    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const gone of ["browser_evaluate", "browser_run_code_unsafe", "browser_route"])
      expect(names, gone).not.toContain(gone);

    const home = `http://localhost:${port}/`;
    const blocked = (res: { text: string; error: boolean }) => {
      expect(res.error, res.text).toBe(true);
      expect(res.text).toContain("blocked by the policy");
      expect(res.text).toContain(`127.0.0.1:${port}`);
      expect(res.text).toContain("localhost:*");
    };

    // Allowed, and its image from the other host loads: subresources are not checked.
    const open = await call(client, "browser_navigate", { url: home });
    expect(open.error, open.text).toBe(false);
    expect(seen).toContain("127.0.0.1 /pixel.svg");

    blocked(await call(client, "browser_navigate", { url: `http://127.0.0.1:${port}/direct` }));
    // The redirect before the link, on a tab with no take-back in flight: the hop's page never
    // loads, so this call returns only if taking the tab back gives it a page that does.
    blocked(await call(client, "browser_navigate", { url: `${home}redirect` }));
    blocked(await call(client, "browser_click", { element: "out link", target: "#out" }));
    blocked(await call(client, "browser_click", { element: "pop button", target: "#pop" }));

    // The route stopped the link, the direct navigation and the popup before they left Chrome;
    // the redirect hop reached the other host (Playwright does not route it) and was taken back.
    expect(seen.filter((s) => s.startsWith("127.0.0.1 /") && !/pixel.svg|favicon/.test(s))).toEqual([
      "127.0.0.1 /landed",
    ]);
    const tabs = await call(client, "browser_tabs", { action: "list" });
    expect(tabs.error, tabs.text).toBe(false);
    expect(tabs.text).not.toContain(`127.0.0.1:${port}`);
    expect(tabs.text).toContain(home);
  }, 90_000);
});
