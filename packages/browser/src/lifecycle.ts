import { readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type ProcTable,
  killTree,
  parentIsInit,
  pidAlive as processAlive,
  readProcTable,
  signalProcess as sendSignal,
} from "turno-core/process";
import { parseSingletonLock, windowsProfileLocked } from "./identities.js";

/**
 * The life of the Chrome behind one profile.
 *
 * Playwright launches Chrome as the leader of its own process group and only kills that group
 * from exit handlers, which never run when the server is killed with SIGKILL. So
 * turno-browser-mcp
 *
 * - sweeps a Chrome that an earlier run left behind for the same profile before it starts
 *   (`sweepOrphan`): the profile's `SingletonLock` names the PID, the process table confirms it
 *   is a Chrome browser process for exactly that `--user-data-dir`, and its parent must be gone
 *   (reparented to init), so a Chrome another live process drives is never touched;
 * - puts a deadline on its own shutdown (`installShutdownGuard`): when stdin closes or a
 *   signal arrives the program closes the browser gracefully, and if that has not finished in
 *   time Chrome gets SIGTERM and then the whole group SIGKILL, inside the 4 seconds the MCP SDK
 *   gives a server before it kills it.
 *
 * Windows has neither process groups nor a PID in the profile lock: Chrome holds `lockfile` in
 * the profile open (and deletes it when it exits), the process table comes from PowerShell, and
 * a Chrome is ended with its helpers by `taskkill /T`, which is never graceful for a headless
 * one. Node's own `process.kill` there terminates at once, whatever the signal.
 */

export { type ProcTable, parseProcTable } from "turno-core/process";

/**
 * The PID in the profile's `SingletonLock` (`<host>-<pid>`), if there is one. Windows' lock names
 * no PID, so there it is always undefined.
 */
export function readLockPid(userDataDir: string): number | undefined {
  try {
    return parseSingletonLock(readlinkSync(join(userDataDir, "SingletonLock")));
  } catch {
    return undefined;
  }
}

/**
 * True when the command line passes exactly this profile as `--user-data-dir=<dir>` (the form
 * Playwright gives Chrome and its helpers; the wrapper's own `--user-data-dir <dir>` never
 * matches). Spaces in the path are fine; `<dir>-2` or `<dir>/sub` are other profiles.
 */
export function usesProfile(command: string, userDataDir: string): boolean {
  const dirs = new Set([userDataDir]);
  try {
    dirs.add(realpathSync(userDataDir));
  } catch {
    /* the profile is gone: only the given path can match */
  }
  for (const dir of dirs) {
    const flag = `--user-data-dir=${dir}`;
    for (let i = command.indexOf(flag); i >= 0; i = command.indexOf(flag, i + 1)) {
      const end = i + flag.length;
      // Windows quotes an argument with a space in it: "--user-data-dir=C:\Users\a b\p".
      if (end === command.length || command[end] === " " || command[end] === '"') return true;
    }
  }
  return false;
}

/** The browser process itself, not a renderer, GPU or utility helper (those carry `--type=`). */
export function isBrowserProcess(command: string): boolean {
  return !/(^|\s)--type=/.test(command);
}

/** Who drives the Chrome behind a profile: this process, nobody (an orphan), or someone else. */
type ChromeOwner = "self" | "orphan" | "other";

export interface ProfileChrome {
  /** The PID in the lock: the browser process, and the leader of its process group. */
  pid: number;
  pgid: number;
  /** False when only helpers are left in the group. */
  leaderAlive: boolean;
  owner: ChromeOwner;
}

type Alive = (pid: number) => boolean;
type Signal = (pid: number, signal: NodeJS.Signals) => void;

export interface FindOptions {
  /** The process table to use (tests); read with `ps` when missing. */
  table?: ProcTable;
  readTable?: () => ProcTable | undefined;
  alive?: Alive;
  /** The PID that counts as "self" (default: this process). */
  selfPid?: number;
  platform?: NodeJS.Platform;
  /** Windows: whether a Chrome holds the profile's `lockfile` (default: `windowsProfileLocked`). */
  locked?: (userDataDir: string) => boolean;
}

