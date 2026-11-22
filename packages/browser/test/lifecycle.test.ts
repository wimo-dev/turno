import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findProfileChrome,
  isBrowserProcess,
  KILL_WAIT_MS,
  parseProcTable,
  type ProcTable,
  readLockPid,
  stopChrome,
  sweepOrphan,
  usesProfile,
} from "../src/lifecycle.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
let dir: string;
beforeEach(() => {
  sb = sandbox();
  dir = join(sb.home, "my profile", "work");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => sb.cleanup());

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = (d: string) => `${CHROME} --disable-sync --user-data-dir=${d} --remote-debugging-pipe about:blank`;
const helper = (d: string) => `${CHROME} Helper (Renderer) --type=renderer --user-data-dir=${d} --lang=en`;

function table(rows: [number, number, number, string][]): ProcTable {
  return parseProcTable(rows.map(([pid, ppid, pgid, cmd]) => `  ${pid} ${ppid}  ${pgid} ${cmd}`).join("\n"));
}

function lock(pid: number): void {
  symlinkSync(`some-host.local-${pid}`, join(dir, "SingletonLock"));
}

describe("process table", () => {
  it("parses pid, ppid, pgid and the full command line", () => {
    const t = parseProcTable(`  1     0     1 /sbin/launchd\n 42     1    42 ${browser(dir)}\ngarbage\n`);
    expect(t.get(1)).toEqual({ pid: 1, ppid: 0, pgid: 1, command: "/sbin/launchd" });
    expect(t.get(42)?.command).toBe(browser(dir));
    expect(t.size).toBe(2);
  });

  it("matches the profile dir exactly, spaces included", () => {
    expect(usesProfile(browser(dir), dir)).toBe(true);
    expect(usesProfile(browser(`${dir}-2`), dir)).toBe(false);
    expect(usesProfile(browser(join(dir, "sub")), dir)).toBe(false);
    // The wrapper itself gets `--user-data-dir <dir>` as two arguments: never a match.
    expect(usesProfile(`node mcp.js --user-data-dir ${dir}`, dir)).toBe(false);
    expect(usesProfile(`${CHROME} --user-data-dir=${dir}`, dir)).toBe(true);
  });

  it("tells the browser process from its helpers", () => {
    expect(isBrowserProcess(browser(dir))).toBe(true);
    expect(isBrowserProcess(helper(dir))).toBe(false);
  });

  it("reads the PID from the profile's SingletonLock", () => {
    expect(readLockPid(dir)).toBeUndefined();
    lock(4242);
    expect(readLockPid(dir)).toBe(4242);
  });
});

describe("findProfileChrome", () => {
  const alive = () => true;

  it("finds nothing without a lock or when the lock points at another program", () => {
    expect(findProfileChrome(dir, { table: table([]), alive })).toBeUndefined();
    lock(500);
    expect(findProfileChrome(dir, { table: table([[500, 1, 500, "/usr/bin/vim notes.txt"]]), alive })).toBeUndefined();
    expect(
      findProfileChrome(dir, { table: table([[500, 1, 500, browser(join(sb.home, "other"))]]), alive }),
    ).toBeUndefined();
  });

  it("calls a Chrome whose parent is init an orphan", () => {
    lock(500);
    const t = table([
      [1, 0, 1, "/sbin/launchd"],
      [500, 1, 500, browser(dir)],
      [501, 500, 500, helper(dir)],
    ]);
    expect(findProfileChrome(dir, { table: t, alive, selfPid: 99 })).toEqual({
      pid: 500,
      pgid: 500,
      leaderAlive: true,
      owner: "orphan",
    });
  });

  it("calls a Chrome whose parent is this process its own, and one with another live parent in use", () => {
    lock(500);
    const mine = table([
      [99, 1, 99, "node mcp.js"],
      [500, 99, 500, browser(dir)],
    ]);
    expect(findProfileChrome(dir, { table: mine, alive, selfPid: 99 })?.owner).toBe("self");
    const login = table([
      [77, 1, 77, "node turno identity login browser:work"],
      [500, 77, 500, browser(dir)],
    ]);
    expect(findProfileChrome(dir, { table: login, alive, selfPid: 99 })?.owner).toBe("other");
  });

  it("treats a parent that is gone, or a user service manager, as init", () => {
    lock(500);
    expect(findProfileChrome(dir, { table: table([[500, 321, 500, browser(dir)]]), alive, selfPid: 99 })?.owner).toBe(
      "orphan",
    );
    const user = table([
      [321, 1, 321, "/usr/lib/systemd/systemd --user"],
      [500, 321, 500, browser(dir)],
    ]);
    expect(findProfileChrome(dir, { table: user, alive, selfPid: 99 })?.owner).toBe("orphan");
  });

  it("finds helpers left in the group after the browser process died", () => {
    lock(500);
    const t = table([
      [1, 0, 1, "/sbin/launchd"],
      [501, 1, 500, helper(dir)],
      [502, 1, 500, helper(dir)],
      [600, 1, 500, "/usr/bin/unrelated"],
    ]);
    expect(findProfileChrome(dir, { table: t, alive, selfPid: 99 })).toEqual({
      pid: 500,
      pgid: 500,
      leaderAlive: false,
      owner: "orphan",
    });
  });

  it("does not read the process table when nothing behind the lock is alive", () => {
    lock(500);
    let read = false;
    const found = findProfileChrome(dir, {
      alive: () => false,
      readTable: () => {
        read = true;
        return table([]);
      },
    });
    expect(found).toBeUndefined();
    expect(read).toBe(false);
  });
});

describe("stopChrome", () => {
  function fakeProcs(dieOn: NodeJS.Signals | "never") {
    const sent: [number, NodeJS.Signals][] = [];
    let dead = false;
    return {
      sent,
      opts: {
        graceMs: 200,
        killMs: 200,
        signal: (pid: number, sig: NodeJS.Signals) => {
          sent.push([pid, sig]);
          if (sig === dieOn) dead = true;
        },
        alive: () => !dead,
      },
    };
  }

  it("asks the browser process to quit, and stops there when it does", async () => {
    const f = fakeProcs("SIGTERM");
    expect(await stopChrome({ pid: 500, pgid: 500, leaderAlive: true, owner: "orphan" }, f.opts)).toBe("exited");
    expect(f.sent).toEqual([[500, "SIGTERM"]]);
  });

  it("kills the whole process group when the browser does not quit", async () => {
    const f = fakeProcs("SIGKILL");
    expect(await stopChrome({ pid: 500, pgid: 500, leaderAlive: true, owner: "orphan" }, f.opts)).toBe("killed");
    expect(f.sent).toEqual([
      [500, "SIGTERM"],
      [-500, "SIGKILL"],
    ]);
  });

  it("never signals a group it does not lead, and reports a survivor", async () => {
    const f = fakeProcs("never");
    expect(await stopChrome({ pid: 500, pgid: 77, leaderAlive: true, owner: "orphan" }, f.opts)).toBe("survived");
    expect(f.sent).toEqual([
      [500, "SIGTERM"],
      [500, "SIGKILL"],
    ]);
  });

  it("waits more than 2 seconds after SIGKILL before it reports a survivor (zombies still count)", async () => {
    vi.useFakeTimers();
    try {
      // The group goes 3 seconds after SIGKILL, as on a loaded runner.
      let killedAt: number | undefined;
      const result = stopChrome(
        { pid: 500, pgid: 500, leaderAlive: true, owner: "orphan" },
        {
          graceMs: 100,
          signal: (_pid, sig) => {
            if (sig === "SIGKILL") killedAt = Date.now();
          },
          alive: () => killedAt === undefined || Date.now() - killedAt < 3_000,
        },
      );
      await vi.advanceTimersByTimeAsync(KILL_WAIT_MS + 1_000);
      expect(await result).toBe("killed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals the group of leftover helpers", async () => {
    const f = fakeProcs("SIGTERM");
    expect(await stopChrome({ pid: 500, pgid: 500, leaderAlive: false, owner: "orphan" }, f.opts)).toBe("exited");
    expect(f.sent).toEqual([[-500, "SIGTERM"]]);
  });
});

describe("sweepOrphan", () => {
  it("leaves a Chrome that another live process owns", async () => {
    lock(500);
    const t = table([
      [77, 1, 77, "node turno identity login browser:work"],
      [500, 77, 500, browser(dir)],
    ]);
    const sent: number[] = [];
    const r = await sweepOrphan(dir, { table: t, alive: () => true, selfPid: 99, signal: (pid) => sent.push(pid) });
    expect(r).toEqual({ action: "in-use", pid: 500 });
    expect(sent).toEqual([]);
  });

  it("stops an orphan of this profile", async () => {
    lock(500);
    const t = table([
      [1, 0, 1, "/sbin/launchd"],
      [500, 1, 500, browser(dir)],
    ]);
    let dead = false;
    const r = await sweepOrphan(dir, {
      table: t,
      alive: () => !dead,
      selfPid: 99,
      graceMs: 100,
      signal: () => {
        dead = true;
      },
    });
    expect(r).toEqual({ action: "exited", pid: 500 });
  });

  it("does nothing without a lock", async () => {
    expect(await sweepOrphan(dir)).toEqual({ action: "none" });
  });
});

describe("on Windows", () => {
  const WIN_CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
  const profile = "C:\\Users\\a\\AppData\\Local\\turno\\data\\browser\\identities\\work";
  const winTable = (rows: [number, number, string][]): ProcTable =>
    new Map(rows.map(([pid, ppid, command]) => [pid, { pid, ppid, pgid: pid, command }]));
  const opts = (t: ProcTable, locked = true) => ({
    platform: "win32" as const,
    table: t,
    locked: () => locked,
    selfPid: 7,
  });

  it("matches a profile Windows quoted for its space", () => {
    expect(usesProfile(`${WIN_CHROME} "--user-data-dir=C:\\Users\\a b\\p" --no-first-run`, "C:\\Users\\a b\\p")).toBe(
      true,
    );
    expect(usesProfile(`${WIN_CHROME} "--user-data-dir=C:\\Users\\a b\\p-2"`, "C:\\Users\\a b\\p")).toBe(false);
  });

  it("finds the browser process by its command line while Chrome holds the lockfile, an orphan when its parent left", () => {
    const t = winTable([
      [900, 4444, `${WIN_CHROME} --user-data-dir=${profile} --remote-debugging-pipe`],
      [901, 900, `${WIN_CHROME} --type=renderer --user-data-dir=${profile}`],
    ]);
    expect(findProfileChrome(profile, opts(t))).toEqual({ pid: 900, pgid: 900, leaderAlive: true, owner: "orphan" });
    expect(findProfileChrome(profile, opts(t, false))).toBeUndefined();
    t.set(4444, { pid: 4444, ppid: 1, pgid: 4444, command: "node.exe mcp.js" });
    expect(findProfileChrome(profile, opts(t))?.owner).toBe("other");
    t.get(900)!.ppid = 7;
    expect(findProfileChrome(profile, opts(t))?.owner).toBe("self");
  });

  it("closes the tree's windows, then ends the tree with taskkill", async () => {
    const calls: [number, boolean][] = [];
    let alive = true;
    const target = { pid: 900, pgid: 900, leaderAlive: true, owner: "orphan" as const };
    const kill = (pid: number, force: boolean) => {
      calls.push([pid, force]);
      if (force) alive = false;
    };
    const run = { platform: "win32" as const, killTree: kill, alive: () => alive, graceMs: 50, killMs: 50 };
    expect(await stopChrome(target, run)).toBe("killed");
    expect(calls).toEqual([
      [900, false],
      [900, true],
    ]);
  });
});
