import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type JSONRPCMessage,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { pidAlive } from "turno-core/process";
import {
  type BackgroundState,
  backgroundAlive,
  backgroundDir,
  backgroundSocketPath,
  backgroundStatePath,
  backgroundTokenPath,
  readBackgroundState,
} from "./background-state.js";
import type { IdentityRef } from "./engine.js";
import { type Host, type SharedHost, shareHost } from "./host.js";
import { touchLastUsed } from "./last-used.js";
import { inUseMessage, readRuntimeLock, runtimeLockAlive } from "./runtime-lock.js";
import { SESSION_META_KEY } from "./session.js";
import type { SharingMode } from "./sharing.js";
import { parseDuration } from "./units.js";

/**
 * The background server of an identity: `turno-browser-mcp --identity <id> --background`.
 *
 * It serves the identity over MCP streamable HTTP, for shell use without turno's gateway
 * (`client.ts` starts it, connects and calls tools). Only the user reaches it: a Unix socket in
 * a folder only the user can enter, or, where a socket cannot be used (Windows, or a path longer
 * than the system allows), a loopback port that asks for a random per-server bearer token kept
 * in a file only the user can read. It writes `server.json` (pid, address, version) when it is
 * ready and removes it when it exits.
 *
 * Every connection is one client session, and they all drive the identity's one browser
 * (`shareHost`), as mcpd's sessions share one stdio server: with `"sharing": "tabs"` each session
 * has its own tabs; with `"sharing": "session"` one session at a time holds the browser (a lease
 * that ends with the session, when its owner process exits, or after `leaseMs` without a call),
 * and another session's calls get an error that says so. A session continues across connections
 * and processes: a client that sends its `Mcp-Session-Id` again keeps its session and its tab.
 *
 * It exits after `idleMs` without a request (default 15 minutes), on SIGTERM, SIGINT and SIGHUP,
 * closing Chrome first. Coexistence with the stdio servers of the identity: `background-state.ts`.
 */

/** Exits after this long without a request, unless the flag or TURNO_BROWSER_BACKGROUND_IDLE says otherwise. */
export const DEFAULT_BACKGROUND_IDLE_MS = 15 * 60_000;

/** With `"sharing": "session"`: how long an idle session keeps the browser (mcpd's default lease). */
const DEFAULT_LEASE_MS = 5 * 60_000;

/** The flag that turns a server into the background server, and its idle limit. */
const BACKGROUND_FLAG = "--background";
const BACKGROUND_IDLE_FLAG = "--background-idle";
const BACKGROUND_IDLE_ENV = "TURNO_BROWSER_BACKGROUND_IDLE";

/** The request header a client names the process its session belongs to with (as mcpd's). */
export const OWNER_HEADER = "x-turno-pid";

/** Longest Unix socket path (macOS allows 103 bytes, Linux 107). */
const MAX_SOCKET_PATH = 103;

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

export class BackgroundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundError";
  }
}

export interface BackgroundFlags {
  /** `--background`. */
  background: boolean;
  /** `--background-idle <duration>` or TURNO_BROWSER_BACKGROUND_IDLE, in ms; 0 never. */
  idleMs: number;
  rest: string[];
}

