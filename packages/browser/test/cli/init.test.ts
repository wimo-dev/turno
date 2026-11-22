import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "turno-core/cli";
import { readRegistrations } from "../../src/agent-mcp.js";
import type { BrowserFunctions } from "../../src/api.js";
import { localTime } from "../../src/cli/identity.js";
import { detectAgents, init, shellWords } from "../../src/cli/init.js";
import { loginSummary } from "../../src/cli/login-summary.js";
import { errorHint } from "../../src/cli/do.js";
import { formatIdle } from "../../src/cli/do-background.js";
import { unknownAgent } from "../../src/cli/setup.js";
import { siteOf, welcomePage } from "../../src/login.js";
import { ctx, fakeAgentCli, fakeIo, real } from "./helpers.js";

/** A sandbox: turno's folders, a HOME, and a PATH with only the agents a test puts there. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "turno-init-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const env: NodeJS.ProcessEnv = {
    HOME: join(root, "home"),
    PATH: bin,
    TURNO_CONFIG_DIR: join(root, "config"),
    TURNO_STATE_DIR: join(root, "state"),
    TURNO_DATA_DIR: join(root, "data"),
  };
  mkdirSync(env.HOME!);
  const agent = (name: string) => {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  };
  return { root, env, agent, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** An Io whose questions get `answers` in order, and that records each question. */
function asking(
  env: NodeJS.ProcessEnv,
  answers: string[],
): Io & { lines: string[]; errors: string[]; asked: string[] } {
  const io = fakeIo(env);
  const asked: string[] = [];
  return {
    ...io,
    asked,
    ask: async (q: string) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
  };
}

