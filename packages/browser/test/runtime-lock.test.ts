import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity, isInUse, inUseBy } from "../src/identities.js";
import {
  IdentityInUseError,
  acquireRuntimeLock,
  inUseMessage,
  readRuntimeLock,
  runtimeLockAlive,
  runtimeLockPath,
  stopCommand,
} from "../src/runtime-lock.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

/**
 * The runtime lock: who drives an identity's Chrome right now ({ nodePid, chromePid, pgid,
 * startedAt }), written by the host when it launches Chrome and removed when Chrome closes or
 * the process exits, so a second user of the identity gets a clear message instead of
 * Chrome's "Browser is already in use".
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const T0 = new Date("2026-11-17T16:00:00.000Z");

/** A process that is surely alive while the test runs, and not this one. */
function sleeper(): { pid: number; kill(): void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

describe("runtime lock", () => {
  it("is written under the identity's state folder, mode 600, and removed on release", () => {
    const held = acquireRuntimeLock("school", sb.env, { holder: "mcp", now: T0 });
    const file = runtimeLockPath("school", sb.env);
    expect(file).toBe(join(sb.home, ".local", "state", "turno", "browser", "identities", "school", "lock.json"));
    expectMode(file, 0o600);
    expect(readRuntimeLock("school", sb.env)).toEqual({
      nodePid: process.pid,
      holder: "mcp",
      startedAt: T0.toISOString(),
    });
    held.update({ chromePid: 4242, pgid: 4242 });
    expect(readRuntimeLock("school", sb.env)).toEqual({
      nodePid: process.pid,
      chromePid: 4242,
      pgid: 4242,
      holder: "mcp",
      startedAt: T0.toISOString(),
    });
    held.release();
    expect(existsSync(file)).toBe(false);
    held.release();
  });

  it("refuses a second holder while the first is alive, naming it and how to stop it", () => {
    const other = sleeper();
    try {
      const file = runtimeLockPath("school", sb.env);
      acquireRuntimeLock("school", sb.env, { holder: "mcp", nodePid: other.pid, now: T0 }).update({
        chromePid: 777,
        pgid: 777,
      });
      let error: unknown;
      try {
        acquireRuntimeLock("school", sb.env, { holder: "mcp" });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(IdentityInUseError);
      const message = (error as Error).message;
      expect(message).toContain(
        `browser identity "school" is in use by turno-browser-mcp (pid ${other.pid}, Chrome pid 777) since ${T0.toISOString()}`,
      );
      expect(message).toContain(stopCommand(other.pid!));
      expect(JSON.parse(readFileSync(file, "utf8")).nodePid).toBe(other.pid);
    } finally {
      other.kill();
    }
  });

  it("names a login as the holder and tells the user to close its window", () => {
    expect(inUseMessage("bank", { nodePid: 12, chromePid: 34, holder: "login", startedAt: T0.toISOString() })).toBe(
      `browser identity "bank" is in use by turno-browser login (pid 12, Chrome pid 34) since ${T0.toISOString()}. ` +
        "Close that Chrome window to finish the login, then try again.",
    );
  });

  it("takes over a lock whose process is gone, or a file that is not a lock", async () => {
    const gone = sleeper();
    acquireRuntimeLock("school", sb.env, { holder: "mcp", nodePid: gone.pid });
    gone.kill();
    await new Promise((r) => setTimeout(r, 200));
    expect(runtimeLockAlive(readRuntimeLock("school", sb.env)!)).toBe(false);
    const held = acquireRuntimeLock("school", sb.env, { holder: "mcp" });
    expect(readRuntimeLock("school", sb.env)!.nodePid).toBe(process.pid);
    held.release();

    writeFileSync(runtimeLockPath("school", sb.env), "garbage");
    expect(readRuntimeLock("school", sb.env)).toBeUndefined();
    acquireRuntimeLock("school", sb.env, { holder: "mcp" }).release();
  });

  it("lets the same process take its own lock again (a relaunch after the idle close)", () => {
    const first = acquireRuntimeLock("school", sb.env, { holder: "mcp" });
    const second = acquireRuntimeLock("school", sb.env, { holder: "mcp" });
    first.release();
    expect(readRuntimeLock("school", sb.env), "a stale handle does not remove the current lock").toBeDefined();
    second.release();
    expect(readRuntimeLock("school", sb.env)).toBeUndefined();
  });

  it("does not remove or rewrite a lock another process took meanwhile", () => {
    const other = sleeper();
    try {
      const mine = acquireRuntimeLock("school", sb.env, { holder: "mcp" });
      writeFileSync(
        runtimeLockPath("school", sb.env),
        JSON.stringify({ nodePid: other.pid, holder: "mcp", startedAt: T0.toISOString() }),
      );
      mine.update({ chromePid: 1 });
      mine.release();
      expect(readRuntimeLock("school", sb.env)).toEqual({
        nodePid: other.pid,
        holder: "mcp",
        startedAt: T0.toISOString(),
      });
    } finally {
      other.kill();
    }
  });

  it("makes the identity count as in use, with who holds it", () => {
    addIdentity("school", sb.env);
    expect(isInUse("school", sb.env)).toBe(false);
    expect(inUseBy("school", sb.env)).toBeUndefined();
    const held = acquireRuntimeLock("school", sb.env, { holder: "login", now: T0 });
    expect(isInUse("school", sb.env)).toBe(true);
    expect(inUseBy("school", sb.env)).toMatch(/in use by turno-browser login/);
    held.release();
    expect(isInUse("school", sb.env)).toBe(false);
  });
});

describe("how a message says to stop the holder", () => {
  it("is kill elsewhere, and taskkill of the tree on Windows, which has no SIGTERM", () => {
    expect(stopCommand(123, "darwin")).toBe("kill 123");
    expect(stopCommand(123, "win32")).toBe("taskkill /PID 123 /T /F");
    const lock = { nodePid: 123, holder: "mcp" as const, startedAt: "2026-11-22T00:00:00.000Z" };
    expect(inUseMessage("work", lock, "win32")).toContain("`taskkill /PID 123 /T /F`, which ends its Chrome with it");
  });
});