/** Removes `--background` and `--background-idle <duration>` from args and checks them. */
export function extractBackground(args: string[], env: NodeJS.ProcessEnv = process.env): BackgroundFlags {
  const rest: string[] = [];
  let background = false;
  let idle: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === BACKGROUND_FLAG) background = true;
    else if (a.startsWith(`${BACKGROUND_FLAG}=`)) throw new Error(`${BACKGROUND_FLAG} takes no value`);
    else if (a === BACKGROUND_IDLE_FLAG) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${BACKGROUND_IDLE_FLAG} needs a duration`);
      idle = v;
      i++;
    } else if (a.startsWith(`${BACKGROUND_IDLE_FLAG}=`)) idle = a.slice(BACKGROUND_IDLE_FLAG.length + 1);
    else rest.push(a);
  }
  if (idle !== undefined && !background)
    throw new Error(`${BACKGROUND_IDLE_FLAG} applies only with ${BACKGROUND_FLAG}`);
  const source = idle ?? env[BACKGROUND_IDLE_ENV];
  let idleMs = DEFAULT_BACKGROUND_IDLE_MS;
  if (source !== undefined && source !== "") {
    const ms = parseDuration(source);
    if (ms === undefined)
      throw new Error(
        `${idle !== undefined ? BACKGROUND_IDLE_FLAG : BACKGROUND_IDLE_ENV} must be a duration like "15m", "90s" or "0" (never), not "${source}"`,
      );
    idleMs = ms;
  }
  if (background) {
    const http = rest.find((a) => ["--port", "--host"].some((f) => a === f || a.startsWith(`${f}=`)));
    if (http) throw new Error(`${BACKGROUND_FLAG} picks its own address: drop ${http.split("=")[0]}`);
  }
  return { background, idleMs, rest };
}

export interface BackgroundOptions {
  identity: IdentityRef;
  /** Exit after this long without a request; 0 never. */
  idleMs: number;
  /** The identity's sharing mode now (the flag, else identity.json, else "session"). */
  sharing: () => SharingMode;
  /** "auto" (default): a Unix socket where it can, else loopback with a token. */
  transport?: "auto" | "socket" | "tcp";
  /** With `"sharing": "session"`, how long an idle session keeps the browser. */
  leaseMs?: number;
  /** How often sessions whose owner exited are ended and the idle limit is checked. */
  sweepMs?: number;
  /** Runs once the server closed; default: exit the process. */
  onClosed?: (reason: string) => void;
  /** Answer SIGTERM, SIGINT and SIGHUP (default true; tests in process pass false). */
  signals?: boolean;
  log?: (line: string) => void;
}

export interface BackgroundServer {
  state: BackgroundState;
  /** Closes every session and the browser, removes the state file. */
  close(reason?: string): Promise<void>;
  /** Resolves once closed. */
  closed: Promise<void>;
}

interface Session {
  /** The `Mcp-Session-Id`. */
  sid: string;
  /** The client session the host sees in `_meta` (not the Mcp-Session-Id, which is a key to the session). */
  key: string;
  transport: StreamableHTTPServerTransport;
  owner?: number;
  lastSeen: number;
  inflight: Set<string | number>;
  ended: boolean;
}

function writeState(file: string, state: BackgroundState, flag: "w" | "wx"): void {
  if (flag === "wx") {
    writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** The private folder of the identity's background server, 0700 even when it existed. */
function privateDir(id: string, env: NodeJS.ProcessEnv): string {
  const dir = backgroundDir(id, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Takes the identity's background slot: `server.json` is created exclusively, so two servers
 * started at once never both run. Refuses while another background server runs, or while
 * another process holds the identity's runtime lock (its Chrome is open).
 */
function claim(id: string, env: NodeJS.ProcessEnv, idleMs: number): BackgroundState {
  privateDir(id, env);
  const file = backgroundStatePath(id, env);
  const state: BackgroundState = {
    v: 1,
    pid: process.pid,
    identity: id,
    version: PACKAGE_VERSION,
    startedAt: new Date().toISOString(),
    idleMs,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      writeState(file, state, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw err;
    }
    const other = readBackgroundState(id, env);
    if (other && other.pid !== process.pid && backgroundAlive(other))
      throw new BackgroundError(
        `the background server of browser identity "${id}" already runs (pid ${other.pid}, since ${other.startedAt})`,
      );
    rmSync(file, { force: true });
  }
  const lock = readRuntimeLock(id, env);
  if (lock && lock.nodePid !== process.pid && runtimeLockAlive(lock)) {
    rmSync(file, { force: true });
    throw new BackgroundError(
      `${inUseMessage(id, lock)} The background server owns the identity's browser while it runs, so it starts only when no other process has it open.`,
    );
  }
  return state;
}

function socketUsable(path: string, transport: BackgroundOptions["transport"]): boolean {
  if (transport === "tcp") return false;
  const fits = process.platform !== "win32" && Buffer.byteLength(path) <= MAX_SOCKET_PATH;
  if (transport === "socket" && !fits)
    throw new BackgroundError(`cannot use a Unix socket at ${path} on this system (path too long or no sockets)`);
  return fits;
}

function listen(server: HttpServer, target: string | { port: 0; host: "127.0.0.1" }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve();
    };
    if (typeof target === "string") server.listen(target, done);
    else server.listen(target.port, target.host, done);
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new BackgroundError("request body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(res: ServerResponse, status: number, message: string, id: unknown = null): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id }));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false });
}

