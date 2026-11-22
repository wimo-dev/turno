import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addIdentity,
  identityDir,
  isInUse,
  isValidIdentityId,
  listIdentities,
  parseSingletonLock,
  removeIdentity,
} from "../src/identities.js";
import { manifestSnippet } from "../src/index.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("identity ids", () => {
  it("accepts lowercase ids with digits, dashes and underscores", () => {
    for (const id of ["school", "bank", "work-2", "a_b", "0"]) expect(isValidIdentityId(id)).toBe(true);
  });

  it("rejects everything else", () => {
    for (const id of ["", "School", "-x", "_x", "a b", "../x", "a/b", "a.b", "x".repeat(65)]) {
      expect(isValidIdentityId(id)).toBe(false);
    }
    expect(() => identityDir("../x", sb.env)).toThrow(/invalid identity/);
  });
});

describe("identity store", () => {
  it("adds, lists and removes identities inside the sandbox", () => {
    expect(listIdentities(sb.env)).toEqual([]);
    const info = addIdentity("school", sb.env);
    addIdentity("bank", sb.env);
    expect(info.dir).toBe(join(sb.home, ".local", "share", "turno", "browser", "identities", "school"));
    expect(listIdentities(sb.env).map((i) => i.id)).toEqual(["bank", "school"]);
    removeIdentity("school", sb.env);
    expect(existsSync(info.dir)).toBe(false);
    expect(() => removeIdentity("school", sb.env)).toThrow(/does not exist/);
  });

  it("ignores folders that are not valid ids", () => {
    mkdirSync(join(sb.home, ".local", "share", "turno", "browser", "identities", "Not Valid"), { recursive: true });
    expect(listIdentities(sb.env)).toEqual([]);
  });
});

describe("in use detection", () => {
  it("parses Chrome's SingletonLock target", () => {
    expect(parseSingletonLock("my-host.local-4242")).toBe(4242);
    expect(parseSingletonLock("garbage")).toBeUndefined();
  });

  // SingletonLock is POSIX; on Windows Chrome holds a lockfile no Node process can hold the same way.
  it.skipIf(process.platform === "win32")("is in use when the lock points to a live PID", () => {
    const { dir } = addIdentity("work", sb.env);
    expect(isInUse("work", sb.env)).toBe(false);
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
    expect(isInUse("work", sb.env)).toBe(true);
    expect(() => removeIdentity("work", sb.env)).toThrow(/in use/);
  });

  it("is free when the lock is stale", () => {
    const { dir } = addIdentity("work", sb.env);
    symlinkSync(`${hostname()}-999999999`, join(dir, "SingletonLock"));
    expect(isInUse("work", sb.env)).toBe(false);
  });
});

describe("manifestSnippet", () => {
  it("renders an exclusive shared server for the identity", () => {
    expect(manifestSnippet("school")).toBe(
      [
        "[server.browser-school]",
        'command = "turno-browser-mcp"',
        'args = ["--identity", "school"]',
        'scope = "shared"',
        "exclusive = true",
        'lease = "10m"',
        'idle = "30m"',
        "",
      ].join("\n"),
    );
    expect(() => manifestSnippet("Bad Id")).toThrow();
  });

  it("renders a shared, non-exclusive server for an identity whose sharing is tabs", () => {
    expect(manifestSnippet("team", { sharing: "tabs" })).toBe(
      [
        "[server.browser-team]",
        'command = "turno-browser-mcp"',
        'args = ["--identity", "team"]',
        'scope = "shared"',
        "exclusive = false  # every agent session at once, each in its own tabs",
        'idle = "30m"',
        "",
      ].join("\n"),
    );
    expect(manifestSnippet("team", { sharing: "session" })).toBe(manifestSnippet("team"));
  });
});
