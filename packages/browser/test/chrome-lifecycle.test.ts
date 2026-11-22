import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { findBrowser } from "../src/browsers.js";
import { runDoctor } from "../src/doctor.js";
import { readHealth } from "../src/health.js";
import { createHost, serve } from "../src/host.js";
import { startedChromePid } from "../src/lifecycle.js";
import { readChallenges } from "../src/reputation.js";
import { readRuntimeLock } from "../src/runtime-lock.js";
import { writeIdentitySettings } from "../src/settings.js";
import { type TurnoTool, turnoZod } from "../src/tools.js";
import { upstream } from "../src/upstream.js";
import { alive, chromeUnavailable, stopSandboxProcesses, sandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Lifecycle tests against a real Google Chrome: the idle limit of the generated
 * config, the shutdown deadline, and the sweep of a Chrome left behind by a wrapper killed with
 * SIGKILL. Also the host end to end: a stock tool through the built server, and a
 * test-only turno tool on the same browser context as the stock tools. Every Chrome here runs on a profile inside the test's sandbox HOME, and cleanup only
 * signals processes whose command line names that sandbox, so no other Chrome is touched.
 *
 * Skipped, with the reason in the suite name, when Chrome is not installed or cannot start
 * (or with TURNO_SKIP_CHROME=1).
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");

const reason = chromeUnavailable();
const HEADED = process.platform === "darwin";

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

function profileDir(id: string): string {
  return join(sb.home, ".local", "share", "turno", "browser", "identities", id);
}

interface Running {
  client: Client;
  transport: StdioClientTransport;
  pid: number;
  stderr: () => string;
}

async function start(id: string, env: Record<string, string> = {}): Promise<Running> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, ...(HEADED ? [] : ["--headless"])],
    env: { ...(sb.env as Record<string, string>), ...env },
    cwd: sb.home,
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (d: Buffer) => {
    err += d.toString();
  });
  running.push(transport);
  const client = new Client({ name: "lifecycle", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid!, stderr: () => err };
}

async function navigate(r: Running): Promise<void> {
  const res = await r.client.callTool({
    name: "browser_navigate",
    arguments: { url: "data:text/html,<title>turno</title>ok" },
  });
  expect(res.isError ?? false, JSON.stringify(res.content)).toBe(false);
}

