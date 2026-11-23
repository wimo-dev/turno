import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProcTable } from "turno-core/process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserCommand, defaultDeps } from "../src/cli/commands/browser.js";
import type { DoDeps } from "../src/cli/commands/browser-do.js";
import {
  identityServer,
  ownerName,
  passesOn,
  sessionName,
  sessionOwner,
  sessionsDir,
  sweepSaved,
  writeSaved,
} from "../src/cli/commands/browser-do-session.js";
import { CliError, UsageError } from "../src/cli/io.js";
import { main } from "../src/cli/main.js";
import { parseManifest } from "../src/core/manifest.js";
import { type RunningDaemon, startDaemon } from "../src/mcpd/daemon.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `turno browser do`: browser actions from the shell, through mcpd, as one session per owner.
 * mcpd runs in process; a fake turno-browser-mcp (fixtures/fake-browser-server.mjs) keeps one
 * page per `io.turno/session` id, so a test sees whether two commands are one session.
 */

const FAKE = fileURLToPath(new URL("./fixtures/fake-browser-server.mjs", import.meta.url));

let sb: Sandbox;
let daemons: RunningDaemon[] = [];
let events: string;

beforeEach(() => {
  sb = sandbox();
  daemons = [];
  events = join(sb.home, "events.log");
});

afterEach(async () => {
  for (const d of daemons) await d.stop().catch(() => {});
  sb.cleanup();
});

/** This test process owns the sessions: alive for the whole test, so mcpd keeps them. */
const deps: DoDeps = { owner: () => ({ pid: process.pid, command: "node vitest" }), stdin: async () => "from stdin\n" };

