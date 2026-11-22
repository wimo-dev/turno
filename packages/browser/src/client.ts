import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, truncateSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ensurePrivateDir } from "turno-core/paths";
import { pidAlive } from "turno-core/process";
import { BackgroundError, OWNER_HEADER } from "./background.js";
import {
  type BackgroundState,
  backgroundDir,
  backgroundLogPath,
  liveBackground,
  readBackgroundState,
  removeBackgroundFiles,
} from "./background-state.js";
import { assertIdentityId } from "./ids.js";

/**
 * The client of an identity's background server (`background.ts`): start it when it is not
 * running, open or continue an MCP session on it, call tools, end the session, stop the server.
 * `turno-browser do` uses it when turno's gateway is not there.
 *
 * A session is the unit that keeps a tab: with `"sharing": "tabs"` each session has its own tabs,
 * with `"sharing": "session"` one session at a time holds the browser. To continue a session from
 * another process, save `id` and `protocolVersion` of an open one and pass them as `session`; a
 * session the server no longer knows (it restarted) is replaced by a new one (`resumed: false`).
 */

export { BackgroundError } from "./background.js";
export type { BackgroundState } from "./background-state.js";

export interface BackgroundClientOptions {
  env?: NodeJS.ProcessEnv;
}

export interface StartBackgroundOptions extends BackgroundClientOptions {
  /** More `turno-browser-mcp` flags for a server this call starts (`--headless`, `--background-idle 30m`). */
  args?: string[];
  /** How long to wait until the server is ready (default 30 seconds). */
  timeoutMs?: number;
  /** The `turno-browser-mcp` script to run (default: this install's). */
  bin?: string;
}

export interface StartedBackground {
  state: BackgroundState;
  /** False when it was already running. */
  started: boolean;
}

export interface OpenSessionOptions extends BackgroundClientOptions {
  /** A session to continue (`BackgroundSession.id` and `protocolVersion` of an earlier one). */
  session?: { id: string; protocolVersion?: string };
  /** The process the session belongs to: the server ends the session when it exits. */
  owner?: number;
  /** Start the server when it is not running (default true); options for that start. */
  start?: boolean | StartBackgroundOptions;
  /** The client name the server sees (default "turno-browser"). */
  clientName?: string;
}