function duration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Serves `host` as the identity's background server until it closes. */
export async function serveBackground(host: Host, options: BackgroundOptions): Promise<BackgroundServer> {
  const { identity, idleMs } = options;
  const { id, env } = identity;
  const log = options.log ?? ((line: string) => process.stderr.write(`turno-browser-mcp: ${line}\n`));
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const state = claim(id, env, idleMs);
  const stateFile = backgroundStatePath(id, env);
  const socketPath = backgroundSocketPath(id, env);
  const tokenFile = backgroundTokenPath(id, env);
  const useSocket = (() => {
    try {
      return socketUsable(socketPath, options.transport);
    } catch (error) {
      rmSync(stateFile, { force: true });
      throw error;
    }
  })();
  const token = useSocket ? undefined : randomBytes(32).toString("base64url");

  const shared: SharedHost = shareHost(host);
  const sessions = new Map<string, Session>();
  let holder: { session: Session; since: number } | undefined;
  let lastActivity = Date.now();
  let active = 0;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  // The files are this server's only while server.json names it.
  const ours = () => readBackgroundState(id, env)?.pid === process.pid;
  const removeFiles = () => {
    if (!ours()) return;
    rmSync(socketPath, { force: true });
    rmSync(tokenFile, { force: true });
    rmSync(stateFile, { force: true });
  };
  process.on("exit", removeFiles);

  const endSession = async (s: Session) => {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s.sid);
    if (holder?.session === s) holder = undefined;
    await shared.endSession(s.key).catch(() => {});
  };

  /** With `"sharing": "session"`, why `s` may not call now, or undefined when it holds the browser. */
  const leaseRefusal = (s: Session): string | undefined => {
    if (options.sharing() === "tabs") return undefined;
    if (holder) {
      const h = holder.session;
      const gone = h.ended || (h.owner !== undefined && !pidAlive(h.owner));
      const idle = h.inflight.size === 0 && Date.now() - h.lastSeen > leaseMs;
      if (gone || idle) holder = undefined;
    }
    if (holder && holder.session !== s) {
      const h = holder.session;
      return (
        `browser identity "${id}" is in use by another session of its background server` +
        `${h.owner !== undefined ? ` (owner pid ${h.owner})` : ""} since ${clock(holder.since)}. ` +
        `Try again when that session ends or after ${duration(leaseMs)} without a call from it, ` +
        `or set "sharing": "tabs" in the identity's settings so that sessions share the browser in separate tabs.`
      );
    }
    if (!holder) holder = { session: s, since: Date.now() };
    return undefined;
  };

  /**
   * Connects a new session: its calls carry its own client session in `_meta` (whatever the
   * client put there), pass the lease, and count as in flight until their response leaves.
   */
  const openSession = async (owner: number | undefined): Promise<StreamableHTTPServerTransport> => {
    let session: Session | undefined;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        session = {
          sid,
          key: randomUUID(),
          transport,
          ...(owner !== undefined ? { owner } : {}),
          lastSeen: Date.now(),
          inflight: new Set(),
          ended: false,
        };
        sessions.set(sid, session);
      },
      onsessionclosed: async () => {
        if (session) await endSession(session);
      },
    });
    await shared.connect(transport);
    const deliver = transport.onmessage!;
    transport.onmessage = (message, extra) => {
      const s = session;
      if (s && isJSONRPCRequest(message) && message.method === "tools/call") {
        s.lastSeen = Date.now();
        const refusal = leaseRefusal(s);
        if (refusal) {
          const response: JSONRPCMessage = {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: `### Error\n${refusal}` }], isError: true },
          };
          void transport.send(response).catch(() => {});
          return;
        }
        s.inflight.add(message.id);
        touchLastUsed(id, env);
        const params = (message.params ?? {}) as { _meta?: Record<string, unknown> };
        message.params = { ...params, _meta: { ...(params._meta ?? {}), [SESSION_META_KEY]: s.key } };
      }
      deliver(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, opts) => {
      const s = session;
      if (s && (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
        if (s.inflight.delete(message.id as string | number)) s.lastSeen = Date.now();
      }
      return await send(message, opts);
    };
    return transport;
  };

  const authorized = (req: IncomingMessage, port: number): boolean => {
    if (!token) return true;
    // The Host check keeps a web page that rebinds a name to 127.0.0.1 out, with the token.
    const hostHeader = req.headers.host ?? "";
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return false;
    const auth = req.headers.authorization ?? "";
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, port: number): Promise<void> => {
    if (!authorized(req, port)) {
      reply(res, 401, "unauthorized");
      return;
    }
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/mcp") {
      reply(res, 404, "not found");
      return;
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const s = sessions.get(sid);
      if (!s) {
        reply(res, 404, "Session not found");
        return;
      }
      s.lastSeen = Date.now();
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST") {
      reply(res, 400, "Bad Request: no session (Mcp-Session-Id)");
      return;
    }
    const body = await readBody(req);
    if (!isInitializeRequest(body)) {
      reply(res, 400, "Bad Request: initialize first, or send the Mcp-Session-Id of a session");
      return;
    }
    const raw = req.headers[OWNER_HEADER];
    const owner = typeof raw === "string" && /^\d{1,10}$/.test(raw) && Number(raw) > 1 ? Number(raw) : undefined;
    const transport = await openSession(owner);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    // A request in flight keeps the server up; an open event stream (GET) does not.
    const counts = req.method !== "GET";
    lastActivity = Date.now();
    if (counts) active++;
    res.once("close", () => {
      lastActivity = Date.now();
      if (counts) active--;
    });
    const port = (http.address() as AddressInfo | null)?.port ?? 0;
    handle(req, res, port).catch((error) => {
      if (error instanceof SyntaxError) reply(res, 400, "Parse error");
      else reply(res, 500, (error as Error).message);
    });
  });
  // A tool call may take longer than Node's default request timeout of 5 minutes.
  http.requestTimeout = 0;

  try {
    if (useSocket) {
      rmSync(socketPath, { force: true });
      await listen(http, socketPath);
      chmodSync(socketPath, 0o600);
    } else {
      await listen(http, { port: 0, host: "127.0.0.1" });
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
    }
  } catch (error) {
    removeFiles();
    throw error;
  }
  const ready: BackgroundState = useSocket
    ? { ...state, transport: "socket", socket: socketPath }
    : { ...state, transport: "tcp", port: (http.address() as AddressInfo).port, tokenFile };
  writeState(stateFile, ready, "w");

  const close = (reason = "closed"): Promise<void> => {
    closing ??= (async () => {
      log(`background server of "${id}" stops: ${reason}`);
      clearInterval(sweep);
      http.close();
      http.closeAllConnections();
      for (const s of [...sessions.values()]) {
        await endSession(s);
        await s.transport.close().catch(() => {});
      }
      await shared.dispose().catch(() => {});
      removeFiles();
      process.off("exit", removeFiles);
      resolveClosed();
      (options.onClosed ?? (() => process.exit(0)))(reason);
    })();
    return closing;
  };

  const sweepMs = options.sweepMs ?? Math.min(15_000, Math.max(100, Math.floor((idleMs || 60_000) / 4)));
  const sweep = setInterval(() => {
    for (const s of [...sessions.values()])
      if (s.owner !== undefined && s.inflight.size === 0 && !pidAlive(s.owner)) {
        void endSession(s);
        void s.transport.close().catch(() => {});
      }
    if (!ours()) void close("its state file was replaced or removed");
    else if (idleMs > 0 && active === 0 && Date.now() - lastActivity >= idleMs)
      void close(`no request for ${duration(idleMs)}`);
  }, sweepMs);

  if (options.signals !== false)
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => void close(signal));

  log(
    `background server of "${id}" ready on ${useSocket ? socketPath : `127.0.0.1:${ready.port} (token in ${tokenFile})`}` +
      `${idleMs > 0 ? `; exits after ${duration(idleMs)} without a request` : ""}`,
  );
  return { state: ready, close, closed };
}

/** The identity's sharing mode for the lease: `--sharing`, else identity.json, else "session". */
export function sharingOf(flag: SharingMode | undefined, read: () => SharingMode | undefined): () => SharingMode {
  return () => {
    if (flag) return flag;
    try {
      return read() ?? "session";
    } catch {
      return "session"; // a bad identity.json: the launch reports it
    }
  };
}
