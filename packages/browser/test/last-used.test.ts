import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityStateDir } from "../src/ids.js";
import { readLastUsed, touchLastUsed, watchStdinCalls } from "../src/last-used.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** When an identity last served a tool call: written at most once a minute, read by `status`. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const T = new Date("2026-11-20T18:00:00.000Z");

describe("last used", () => {
  it("is undefined before any call, then the time of the call, in a file only the user reads", () => {
    expect(readLastUsed("school", sb.env)).toBeUndefined();
    touchLastUsed("school", sb.env, T);
    expect(readLastUsed("school", sb.env)).toBe(T.toISOString());
    const file = join(identityStateDir("school", sb.env), "last-used.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ at: T.toISOString() });
    // A file it cannot parse reads as never; a write it cannot make (the state folder is a file) is ignored.
    writeFileSync(file, "{not json");
    expect(readLastUsed("school", sb.env)).toBeUndefined();
    writeFileSync(identityStateDir("blocked", sb.env), "");
    expect(() => touchLastUsed("blocked", sb.env, T)).not.toThrow();
  });

  it("counts the tool calls on a stdio server's stdin, and nothing before the transport reads", async () => {
    const stdin = new PassThrough();
    watchStdinCalls("calls", sb.env, stdin);
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
    expect(readLastUsed("calls", sb.env)).toBeUndefined();
    const seen: string[] = [];
    stdin.on("data", (c: Buffer) => seen.push(String(c)));
    await new Promise((r) => setImmediate(r));
    // The transport gets what arrived before it listened.
    expect(seen.join("")).toContain("tools/call");
    expect(readLastUsed("calls", sb.env)).toBeDefined();
    const other = new PassThrough();
    watchStdinCalls("listing", sb.env, other);
    other.on("data", () => undefined);
    other.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await new Promise((r) => setImmediate(r));
    expect(readLastUsed("listing", sb.env)).toBeUndefined();
  });
});
