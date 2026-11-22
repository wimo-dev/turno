import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BackgroundServer,
  DEFAULT_BACKGROUND_IDLE_MS,
  extractBackground,
  serveBackground,
} from "../src/background.js";
import {
  backgroundDir,
  backgroundLogPath,
  backgroundSocketPath,
  backgroundStatePath,
  backgroundTokenPath,
  readBackgroundState,
} from "../src/background-state.js";
import {
  BackgroundError,
  backgroundStatus,
  openBackgroundSession,
  startBackground,
  stopBackground,
} from "../src/client.js";
import type { Engine, LaunchRequest } from "../src/engine.js";
import { createHost, serve } from "../src/host.js";
import { runtimeLockPath } from "../src/runtime-lock.js";
import type { SharingMode } from "../src/sharing.js";
import { type TurnoTool, turnoZod } from "../src/tools.js";
import { upstream } from "../src/upstream.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { alive, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The background server of an identity (`--background`) and its client: in process with a fake
 * engine (sessions, the lease, the transports, the idle limit), and as the built program started
 * by the client (start, stop, a stale state file, the rule with stdio servers). Nothing here
 * starts Chrome; background-chrome.test.ts does.
 *
 * The state folder is a short one under /tmp, so the Unix socket path fits the system's limit
 * (the sandbox HOME under the macOS temp folder is too long for one).
 */

const bin = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "bin", "mcp.js");
const ID = "work";

let sb: Sandbox;
let stateRoot: string;
let env: NodeJS.ProcessEnv;
const servers: BackgroundServer[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  sb = sandbox();
  stateRoot = realpathSync(mkdtempSync(process.platform === "win32" ? join(tmpdir(), "tb-") : "/tmp/tb-"));
  env = { ...sb.env, TURNO_STATE_DIR: stateRoot };
});

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close("test end");
  await stopBackground(ID, { env }).catch(() => {});
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(stateRoot, { recursive: true, force: true });
  sb.cleanup();
});

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

/** A test tool that reports the client session the host gave the call. */
function sessionTool(wait?: () => Promise<void>): TurnoTool {
  const z = turnoZod();
  return {
    schema: {
      name: "turno_test_session",
      title: "Session (test)",
      description: "Reports the session.",
      inputSchema: z.object({}),
      type: "readOnly",
    },
    browser: false,
    async handle(ctx) {
      await wait?.();
      return { content: [{ type: "text", text: `session: ${ctx.session ?? "none"}` }] };
    },
  };
}

function failingEngine(): Engine & { launches: LaunchRequest[] } {
  const launches: LaunchRequest[] = [];
  return {
    id: "chrome",
    launches,
    async launch(request) {
      launches.push(request);
      throw new Error("no browser in this test");
    },
  };
}

async function host(tools: TurnoTool[], engine: Engine = failingEngine()) {
  const config = await upstream().tools.resolveCLIConfigForMCP(
    { browser: "chrome", userDataDir: join(sb.home, "profile") },
    {},
  );
  return createHost({ config, cliOptions: {}, turnoTools: tools, engine, identity: { id: ID, env } });
}

async function startInProcess(
  options: {
    tools?: TurnoTool[];
    sharing?: SharingMode;
    transport?: "socket" | "tcp";
    idleMs?: number;
    sweepMs?: number;
    leaseMs?: number;
  } = {},
): Promise<BackgroundServer & { reasons: string[] }> {
  const reasons: string[] = [];
  const server = await serveBackground(await host(options.tools ?? [sessionTool()]), {
    identity: { id: ID, env },
    idleMs: options.idleMs ?? 0,
    sharing: () => options.sharing ?? "session",
    transport: options.transport ?? "socket",
    signals: false,
    onClosed: (reason) => reasons.push(reason),
    log: () => {},
    ...(options.sweepMs !== undefined ? { sweepMs: options.sweepMs } : {}),
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });
  servers.push(server);
  return Object.assign(server, { reasons });
}

