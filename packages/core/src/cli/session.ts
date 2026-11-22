import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { ensurePrivateDir } from "../paths.js";
import type { ProcTable } from "../process.js";
import { UsageError } from "./io.js";

/**
 * Who a shell session of browser commands belongs to, shared by `turno browser do` (through
 * mcpd) and `turno-browser do` (through the identity's background server). A session lives as
 * long as its owner: the coding agent that runs the commands through short-lived shells, or the
 * terminal's shell. The server ends a session when the process it was opened for exits.
 */

/** The process a CLI session belongs to: it lives as long as this process does. */
export interface Owner {
  pid: number;
  /** The process's command line, for messages (`claude`, `-zsh`). */
  command: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "ash", "csh", "tcsh"]);
/** Windows' shells: `cmd /c` (an npm `.cmd` shim, a command an agent runs) and PowerShell's `-Command`. */
const WINDOWS_SHELLS = new Set(["cmd", "powershell", "pwsh"]);
const WRAPPERS = new Set(["env", "timeout", "gtimeout", "nice", "nohup", "stdbuf", "time", "xargs"]);
const RUNNERS = /^(pnpm|pnpx|npm|npx|yarn|bunx|corepack)(\.c?js)?$|^(npm|npx)-cli\.js$/;

/** The words of a command line; a Windows path with a space comes in double quotes. */
function words(command: string): string[] {
  return [...command.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

/** A program's name: no folder (either separator), no login dash, and on Windows no `.exe`, in lower case. */
function program(word: string | undefined): string {
  const name = basename((word ?? "").replace(/\\/g, "/")).replace(/^-/, "");
  return /\.exe$/i.test(name) ? name.slice(0, -4).toLowerCase() : name;
}

/**
 * True for a process that only passes a command on: a shell started for one command (`zsh -c`,
 * `bash -lc`, as coding agents run each command), a wrapper (`env`, `timeout`) or a package
 * runner (`pnpm exec`). An interactive or login shell (`-zsh`, `bash`) and a script's shell
 * (`bash script.sh`) are not: a session belongs to them.
 */
export function passesOn(command: string): boolean {
  const [first, ...rest] = words(command);
  const name = program(first);
  if (SHELLS.has(name)) return rest.some((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  if (WINDOWS_SHELLS.has(name.toLowerCase()))
    return rest.some((w) => /^\/c$/i.test(w) || /^-(c|command|encodedcommand|ec)$/i.test(w));
  if (WRAPPERS.has(name)) return true;
  if (RUNNERS.test(name)) return true;
  if (name === "node" || name === "bun") return RUNNERS.test(program(rest[0]));
  return false;
}

/**
 * The owner of a CLI session started from `start` (the parent of this process). An agent that a
 * turno launcher started names itself in TURNO_SESSION_PID (`agent`), the pid its own MCP
 * sessions send: when that process is up the tree, it is the owner. Otherwise the first process
 * up the tree that does not only pass a command on: inside Claude Code or Codex that is the
 * agent, so its commands share one session; in a terminal it is the shell. Without a process
 * table (no `ps`), the parent itself.
 */
export function sessionOwner(table: ProcTable | undefined, start: number = process.ppid, agent?: number): Owner {
  if (table && agent && agent > 1) {
    for (let pid = start, hops = 0; hops < 32; hops++) {
      const info = table.get(pid);
      if (!info) break;
      if (pid === agent) return { pid, command: info.command };
      if (info.ppid <= 1 || info.ppid === pid) break;
      pid = info.ppid;
    }
  }
  let pid = start;
  for (let hops = 0; table && hops < 16; hops++) {
    const info = table.get(pid);
    if (!info) break;
    const parent = table.get(info.ppid);
    if (!passesOn(info.command) || info.ppid <= 1 || !parent) return { pid, command: info.command };
    pid = info.ppid;
  }
  return { pid: start, command: table?.get(start)?.command ?? "" };
}

/** A short name for the owner in a message: its program (`claude`, `zsh`). */
export function ownerName(owner: Owner): string {
  const [first, second] = words(owner.command);
  const name = program(first);
  if ((name === "node" || name === "bun") && second) return program(second).replace(/\.c?js$/, "");
  return name || `pid ${owner.pid}`;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** `--session <name>`, else TURNO_BROWSER_SESSION, else "default". */
export function sessionName(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const name = flag ?? (env.TURNO_BROWSER_SESSION || "default");
  if (!NAME.test(name))
    throw new UsageError(
      `session name "${name}" must be 1 to 40 lowercase letters, digits, "-" or "_" (--session or TURNO_BROWSER_SESSION)`,
    );
  return name;
}

/**
 * Runs `fn` while holding `<file>.lock`, so two commands of one session started at once open one
 * server session, not two. A lock older than 30 seconds is from a command that died: taken over.
 */
export async function withLock<T>(file: string, env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const staleMs = 30_000;
  const until = Date.now() + 10_000;
  ensurePrivateDir(dirname(file), env);
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > staleMs || Date.now() > until) {
        rmSync(lock, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