/** A local site for the identity tests: echoes Accept-Language, shows a challenge, or a signed-in page. */
async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/challenge")
      res.end("<title>Just a moment...</title><body>Checking your browser before you continue</body>");
    else if (path === "/account") res.end("<title>Account</title><body><h1>Welcome back, Alice</h1></body>");
    else if (path === "/signed-out") res.end("<title>Sign in</title><body><form><input name=user></form></body>");
    else res.end(`<title>echo</title><body><pre id="lang">${req.headers["accept-language"] ?? ""}</pre></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

function chromePid(id: string): number {
  const pid = startedChromePid(profileDir(id));
  expect(pid, "Chrome holds the profile").toBeDefined();
  return pid!;
}

describe.skipIf(reason !== undefined)(reason ? `real Chrome (skipped: ${reason})` : "real Chrome", () => {
  it(`closes Chrome after the generated idle limit${HEADED ? " while headed" : ""}, and opens it again on the next call`, async () => {
    const r = await start("idle", { TURNO_BROWSER_IDLE: "2s" });
    await navigate(r);
    const first = chromePid("idle");
    expect(alive(first)).toBe(true);
    expect(await waitFor(() => !alive(first), 15_000), "Chrome closed by the idle timer").toBe(true);
    expect(alive(r.pid), "the MCP server keeps running").toBe(true);

    await navigate(r);
    const second = chromePid("idle");
    expect(second).not.toBe(first);
    expect(alive(second)).toBe(true);

    await r.client.close();
    expect(await waitFor(() => !alive(second), 5_000), "Chrome closed with stdin").toBe(true);
  }, 60_000);

  // SIGSTOP freezes Chrome here; Windows has no way to stop a process like it.
  it.skipIf(process.platform === "win32")(
    "stops a Chrome that does not close in time when the server gets SIGTERM",
    async () => {
      const r = await start("stuck");
      await navigate(r);
      const pid = chromePid("stuck");
      // A Chrome that cannot answer: the graceful close upstream would wait 15 seconds for it.
      process.kill(pid, "SIGSTOP");
      const t0 = Date.now();
      process.kill(r.pid, "SIGTERM");
      expect(await waitFor(() => !alive(r.pid) && !alive(pid), 10_000)).toBe(true);
      // Within the 4 seconds mcpd gives a server between closing stdin and SIGKILL.
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(sandboxProcesses(sb.home)).toEqual([]);
    },
    60_000,
  );

  it("does not let a server killed with SIGKILL block the next start", async () => {
    const r = await start("killed");
    await navigate(r);
    const pid = chromePid("killed");
    process.kill(r.pid, "SIGKILL");
    const next = await start("killed");
    await navigate(next);
    // The old Chrome was signalled before the new one started; on a busy runner its exit can
    // still be on its way.
    expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
    expect(chromePid("killed")).not.toBe(pid);
  }, 60_000);

  // SIGSTOP freezes Chrome here; Windows has no way to stop a process like it.
  it.skipIf(process.platform === "win32")(
    "sweeps an orphaned Chrome of the same identity on start",
    async () => {
      const r = await start("orphan");
      await navigate(r);
      const pid = chromePid("orphan");
      // Freeze Chrome so it cannot notice its pipe closing, then kill the server the way the
      // MCP SDK does after its grace periods: Chrome is left running with no parent.
      process.kill(pid, "SIGSTOP");
      process.kill(r.pid, "SIGKILL");
      expect(await waitFor(() => !alive(r.pid), 5_000)).toBe(true);
      expect(
        await waitFor(() => sandboxProcesses(sb.home).some((p) => p.pid === pid && p.ppid !== r.pid), 5_000),
        "Chrome reparented",
      ).toBe(true);

      const next = await start("orphan");
      await navigate(next);
      // The old Chrome was signalled before the new one started; on a busy runner its exit can
      // still be on its way.
      expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
      expect(sandboxProcesses(sb.home).filter((p) => p.pgid === pid)).toEqual([]);
      expect(next.stderr()).toMatch(new RegExp(`closed a Chrome .*pid ${pid}`));
    },
    60_000,
  );

  it("drives stock tools end to end through the host: navigate and snapshot a data: page", async () => {
    const r = await start("e2e");
    const page = "data:text/html,<title>turno host</title><h1>Hello from turno</h1><button>Press me</button>";
    const nav = await r.client.callTool({ name: "browser_navigate", arguments: { url: page } });
    expect(nav.isError ?? false, JSON.stringify(nav.content)).toBe(false);
    expect((nav.content as { text: string }[])[0]!.text).toContain("- Page Title: turno host");
    const snap = await r.client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(snap.isError ?? false, JSON.stringify(snap.content)).toBe(false);
    const text = (snap.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    expect(text).toMatch(/heading "Hello from turno" \[level=1\] \[ref=e\d+\]/);
    expect(text).toMatch(/button "Press me" \[ref=e\d+\]/);
    expect(chromePid("e2e")).toBeGreaterThan(0);
    await r.client.close();
  }, 60_000);

  it("gives a turno tool the same browser context the stock tools drive", async () => {
    const z = turnoZod();
    const title: TurnoTool = {
      schema: {
        name: "turno_test_title",
        title: "Page title (test)",
        description: "Title of the first page.",
        inputSchema: z.object({}),
        type: "readOnly",
      },
      async handle({ browserContext }) {
        return { content: [{ type: "text", text: `title: ${await browserContext!.pages()[0]!.title()}` }] };
      },
    };
    // Chrome started in process inherits this process's env: on Linux it writes crash reports
    // under XDG_CONFIG_HOME, and upstream registers the bound browser under the cache dir (HOME
    // on macOS, XDG_CACHE_HOME on Linux; read once per process, and this is the only test here
    // that launches Chrome in process). Keep all of it in the sandbox.
    const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = sb.home;
    process.env.XDG_CONFIG_HOME = join(sb.home, ".config");
    process.env.XDG_CACHE_HOME = join(sb.home, ".cache");
    process.env.XDG_DATA_HOME = join(sb.home, ".local", "share");
    process.env.XDG_STATE_HOME = join(sb.home, ".local", "state");
    onTestFinished(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const config = await upstream().tools.resolveCLIConfigForMCP(
      { browser: "chrome", userDataDir: profileDir("inproc"), headless: !HEADED, outputDir: join(sb.home, "output") },
      {},
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serve(createHost({ config, cliOptions: {}, turnoTools: [title] }), serverSide);
    const client = new Client({ name: "inproc", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const nav = await client.callTool({
        name: "browser_navigate",
        arguments: { url: "data:text/html,<title>same context</title>ok" },
      });
      expect(nav.isError ?? false, JSON.stringify(nav.content)).toBe(false);
      const pid = chromePid("inproc");
      expect(await client.callTool({ name: "turno_test_title", arguments: {} })).toEqual({
        content: [{ type: "text", text: "title: same context" }],
      });
      await client.close();
      expect(await waitFor(() => !alive(pid), 10_000), "Chrome closed with the session").toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);

  it("applies identity.json at launch: Accept-Language with q-values, navigator.languages and the time zone", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    // A zone that is not this machine's, so Chrome has to be told.
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Tokyo" ? "Europe/Lisbon" : "Asia/Tokyo";
    writeIdentitySettings("langs", { timezone: zone, languages: ["fr-FR", "fr", "en"] }, sb.env);
    const r = await start("langs");
    const nav = await r.client.callTool({ name: "browser_navigate", arguments: { url: `${web.url}/` } });
    expect(nav.isError ?? false, textOf(nav)).toBe(false);
    const res = await r.client.callTool({
      name: "browser_evaluate",
      arguments: {
        function:
          "() => JSON.stringify({ header: document.getElementById('lang').textContent, languages: navigator.languages, zone: Intl.DateTimeFormat().resolvedOptions().timeZone })",
      },
    });
    expect(res.isError ?? false, textOf(res)).toBe(false);
    const json = /\{\\?"header[^\n]*\}/.exec(textOf(res))?.[0]?.replace(/\\"/g, '"');
    expect(JSON.parse(json!)).toEqual({ header: "fr-FR,fr;q=0.9,en;q=0.8", languages: ["fr-FR", "fr", "en"], zone });
  }, 60_000);

  it("holds the identity in a runtime lock while Chrome runs, and tells a second server who has it", async () => {
    const r = await start("locked");
    await navigate(r);
    const pid = chromePid("locked");
    expect(readRuntimeLock("locked", sb.env)).toMatchObject({
      nodePid: r.pid,
      chromePid: pid,
      pgid: pid,
      holder: "mcp",
    });

    const second = await start("locked");
    const res = await second.client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,second" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      `browser identity "locked" is in use by turno-browser-mcp (pid ${r.pid}, Chrome pid ${pid})`,
    );
    expect(textOf(res)).toContain(`kill ${r.pid}`);
    expect(alive(pid), "the first Chrome is untouched").toBe(true);

    await r.client.close();
    expect(await waitFor(() => !alive(r.pid), 10_000)).toBe(true);
    expect(readRuntimeLock("locked", sb.env), "the lock goes with its process").toBeUndefined();
    await navigate(second);
    expect(readRuntimeLock("locked", sb.env)).toMatchObject({ nodePid: second.pid, holder: "mcp" });
  }, 90_000);

  it("gives the lock back when Chrome closes for idle, and takes it again on the next call", async () => {
    const r = await start("idlelock", { TURNO_BROWSER_IDLE: "2s" });
    await navigate(r);
    const first = chromePid("idlelock");
    expect(await waitFor(() => !alive(first), 15_000)).toBe(true);
    expect(
      await waitFor(() => readRuntimeLock("idlelock", sb.env) === undefined, 5_000),
      "released with the idle close",
    ).toBe(true);
    await navigate(r);
    expect(readRuntimeLock("idlelock", sb.env)).toMatchObject({ nodePid: r.pid, chromePid: chromePid("idlelock") });
  }, 60_000);

  it("marks an identity NEEDS_AUTH when its health check page shows no sign-in, and passes once it does", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    writeIdentitySettings("health", { health: { url: `${web.url}/signed-out`, text: "Welcome back" } }, sb.env);
    const r = await start("health");
    const res = await r.client.callTool({ name: "browser_navigate", arguments: { url: "data:text/html,hi" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /NEEDS_AUTH: browser identity "health" is not signed in: the page did not show "Welcome back"/,
    );
    expect(textOf(res)).toContain("turno-browser login health");
    expect(readHealth("health", sb.env)).toMatchObject({ status: "needs_auth" });
    expect(
      await waitFor(
        () => startedChromePid(profileDir("health")) === undefined || !alive(startedChromePid(profileDir("health"))!),
        10_000,
      ),
      "Chrome closed",
    ).toBe(true);

    writeIdentitySettings("health", { health: { url: `${web.url}/account`, text: "Welcome back" } }, sb.env);
    await navigate(r);
    expect(readHealth("health", sb.env)).toMatchObject({ status: "ok", url: `${web.url}/account` });
  }, 90_000);

  it("logs a challenge page to the identity's reputation log, host name only", async () => {
    const web = await site();
    onTestFinished(() => web.close());
    const r = await start("rep");
    const nav = await r.client.callTool({
      name: "browser_navigate",
      arguments: { url: `${web.url}/challenge?session=secret` },
    });
    expect(nav.isError ?? false, textOf(nav)).toBe(false);
    expect(await waitFor(() => readChallenges("rep", sb.env).length > 0, 10_000)).toBe(true);
    expect(readChallenges("rep", sb.env)).toEqual([
      {
        ts: expect.any(String),
        site: "127.0.0.1",
        kind: "captcha",
        markers: ["checking your browser", "just a moment"],
      },
    ]);
    const raw = readFileSync(
      join(sb.home, ".local", "state", "turno", "browser", "identities", "rep", "reputation.jsonl"),
      "utf8",
    );
    expect(raw).not.toMatch(/secret|challenge\?/);
  }, 60_000);

  it("doctor: finds Chrome and starts it on a temporary profile", async () => {
    const report = await runDoctor({ env: sb.env });
    expect(report.checks.find((c) => c.area === "chrome" && c.text.startsWith("Google Chrome"))?.level).toBe("ok");
    expect(report.checks.find((c) => c.text.startsWith("smoke launch"))).toMatchObject({ level: "ok" });
  }, 60_000);
});

/**
 * The per-user browser (`turno-browser install-browser`), the one browser besides Google Chrome
 * these tests start: an identity set to Chrome for Testing runs on it through the built server.
 * The whole run has a throwaway HOME, so the build is looked for in PLAYWRIGHT_BROWSERS_PATH
 * (`PLAYWRIGHT_BROWSERS_PATH=~/Library/Caches/ms-playwright pnpm test`); nothing is downloaded.
 * Skipped when that cache does not have it.
 */
const cft = process.env.TURNO_SKIP_CHROME === "1" ? undefined : findBrowser("chrome-for-testing");
const cftCache = cft
  ? (createRequire(import.meta.url)("patchright-core/lib/coreBundle") as CoreBundle).registry.registryDirectory
  : undefined;

interface CoreBundle {
  registry: { registryDirectory: string };
}

describe.skipIf(!cft)(cft ? "Chrome for Testing" : "Chrome for Testing (skipped: not installed)", () => {
  it("runs an identity whose identity.json browser is chrome-for-testing", async () => {
    writeIdentitySettings("cft", { browser: "chrome-for-testing" }, sb.env);
    const r = await start("cft", { PLAYWRIGHT_BROWSERS_PATH: cftCache! });
    const local = await site();
    onTestFinished(() => local.close());
    // A secure context, where navigator.userAgentData names the browser's brands.
    const nav = await r.client.callTool({ name: "browser_navigate", arguments: { url: `${local.url}/account` } });
    expect(nav.isError ?? false, textOf(nav)).toBe(false);
    const res = await r.client.callTool({
      name: "browser_evaluate",
      arguments: { function: "() => navigator.userAgentData.brands.map((b) => b.brand).join(',')" },
    });
    expect(textOf(res)).toContain("Chromium");
    expect(textOf(res)).not.toContain("Google Chrome");
    await r.client.close();
    expect(readFileSync(join(profileDir("cft"), "Last Version"), "utf8")).toBe(cft!.version);
  }, 60_000);
});