/**
 * Windows: the browser process for this profile from the process table, while a Chrome holds
 * the profile's lockfile. A parent that is not in the table has exited: the Chrome is an orphan.
 */
function findWindowsProfileChrome(userDataDir: string, opts: FindOptions): ProfileChrome | undefined {
  if (!(opts.locked ?? windowsProfileLocked)(userDataDir)) return undefined;
  const table = opts.table ?? (opts.readTable ?? (() => readProcTable("win32")))();
  if (!table) return undefined;
  const self = opts.selfPid ?? process.pid;
  const leader = [...table.values()].find((p) => usesProfile(p.command, userDataDir) && isBrowserProcess(p.command));
  if (!leader) return undefined;
  const owner: ChromeOwner = leader.ppid === self ? "self" : parentIsInit(leader.ppid, table) ? "orphan" : "other";
  return { pid: leader.pid, pgid: leader.pid, leaderAlive: true, owner };
}

/**
 * The Chrome that holds this profile, after checking that the PID in the lock really is a
 * Chrome browser process for this exact profile dir. Undefined when there is none, or when the
 * lock points at some other program (a reused PID).
 */
export function findProfileChrome(userDataDir: string, opts: FindOptions = {}): ProfileChrome | undefined {
  if ((opts.platform ?? process.platform) === "win32") return findWindowsProfileChrome(userDataDir, opts);
  const pid = readLockPid(userDataDir);
  if (pid === undefined) return undefined;
  const alive = opts.alive ?? processAlive;
  if (!opts.table && !alive(pid) && !alive(-pid)) return undefined;
  const table = opts.table ?? (opts.readTable ?? readProcTable)();
  if (!table) return undefined;
  const self = opts.selfPid ?? process.pid;
  const leader = table.get(pid);
  if (leader) {
    if (!usesProfile(leader.command, userDataDir) || !isBrowserProcess(leader.command)) return undefined;
    const owner: ChromeOwner = leader.ppid === self ? "self" : parentIsInit(leader.ppid, table) ? "orphan" : "other";
    return { pid, pgid: leader.pgid, leaderAlive: true, owner };
  }
  // The browser process died but helpers of its group may still run.
  const members = [...table.values()].filter((p) => p.pgid === pid && usesProfile(p.command, userDataDir));
  if (!members.length) return undefined;
  const orphaned = members.every((m) => parentIsInit(m.ppid, table) || table.get(m.ppid)?.pgid === pid);
  return { pid, pgid: pid, leaderAlive: false, owner: orphaned ? "orphan" : "other" };
}

/**
 * How long `stopChrome` waits for the group to go after SIGKILL. A SIGKILL is delivered at
 * once, but the group is gone only when the kernel has torn down every member and init (or a
 * subreaper) has reaped each one: until then `kill(-pgid, 0)` still finds the zombies. On a
 * loaded two-core CI runner with several Chromes that took more than 2 seconds, and the sweep
 * then reported a Chrome that "did not stop" while it was already dying.
 */
export const KILL_WAIT_MS = 5_000;

