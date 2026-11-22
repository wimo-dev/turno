import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, readProcTable } from "turno-core/process";
import type { IdentityRef } from "./engine.js";
import { IdentityError, identityStateDir } from "./ids.js";
import { stopCommand } from "./runtime-lock.js";

/**
 * Where the background server of an identity (`turno-browser-mcp --identity <id> --background`)
 * says it runs, and the rule it keeps with the other servers of that identity.
 *
 * Everything lives in `<state>/browser/identities/<id>/background/`, a folder only the user can
 * enter (0700): `server.json` (pid, address, version, mode 600), the Unix socket `sock`, or when
 * no socket can be used, `token` (the per-server bearer token of the loopback port, mode 600),
 * and `server.log`, where a server started by the client module writes its output. On Windows
 * the socket is a named pipe (`backgroundSocketPath`), which lives in the system's pipe
 * namespace instead of the folder.
 *
 * The rule: while a background server runs, it is the one owner of the identity's browser. A
 * stdio server of the same identity refuses every call that would launch the browser, with a
 * message that names the background server and how to stop it, and a background server does not
 * start while another process holds the identity's runtime lock (its Chrome is open). Calls are
 * never forwarded from one server to the other: either way there is one Chrome, never a wait.
 */

export interface BackgroundState {
  v: 1;
  pid: number;
  identity: string;
  /** turno-browser's version. */
  version: string;
  startedAt: string;
  /** Exits after this long without a request; 0 never. */
  idleMs: number;
  /** Absent while the server starts; then where it listens. */
  transport?: "socket" | "tcp";
  /** `transport: "socket"`: the Unix socket. */
  socket?: string;
  /** `transport: "tcp"`: the loopback port, and the file that holds its bearer token. */
  port?: number;
  tokenFile?: string;
}

export function backgroundDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "background");
}

export function backgroundStatePath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(backgroundDir(id, env), "server.json");
}

/** True for a Windows named pipe path (`\\.\pipe\...`), which is not a file. */
export function isPipePath(path: string): boolean {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path);
}

/**
 * Where the background server listens: the Unix socket `sock` in its private folder, or on
 * Windows the named pipe `\\.\pipe\turno-browser-<id>-<hash>`. The hash is of the folder (in
 * lower case, as Windows paths compare), so two users, or two TURNO_STATE_DIRs, never share a
 * pipe. A pipe name may be up to 256 characters; an identity id is at most 64.
 */
export function backgroundSocketPath(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return join(backgroundDir(id, env), "sock");
  const hash = createHash("sha256").update(backgroundDir(id, env).toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\turno-browser-${id}-${hash}`;
}

export function backgroundTokenPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(backgroundDir(id, env), "token");
}

export function backgroundLogPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(backgroundDir(id, env), "server.log");
}

function isState(v: unknown, id: string): v is BackgroundState {
  const s = v as Partial<BackgroundState> | null;
  if (typeof s !== "object" || s === null || s.v !== 1 || s.identity !== id) return false;
  if (typeof s.pid !== "number" || !Number.isSafeInteger(s.pid) || s.pid <= 0) return false;
  if (typeof s.startedAt !== "string" || typeof s.version !== "string" || typeof s.idleMs !== "number") return false;
  if (s.transport === "socket") return typeof s.socket === "string";
  if (s.transport === "tcp") return typeof s.port === "number" && typeof s.tokenFile === "string";
  return s.transport === undefined;
}

/** The state file's content, undefined when there is none or it is not one. */
export function readBackgroundState(id: string, env: NodeJS.ProcessEnv = process.env): BackgroundState | undefined {
  try {
    const v = JSON.parse(readFileSync(backgroundStatePath(id, env), "utf8")) as unknown;
    return isState(v, id) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True while the state's process runs and, when the process table can be read, is a background
 * server (a pid the system gave to another program after a kill is not one; not checked on
 * Windows).
 */
export function backgroundAlive(state: BackgroundState, platform: NodeJS.Platform = process.platform): boolean {
  if (state.pid === process.pid) return true;
  if (!pidAlive(state.pid)) return false;
  // Windows reads command lines through PowerShell, about a second per call: too slow for a
  // check that clients make in a loop, so a live pid is taken at its word there.
  if (platform === "win32") return true;
  const command = readProcTable()?.get(state.pid)?.command;
  return command === undefined || command.includes("--background");
}

/** Removes what a background server that is gone left behind (state, socket, token). A pipe goes with its server. */
export function removeBackgroundFiles(id: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const file of [backgroundStatePath(id, env), backgroundSocketPath(id, env), backgroundTokenPath(id, env)])
    if (!isPipePath(file)) rmSync(file, { force: true });
}

/** The running background server of the identity, undefined when none runs (a stale state is removed). */
export function liveBackground(id: string, env: NodeJS.ProcessEnv = process.env): BackgroundState | undefined {
  const state = readBackgroundState(id, env);
  if (!state) return undefined;
  if (backgroundAlive(state)) return state;
  if (readBackgroundState(id, env)?.pid === state.pid) removeBackgroundFiles(id, env);
  return undefined;
}

function duration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Why a server other than the background one may not launch the identity's browser now. */
function backgroundOwnsMessage(id: string, state: BackgroundState): string {
  const idle = state.idleMs > 0 ? `, or wait: it exits after ${duration(state.idleMs)} without a request` : "";
  return (
    `browser identity "${id}" is served by its background server (pid ${state.pid}) since ${state.startedAt}, ` +
    `which owns the identity's browser while it runs. Stop it with \`turno-browser background stop ${id}\` ` +
    `(or \`${stopCommand(state.pid)}\`; ${process.platform === "win32" ? "that ends its Chrome with it" : "it closes its Chrome first"})${idle}; ` +
    "then try again."
  );
}

/**
 * Throws when another process runs the identity's background server: called before a server
 * launches the identity's browser. The background server itself passes.
 */
export function refuseWhileBackground(identity: IdentityRef): void {
  const state = readBackgroundState(identity.id, identity.env);
  if (!state || state.pid === process.pid || !backgroundAlive(state)) return;
  throw new IdentityError(backgroundOwnsMessage(identity.id, state));
}