export interface CallOptions {
  /** Default 120 seconds; progress from the server restarts it. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BackgroundSession {
  /** The session id (`Mcp-Session-Id`): what continues this session from another process. */
  readonly id: string;
  readonly protocolVersion: string | undefined;
  /** True when it continued the session asked for, false when it opened a new one. */
  readonly resumed: boolean;
  readonly state: BackgroundState;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<CallToolResult>;
  /** Ends the session on the server (its tabs and lease go) and disconnects. */
  end(): Promise<void>;
  /** Disconnects and keeps the session for the next process that continues it. */
  close(): Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** A log longer than this is cut when a server starts. */
const MAX_LOG_BYTES = 1024 * 1024;

function envOf(options?: BackgroundClientOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

/** The running background server of the identity, or undefined (a state left by a killed one is removed). */
export function backgroundStatus(id: string, options?: BackgroundClientOptions): BackgroundState | undefined {
  assertIdentityId(id);
  const state = liveBackground(id, envOf(options));
  return state?.transport ? state : undefined;
}

function defaultBin(): string {
  return fileURLToPath(new URL("./bin/mcp.js", import.meta.url));
}

function logTail(file: string, lines = 8): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the identity's background server unless it runs: detached from this process, its
 * output in `server.log` of its folder. Resolves when it is ready; rejects with what it wrote
 * when it exits first (the identity is in use, a bad flag) or after the timeout.
 */
export async function startBackground(id: string, options: StartBackgroundOptions = {}): Promise<StartedBackground> {
  assertIdentityId(id);
  const env = envOf(options);
  const running = backgroundStatus(id, options);
  if (running) return { state: running, started: false };
  // Files the server saves (snapshots, downloads) land in its private folder, not where it was started.
  const dir = ensurePrivateDir(backgroundDir(id, env), env);
  const logFile = backgroundLogPath(id, env);
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) truncateSync(logFile, 0);
  } catch {
    /* no log yet */
  }
  const fd = openSync(logFile, "a", 0o600);
  const offset = (() => {
    try {
      return statSync(logFile).size;
    } catch {
      return 0;
    }
  })();
  let exited: number | null | undefined;
  try {
    const child = spawn(
      process.execPath,
      [options.bin ?? defaultBin(), "--identity", id, "--background", ...(options.args ?? [])],
      // windowsHide: on Windows a detached child gets a console window of its own otherwise.
      { detached: true, stdio: ["ignore", fd, fd], env, cwd: dir, windowsHide: true },
    );
    child.once("exit", (code, signal) => {
      exited = code ?? (signal ? -1 : null);
    });
    child.once("error", () => {
      exited = -1;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  for (;;) {
    // Ready: this call's server, or one another call started at the same time.
    const state = backgroundStatus(id, options);
    if (state) return { state, started: true };
    if (exited !== undefined) {
      const said = (() => {
        try {
          return readFileSync(logFile, "utf8").slice(offset).trim();
        } catch {
          return "";
        }
      })();
      throw new BackgroundError(
        said
          ? said.replace(/^turno-browser-mcp: /gm, "")
          : `the background server of "${id}" exited at start (code ${exited}); see ${logFile}`,
      );
    }
    if (Date.now() > deadline)
      throw new BackgroundError(
        `the background server of "${id}" was not ready in time; see ${logFile}${logTail(logFile) ? `:\n${logTail(logFile)}` : ""}`,
      );
    await sleep(50);
  }
}

/**
 * Asks the server to stop over its own transport (`POST /shutdown`). Windows has no SIGTERM:
 * `process.kill` there ends the process at once, before it closes Chrome.
 */
async function requestShutdown(state: BackgroundState): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(5000);
    const res =
      state.transport === "socket"
        ? await socketFetch(state.socket!)("http://localhost/shutdown", { method: "POST", signal })
        : await fetch(`http://127.0.0.1:${state.port}/shutdown`, {
            method: "POST",
            signal,
            headers: { Authorization: `Bearer ${readFileSync(state.tokenFile!, "utf8").trim()}` },
          });
    await res.body?.cancel();
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * Stops the identity's background server (SIGTERM, on Windows a `POST /shutdown`: it closes its
 * sessions and Chrome, then exits). Resolves true when one ran, false when none did.
 */
export async function stopBackground(
  id: string,
  options: BackgroundClientOptions & { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  assertIdentityId(id);
  const env = envOf(options);
  const state = liveBackground(id, env);
  if (!state) return false;
  const asked = (options.platform ?? process.platform) === "win32" && state.transport && (await requestShutdown(state));
  if (!asked) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      /* exited meanwhile */
    }
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (pidAlive(state.pid) && Date.now() < deadline) await sleep(50);
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL"); // its Chrome is swept by the next start
    } catch {
      /* gone */
    }
  }
  if (readBackgroundState(id, env)?.pid === state.pid && !pidAlive(state.pid)) removeBackgroundFiles(id, env);
  return true;
}

/** A fetch over the server's Unix socket. */
function socketFetch(socketPath: string): FetchLike {
  return (url, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(url);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const req = httpRequest(
        { socketPath, path: `${target.pathname}${target.search}`, method: init.method ?? "GET", headers },
        (res) => {
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const v of value) out.append(key, v);
            else if (value !== undefined) out.set(key, value);
          }
          const status = res.statusCode ?? 500;
          const empty = status === 204 || status === 304 || init.method === "HEAD";
          if (empty) res.resume();
          resolve(
            new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              statusText: res.statusMessage ?? "",
              headers: out,
            }),
          );
        },
      );
      const signal = init.signal;
      const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      req.once("error", reject);
      if (typeof init.body === "string" || init.body instanceof Uint8Array) req.end(init.body);
      else req.end();
    });
}

