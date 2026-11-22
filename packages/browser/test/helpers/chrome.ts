import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readProcTable } from "turno-core/process";

/** Shared by the tests that start a real Google Chrome (chrome-lifecycle, browser-tools). */

const pkg = fileURLToPath(new URL("../..", import.meta.url));

const CHROME_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/opt/google/chrome/chrome"],
  win32: [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((d) => d !== undefined)
    .map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe")),
};

/** The installed Google Chrome these tests start by hand, if there is one. */
export function chromeExecutable(): string | undefined {
  return CHROME_PATHS[process.platform]?.find((p) => existsSync(p));
}

/** Why these tests cannot run here, or undefined when a real Chrome starts. */
export function chromeUnavailable(): string | undefined {
  if (process.env.TURNO_SKIP_CHROME === "1") return "TURNO_SKIP_CHROME=1";
  const candidates = CHROME_PATHS[process.platform];
  if (!candidates) return `no Chrome location known on ${process.platform}`;
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) return `Google Chrome is not installed (looked for ${candidates.join(", ")})`;
  // Start it once, headless, from a throwaway HOME, so a Chrome that is present but cannot run
  // (a sandbox the host forbids, missing libraries) skips instead of failing every test.
  const home = mkdtempSync(join(tmpdir(), "turno-chrome-probe-"));
  const probe = [
    "const { chromium } = require(process.argv[1]);",
    "chromium.launch({ channel: 'chrome', headless: true, timeout: 20000 })",
    "  .then((b) => b.close()).catch((e) => { console.error(String(e.message).split('\\n')[0]); process.exit(1); });",
  ].join("\n");
  try {
    const core = join(pkg, "node_modules", "patchright-core");
    execFileSync(process.execPath, ["-e", probe, core], {
      env:
        process.platform === "win32"
          ? // USERPROFILE stays the account's: Chrome refuses the DevTools pipe with another one.
            { ...process.env, HOME: home, USERPROFILE: userInfo().homedir, LOCALAPPDATA: home, APPDATA: home }
          : { PATH: process.env.PATH, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 40_000,
    });
    return undefined;
  } catch (err) {
    const why = String((err as { stderr?: Buffer }).stderr ?? "").trim() || String((err as Error).message);
    return `Chrome at ${exe} did not start: ${why}`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Starts a Chrome (Chrome, Edge, Brave or another Chromium) outside Playwright, on its own user
 * data dir. Every Chrome a test or experiment starts by hand goes through here: Playwright adds
 * `--use-mock-keychain` and `--password-store=basic` to the Chromes it launches, a direct spawn
 * does not, and with a sandbox HOME macOS then shows the person a "Keychain not found" dialog
 * for each launch.
 */
export function spawnChrome(exe: string, userDataDir: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(
    exe,
    [
      `--user-data-dir=${userDataDir}`,
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-first-run",
      "--no-default-browser-check",
      ...args,
    ],
    { stdio: "ignore", env: process.platform === "win32" ? { ...env, USERPROFILE: userInfo().homedir } : env },
  );
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Processes whose command line names the sandbox (only the Chromes these tests started). */
export function sandboxProcesses(home: string): { pid: number; ppid: number; pgid: number }[] {
  if (process.platform === "win32") {
    // PowerShell's table: no process groups there, each process is its own.
    return [...(readProcTable("win32")?.values() ?? [])]
      .filter((p) => p.command.includes(home))
      .map(({ pid, ppid, pgid }) => ({ pid, ppid, pgid }));
  }
  const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((l) => l.includes(home))
    .map((l) => {
      const [pid, ppid, pgid] = l.trim().split(/\s+/).map(Number);
      return { pid: pid!, ppid: ppid!, pgid: pgid! };
    });
}

/**
 * Kills every process that names the sandbox and resolves once they are gone. Waiting matters:
 * a Chrome that got SIGKILL (or is still shutting down after its server closed) keeps writing
 * into its profile until it has exited, and a recursive delete of the sandbox that runs at the
 * same time fails with ENOTEMPTY when a file appears in a folder it just emptied.
 */
export async function stopSandboxProcesses(home: string, ms = 10_000): Promise<void> {
  const left = () => sandboxProcesses(home).filter((p) => alive(p.pid));
  for (const p of left()) {
    for (const sig of process.platform === "win32" ? (["SIGKILL"] as const) : (["SIGCONT", "SIGKILL"] as const)) {
      try {
        process.kill(p.pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
  if (!(await waitFor(() => left().length === 0, ms)))
    throw new Error(`processes of the sandbox ${home} did not exit: ${left().map((p) => p.pid)}`);
}
