import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { addIdentity } from "../src/identities.js";
import { CLIENT_META_KEY, SESSION_META_KEY } from "../src/session.js";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The agent cursor on a real Google Chrome, through the built server: with `--cursor on` the
 * page gets the overlay, the model's snapshot and read text never hold it, a click under it
 * still lands, and the model's screenshot is taken with it hidden; with `--cursor off`, and
 * with `auto` on a headless Chrome, the page gets nothing at all. With humanize on, the arrow
 * follows the pointer path; the typing bubble stays up long enough to see; the label stays
 * inside the page; with shared tabs each agent is named and the badge counts the others at work.
 * Every Chrome runs headless on a profile in the test's sandbox HOME.
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
  const client = new Client({ name: "Cursor Test Agent", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type Part = { type: string; text?: string; data?: string };

function textOf(res: unknown): string {
  return ((res as { content: Part[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

/** A client session as mcpd relays it: its id, and the name of the agent behind it. */
interface As {
  session: string;
  agent: string;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, as?: As): Promise<string> {
  const res = await client.callTool({
    name,
    arguments: args,
    ...(as ? { _meta: { [SESSION_META_KEY]: as.session, [CLIENT_META_KEY]: as.agent } } : {}),
  });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return textOf(res);
}

/** The value a browser_evaluate returned. */
async function evaluate<T>(client: Client, fn: string, as?: As): Promise<T> {
  const text = await call(client, "browser_evaluate", { function: fn }, as);
  const m = /### Result\n([\s\S]*?)(?:\n###|$)/.exec(text);
  if (!m) throw new Error(`no result in ${text}`);
  return JSON.parse(m[1]!.trim()) as T;
}

/** The ref of the element whose snapshot line holds `label`. */
function refOf(snapshot: string, label: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(label));
  const m = line && /\[ref=(e\d+)\]/.exec(line);
  if (!m) throw new Error(`no ref for ${label} in\n${snapshot}`);
  return m[1]!;
}

// The page's own script (the main world) logs what it sees of the overlay: the host element as
// it is added, and every change of its style, so the test knows it was hidden for the screenshot.
const PAGE = `<title>cursor</title>
<style>body { margin: 0; font: 16px sans-serif } #go { position: absolute; left: 300px; top: 200px; width: 160px; height: 44px }
#name { position: absolute; left: 300px; top: 120px }
#edge { position: absolute; right: 4px; top: 320px; width: 70px; height: 32px }</style>
<input id="name" aria-label="Your name"><button id="go">Sign in</button><button id="edge">Help</button>
<script>
  const log = { clicks: 0, hosts: 0, visibility: [] };
  // Kept in a data attribute: the observer below watches only children and style.
  const save = () => { document.body.dataset.log = JSON.stringify(log); };
  document.getElementById("go").addEventListener("click", () => { log.clicks++; save(); });
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeName === "TURNO-AGENT-CURSOR") log.hosts++;
      if (r.type === "attributes" && r.target.nodeName === "TURNO-AGENT-CURSOR") log.visibility.push(r.target.style.visibility);
    }
    save();
  }).observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ["style"], subtree: true });
  save();
</script>`;

async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(() => r())) };
}

interface PageLog {
  clicks: number;
  hosts: number;
  visibility: string[];
}

const pageLog = (client: Client) => evaluate<PageLog>(client, "() => JSON.parse(document.body.dataset.log)");

/** What the overlay shows, read from the utility world where browser_evaluate runs too. */
interface OverlayState {
  connected: boolean;
  cursors: string[];
}
const overlayState = (client: Client) =>
  evaluate<OverlayState | null>(
    client,
    "() => { const p = window.__turnoAgentCursor; return p ? { connected: p.host.isConnected, cursors: [...p.cursors.values()].map((c) => c.label) } : null; }",
  );

/** Each cursor the overlay draws, with where its label is, and the typing bubbles and badge. */
interface Drawn {
  cursors: { label: string; x: number; y: number; moves: number; pillLeft: number; pillRight: number }[];
  typing: string[];
  badge: string;
  width: number;
}
const DRAWN = `() => {
  const p = window.__turnoAgentCursor;
  if (!p) return null;
  return {
    cursors: [...p.cursors.values()].map((c) => {
      const r = c.pill.getBoundingClientRect();
      return { label: c.label, x: c.x, y: c.y, moves: c.moves, pillLeft: r.left, pillRight: r.right };
    }),
    typing: [...p.typing.keys()],
    badge: p.badgeText.textContent,
    width: window.innerWidth,
  };
}`;
const drawn = (client: Client, as?: As) => evaluate<Drawn | null>(client, DRAWN, as);

describe.skipIf(reason !== undefined)(
  reason ? `the agent cursor on real Chrome (skipped: ${reason})` : "the agent cursor on real Chrome",
  () => {
    it("draws the cursor with --cursor on, out of the snapshot and the text, without blocking a click", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("drawn", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const snapshot = await call(client, "browser_snapshot");
      await call(client, "browser_type", { element: "Your name", target: refOf(snapshot, "Your name"), text: "Ada" });
      await call(client, "browser_click", { element: "Sign in", target: refOf(snapshot, "Sign in") });

      const log = await pageLog(client);
      expect(log.clicks).toBe(1);
      expect(log.hosts).toBe(1);
      const state = await overlayState(client);
      expect(state?.connected).toBe(true);
      expect(state?.cursors).toEqual(["Cursor Test Agent · drawn"]);

      const after = await call(client, "browser_snapshot");
      expect(after).not.toMatch(/turno|at work|Cursor Test Agent/);
      const text = await evaluate<string>(client, "() => document.body.innerText");
      expect(text).not.toMatch(/turno|at work|Cursor Test Agent/);
    });

    it("hides the overlay while the model's screenshot is taken, then shows it again", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("shot", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const res = await client.callTool({ name: "browser_take_screenshot", arguments: {} });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      expect((res.content as Part[]).some((c) => c.type === "image")).toBe(true);
      const log = await pageLog(client);
      // Each change of the host's style after it was built: hidden for the shot, then visible.
      expect(log.visibility).toEqual(["hidden", "visible"]);
    });

    it("leaves the page alone with --cursor off, and with auto on a headless Chrome without the live view", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      for (const [id, args] of [
        ["off", ["--cursor", "off"]],
        ["auto", []],
      ] as const) {
        // The live view is on by default, and someone watching it sees the cursor.
        if (id === "auto") writeIdentitySettings(id, { live: { enabled: false } }, sb.env);
        const client = await start(id, [...args]);
        await call(client, "browser_navigate", { url: web.url });
        const snapshot = await call(client, "browser_snapshot");
        await call(client, "browser_click", { element: "Sign in", target: refOf(snapshot, "Sign in") });
        const log = await pageLog(client);
        expect(log).toEqual({ clicks: 1, hosts: 0, visibility: [] });
        expect(await overlayState(client)).toBeNull();
        expect(await evaluate<boolean>(client, "() => document.querySelector('turno-agent-cursor') === null")).toBe(
          true,
        );
      }
    });

    it("moves the arrow along humanize's pointer path to the point it clicks", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("human", ["--cursor", "on", "--humanize", "light"]);
      await call(client, "browser_navigate", { url: web.url });
      const snapshot = await call(client, "browser_snapshot");
      await call(client, "browser_click", { element: "Sign in", target: refOf(snapshot, "Sign in") });
      expect((await pageLog(client)).clicks).toBe(1);
      const state = await drawn(client);
      const arrow = state?.cursors.find((c) => c.label === "Cursor Test Agent · human");
      // Many steps of a curved path, ending inside the button (left 300, top 200, 160 by 44).
      expect(arrow?.moves).toBeGreaterThanOrEqual(5);
      expect(arrow?.x).toBeGreaterThanOrEqual(300);
      expect(arrow?.x).toBeLessThanOrEqual(460);
      expect(arrow?.y).toBeGreaterThanOrEqual(200);
      expect(arrow?.y).toBeLessThanOrEqual(244);
    });

    it("keeps the typing bubble up a moment after a fill, then takes it down", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("bubble", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const snapshot = await call(client, "browser_snapshot");
      await call(client, "browser_type", { element: "Your name", target: refOf(snapshot, "Your name"), text: "Ada" });
      expect((await drawn(client))?.typing).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 1500));
      expect((await drawn(client))?.typing).toEqual([]);
    });

    it("puts the label left of the arrow near the right edge, inside the page", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      const client = await start("edge", ["--cursor", "on"]);
      await call(client, "browser_navigate", { url: web.url });
      const snapshot = await call(client, "browser_snapshot");
      await call(client, "browser_click", { element: "Help", target: refOf(snapshot, "Help") });
      const state = await drawn(client);
      const arrow = state?.cursors[0];
      expect(arrow?.pillRight).toBeLessThanOrEqual(state!.width);
      expect(arrow?.pillLeft).toBeGreaterThanOrEqual(0);
      expect(arrow!.pillRight).toBeLessThan(arrow!.x + 6);
    });

    it("with shared tabs names each session's agent and counts the others at work on the badge", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("team", sb.env);
      writeIdentitySettings("team", { sharing: "tabs" }, sb.env);
      const client = await start("team", ["--cursor", "on"]);
      const A: As = { session: "aaaaaaaa-1111-4111-8111-111111111111", agent: "claude-code" };
      const B: As = { session: "bbbbbbbb-2222-4222-8222-222222222222", agent: "codex-mcp-client" };
      const C: As = { session: "cccccccc-3333-4333-8333-333333333333", agent: "claude-code" };
      for (const as of [A, B, C]) await call(client, "browser_navigate", { url: web.url }, as);
      // A waits in its tab while B looks at its own: B's badge counts A.
      const waiting = call(client, "browser_wait_for", { time: 3 }, A);
      await new Promise((r) => setTimeout(r, 600));
      const seenByB = await drawn(client, B);
      await waiting;
      expect(seenByB?.badge).toBe("turno · Codex at work +1");
      expect(seenByB?.cursors.map((c) => c.label)).toContain("Codex · team");
      expect((await drawn(client, A))?.cursors.map((c) => c.label)).toContain("Claude Code · team");
      expect((await drawn(client, C))?.cursors.map((c) => c.label)).toContain("Claude Code (2) · team");
      // Nobody else at work: no count.
      expect((await drawn(client, B))?.badge).toBe("turno · Codex at work");
    }, 60_000);
  },
);