function transportFor(
  state: BackgroundState,
  owner: number | undefined,
  session?: { id: string; protocolVersion?: string },
): StreamableHTTPClientTransport {
  const headers: Record<string, string> = owner !== undefined ? { [OWNER_HEADER]: String(owner) } : {};
  let url: URL;
  let fetch: FetchLike | undefined;
  if (state.transport === "socket") {
    url = new URL("http://localhost/mcp");
    fetch = socketFetch(state.socket!);
  } else {
    url = new URL(`http://127.0.0.1:${state.port}/mcp`);
    headers.Authorization = `Bearer ${readFileSync(state.tokenFile!, "utf8").trim()}`;
  }
  const transport = new StreamableHTTPClientTransport(url, {
    ...(fetch ? { fetch } : {}),
    ...(session ? { sessionId: session.id } : {}),
    requestInit: { headers },
  });
  if (session?.protocolVersion) transport.setProtocolVersion(session.protocolVersion);
  return transport;
}

function gone(err: unknown): boolean {
  return (
    (err instanceof StreamableHTTPError && err.code === 404) ||
    /session not found/i.test(String((err as Error)?.message ?? ""))
  );
}

function unreachable(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ""} ${String((err as { cause?: unknown })?.cause ?? "")}`;
  return /ECONNREFUSED|ENOENT|ECONNRESET|fetch failed|socket hang up/i.test(text);
}

async function connect(
  state: BackgroundState,
  options: OpenSessionOptions,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport; resumed: boolean }> {
  const name = options.clientName ?? "turno-browser";
  if (options.session) {
    const transport = transportFor(state, options.owner, options.session);
    const client = new Client({ name, version: state.version }, { capabilities: {} });
    await client.connect(transport); // a session id set: no initialize, it continues
    try {
      await client.ping();
      return { client, transport, resumed: true };
    } catch (err) {
      await client.close().catch(() => {});
      if (!gone(err)) throw err;
    }
  }
  const transport = transportFor(state, options.owner);
  const client = new Client({ name, version: state.version }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, resumed: false };
}

/**
 * Opens a session on the identity's background server, or continues `options.session`,
 * starting the server first unless `start` is false.
 */
export async function openBackgroundSession(id: string, options: OpenSessionOptions = {}): Promise<BackgroundSession> {
  assertIdentityId(id);
  const startOptions: StartBackgroundOptions | undefined =
    options.start === false
      ? undefined
      : { ...(typeof options.start === "object" ? options.start : {}), ...(options.env ? { env: options.env } : {}) };
  const find = async (): Promise<BackgroundState> => {
    if (startOptions) return (await startBackground(id, startOptions)).state;
    const state = backgroundStatus(id, options);
    if (!state) throw new BackgroundError(`the background server of browser identity "${id}" is not running`);
    return state;
  };
  let state = await find();
  let conn: Awaited<ReturnType<typeof connect>>;
  try {
    conn = await connect(state, options);
  } catch (err) {
    if (!unreachable(err))
      throw new BackgroundError(`the background server of "${id}" refused the session: ${(err as Error).message}`);
    // It exited between the status and the connection (its idle limit): once more, from the start.
    await sleep(100);
    state = await find();
    conn = await connect(state, options).catch((again: unknown) => {
      throw new BackgroundError(`cannot reach the background server of "${id}": ${(again as Error).message}`);
    });
  }
  const { client, transport, resumed } = conn;
  const sessionId = transport.sessionId;
  if (!sessionId) {
    await client.close().catch(() => {});
    throw new BackgroundError(`the background server of "${id}" gave no session id`);
  }
  return {
    id: sessionId,
    get protocolVersion() {
      return transport.protocolVersion;
    },
    resumed,
    state,
    async listTools() {
      return (await client.listTools()).tools;
    },
    async callTool(name, args = {}, call = {}) {
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: call.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(call.signal ? { signal: call.signal } : {}),
      })) as CallToolResult;
    },
    async end() {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
