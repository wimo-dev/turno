import { execFileSync } from "node:child_process";
import { loadAssembly, windowsPowerShell, windowsPowerShellEnv } from "./secrets.js";

/**
 * Process helpers shared by turno-cli and turno-browser: whether a PID lives, a signal that
 * never throws, the process table with process groups (Chrome runs as the leader of its own
 * group), and how to end a whole process tree. Windows has no process groups and no signals
 * (`process.kill` terminates at once there), so the table comes from PowerShell with each
 * process as its own group, and a tree ends with `taskkill /T`.
 */

/** Whether a process is alive. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Send a signal; a process that is already gone is not an error. A negative PID is a group. */
export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export type ProcTable = Map<number, ProcInfo>;

/** `ps -o pid=,ppid=,pgid=,command=` output. */
export function parseProcTable(stdout: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    t.set(pid, { pid, ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return t;
}

/**
 * PowerShell's `Win32_Process` lines, `<pid>\t<ppid>\t<command line>`. There are no process
 * groups on Windows: each process counts as the leader of its own. A process whose command line
 * the user may not read (another user's, a system one) has an empty one.
 */
export function parseWindowsProcTable(stdout: string): ProcTable {
  const t: ProcTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\d+)\t(\d+)\t(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    t.set(pid, { pid, ppid: Number(m[2]), pgid: pid, command: m[3]!.trim() });
  }
  return t;
}

/**
 * Lists every process as `parseWindowsProcTable` reads it, in UTF-8 whatever the console code
 * page, through WMI's .NET classes rather than Get-CimInstance (see loadAssembly).
 */
const WINDOWS_PROC_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  loadAssembly("System.Management"),
  "$s = [Management.ManagementObjectSearcher]::new('SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process')",
  "$b = [Text.StringBuilder]::new()",
  "foreach ($p in $s.Get()) { $null = $b.Append([string]$p['ProcessId']).Append([char]9).Append([string]$p['ParentProcessId']).Append([char]9).Append([string]$p['CommandLine']).Append([char]10) }",
  "[Console]::Out.Write($b.ToString())",
].join("; ");

/**
 * Every process with its full command line, or undefined when the table cannot be read (no
 * `ps`; on Windows, no PowerShell).
 */
export function readProcTable(platform: NodeJS.Platform = process.platform): ProcTable | undefined {
  if (platform === "win32") {
    try {
      // By its full path: the PATH an agent hands a server can leave System32 out.
      const out = execFileSync(
        windowsPowerShell(process.env),
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROC_SCRIPT],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          env: windowsPowerShellEnv(process.env),
          maxBuffer: 64 * 1024 * 1024,
          timeout: 15_000,
        },
      );
      return parseWindowsProcTable(out);
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH || "/bin:/usr/bin", LC_ALL: "C" },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
    return parseProcTable(out);
  } catch {
    return undefined;
  }
}

/**
 * The command that ends a process and every process it started: `taskkill /T` on Windows, which
 * walks the tree by parent PID (with `/F` it does not ask first). Undefined on other systems,
 * where a tree is a process group and gets a signal (`signalProcess(-pgid, ...)`).
 */
export function treeKillCommand(
  pid: number,
  force: boolean,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } | undefined {
  if (platform !== "win32") return undefined;
  return { file: "taskkill.exe", args: ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])] };
}

/**
 * Ends the tree of `pid`. On Windows through `treeKillCommand`: without `force`, taskkill asks
 * the windows of the tree to close, as the close button does (a headless process has none and
 * keeps running); false when taskkill failed (the process is already gone, or access was
 * denied). Elsewhere `pid` must lead its process group, which gets SIGTERM, or SIGKILL with `force`.
 */
export function killTree(pid: number, force: boolean, platform: NodeJS.Platform = process.platform): boolean {
  const cmd = treeKillCommand(pid, force, platform);
  if (!cmd) {
    signalProcess(-pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  }
  try {
    execFileSync(cmd.file, cmd.args, { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** A parent that means "nobody": init, launchd, a `systemd --user` subreaper, or none at all. */
export function parentIsInit(ppid: number, table: ProcTable): boolean {
  const parent = table.get(ppid);
  return ppid <= 1 || !parent || /(^|\/)(launchd|systemd|init)(\s|$)/.test(parent.command);
}