describe("turno-browser init", () => {
  let sb: ReturnType<typeof sandbox>;
  let api: BrowserFunctions;
  let logins: { id: string; url?: string }[];
  let runs: string[][];
  beforeEach(async () => {
    sb = sandbox();
    logins = [];
    runs = [];
    const realApi = await real();
    api = {
      ...realApi,
      loginIdentity: (async (id: string, o: { url?: string }) => {
        logins.push({ id, ...(o.url ? { url: o.url } : {}) });
        return { sites: ["mail.example.com"] };
      }) as BrowserFunctions["loginIdentity"],
    };
  });
  afterEach(() => sb.done());

  const run = async (command: string, args: readonly string[]) => {
    runs.push([command, ...args]);
    return 0;
  };

  it("asks the name, signs in on the first site and runs the agent's command on a yes", async () => {
    sb.agent("claude");
    const io = asking(sb.env, ["school", "mail.example.com", "", "", ""]);
    const c = ctx(api, { interactive: () => true });
    expect(await init(c, [], io, run)).toBe(0);
    expect(io.asked).toEqual([
      "Name [personal]: ",
      "First site to open (Enter for none): ",
      "Open Chrome now? [Y/n] ",
      "Agent [claude-code]: ",
      "Run it now? [Y/n] ",
    ]);
    expect(api.identityExists("school", sb.env)).toBe(true);
    expect(logins).toEqual([{ id: "school", url: "https://mail.example.com" }]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slice(0, 6)).toEqual(["claude", "mcp", "add", "--scope", "user", "browser-school"]);
    expect(runs[0]!.slice(-2)).toEqual(["--identity", "school"]);
    const out = io.lines.join("\n");
    expect(out).toContain("Saved. Sites you opened: mail.example.com.");
    expect(out).toContain('Done: Claude Code has the browser "school".');
    expect(out).toContain("Start a new Claude Code session and ask it to open https://mail.example.com.");
  });

  it("asks again after an invalid name and reuses an identity that is already there", async () => {
    await (await real()).addIdentity("work", sb.env);
    const io = asking(sb.env, ["Bad Name", "work", "", "n", "none"]);
    const c = ctx(api, { interactive: () => true });
    expect(await init(c, [], io, run)).toBe(0);
    expect(io.asked[0]).toBe("Name [work]: ");
    expect(io.errors.join("\n")).toMatch(/Bad Name/);
    expect(io.lines).toContain('Using the identity "work" that is already here.');
    expect(logins).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("prints the block to paste for an agent without an mcp add command", async () => {
    mkdirSync(join(sb.env.HOME!, ".cursor"));
    const io = asking(sb.env, []);
    const c = ctx(api, { interactive: () => true });
    expect(await init(c, ["--identity", "school", "--agent", "cursor", "--no-login", "--yes"], io, run)).toBe(0);
    expect(runs).toEqual([]);
    const out = io.lines.join("\n");
    expect(out).toContain('"browser-school"');
    expect(out).toContain("Once it is added, start a new Cursor session");
  });

  it("names any MCP client as your MCP client in the next steps", async () => {
    const io = asking(sb.env, []);
    const c = ctx(api, { interactive: () => true });
    expect(await init(c, ["--identity", "school", "--agent", "json", "--no-login", "--yes"], io, run)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("Once it is added, start a new session of your MCP client and ask it to open");
    expect(out).not.toContain("a new any MCP client session");
  });

  it("without a terminal needs --identity and --agent, skips the sign-in and runs nothing", async () => {
    sb.agent("claude");
    const io = fakeIo(sb.env);
    const c = ctx(api);
    await expect(init(c, [], io, run)).rejects.toThrow(/--identity and --agent/);
    expect(await init(c, ["--identity", "school", "--agent", "claude-code"], io, run)).toBe(0);
    expect(logins).toEqual([]);
    expect(runs).toEqual([]);
    expect(io.lines.join("\n")).toContain("Skipped: only a person can sign in.");
    expect(io.lines.join("\n")).toContain("claude mcp add --scope user browser-school");
  });

  it("--dry-run creates nothing, opens nothing and runs nothing", async () => {
    sb.agent("claude");
    const io = fakeIo(sb.env);
    const c = ctx(api, { interactive: () => true });
    expect(await init(c, ["--identity", "school", "--agent", "claude-code", "--dry-run"], io, run)).toBe(0);
    expect(api.identityExists("school", sb.env)).toBe(false);
    expect(logins).toEqual([]);
    expect(runs).toEqual([]);
    expect(io.lines.join("\n")).toContain('(dry run) would create the identity "school"');
  });

  it("refuses an unknown agent with the closest name", async () => {
    const c = ctx(api, { interactive: () => true });
    await expect(init(c, ["--agent", "claude"], asking(sb.env, []), run)).rejects.toThrow(/did you mean claude-code\?/);
  });

  it("finds the agents on the PATH, and Cursor by its folder", () => {
    expect(detectAgents(sb.env)).toEqual([]);
    sb.agent("codex");
    sb.agent("gemini");
    mkdirSync(join(sb.env.HOME!, ".cursor"));
    expect(detectAgents(sb.env)).toEqual(["codex", "cursor", "gemini"]);
  });
});

describe("turno-browser init without a terminal", () => {
  let sb: ReturnType<typeof sandbox>;
  let api: BrowserFunctions;
  beforeEach(async () => {
    sb = sandbox();
    api = await real();
  });
  afterEach(() => sb.done());

  const report = (io: { lines: string[] }) => JSON.parse(io.lines.join("\n"));
  const flags = ["--identity", "school", "--agent", "claude-code", "--yes", "--json"];

  it("--yes runs the agent's command, reports it as JSON and records it; a second run changes nothing", async () => {
    sb.agent("claude");
    const agent = fakeAgentCli(sb.env);
    const c = ctx(api, { exec: agent.exec });
    const io = fakeIo(sb.env);
    expect(await init(c, flags, io)).toBe(0);
    const first = report(io);
    expect(first).toMatchObject({
      schemaVersion: 1,
      dryRun: false,
      identity: { id: "school", created: true, existed: false },
      login: { status: "skipped", reason: "no terminal: only a person can sign in" },
      mcp: {
        status: "added",
        agent: "claude-code",
        server: "browser-school",
        file: "~/.claude.json",
        exitCode: 0,
        output: "add browser-school",
      },
    });
    expect(first.mcp.register.slice(0, 6)).toEqual(["claude", "mcp", "add", "--scope", "user", "browser-school"]);
    expect(first.mcp.run.slice(-2)).toEqual(["--identity", "school"]);
    expect(first.next.join("\n")).toContain("turno-browser login school");
    expect(agent.calls).toHaveLength(1);
    expect(agent.config().mcpServers["browser-school"]!.args).toEqual(["--identity", "school"]);
    expect(readRegistrations("school", sb.env)).toMatchObject([
      { agent: "claude-code", server: "browser-school", file: join(sb.env.HOME!, ".claude.json") },
    ]);

    const again = fakeIo(sb.env);
    expect(await init(c, flags, again)).toBe(0);
    expect(report(again)).toMatchObject({
      identity: { created: false, existed: true },
      mcp: { status: "already", exitCode: null },
    });
    expect(agent.calls).toHaveLength(1);
    expect(readRegistrations("school", sb.env)).toHaveLength(1);
    expect(Object.keys(agent.config().mcpServers)).toEqual(["browser-school"]);
  });

  it("without --json says what it ran, in words", async () => {
    sb.agent("claude");
    const agent = fakeAgentCli(sb.env);
    const io = fakeIo(sb.env);
    expect(
      await init(ctx(api, { exec: agent.exec }), ["--identity", "school", "--agent", "claude-code", "--yes"], io),
    ).toBe(0);
    expect(io.lines.join("\n")).toContain(
      'Done: Claude Code has the browser "school" (claude mcp add --scope user browser-school',
    );
  });

  it("leaves a server of the same name with another command as it is", async () => {
    sb.agent("claude");
    writeFileSync(
      join(sb.env.HOME!, ".claude.json"),
      JSON.stringify({ mcpServers: { "browser-school": { command: "/old/mcp.js", args: ["--identity", "school"] } } }),
    );
    const agent = fakeAgentCli(sb.env);
    const io = fakeIo(sb.env);
    expect(await init(ctx(api, { exec: agent.exec }), flags, io)).toBe(0);
    const r = report(io);
    expect(r.mcp.status).toBe("differs");
    expect(r.mcp.notes.join("\n")).toContain("with another command (/old/mcp.js --identity school)");
    expect(agent.calls).toEqual([]);
  });

  it("counts an agent that says the server already exists as done", async () => {
    sb.agent("claude");
    const agent = fakeAgentCli(sb.env, { code: 1, output: "MCP server browser-school already exists in user config" });
    const io = fakeIo(sb.env);
    expect(await init(ctx(api, { exec: agent.exec }), flags, io)).toBe(0);
    expect(report(io).mcp).toMatchObject({ status: "already", exitCode: 1 });
  });

  it("exits 1 with the agent's output when its command fails", async () => {
    sb.agent("claude");
    const agent = fakeAgentCli(sb.env, { code: 3, output: "not signed in" });
    const io = fakeIo(sb.env);
    expect(await init(ctx(api, { exec: agent.exec }), flags, io)).toBe(1);
    expect(report(io).mcp).toMatchObject({ status: "failed", exitCode: 3, output: "not signed in" });
    expect(io.errors).toEqual([]);
    expect(readRegistrations("school", sb.env)).toEqual([]);
  });

  it("exits 127 when --yes names an agent whose program is not on the PATH", async () => {
    const agent = fakeAgentCli(sb.env);
    const io = fakeIo(sb.env);
    expect(await init(ctx(api, { exec: agent.exec }), flags, io)).toBe(127);
    expect(report(io).mcp).toMatchObject({ status: "not_installed", exitCode: null });
    expect(agent.calls).toEqual([]);
  });

  it("reports the block to paste for an agent without an add command", async () => {
    const io = fakeIo(sb.env);
    expect(await init(ctx(api), ["--identity", "school", "--agent", "cursor", "--yes", "--json"], io)).toBe(0);
    const r = report(io);
    expect(r.mcp).toMatchObject({ status: "manual", register: null, file: "~/.cursor/mcp.json" });
    expect(JSON.parse(r.mcp.config).mcpServers["browser-school"].args).toEqual(["--identity", "school"]);
  });

  it("--json needs --identity and --agent, even on a terminal", async () => {
    const c = ctx(api, { interactive: () => true });
    await expect(init(c, ["--json"], asking(sb.env, []))).rejects.toThrow(/--identity and --agent/);
  });

  it("--json --dry-run creates nothing and says what it would run", async () => {
    sb.agent("claude");
    const agent = fakeAgentCli(sb.env);
    const io = fakeIo(sb.env);
    expect(await init(ctx(api, { exec: agent.exec }), [...flags, "--dry-run"], io)).toBe(0);
    expect(report(io)).toMatchObject({
      dryRun: true,
      identity: { created: false, existed: false },
      login: { status: "skipped" },
      mcp: { status: "would_add" },
    });
    expect(api.identityExists("school", sb.env)).toBe(false);
    expect(agent.calls).toEqual([]);
  });
});

describe("the words of the first steps", () => {
  const c = ctx({} as BrowserFunctions);

  it("splits setup's shell line back into words", () => {
    expect(shellWords("claude mcp add --scope user browser-a -- '/x y/mcp.js' --identity a")).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "browser-a",
      "--",
      "/x y/mcp.js",
      "--identity",
      "a",
    ]);
  });

  it("says what a login saved, or that it saved nothing", () => {
    expect(loginSummary(c, "school", [])).toBe(
      "Closed. No site was opened, so no new sign-in was saved. Open one directly with turno-browser login school --url https://mail.example.com",
    );
    expect(loginSummary(c, "school", ["a.com", "b.com"])).toBe(
      "Saved. Sites you opened: a.com, b.com. The agent starts with the same cookies on them.",
    );
    expect(loginSummary(c, "school", ["a", "b", "c", "d", "e", "f"])).toContain("a, b, c, d and 2 more");
  });

  it("names the sites a login opened and skips internal pages", () => {
    expect(siteOf("https://www.github.com/login")).toBe("github.com");
    expect(siteOf("about:blank")).toBeUndefined();
    expect(siteOf("chrome://newtab/")).toBeUndefined();
  });

  it("opens a welcome page that names the identity, escaped", () => {
    const html = welcomePage('a"<b>', "turno-browser login x");
    expect(html).toContain("a&quot;&lt;b&gt;");
    expect(html).toContain("Close the window when you are done");
    expect(html).not.toContain("<b>");
  });

  it("guesses the agent a person meant", () => {
    expect(unknownAgent("claude")).toContain("did you mean claude-code?");
    expect(unknownAgent("Cursr")).toContain("did you mean cursor?");
    expect(unknownAgent("vim")).not.toContain("did you mean");
  });

  it("gives a next step for a stale ref or text where a ref goes", () => {
    expect(errorHint("Ref e99 not found in the current page snapshot.", "turno-browser", "s")).toContain(
      "turno-browser do s snapshot",
    );
    expect(errorHint('"Learn more" does not match any elements.', "turno-browser", "s")).toContain(
      'turno-browser do s find "<text>"',
    );
    expect(errorHint("Timeout 5000ms exceeded", "turno-browser", "s")).toBeUndefined();
  });

  it("writes idle limits and times the way a person reads them", () => {
    expect(formatIdle(15 * 60_000)).toBe("15m");
    expect(formatIdle(3_600_000)).toBe("1h");
    expect(formatIdle(90_000)).toBe("90s");
    expect(localTime("not a time")).toBe("not a time");
    expect(localTime("2026-11-20T05:46:30.169Z")).toMatch(/^2026-11-(19|20) \d\d:\d\d$/);
  });
});
