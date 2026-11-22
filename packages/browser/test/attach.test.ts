import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Browser } from "patchright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAttachEndpoint } from "../src/engine-attach.js";
import { playwright } from "../src/upstream.js";
import { alive, chromeUnavailable, spawnChrome, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Attach mode against a real Google Chrome that the test starts itself, the way a user's Chrome
 * would be running: its own throwaway `--user-data-dir` in the sandbox HOME and
 * `--remote-debugging-port=0`, so Chrome picks a free port and writes `DevToolsActivePort`
 * there (the file `--attach <dir>` reads, as `auto` reads the default profile's). Nothing here
 * touches a real profile or a running Chrome of the user's.
 *
 * Checks that turno opens a tab of its own, never changes or closes the "user's" tab, and leaves
 * Chrome running after `browser_close`, the idle limit and the server's exit.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const exe = process.platform === "darwin" ? CHROME : "/opt/google/chrome/chrome";

const USER_PAGE = "data:text/html,<title>User tab</title><p>the user's own page</p>";

let sb: Sandbox;
let chrome: ChildProcess | undefined;
const running: StdioClientTransport[] = [];
const watchers: Browser[] = [];

beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  for (const b of watchers.splice(0)) await b.close().catch(() => {});
  chrome?.kill("SIGKILL");
  chrome = undefined;
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

/** The env of a process this test starts: everything it writes under HOME lands in the sandbox. */
function sandboxEnv(): NodeJS.ProcessEnv {
  return { ...sb.env, XDG_CONFIG_HOME: join(sb.home, ".config"), XDG_CACHE_HOME: join(sb.home, ".cache") };
}

/** The "user's" Chrome: headless, a throwaway profile, remote debugging on a free port. */
async function startUserChrome(): Promise<string> {
  const dir = join(sb.home, "user-chrome");
  // The sandbox HOME and XDG dirs: Chrome writes crash reports and the font cache under them.
  chrome = spawnChrome(exe, dir, ["--headless=new", "--remote-debugging-port=0", USER_PAGE], sandboxEnv());
  // Chrome creates the file before it writes the port and path into it: wait for both.
  await resolveAttachEndpoint({ kind: "dir", dir }, sandboxEnv(), process.platform, 20_000);
  return dir;
}

/** A second CDP client that watches the Chrome's tabs, as the user's own view of it. */
async function watch(dir: string): Promise<Browser> {
  const browser = await playwright().chromium.connectOverCDP(await resolveAttachEndpoint({ kind: "dir", dir }));
  watchers.push(browser);
  return browser;
}

const urls = (b: Browser) =>
  b
    .contexts()[0]!
    .pages()
    .map((p) => p.url());

async function start(args: string[], env: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, ...args],
    env: { ...(sandboxEnv() as Record<string, string>), ...env },
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "attach-test", version: "0.0.0" });
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

describe.skipIf(reason)(`attach mode with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  it("works in a tab of its own and leaves the user's tab and Chrome alone on browser_close", async () => {
    const dir = await startUserChrome();
    const user = await watch(dir);
    await waitFor(() => urls(user).includes(USER_PAGE), 10_000);
    const client = await start(["--attach", dir]);

    const tabs = await call(client, "browser_tabs", { action: "list" });
    expect(tabs).toContain("User tab");
    expect(tabs).toMatch(/\(current\) \[\]\(about:blank\)/);

    await call(client, "browser_navigate", { url: "data:text/html,<title>Agent</title><p>agent page</p>" });
    expect(urls(user)).toContain(USER_PAGE);
    expect(urls(user).some((u) => u.includes("Agent"))).toBe(true);

    await call(client, "browser_close");
    expect(await waitFor(() => !urls(user).some((u) => u.includes("Agent")), 10_000)).toBe(true);
    expect(urls(user)).toEqual([USER_PAGE]);
    expect(alive(chrome!.pid!)).toBe(true);
  }, 90_000);

  it("closes only its own tabs at the idle limit and on exit, and Chrome keeps running", async () => {
    const dir = await startUserChrome();
    const user = await watch(dir);
    await waitFor(() => urls(user).includes(USER_PAGE), 10_000);
    const client = await start(["--attach", dir], { TURNO_BROWSER_IDLE: "2s" });
    await call(client, "browser_navigate", { url: "data:text/html,<title>Agent</title>a" });
    expect(urls(user)).toHaveLength(2);
    expect(await waitFor(() => urls(user).length === 1, 15_000)).toBe(true);
    expect(urls(user)).toEqual([USER_PAGE]);

    // The next call attaches again with a fresh tab of its own.
    await call(client, "browser_navigate", { url: "data:text/html,<title>Again</title>b" });
    expect(urls(user)).toHaveLength(2);
    await running.pop()!.close();
    expect(await waitFor(() => urls(user).length === 1, 15_000)).toBe(true);
    expect(alive(chrome!.pid!)).toBe(true);
  }, 90_000);

  it("refuses browser_run_code_unsafe in the user's browser", async () => {
    const dir = await startUserChrome();
    const client = await start(["--attach", dir]);
    const res = await client.callTool({ name: "browser_run_code_unsafe", arguments: { code: "async () => 1" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/refused in attach mode/);
  }, 60_000);

  it("plays human-like input in its own tab", async () => {
    const dir = await startUserChrome();
    const client = await start(["--attach", dir, "--humanize", "light"]);
    await call(client, "browser_navigate", {
      url: "data:text/html,<title>Agent</title><button onclick=\"document.title='clicked'\">Go</button>",
    });
    const ref = /button "Go" \[ref=([^\]]+)\]/.exec(await call(client, "browser_snapshot"))![1]!;
    await call(client, "browser_click", { element: "Go", target: ref });
    expect(await call(client, "browser_evaluate", { function: "() => document.title" })).toContain('"clicked"');
  }, 60_000);

  it('refuses "sharing": "tabs" in the user\'s browser, before connecting', async () => {
    const dir = await startUserChrome();
    const user = await watch(dir);
    await waitFor(() => urls(user).includes(USER_PAGE), 10_000);
    const client = await start(["--attach", dir, "--sharing", "tabs"]);
    const res = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not go with attach mode/);
    expect(urls(user)).toEqual([USER_PAGE]);
  }, 60_000);

  it("says how to turn remote debugging on when no Chrome listens", async () => {
    const client = await start(["--attach", join(sb.home, "no-chrome")]);
    const res = await client.callTool({ name: "browser_navigate", arguments: { url: "about:blank" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
  }, 30_000);
});
