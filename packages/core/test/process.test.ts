import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parentIsInit,
  parseProcTable,
  parseWindowsProcTable,
  pidAlive,
  readProcTable,
  signalProcess,
  treeKillCommand,
} from "../src/process.js";

describe("process helpers", () => {
  it("parses ps output with process groups and skips other lines", () => {
    const t = parseProcTable(
      "  1     0     1 /sbin/launchd\n 42     1    42 /Applications/Chrome --user-data-dir=/a b\ngarbage\n",
    );
    expect([...t.keys()]).toEqual([1, 42]);
    expect(t.get(42)).toEqual({ pid: 42, ppid: 1, pgid: 42, command: "/Applications/Chrome --user-data-dir=/a b" });
    expect(parentIsInit(1, t)).toBe(true);
    expect(parentIsInit(42, t)).toBe(false);
    expect(parentIsInit(999, t)).toBe(true);
  });

  it("parses the Windows table, where every process leads its own group", () => {
    const t = parseWindowsProcTable(
      '4\t0\t\r\n900\t12\t"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\p q\r\nnoise\r\n',
    );
    expect([...t.keys()]).toEqual([4, 900]);
    expect(t.get(900)).toEqual({
      pid: 900,
      ppid: 12,
      pgid: 900,
      command: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\p q',
    });
    expect(t.get(4)?.command).toBe("");
    expect(parentIsInit(12, t)).toBe(true);
  });

  it("ends a tree with taskkill /T on Windows only", () => {
    expect(treeKillCommand(900, true, "win32")).toEqual({ file: "taskkill.exe", args: ["/PID", "900", "/T", "/F"] });
    expect(treeKillCommand(900, false, "win32")?.args).toEqual(["/PID", "900", "/T"]);
    expect(treeKillCommand(900, true, "darwin")).toBeUndefined();
  });

  it("reads this process from the real process table", () => {
    const t = readProcTable();
    if (!t) return; // no ps here
    expect(t.get(process.pid)?.ppid).toBe(process.ppid);
  });

  it("tells a live process from a gone one, and signals without throwing", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const pid = child.pid!;
    expect(pidAlive(pid)).toBe(true);
    const exited = new Promise((r) => child.once("exit", r));
    signalProcess(pid, "SIGTERM");
    await exited;
    expect(pidAlive(pid)).toBe(false);
    expect(() => signalProcess(pid, "SIGTERM")).not.toThrow();
  });
});