/** A process that lives until the test kills it, with `--background` on its command line. */
function bystander(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", "--background"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

describe("--background flags", () => {
  it("takes --background and --background-idle out, with the env as the fallback", () => {
    expect(extractBackground(["--identity", "w", "--headless"], {})).toEqual({
      background: false,
      idleMs: DEFAULT_BACKGROUND_IDLE_MS,
      idleSet: false,
      rest: ["--identity", "w", "--headless"],
    });
    expect(extractBackground(["--background", "--background-idle", "30m", "--identity", "w"], {})).toMatchObject({
      background: true,
      idleMs: 30 * 60_000,
      idleSet: true,
      rest: ["--identity", "w"],
    });
    expect(extractBackground(["--background"], { TURNO_BROWSER_BACKGROUND_IDLE: "0" })).toMatchObject({
      idleMs: 0,
      idleSet: true,
    });
    expect(
      extractBackground(["--background", "--background-idle=90s"], { TURNO_BROWSER_BACKGROUND_IDLE: "1h" }).idleMs,
    ).toBe(90_000);
  });

  it("refuses a bad duration, --background-idle alone, and --port or --host with --background", () => {
    expect(() => extractBackground(["--background", "--background-idle", "soon"], {})).toThrow(
      /--background-idle must be a duration/,
    );
    expect(() => extractBackground(["--background"], { TURNO_BROWSER_BACKGROUND_IDLE: "x" })).toThrow(
      /TURNO_BROWSER_BACKGROUND_IDLE must be a duration/,
    );
    expect(() => extractBackground(["--background-idle", "5m"], {})).toThrow(/applies only with --background/);
    expect(() => extractBackground(["--background", "--port", "8931"], {})).toThrow(/drop --port/);
    expect(() => extractBackground(["--background", "--host=127.0.0.1"], {})).toThrow(/drop --host/);
  });
});

describe("the background server in process", () => {
  it("is ready on a Unix socket in a private folder, and serves a tool call", async () => {
    const server = await startInProcess();
    expect(server.state).toMatchObject({ v: 1, pid: process.pid, identity: ID, transport: "socket" });
    expect(server.state.socket).toBe(backgroundSocketPath(ID, env));
    expect(readBackgroundState(ID, env)).toEqual(server.state);
    expect(mode(backgroundDir(ID, env))).toBe(0o700);
    expect(mode(backgroundStatePath(ID, env))).toBe(0o600);
    expect(mode(backgroundSocketPath(ID, env))).toBe(0o600);
    expect(existsSync(backgroundTokenPath(ID, env))).toBe(false);

    const s = await openBackgroundSession(ID, { env, start: false });
    expect(s.resumed).toBe(false);
    expect(textOf(await s.callTool("turno_test_session"))).toMatch(/^session: [0-9a-f-]{36}$/);
    await s.end();
  });

  it("continues a session from a second connection: same client session, so the same tabs", async () => {
    await startInProcess();
    const first = await openBackgroundSession(ID, { env, start: false });
    const key = textOf(await first.callTool("turno_test_session"));
    await first.close();

    const again = await openBackgroundSession(ID, {
      env,
      start: false,
      session: { id: first.id, protocolVersion: first.protocolVersion! },
    });
    expect(again.resumed).toBe(true);
    expect(again.id).toBe(first.id);
    expect(textOf(await again.callTool("turno_test_session"))).toBe(key);

    const other = await openBackgroundSession(ID, { env, start: false });
    expect(other.id).not.toBe(first.id);
    await again.end();
    // Ended: the next try to continue it opens a new session.
    const after = await openBackgroundSession(ID, {
      env,
      start: false,
      session: { id: first.id, protocolVersion: first.protocolVersion! },
    });
    expect(after.resumed).toBe(false);
    expect(textOf(await after.callTool("turno_test_session"))).not.toBe(key);
    await after.end();
    await other.end();
  });

  it("puts its own client session in _meta, whatever the client sent there", async () => {
    await startInProcess();
    const s = await openBackgroundSession(ID, { env, start: false });
    const key = textOf(await s.callTool("turno_test_session"));
    const res = await s.callTool("turno_test_session", { _meta: { "io.turno/session": "forged" } });
    expect(textOf(res)).toBe(key);
    await s.end();
  });

  it('with "sharing": "session", refuses a second session while the first holds the browser', async () => {
    await startInProcess({ sharing: "session" });
    const a = await openBackgroundSession(ID, { env, start: false, owner: process.pid });
    const b = await openBackgroundSession(ID, { env, start: false });
    expect((await a.callTool("turno_test_session")).isError ?? false).toBe(false);
    const refused = await b.callTool("turno_test_session");
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(
      new RegExp(
        `^### Error\nbrowser identity "${ID}" is in use by another session of its background server \\(owner pid ${process.pid}\\) since \\d`,
      ),
    );
    expect(textOf(refused)).toContain('"sharing": "tabs"');
    await a.end();
    expect((await b.callTool("turno_test_session")).isError ?? false).toBe(false);
    await b.end();
  });

  it('with "sharing": "session", lets the lease go after leaseMs without a call', async () => {
    await startInProcess({ sharing: "session", leaseMs: 200 });
    const a = await openBackgroundSession(ID, { env, start: false });
    const b = await openBackgroundSession(ID, { env, start: false });
    await a.callTool("turno_test_session");
    expect((await b.callTool("turno_test_session")).isError).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect((await b.callTool("turno_test_session")).isError ?? false).toBe(false);
    await a.end();
    await b.end();
  });

  it('with "sharing": "tabs", serves several sessions at once, each with its own client session', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    await startInProcess({
      sharing: "tabs",
      tools: [
        sessionTool(async () => {
          if (first) {
            first = false;
            await held;
          }
        }),
      ],
    });
    const a = await openBackgroundSession(ID, { env, start: false });
    const b = await openBackgroundSession(ID, { env, start: false });
    const slow = a.callTool("turno_test_session");
    const quick = await b.callTool("turno_test_session");
    expect(quick.isError ?? false).toBe(false);
    release();
    expect(textOf(await slow)).not.toBe(textOf(quick));
    await a.end();
    await b.end();
  });

  it("ends a session whose owner process exited, and its lease with it", async () => {
    await startInProcess({ sharing: "session", sweepMs: 50 });
    const owner = bystander();
    const a = await openBackgroundSession(ID, { env, start: false, owner: owner.pid! });
    const b = await openBackgroundSession(ID, { env, start: false });
    await a.callTool("turno_test_session");
    expect((await b.callTool("turno_test_session")).isError).toBe(true);
    owner.kill("SIGKILL");
    expect(await waitFor(() => !alive(owner.pid!), 5000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect((await b.callTool("turno_test_session")).isError ?? false).toBe(false);
    await b.end();
    await a.close();
  });

  it("on loopback, asks for the token in a 0600 file and checks the Host header", async () => {
    const server = await startInProcess({ transport: "tcp" });
    expect(server.state).toMatchObject({ transport: "tcp", tokenFile: backgroundTokenPath(ID, env) });
    expect(mode(backgroundTokenPath(ID, env))).toBe(0o600);
    const token = readFileSync(backgroundTokenPath(ID, env), "utf8").trim();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(readBackgroundState(ID, env))).not.toContain(token);

    const url = `http://127.0.0.1:${server.state.port}/mcp`;
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(init),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);

    const s = await openBackgroundSession(ID, { env, start: false });
    expect((await s.callTool("turno_test_session")).isError ?? false).toBe(false);
    await s.end();
  });

  it("exits after the idle limit without a request, and removes its files", async () => {
    const server = await startInProcess({ idleMs: 300, sweepMs: 50 });
    const s = await openBackgroundSession(ID, { env, start: false });
    await s.callTool("turno_test_session");
    await s.close();
    await server.closed;
    expect(server.reasons).toEqual(["no request for 0s"]);
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);
    expect(existsSync(backgroundSocketPath(ID, env))).toBe(false);
    expect(backgroundStatus(ID, { env })).toBeUndefined();
  });

  it("does not exit while a call runs past the idle limit", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const server = await startInProcess({ idleMs: 200, sweepMs: 50, tools: [sessionTool(() => held)] });
    const s = await openBackgroundSession(ID, { env, start: false });
    const call = s.callTool("turno_test_session");
    await new Promise((r) => setTimeout(r, 600));
    expect(server.reasons).toEqual([]);
    release();
    expect((await call).isError ?? false).toBe(false);
    await s.close();
    await server.closed;
  });

  it("refuses to start while another background server of the identity runs", async () => {
    const other = bystander();
    mkdirSync(backgroundDir(ID, env), { recursive: true });
    const state = {
      v: 1,
      pid: other.pid,
      identity: ID,
      version: "0.0.0",
      startedAt: new Date().toISOString(),
      idleMs: 0,
    };
    writeFileSync(backgroundStatePath(ID, env), JSON.stringify(state));
    await expect(startInProcess()).rejects.toThrow(
      new RegExp(`the background server of browser identity "${ID}" already runs \\(pid ${other.pid}`),
    );
    expect(readBackgroundState(ID, env)?.pid).toBe(other.pid);
  });

  it("refuses to start while another process has the identity's Chrome open (runtime lock)", async () => {
    const other = bystander();
    mkdirSync(join(stateRoot, "browser", "identities", ID), { recursive: true });
    writeFileSync(
      runtimeLockPath(ID, env),
      JSON.stringify({ nodePid: other.pid, holder: "mcp", startedAt: new Date().toISOString() }),
    );
    await expect(startInProcess()).rejects.toThrow(
      /is in use by turno-browser-mcp .* The background server owns the identity's browser while it runs, so it starts only when no other process has it open\./,
    );
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);
  });

  it("takes over the state file and socket a killed server left", async () => {
    const gone = bystander();
    gone.kill("SIGKILL");
    await waitFor(() => !alive(gone.pid!), 5000);
    mkdirSync(backgroundDir(ID, env), { recursive: true });
    writeFileSync(
      backgroundStatePath(ID, env),
      JSON.stringify({
        v: 1,
        pid: gone.pid,
        identity: ID,
        version: "0.0.0",
        startedAt: new Date().toISOString(),
        idleMs: 0,
        transport: "socket",
        socket: backgroundSocketPath(ID, env),
      }),
    );
    writeFileSync(backgroundSocketPath(ID, env), "");
    expect(backgroundStatus(ID, { env })).toBeUndefined();
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);
    writeFileSync(backgroundSocketPath(ID, env), "");
    const server = await startInProcess();
    expect(server.state.pid).toBe(process.pid);
    const s = await openBackgroundSession(ID, { env, start: false });
    expect((await s.callTool("turno_test_session")).isError ?? false).toBe(false);
    await s.end();
  });
});