async function run(args: string[], d: DoDeps = deps) {
  const io = fakeIo(sb.env);
  let code: number;
  try {
    code = await browserCommand(defaultDeps, d).run(args, io);
  } catch (err) {
    if (!(err instanceof UsageError) && !(err instanceof CliError)) throw err;
    code = err instanceof CliError ? err.code : 2;
    io.err((err as Error).message);
  }
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

function block(id: string, extra = "", env: Record<string, string> = {}) {
  const vars = Object.entries({ FIXTURE_EVENTS: events, ...env })
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  return [
    `[server.browser-${id}]`,
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(FAKE)}, "--identity", "${id}"]`,
    `scope = "shared"`,
    extra || "exclusive = false",
    `env = { ${vars} }`,
    "",
  ].join("\n");
}

async function daemon(manifest = block("school")): Promise<RunningDaemon> {
  sb.write(".config/turno/config.toml", "");
  sb.write(".config/turno/mcp.toml", manifest);
  const d = await startDaemon({ env: sb.env, port: 0 });
  daemons.push(d);
  return d;
}

function sessionOf(out: string): string {
  return /title: Page of (\w+)/.exec(out)?.[1] ?? "";
}

function eventLines(): string[] {
  return existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : [];
}

describe("the session owner", () => {
  it("skips shells started for one command, wrappers and package runners", () => {
    expect(passesOn("/bin/zsh -c -l source /tmp/snap.sh && eval 'turno browser do x snapshot'")).toBe(true);
    expect(passesOn("bash -lc turno browser do x open https://example.com")).toBe(true);
    expect(passesOn("env FOO=1 turno")).toBe(true);
    expect(passesOn("node /opt/pnpm/bin/pnpm.cjs exec turno")).toBe(true);
    expect(passesOn("-zsh")).toBe(false);
    expect(passesOn("/bin/bash ./script.sh")).toBe(false);
    expect(passesOn("node /opt/agent/cli.js")).toBe(false);
  });

  it("knows Windows' shells, quoted paths and .exe names", () => {
    expect(passesOn('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "turno-browser do x snapshot"')).toBe(true);
    expect(passesOn('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command turno-browser do x')).toBe(true);
    expect(passesOn('"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "turno-browser do x"')).toBe(true);
    expect(passesOn('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"')).toBe(false);
    expect(passesOn("C:\\WINDOWS\\system32\\cmd.exe")).toBe(false);
    expect(ownerName({ pid: 7, command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\agent\\cli.js"' })).toBe("cli");
  });

  it("is the agent above its per-command shells, or the terminal's shell", () => {
    const table = parseProcTable(
      [
        "  1     0     1 /sbin/launchd",
        " 70     1    70 /usr/bin/login -fp alice",
        " 75    70    75 -zsh",
        " 80    75    80 node /opt/agent/cli.js",
        " 90    80    90 /bin/zsh -c -l eval 'turno browser do school snapshot'",
        " 95    80    95 /bin/zsh -c -l eval 'turno browser do school read'",
      ].join("\n"),
    );
    expect(sessionOwner(table, 90)).toEqual({ pid: 80, command: "node /opt/agent/cli.js" });
    expect(sessionOwner(table, 95).pid).toBe(80);
    expect(sessionOwner(table, 75)).toEqual({ pid: 75, command: "-zsh" });
    expect(sessionOwner(undefined, 42)).toEqual({ pid: 42, command: "" });
    // An agent a turno launcher started (TURNO_SESSION_PID) owns its commands when it is up the tree.
    expect(sessionOwner(table, 90, 75).pid).toBe(75);
    expect(sessionOwner(table, 90, 4242).pid).toBe(80);
  });

  it("checks session names", () => {
    expect(sessionName(undefined, {})).toBe("default");
    expect(sessionName(undefined, { TURNO_BROWSER_SESSION: "sub-1" })).toBe("sub-1");
    expect(sessionName("a_b", { TURNO_BROWSER_SESSION: "x" })).toBe("a_b");
    expect(() => sessionName("Bad Name", {})).toThrow(/lowercase/);
  });

  it("finds the server that serves an identity", () => {
    const m = parseManifest(
      [
        '[server.other]\ncommand = "turno-browser-mcp"\nargs = ["--identity=school"]',
        '[server.browser-school]\ncommand = "turno-browser-mcp"\nargs = ["--identity", "school"]',
        '[server.fx]\ncommand = "x"\nargs = ["--identity", "work"]',
      ].join("\n"),
    );
    expect(identityServer(m, "school")?.name).toBe("browser-school");
    expect(identityServer(m, "work")?.name).toBe("fx");
    expect(identityServer(m, "nobody")).toBeUndefined();
  });

  it("forgets saved sessions whose owner exited", () => {
    const saved = (pid: number) => ({
      v: 1 as const,
      identity: "school",
      server: "browser-school",
      profile: "default",
      port: 1,
      sessionId: "s",
      owner: { pid, command: "" },
      name: "default",
      createdAt: "",
      usedAt: "",
    });
    writeSaved(join(sessionsDir(sb.env), "school.111.default.json"), saved(111), sb.env);
    writeSaved(join(sessionsDir(sb.env), "school.222.default.json"), saved(222), sb.env);
    sweepSaved(sb.env, (pid) => pid === 222);
    expect(readdirSync(sessionsDir(sb.env))).toEqual(["school.222.default.json"]);
  });
});

describe("turno browser do", () => {
  it("keeps one session, and so one tab, across commands of one owner", async () => {
    await daemon();
    const a = await run(["do", "school", "open", "http://127.0.0.1:9/one", "--json"]);
    expect(a.code).toBe(0);
    const first = JSON.parse(a.out);
    expect(first).toMatchObject({
      schemaVersion: 1,
      identity: "browser:school",
      server: "browser-school",
      action: "open",
      tool: "browser_navigate",
      ok: true,
      page: { url: "http://127.0.0.1:9/one" },
      session: { name: "default", ownerPid: process.pid, resumed: false },
    });
    const b = await run(["do", "school", "snapshot"]);
    expect(b.code).toBe(0);
    expect(b.out.split("\n").slice(0, 2)).toEqual(["url: http://127.0.0.1:9/one", expect.stringMatching(/^title: /)]);
    expect(b.out).toContain('- button "Go" [ref=e5]');
    expect(b.out).not.toContain("```");
    const c = JSON.parse((await run(["do", "school", "read", "--json"])).out);
    expect(c.session.resumed).toBe(true);
    // One io.turno/session id for all three calls.
    const ids = new Set(eventLines().map((l) => l.split(" ")[2]));
    expect(ids.size).toBe(1);
  });

  it("prints actions as url and title lines, without the code upstream ran or the snapshot file", async () => {
    await daemon();
    const r = await run(["do", "school", "click", "e5"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^url: about:blank\ntitle: Page of \w+\nnote: New tab opened$/);
    const s = await run(["do", "school", "click", "e5", "--snapshot"]);
    expect(s.out).toContain('- textbox "Name" [ref=e4]');
  });

  it("reports a failed action on stderr with exit 1, without terminal colors or wrapper names", async () => {
    await daemon();
    const r = await run(["do", "school", "click", "e99"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error: Ref e99 not found in the current page snapshot\. Try capturing new snapshot\./);
    expect(r.err).not.toContain(String.fromCharCode(27));
    const j = JSON.parse((await run(["do", "school", "click", "e99", "--json"])).out);
    expect(j).toMatchObject({ ok: false, error: expect.stringMatching(/^Ref e99 not found/) });
  });

  it("relays the server's refusal, as read mode refuses a screenshot", async () => {
    await daemon(block("school", "", { FAKE_REFUSE: "browser_take_screenshot" }));
    const r = await run(["do", "school", "screenshot"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("error: browser_take_screenshot is refused in read mode");
  });

  it("prints the live view's pause note, and fails a command the pause kept from running", async () => {
    await daemon(block("school", "", { FAKE_PAUSED_RAN: "browser_click", FAKE_PAUSED_NOT_RUN: "browser_type" }));
    const ran = await run(["do", "school", "click", "e5"]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("note: The user paused this browser (the live view) for 12s and has resumed it.");
    expect(ran.out).toContain('note: Title: "A" -> "B"');
    const held = await run(["do", "school", "type", "e4", "Ada"]);
    expect(held.code).toBe(1);
    expect(held.out).toContain("note: Current tab: about:blank -> http://127.0.0.1:9/b");
    expect(held.err).toBe("error: browser_type was not run: the user changed the browser while you waited (below).");
    const j = JSON.parse((await run(["do", "school", "type", "e4", "Ada", "--json"])).out);
    expect(j).toMatchObject({ ok: false, error: expect.stringMatching(/^browser_type was not run/) });
    expect(j.notes).toContain("Current tab: about:blank -> http://127.0.0.1:9/b");
  });

  it("reads the page's text, cut at --max-chars", async () => {
    await daemon();
    await run(["do", "school", "open", "https://example.com/"]);
    await run(["do", "school", "type", "e4", "-"]);
    const r = await run(["do", "school", "read"]);
    expect(r.out).toBe("Hello from https://example.com/\n\ntyped: from stdin");
    const cut = await run(["do", "school", "read", "--max-chars", "5"]);
    expect(cut.out).toBe("Hello");
    expect(cut.err).toMatch(/text cut at 5 of \d+ characters/);
  });

  it("saves a screenshot to a file and prints its path", async () => {
    await daemon();
    const out = join(sb.home, "shot.png");
    const r = await run(["do", "school", "screenshot", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`file: ${out}`);
    expect(readFileSync(out, "utf8")).toBe("PNGDATA");
  });

  it("keeps named sessions apart, each with its own tab", async () => {
    await daemon();
    await run(["do", "school", "open", "https://a.example/"]);
    await run(["do", "school", "open", "https://b.example/", "--session", "other"]);
    const a = await run(["do", "school", "snapshot"]);
    const b = await run(["do", "school", "snapshot"], deps);
    const o = await run(["do", "school", "snapshot", "--session", "other"]);
    expect(a.out).toContain("url: https://a.example/");
    expect(sessionOf(a.out)).toBe(sessionOf(b.out));
    expect(o.out).toContain("url: https://b.example/");
    expect(sessionOf(o.out)).not.toBe(sessionOf(a.out));
  });

  it("ends the session with end: mcpd tells the server, and the next command starts a new one", async () => {
    await daemon();
    const first = sessionOf((await run(["do", "school", "open", "https://a.example/"])).out);
    const info = await run(["do", "school", "session"]);
    expect(info.out).toContain(`session: default, owned by vitest (pid ${process.pid})`);
    expect(info.out).toMatch(/state: open since/);
    const end = await run(["do", "school", "end"]);
    expect(end.out).toBe("ended session default of browser:school");
    for (let i = 0; i < 50 && !eventLines().some((l) => l.startsWith("session_ended")); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(eventLines().some((l) => l.startsWith("session_ended"))).toBe(true);
    expect((await run(["do", "school", "session"])).out).toContain("state: none yet");
    const next = await run(["do", "school", "snapshot"]);
    expect(next.out).toContain("url: about:blank");
    expect(sessionOf(next.out)).not.toBe(first);
  });

  it("holds the identity's one-session lease, so another session is told who has it", async () => {
    await daemon(block("school", 'exclusive = true\nlease = "10m"'));
    expect((await run(["do", "school", "open", "https://a.example/"])).code).toBe(0);
    const other = await run(["do", "school", "snapshot", "--session", "other"]);
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/browser-school is in use by another session/);
    await run(["do", "school", "end"]);
    expect((await run(["do", "school", "snapshot", "--session", "other"])).code).toBe(0);
  });

  it("closes the session's tabs and ends the session with close", async () => {
    await daemon();
    await run(["do", "school", "open", "https://a.example/"]);
    const r = await run(["do", "school", "close"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("Closed 1 tab of this session.");
    expect(
      existsSync(sessionsDir(sb.env)) ? readdirSync(sessionsDir(sb.env)).filter((n) => n.endsWith(".json")) : [],
    ).toEqual([]);
  });

  it("runs any tool of the server in the session with call", async () => {
    await daemon();
    await run(["do", "school", "open", "https://a.example/"]);
    const r = await run(["do", "school", "call", "browser_find", "--arg", "text=Go"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Found 1 match for "Go"');
  });

  it("refuses a bad command line before it opens any session", async () => {
    await daemon();
    expect((await run(["do", "school", "fly"])).code).toBe(2);
    expect((await run(["do", "school", "click"])).code).toBe(2);
    expect((await run(["do", "school", "wait"])).err).toMatch(/--text, --gone or --seconds/);
    expect((await run(["do", "School", "open", "x"])).code).toBe(2);
    expect((await run(["do", "school", "open", "x", "--session", "Bad"])).code).toBe(2);
    expect(eventLines()).toEqual([]);
    expect(existsSync(sessionsDir(sb.env))).toBe(false);
  });

  it("says how to serve an identity that mcp.toml does not have, and exits 5 without mcpd", async () => {
    await daemon();
    const r = await run(["do", "work", "snapshot"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/browser identity "work" is not served by mcpd: .*turno browser add work/);
    await daemons.pop()!.stop();
    sb.write(".config/turno/mcp.toml", block("school"));
    sb.write(".local/state/turno/mcpd.port", "9");
    const down = await run(["do", "school", "snapshot"]);
    expect(down.code).toBe(5);
    expect(down.err).toMatch(/mcpd is not running/);
  });

  it("prints its help with every action, and takes the short form turno browser <id> <action>", async () => {
    const help = await run(["do", "--help"]);
    expect(help.out).toContain("turno browser do <id> <action>");
    for (const a of ["open <url>", "snapshot", "click <ref>", "type <ref>", "read", "end"])
      expect(help.out).toContain(a);
    await daemon();
    const io = fakeIo(sb.env);
    expect(await main(["browser", "school", "open", "https://a.example/"], io)).toBe(0);
    expect(io.lines[0]).toBe("url: https://a.example/");
    // A subcommand name is never taken for an identity.
    const typo = fakeIo(sb.env);
    expect(await main(["browser", "flws", "school"], typo)).toBe(2);
  });
});
