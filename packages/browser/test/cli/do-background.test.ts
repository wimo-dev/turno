import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "turno-core/cli";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackgroundState } from "../../src/background-state.js";
import type { BackgroundSession, OpenSessionOptions } from "../../src/client.js";
import { type BackgroundDoDeps, backgroundTransport } from "../../src/cli/do-background.js";
import { type Sandbox, sandbox, expectMode } from "../helpers/sandbox.js";
import { fakeIo } from "./helpers.js";

/**
 * The background transport of `turno-browser do` on a fake client: the first command opens a
 * session and saves it, the next continues it, `end` ends it, and a session of a server that
 * is gone is not continued. The real server and Chrome are in the bin and chrome tests.
 */

const OWNER = { pid: process.pid, command: "/bin/zsh" };

interface Fake {
  deps: BackgroundDoDeps;
  opened: OpenSessionOptions[];
  ended: string[];
  calls: string[];
  server: { pid: number } | undefined;
  failNext: boolean;
}

function fake(): Fake {
  const f: Fake = { opened: [], ended: [], calls: [], server: { pid: 4242 }, failNext: false, deps: undefined! };
  let next = 0;
  const state = (): BackgroundState => ({
    v: 1,
    pid: f.server!.pid,
    identity: "school",
    version: "0.0.0",
    startedAt: "2026-11-19T10:00:00.000Z",
    idleMs: 900_000,
    transport: "socket",
    socket: "/tmp/sock",
  });
  const known = new Set<string>();
  f.deps = {
    owner: () => OWNER,
    identityExists: (id) => id === "school",
    backgroundStatus: () => (f.server ? state() : undefined),
    async openBackgroundSession(_id, options = {}) {
      f.opened.push(options);
      if (!f.server) f.server = { pid: 5151 };
      const resumed = options.session !== undefined && known.has(options.session.id);
      const id = resumed ? options.session!.id : `s${++next}`;
      known.add(id);
      const session: BackgroundSession = {
        id,
        protocolVersion: "2025-06-18",
        resumed,
        state: state(),
        listTools: async () => [],
        async callTool(name) {
          f.calls.push(`${id}:${name}`);
          if (f.failNext) {
            f.failNext = false;
            throw new Error("the identity's one-session lease is held by another session");
          }
          return { content: [{ type: "text", text: "### Result\nok" }] };
        },
        async end() {
          known.delete(id);
          f.ended.push(id);
        },
        async close() {},
      };
      return session;
    },
  };
  return f;
}

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const p = (args: string[] = []) => parseFlags(args, { session: { type: "string" } });
const savedFile = (name = "default") =>
  join(
    sb.home,
    ".local",
    "state",
    "turno",
    "browser",
    "identities",
    "school",
    "background",
    "do",
    `${OWNER.pid}.${name}.json`,
  );

describe("the background transport of do", () => {
  it("opens a session, saves it privately, and continues it in the next command", async () => {
    const f = fake();
    const io = fakeIo(sb.env);
    const t = backgroundTransport(f.deps);
    const first = await t.target("school", p(), io);
    expect(first.head).toEqual({ identity: "school", server: "background", profile: null });
    expect(await first.session(async (s) => [s.resumed, (await s.call("browser_navigate", {}, 1000)).content])).toEqual(
      [false, [{ type: "text", text: "### Result\nok" }]],
    );
    expect(f.opened[0]).toMatchObject({ owner: OWNER.pid, env: sb.env });
    expect(f.opened[0]!.session).toBeUndefined();
    const saved = JSON.parse(readFileSync(savedFile(), "utf8"));
    expect(saved).toMatchObject({ v: 1, identity: "school", serverPid: 4242, sessionId: "s1", name: "default" });
    expectMode(savedFile(), 0o600);

    const second = await backgroundTransport(f.deps).target("school", p(), io);
    expect(second.describe(io).open).toBe(true);
    expect(await second.session(async (s) => (await s.call("browser_snapshot", {}, 1000), s.resumed))).toBe(true);
    expect(f.opened[1]!.session).toEqual({ id: "s1", protocolVersion: "2025-06-18" });
    expect(f.calls).toEqual(["s1:browser_navigate", "s1:browser_snapshot"]);

    expect(await second.end()).toBe(true);
    expect(f.ended).toEqual(["s1"]);
    expect(existsSync(savedFile())).toBe(false);
    expect(await second.end()).toBe(false);
  });

  it("does not continue a session of a server that is gone", async () => {
    const f = fake();
    const io = fakeIo(sb.env);
    const t = await backgroundTransport(f.deps).target("school", p(), io);
    await t.session((s) => s.call("browser_navigate", {}, 1000));
    f.server = { pid: 9999 }; // another server now
    expect(t.describe(io).open).toBe(false);
    await t.session(async (s) => {
      expect(s.resumed).toBe(false);
      await s.call("browser_snapshot", {}, 1000);
    });
    expect(f.opened[1]!.session).toBeUndefined();
    expect(JSON.parse(readFileSync(savedFile(), "utf8")).serverPid).toBe(9999);
  });

  it("keeps sessions apart by name, and ends a new session whose first call fails", async () => {
    const f = fake();
    const io = fakeIo(sb.env);
    const t = await backgroundTransport(f.deps).target("school", p(["--session", "two"]), io);
    f.failNext = true;
    await expect(t.session((s) => s.call("browser_navigate", {}, 1000))).rejects.toThrow(
      /^browser_navigate: the identity's one-session lease is held by another session$/,
    );
    expect(f.ended).toEqual(["s1"]);
    expect(existsSync(savedFile("two"))).toBe(false);
    await t.session((s) => s.call("browser_navigate", {}, 1000));
    expect(existsSync(savedFile("two"))).toBe(true);
    expect(existsSync(savedFile())).toBe(false);
  });

  it("says when the identity does not exist, and describes a server that is not running", async () => {
    const f = fake();
    f.server = undefined;
    const io = fakeIo(sb.env);
    await expect(backgroundTransport(f.deps).target("nobody", p(), io)).rejects.toThrow(
      'browser identity "nobody" does not exist (turno-browser add nobody)',
    );
    const t = await backgroundTransport(f.deps).target("school", p(), io);
    const { open, lines } = t.describe(io);
    expect(open).toBe(false);
    expect(lines).toContain("server: not running; the next action starts it");
    expect(lines).toContain(`session: default, owned by zsh (pid ${OWNER.pid})`);
  });
});
