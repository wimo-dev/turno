import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BackgroundSession, openBackgroundSession, startBackground, stopBackground } from "../src/client.js";
import { startedChromePid } from "../src/lifecycle.js";
import { writeIdentitySettings } from "../src/settings.js";
import { alive, chromeUnavailable, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The background server with a real Google Chrome (headless): a session keeps its tab across
 * connections, "sharing": "tabs" gives each session its own tab, and the rule with a stdio
 * server of the same identity holds both ways with one Chrome. Every Chrome runs on a profile
 * in the test's sandbox HOME. Skipped, with the reason in the suite name, when Chrome is not
 * installed or cannot start (or with TURNO_SKIP_CHROME=1).
 */

const bin = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "bin", "mcp.js");
const reason = chromeUnavailable();
const ID = "work";

let sb: Sandbox;
let env: NodeJS.ProcessEnv;
let stateRoot: string;
const stdio: StdioClientTransport[] = [];

beforeEach(() => {
  sb = sandbox();
  // A short state folder, so the Unix socket path fits.
  stateRoot = realpathSync(mkdtempSync(process.platform === "win32" ? join(tmpdir(), "tb-") : "/tmp/tb-"));
  env = { ...sb.env, TURNO_STATE_DIR: stateRoot };
});

afterEach(async () => {
  for (const t of stdio.splice(0)) await t.close().catch(() => {});
  await stopBackground(ID, { env }).catch(() => {});
  await stopSandboxProcesses(sb.home);
  rmSync(stateRoot, { recursive: true, force: true });
  sb.cleanup();
});

function profileDir(): string {
  return join(sb.home, ".local", "share", "turno", "browser", "identities", ID);
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

const page = (title: string) => `data:text/html,<title>${title}</title><p>${title}</p>`;

async function go(s: BackgroundSession, title: string): Promise<void> {
  const res = await s.callTool("browser_navigate", { url: page(title) });
  expect(res.isError ?? false, textOf(res)).toBe(false);
}

async function titleOf(s: BackgroundSession): Promise<string | undefined> {
  const res = await s.callTool("browser_snapshot", {});
  return /- Page Title: (.*)/.exec(textOf(res))?.[1]?.trim();
}

async function stdioServer(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", ID, "--headless"],
    env: env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  stdio.push(transport);
  const client = new Client({ name: "stdio-agent", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe.skipIf(reason !== undefined)(
  reason ? `background server with a real Chrome (skipped: ${reason})` : "background server with a real Chrome",
  () => {
    it("keeps a session's tab across connections, refuses a stdio server, and closes Chrome when stopped", async () => {
      const first = await openBackgroundSession(ID, { env, start: { bin, args: ["--headless"] } });
      await go(first, "first");
      await first.close();
      const chrome = startedChromePid(profileDir());
      expect(chrome !== undefined && alive(chrome)).toBe(true);

      const again = await openBackgroundSession(ID, {
        env,
        start: false,
        session: { id: first.id, protocolVersion: first.protocolVersion! },
      });
      expect(again.resumed).toBe(true);
      expect(await titleOf(again)).toBe("first");

      const agent = await stdioServer();
      const refused = await agent.callTool({ name: "browser_navigate", arguments: { url: page("second") } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain(`is served by its background server (pid ${again.state.pid})`);
      expect(startedChromePid(profileDir())).toBe(chrome);
      expect(await titleOf(again)).toBe("first");

      expect(await stopBackground(ID, { env })).toBe(true);
      expect(await waitFor(() => !alive(chrome!), 10_000), "Chrome closed with the server").toBe(true);
    }, 90_000);

    it('gives each session its own tab with "sharing": "tabs"', async () => {
      writeIdentitySettings(ID, { sharing: "tabs" }, env);
      const a = await openBackgroundSession(ID, { env, start: { bin, args: ["--headless"] } });
      const b = await openBackgroundSession(ID, { env, start: false });
      await go(a, "alpha");
      await go(b, "beta");
      expect(await titleOf(a)).toBe("alpha");
      expect(await titleOf(b)).toBe("beta");
      await a.end();
      await b.end();
    }, 90_000);

    it("does not start while a stdio server has the identity's Chrome open", async () => {
      const agent = await stdioServer();
      const res = await agent.callTool({ name: "browser_navigate", arguments: { url: page("agent") } });
      expect(res.isError ?? false, textOf(res)).toBe(false);
      const chrome = startedChromePid(profileDir());
      await expect(startBackground(ID, { env, bin, args: ["--headless"] })).rejects.toThrow(
        /is in use by turno-browser-mcp .* so it starts only when no other process has it open/s,
      );
      expect(startedChromePid(profileDir())).toBe(chrome);
      expect(alive(chrome!)).toBe(true);
    }, 90_000);

    it("serves turno-browser do from the shell: one session keeps its tab across commands", () => {
      const cli = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli", "main.js");
      const tb = (...args: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          env: { ...env, TURNO_NO_INPUT: "1" },
          encoding: "utf8",
          timeout: 60_000,
        });
      expect(tb("add", ID).status).toBe(0);
      // Started ahead, headless; `do` would start it on its own too.
      expect(tb("background", "start", ID, "--headless").stdout).toMatch(/^started the background server of "work"/);
      const open = tb("do", ID, "open", page("shell"));
      expect(open.stderr).toBe("");
      expect(open.stdout).toContain("title: shell");
      expect(tb("do", ID, "read").stdout.trim()).toBe("shell");
      const json = JSON.parse(tb("do", ID, "snapshot", "--json").stdout);
      expect(json).toMatchObject({ identity: ID, server: "background", session: { resumed: true }, ok: true });
      expect(tb("do", ID, "end").stdout).toBe(
        `ended session default of ${ID}\nChrome stays open in the background server until it has been idle for 15m; turno-browser background stop ${ID} closes it now.\n`,
      );
      expect(tb("background", "status", "--json").stdout).toContain(`"identity": "${ID}"`);
      expect(tb("background", "stop", ID).stdout).toMatch(/^stopped the background server of "work"/);
    }, 90_000);
  },
);