export interface StopOptions {
  /** How long the browser gets to quit after SIGTERM. */
  graceMs?: number;
  /** How long to wait for the group to go after SIGKILL (default `KILL_WAIT_MS`). */
  killMs?: number;
  signal?: Signal;
  alive?: Alive;
  platform?: NodeJS.Platform;
  /** Windows: ends a process tree (default: turno-core's `killTree`). */
  killTree?: (pid: number, force: boolean) => void;
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Gracefully, then forcefully: SIGTERM to the browser process alone (it shuts its helpers down
 * and writes the profile, cookies included; a SIGTERM to the whole group would kill the network
 * process that holds the cookie store at the same moment), then SIGKILL to the whole group.
 * A group is only signalled when the browser process leads it.
 */
export async function stopChrome(
  target: ProfileChrome,
  opts: StopOptions = {},
): Promise<"exited" | "killed" | "survived"> {
  const signal = opts.signal ?? sendSignal;
  const alive = opts.alive ?? processAlive;
  if ((opts.platform ?? process.platform) === "win32") {
    // No signal to ask for a clean exit: close the windows of the tree (a headed Chrome saves
    // and quits), then end the tree.
    const kill = opts.killTree ?? ((pid: number, force: boolean) => void killTree(pid, force, "win32"));
    const gone = () => !alive(target.pid);
    kill(target.pid, false);
    if (await waitUntil(gone, opts.graceMs ?? 3000)) return "exited";
    kill(target.pid, true);
    return (await waitUntil(gone, opts.killMs ?? KILL_WAIT_MS)) ? "killed" : "survived";
  }
  const leadsGroup = target.pgid === target.pid;
  const handle = leadsGroup ? -target.pid : target.pid;
  const gone = () => !alive(handle);
  signal(target.leaderAlive ? target.pid : handle, "SIGTERM");
  if (await waitUntil(gone, opts.graceMs ?? 3000)) return "exited";
  signal(handle, "SIGKILL");
  return (await waitUntil(gone, opts.killMs ?? KILL_WAIT_MS)) ? "killed" : "survived";
}

export interface SweepResult {
  /** `none`: nothing holds the profile; `in-use`: a live process drives it, left alone. */
  action: "none" | "in-use" | "exited" | "killed" | "survived";
  pid?: number;
}

/** Stop a Chrome that an earlier run left behind on this profile (see the module comment). */
export async function sweepOrphan(userDataDir: string, opts: FindOptions & StopOptions = {}): Promise<SweepResult> {
  const found = findProfileChrome(userDataDir, opts);
  if (!found) return { action: "none" };
  if (found.owner !== "orphan") return { action: "in-use", pid: found.pid };
  return { action: await stopChrome(found, opts), pid: found.pid };
}

export interface ShutdownOptions {
  platform?: NodeJS.Platform;
  /** Time the program gets to close the browser gracefully before Chrome gets SIGTERM. */
  graceMs?: number;
  /** Time Chrome gets after SIGTERM before this process exits and its group gets SIGKILL. */
  termMs?: number;
  /** False for a server without an MCP client on stdin (`--background`): its stdin closing means nothing. */
  stdin?: boolean;
}

/**
 * Bound the shutdown of this server. The program's own watchdog closes the browser when stdin
 * closes or on SIGINT and SIGTERM, but it allows itself 15 seconds, while the MCP SDK sends
 * SIGTERM 2 seconds after closing stdin and SIGKILL 2 seconds later. After `graceMs` the Chrome
 * this process started gets SIGTERM; after `termMs` more this process exits, and the exit
 * handler SIGKILLs the group if it is still there. SIGHUP is turned into SIGTERM so the
 * program closes the browser instead of the process dying with it open.
 */
export function installShutdownGuard(userDataDir: string, opts: ShutdownOptions = {}): void {
  const graceMs = opts.graceMs ?? 1500;
  const termMs = opts.termMs ?? 1000;
  const windows = (opts.platform ?? process.platform) === "win32";
  const ours = () => {
    const c = findProfileChrome(userDataDir, windows ? { platform: "win32" } : {});
    return c && c.owner !== "other" ? c : undefined;
  };
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    setTimeout(() => {
      const c = ours();
      // Windows has no SIGTERM to give Chrome: the exit handler ends its tree.
      if (c?.leaderAlive && !windows) sendSignal(c.pid, "SIGTERM");
      setTimeout(() => process.exit(0), termMs).unref();
    }, graceMs).unref();
  };
  if (opts.stdin !== false) process.stdin.once("close", begin);
  process.on("SIGTERM", begin);
  process.on("SIGINT", begin);
  process.on("SIGHUP", () => {
    begin();
    // On Windows (the console window closed) process.kill would end this process at once.
    if (windows) process.emit("SIGTERM", "SIGTERM");
    else process.kill(process.pid, "SIGTERM");
  });
  process.on("exit", () => {
    const c = ours();
    if (!c) return;
    if (windows) killTree(c.pid, true, "win32");
    else sendSignal(c.pgid === c.pid ? -c.pid : c.pid, "SIGKILL");
  });
}
