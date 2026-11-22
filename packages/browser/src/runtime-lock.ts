import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import { pidAlive } from "turno-core/process";
import { IdentityError, identityStateDir } from "./ids.js";
import { names } from "./names.js";

/**
 * The runtime lock of an identity: which process drives its Chrome right now.
 * `<state>/browser/identities/<id>/lock.json`, mode 600:
 *
 *     { "nodePid": 123, "chromePid": 456, "pgid": 456, "holder": "mcp", "startedAt": "..." }
 *
 * The host takes it just before it launches Chrome for an identity and gives it back when that
 * Chrome closes (idle limit, `browser_close`, the session ending) or the process exits;
 * `turno browser login` holds it while its window is open. Chrome's own `SingletonLock` only
 * says that some process holds the profile; this lock says which one and how to stop it, so a
 * second user of the identity gets that instead of "Browser is already in use".
 *
 * The file is created with O_EXCL, so two processes never both take it. A lock whose `nodePid`
 * is gone is stale and is taken over.
 */

export interface RuntimeLock {
  /** The Node process that holds the identity (turno-browser-mcp, or turno for a login). */
  nodePid: number;
  /** The Chrome browser process, once it runs. */
  chromePid?: number;
  /** Chrome's process group (Playwright makes Chrome its leader). */
  pgid?: number;
  /** `export` and `import`: `turno browser export` and `import`, for a few seconds. */
  holder: "mcp" | "login" | "export" | "import";
  startedAt: string;
}

export interface HeldLock {
  readonly id: string;
  /** Adds what is known once Chrome runs. No-op when the lock is no longer this process's. */
  update(fields: { chromePid?: number; pgid?: number }): void;
  /** Removes the lock if it is still this process's. Safe to call twice. */
  release(): void;
}

export class IdentityInUseError extends IdentityError {
  constructor(
    message: string,
    readonly lock: RuntimeLock,
  ) {
    super(message);
    this.name = "IdentityInUseError";
  }
}

export function runtimeLockPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "lock.json");
}

function isLock(v: unknown): v is RuntimeLock {
  const l = v as Partial<RuntimeLock> | null;
  const pid = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  return (
    typeof l === "object" &&
    l !== null &&
    pid(l.nodePid) &&
    (l.chromePid === undefined || pid(l.chromePid)) &&
    (l.pgid === undefined || pid(l.pgid)) &&
    (l.holder === "mcp" || l.holder === "login" || l.holder === "export" || l.holder === "import") &&
    typeof l.startedAt === "string"
  );
}

/** The lock file's content, undefined when there is none or it is not a lock. */
export function readRuntimeLock(id: string, env: NodeJS.ProcessEnv = process.env): RuntimeLock | undefined {
  try {
    const v = JSON.parse(readFileSync(runtimeLockPath(id, env), "utf8")) as unknown;
    return isLock(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** True while the lock's Node process lives. */
export function runtimeLockAlive(lock: RuntimeLock): boolean {
  return pidAlive(lock.nodePid);
}

/**
 * The command that stops a turno-browser-mcp, for messages: `kill <pid>` (SIGTERM: it closes its
 * Chrome first), or on Windows, which has no SIGTERM, `taskkill` of its tree (its Chrome with it).
 */
export function stopCommand(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`;
}

/** Who holds the identity and how to get it back, for errors and `turno browser doctor`. */
export function inUseMessage(id: string, lock: RuntimeLock, platform: NodeJS.Platform = process.platform): string {
  const pids = `pid ${lock.nodePid}${lock.chromePid ? `, Chrome pid ${lock.chromePid}` : ""}`;
  if (lock.holder === "login") {
    return `browser identity "${id}" is in use by ${names().browser} login (${pids}) since ${lock.startedAt}. Close that Chrome window to finish the login, then try again.`;
  }
  if (lock.holder === "export" || lock.holder === "import") {
    return `browser identity "${id}" is in use by ${names().browser} ${lock.holder} (${pids}) since ${lock.startedAt}. Wait for it to finish, then try again.`;
  }
  return (
    `browser identity "${id}" is in use by turno-browser-mcp (${pids}) since ${lock.startedAt}. ` +
    "One identity drives one Chrome at a time: wait for that session to end (mcpd stops the server after its lease or idle time), " +
    `or stop it now with \`${stopCommand(lock.nodePid, platform)}\`, ${platform === "win32" ? "which ends its Chrome with it" : "which closes its Chrome first"}.`
  );
}

function writeAtomic(file: string, lock: RuntimeLock): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, file);
}

/** Locks this process holds, released on exit (sync: an exit handler cannot wait). */
const held = new Map<string, () => void>();
/** The newest handle per lock file, so an older handle of a re-taken lock never removes it. */
const newest = new Map<string, symbol>();
let exitHook = false;

export interface AcquireOptions {
  holder: RuntimeLock["holder"];
  /** The process that holds it (default: this one). Tests pass another. */
  nodePid?: number;
  now?: Date;
}

/**
 * Takes the identity's runtime lock, or throws `IdentityInUseError` naming the live holder. The
 * same process may take it again (a relaunch after the idle close).
 */
export function acquireRuntimeLock(id: string, env: NodeJS.ProcessEnv = process.env, opts: AcquireOptions): HeldLock {
  const file = runtimeLockPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const nodePid = opts.nodePid ?? process.pid;
  let lock: RuntimeLock = { nodePid, holder: opts.holder, startedAt: (opts.now ?? new Date()).toISOString() };
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw err;
    }
    const current = readRuntimeLock(id, env);
    if (current && current.nodePid !== nodePid && runtimeLockAlive(current))
      throw new IdentityInUseError(inUseMessage(id, current), current);
    // Stale, unreadable, or ours already: replace it.
    rmSync(file, { force: true });
  }
  const token = Symbol(file);
  newest.set(file, token);
  const mine = () => newest.get(file) === token && readRuntimeLock(id, env)?.nodePid === nodePid;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (held.get(file) === release) held.delete(file);
    if (mine()) rmSync(file, { force: true });
    if (newest.get(file) === token) newest.delete(file);
  };
  if (nodePid === process.pid) {
    held.set(file, release);
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        for (const r of [...held.values()]) r();
      });
    }
  }
  return {
    id,
    update(fields) {
      if (released || !mine()) return;
      lock = { ...lock, ...fields };
      // Key order as documented: who, then what it runs, then since when.
      writeAtomic(file, {
        nodePid: lock.nodePid,
        ...(lock.chromePid !== undefined ? { chromePid: lock.chromePid } : {}),
        ...(lock.pgid !== undefined ? { pgid: lock.pgid } : {}),
        holder: lock.holder,
        startedAt: lock.startedAt,
      });
    },
    release,
  };
}
