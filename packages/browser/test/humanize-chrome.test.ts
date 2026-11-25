import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Human-like input against a real Google Chrome, through the built server: what a page sees of
 * the stock tools' clicks, typing and scrolling at each level (pointer moves before the press,
 * how long the button stays down, where in the target it lands, key timing, wheel events,
 * isTrusted), and that browser_batch gets the same input. Every Chrome runs headless on a
 * profile in the test's sandbox HOME.
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
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "humanize-chrome", version: "0.0.0" });
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

/** What the page recorded (kept in the DOM: a stock tool's evaluate runs in an isolated world). */
interface PageLog {
  moves: number;
  trusted: boolean;
  downs: number[];
  ups: number[];
  movesBeforeDown: number[];
  clicks: { id: string; dx: number; dy: number }[];
  keys: number[];
  wheels: number;
  value: string;
}

async function pageLog(client: Client): Promise<PageLog> {
  const text = await call(client, "browser_evaluate", {
    function: "() => document.documentElement.dataset.log",
  });
  const m = /### Result\n("(?:[^"\\]|\\.)*")/.exec(text);
  if (!m) throw new Error(`no result in ${text}`);
  return JSON.parse(JSON.parse(m[1]!) as string) as PageLog;
}

const EVENTS_PAGE = `<title>events</title>
<style>body { margin: 0; height: 3000px } #btn { position: absolute; left: 600px; top: 300px; width: 120px; height: 40px }
#name { position: absolute; left: 100px; top: 200px } #far { position: absolute; left: 200px; top: 2300px }</style>
<button id="btn">Press</button><input id="name" aria-label="Name"><button id="far">Far</button>
<script>
  const log = { moves: 0, trusted: true, downs: [], ups: [], movesBeforeDown: [], clicks: [], keys: [], wheels: 0, value: "" };
  const save = () => { log.value = document.getElementById("name").value; document.documentElement.dataset.log = JSON.stringify(log); };
  // Chrome fires one pointermove per frame and folds the moves in between into it, so a busy
  // renderer can turn a whole path into a single event: count the moves folded in too.
  addEventListener("pointermove", (e) => { log.moves += e.getCoalescedEvents?.().length || 1; log.trusted = log.trusted && e.isTrusted; save(); }, true);
  addEventListener("mousedown", (e) => { log.downs.push(performance.now()); log.movesBeforeDown.push(log.moves); log.trusted = log.trusted && e.isTrusted; save(); }, true);
  addEventListener("mouseup", (e) => { log.ups.push(performance.now()); save(); }, true);
  addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect();
    log.clicks.push({ id: e.target.id, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) });
    save();
  }, true);
  addEventListener("keydown", (e) => { log.keys.push(performance.now()); log.trusted = log.trusted && e.isTrusted; save(); }, true);
  addEventListener("input", save, true);
  addEventListener("wheel", () => { log.wheels++; save(); }, { capture: true, passive: true });
  save();
</script>`;

async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(EVENTS_PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/events`, close: () => new Promise((r) => server.close(() => r())) };
}

const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

describe.skipIf(reason !== undefined)(
  reason ? `human-like input on real Chrome (skipped: ${reason})` : "human-like input on real Chrome",
  () => {
    it("keeps Playwright's input on localhost, except that the click lands off the exact center: one move, text inserted", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("plain");
      await call(client, "browser_navigate", { url: web.url });
      await call(client, "browser_click", { target: "#btn", element: "Press" });
      await call(client, "browser_type", { target: "#name", element: "Name", text: "hello" });
      const log = await pageLog(client);
      // No press time is asked for, but a busy machine spaces the events: only the path is checked.
      expect(log.movesBeforeDown[0]).toBeLessThanOrEqual(1);
      expect(log.clicks[0]?.id).toBe("btn");
      expect(Math.abs(log.clicks[0]!.dx) + Math.abs(log.clicks[0]!.dy)).toBeGreaterThan(0.5);
      expect(log.keys).toHaveLength(0); // fill inserts the text without key events
      expect(log.value).toBe("hello");
    }, 60_000);

    it("with full: a path before each press, the button held, a point off center, keys typed, wheel scrolling, batch too", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      writeIdentitySettings("human", { humanize: { level: "full", seed: 5 } }, sb.env);
      const client = await start("human");
      await call(client, "browser_navigate", { url: web.url });

      await call(client, "browser_click", { target: "#btn", element: "Press" });
      let log = await pageLog(client);
      expect(log.trusted).toBe(true);
      expect(log.movesBeforeDown[0]).toBeGreaterThan(10);
      expect(log.ups[0]! - log.downs[0]!).toBeGreaterThanOrEqual(35);
      expect(log.clicks[0]!.id).toBe("btn");
      expect(Math.abs(log.clicks[0]!.dx) + Math.abs(log.clicks[0]!.dy)).toBeGreaterThan(0.5);

      await call(client, "browser_type", { target: "#name", element: "Name", text: "hello" });
      log = await pageLog(client);
      expect(log.value).toBe("hello");
      expect(log.keys).toHaveLength(5);
      for (const gap of gaps(log.keys)) expect(gap).toBeGreaterThan(30);
      // Typing over a field that holds text replaces it, as fill does.
      await call(client, "browser_type", { target: "#name", element: "Name", text: "bye" });
      log = await pageLog(client);
      expect(log.value).toBe("bye");

      await call(client, "browser_click", { target: "#far", element: "Far" });
      log = await pageLog(client);
      expect(log.wheels).toBeGreaterThan(5);
      expect(log.clicks.at(-1)!.id).toBe("far");

      const before = log.moves;
      await call(client, "browser_batch", {
        actions: [
          { tool: "browser_navigate", arguments: { url: web.url } },
          { tool: "browser_click", arguments: { target: "#btn" } },
        ],
      });
      log = await pageLog(client);
      expect(log.moves).toBeGreaterThan(10);
      expect(log.movesBeforeDown.at(-1)).toBeGreaterThan(10);
      expect(before).toBeGreaterThan(0);
    }, 90_000);

    it("turns on with the server's --humanize flag, which wins over identity.json", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      writeIdentitySettings("flag", { humanize: { level: "off" } }, sb.env);
      const client = await start("flag", ["--humanize", "light"]);
      await call(client, "browser_navigate", { url: web.url });
      await call(client, "browser_click", { target: "#btn", element: "Press" });
      const log = await pageLog(client);
      expect(log.movesBeforeDown[0]).toBeGreaterThan(3);
      expect(log.ups[0]! - log.downs[0]!).toBeGreaterThanOrEqual(35);
    }, 60_000);
  },
);