describe("the background server as a program, through the client", () => {
  it("starts detached, is found by a second start, serves a tool call, and stops", async () => {
    const first = await startBackground(ID, { env, bin, args: ["--headless"] });
    expect(first.started).toBe(true);
    expect(first.state).toMatchObject({ identity: ID, transport: "socket" });
    expect(first.state.pid).not.toBe(process.pid);
    expect(alive(first.state.pid)).toBe(true);
    expect(mode(backgroundLogPath(ID, env))).toBe(0o600);

    const second = await startBackground(ID, { env, bin });
    expect(second).toEqual({ state: first.state, started: false });

    const s = await openBackgroundSession(ID, { env, start: false });
    const res = await s.callTool("browser_flows", {});
    expect(textOf(res)).toContain(`Identity "${ID}" has no saved flows yet`);
    await s.end();

    expect(await stopBackground(ID, { env })).toBe(true);
    expect(alive(first.state.pid)).toBe(false);
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);
    expect(existsSync(backgroundSocketPath(ID, env))).toBe(false);
    expect(await stopBackground(ID, { env })).toBe(false);
  });

  it("opens a session and starts the server on the way when it is not running", async () => {
    const s = await openBackgroundSession(ID, { env, owner: process.pid, start: { bin, args: ["--headless"] } });
    expect(alive(s.state.pid)).toBe(true);
    expect((await s.listTools()).map((t) => t.name)).toContain("browser_navigate");
    await s.close();
  });

  it("makes a stdio server of the identity refuse calls that need the browser, without launching one", async () => {
    const { state } = await startBackground(ID, { env, bin, args: ["--headless"] });
    const engine = failingEngine();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serve(await host([sessionTool()], engine), serverSide);
    const client = new Client({ name: "stdio-agent", version: "0.0.0" });
    await client.connect(clientSide);
    const res = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      `browser identity "${ID}" is served by its background server (pid ${state.pid}) since ${state.startedAt}, which owns the identity's browser while it runs. Stop it with \`turno-browser background stop ${ID}\` (or \`kill ${state.pid}\`; it closes its Chrome first), or wait: it exits after 15m without a request; then try again.`,
    );
    expect(engine.launches).toEqual([]);
    // A tool that needs no browser still answers.
    expect((await client.callTool({ name: "turno_test_session", arguments: {} })).isError ?? false).toBe(false);
    await client.close();
  });

  it("does not start while another process holds the identity's runtime lock, and says why", async () => {
    mkdirSync(join(stateRoot, "browser", "identities", ID), { recursive: true });
    writeFileSync(
      runtimeLockPath(ID, env),
      JSON.stringify({ nodePid: process.pid, holder: "mcp", startedAt: new Date().toISOString() }),
    );
    const start = startBackground(ID, { env, bin, args: ["--headless"] });
    await expect(start).rejects.toThrow(BackgroundError);
    await expect(start).rejects.toThrow(
      new RegExp(`browser identity "${ID}" is in use by turno-browser-mcp \\(pid ${process.pid}\\)`),
    );
    expect(backgroundStatus(ID, { env })).toBeUndefined();
  });

  it("exits after --background-idle without a request", async () => {
    const { state } = await startBackground(ID, { env, bin, args: ["--headless", "--background-idle", "1s"] });
    expect(state.idleMs).toBe(1000);
    expect(await waitFor(() => !alive(state.pid), 10_000)).toBe(true);
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);
    expect(readFileSync(backgroundLogPath(ID, env), "utf8")).toContain(
      `background server of "${ID}" stops: no request for 1s`,
    );
  });

  it("treats the state of a killed server as stale, and starts a new one", async () => {
    const { state } = await startBackground(ID, { env, bin, args: ["--headless"] });
    process.kill(state.pid, "SIGKILL");
    expect(await waitFor(() => !alive(state.pid), 5000)).toBe(true);
    expect(existsSync(backgroundStatePath(ID, env))).toBe(true);
    expect(backgroundStatus(ID, { env })).toBeUndefined();
    expect(existsSync(backgroundStatePath(ID, env))).toBe(false);

    const next = await startBackground(ID, { env, bin, args: ["--headless"] });
    expect(next.started).toBe(true);
    expect(next.state.pid).not.toBe(state.pid);
    const s = await openBackgroundSession(ID, { env, start: false });
    expect((await s.callTool("browser_flows", {})).isError ?? false).toBe(false);
    await s.end();
  });

  it("refuses --background without --identity", async () => {
    const child = spawn(process.execPath, [bin, "--background"], { env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let err = "";
    child.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
    });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    expect(code).toBe(2);
    expect(err).toContain("--background needs --identity <id>");
  });
});
