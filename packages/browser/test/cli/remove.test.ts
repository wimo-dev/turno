import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidAlive } from "turno-core/process";
import { type ExecCommand, readRegistrations, recordRegistration } from "../../src/agent-mcp.js";
import type { BrowserFunctions } from "../../src/api.js";
import { backgroundStatePath } from "../../src/background-state.js";
import { identityDir, identityStateDir } from "../../src/ids.js";
import { runtimeLockPath } from "../../src/runtime-lock.js";
import { recordExportFile } from "../../src/session-export.js";
import { identitySettingsPath } from "../../src/settings.js";
import { vaultPath } from "../../src/vault.js";
import { type FakeSecretStore, fakeSecretStore } from "../helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";
import { cli, fakeAgentCli, fakeIo, real } from "./helpers.js";

/**
 * `turno-browser remove`: everything an identity left, removed and checked. The secret store is
 * the file-backed fake, the agents' `mcp remove` is a fake that edits the sandbox's config
 * files, and the processes are small node programs that look like the identity's.
 */

let sb: Sandbox;
let store: FakeSecretStore;
let api: BrowserFunctions;
const children: ChildProcess[] = [];
beforeEach(async () => {
  sb = sandbox();
  store = fakeSecretStore(sb);
  // Only the fakes and the system's own tools: an agent is on the PATH only when a test puts it there.
  sb.env.PATH = `${join(sb.home, "fakebin")}:/usr/bin:/bin`;
  api = await real();
});
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && pidAlive(child.pid)) child.kill("SIGKILL");
  sb.cleanup();
});

/** A program on the sandbox PATH that exits 0: an agent that is installed. */
function installed(name: string): void {
  const dir = join(sb.home, "agentbin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  if (!sb.env.PATH!.includes(dir)) sb.env.PATH = `${dir}:${sb.env.PATH}`;
}

/** The identity "school" with a vault, a proxy secret, an export and an agent that has it. */
async function school(): Promise<{ exportFile: string }> {
  api.addIdentity("school", sb.env);
  api.writeIdentitySettings(
    "school",
    {
      proxy: {
        server: "http://proxy.example.com:8080",
        username: "keychain:shared-user",
        password: "keychain:school-proxy",
      },
    },
    sb.env,
  );
  store.write("school-proxy", "pw");
  store.write("shared-user", "alice");
  await api.vaultAdd(
    "school",
    "mail",
    { urls: ["https://mail.example.com"], username: "alice@example.com", password: "hunter2-correct-horse" },
    { env: sb.env },
  );
  const exportFile = join(sb.home, "school.session");
  writeFileSync(exportFile, JSON.stringify({ format: "turno-browser-session", version: 1 }));
  recordExportFile("school", exportFile, sb.env);
  return { exportFile };
}

/** The identity "work", which uses the same proxy user name item as "school". */
function work(): void {
  api.addIdentity("work", sb.env);
  api.writeIdentitySettings(
    "work",
    {
      proxy: {
        server: "http://proxy.example.com:8080",
        username: "keychain:shared-user",
        password: "keychain:work-proxy",
      },
    },
    sb.env,
  );
}

function claudeHas(id: string, env: NodeJS.ProcessEnv = sb.env): void {
  const file = join(env.CLAUDE_CONFIG_DIR ?? env.HOME!, ".claude.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { [`browser-${id}`]: { command: "turno-browser-mcp", args: ["--identity", id] } } }),
  );
}

const json = (io: { lines: string[] }) => JSON.parse(io.lines.join("\n"));

describe("turno-browser remove", () => {
  it("without a terminal needs --yes, and deletes nothing", async () => {
    await school();
    const io = fakeIo(sb.env);
    await expect(cli(api).run("remove", ["school"], io)).rejects.toThrow(/remove needs an answer; pass --yes/);
    expect(io.errors.join("\n")).toContain('This deletes browser identity "school"');
    expect(api.identityExists("school", sb.env)).toBe(true);
    expect(store.services()).toContain("school-proxy");
    await expect(cli(api).run("remove", ["school", "--json"], fakeIo(sb.env))).rejects.toThrow(/pass --yes/);
  });

  it("--yes deletes the files, the secrets and the agent's entry, keeps what another identity uses, and checks", async () => {
    const { exportFile } = await school();
    work();
    installed("claude");
    claudeHas("school");
    const agent = fakeAgentCli(sb.env);
    const io = fakeIo(sb.env);
    expect(await cli(api, { exec: agent.exec }).run("remove", ["school", "--yes", "--json"], io)).toBe(0);
    const r = json(io);
    expect(r).toMatchObject({
      schemaVersion: 1,
      identity: "school",
      dryRun: false,
      complete: true,
      failed: [],
      left: [],
    });
    const deleted = r.deleted.map(
      (d: { kind: string; item?: string; path?: string; agent?: string }) => d.item ?? d.path ?? d.agent,
    );
    expect(deleted).toEqual(
      expect.arrayContaining([
        "claude-code",
        "turno-browser/vault/school/mail",
        "school-proxy",
        "~/.local/share/turno/browser/identities/school",
        "~/.local/share/turno/browser/identities/school.json",
        "~/.local/share/turno/browser/identities/school.vault.json",
        "~/school.session",
      ]),
    );
    expect(r.kept).toEqual([
      expect.objectContaining({ kind: "keychain", item: "shared-user", reason: 'also used by identity "work"' }),
    ]);
    expect(agent.calls).toEqual([["claude", "mcp", "remove", "--scope", "user", "browser-school"]]);
    expect(agent.config().mcpServers).toEqual({});
    expect(store.services().sort()).toEqual(["shared-user"]);
    for (const f of [
      identityDir("school", sb.env),
      identitySettingsPath("school", sb.env),
      vaultPath("school", sb.env),
    ])
      expect(existsSync(f)).toBe(false);
    expect(existsSync(exportFile)).toBe(false);
    expect(api.identityExists("work", sb.env)).toBe(true);
  });

  it("lists what it cannot remove under left, with the step to do by hand, and exits 1", async () => {
    await school();
    mkdirSync(join(sb.home, ".cursor"));
    writeFileSync(
      join(sb.home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { "browser-school": { command: "turno-browser-mcp", args: ["--identity", "school"] } },
      }),
    );
    claudeHas("school"); // claude is not on the PATH here
    const io = fakeIo(sb.env);
    expect(await cli(api, { exec: fakeAgentCli(sb.env).exec }).run("remove", ["school", "--yes", "--json"], io)).toBe(
      1,
    );
    const r = json(io);
    expect(r.complete).toBe(false);
    expect(r.left).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "mcp",
          agent: "cursor",
          file: "~/.cursor/mcp.json",
          command: `delete the "browser-school" entry from ${join(sb.home, ".cursor", "mcp.json")}`,
        }),
        expect.objectContaining({
          kind: "mcp",
          agent: "claude-code",
          command: "claude mcp remove --scope user browser-school",
          reason: "claude is not on the PATH, so Claude Code cannot be reached",
        }),
      ]),
    );
    expect(api.identityExists("school", sb.env)).toBe(false);
  });

  it("says in words what it did, and calls the host's note once the identity is gone", async () => {
    await school();
    const notes: string[] = [];
    const host = {
      ...(await import("../../src/cli/context.js")).standaloneHost(),
      removed: (id: string) => notes.push(id),
    };
    const io = fakeIo(sb.env);
    expect(await cli(api, {}, host).run("remove", ["school", "--yes"], io)).toBe(0);
    const out = io.lines.join("\n");
    expect(out).toContain("deleted keychain:turno-browser/vault/school/mail (vault credential of mail)");
    expect(out).toContain("deleted keychain:school-proxy (proxy.password secret)");
    expect(out).toContain('removed identity "school" and its saved browser data');
    expect(notes).toEqual(["school"]);
  });

  it("asks on a terminal and deletes nothing on a no", async () => {
    await school();
    const asked: string[] = [];
    const answer = { yes: false };
    const c = cli(api, {
      interactive: () => true,
      confirm: async (q) => {
        asked.push(q);
        return answer.yes;
      },
    });
    const io = fakeIo(sb.env);
    expect(await c.run("remove", ["school"], io)).toBe(1);
    expect(asked).toEqual(["Delete all of this? [y/N] "]);
    expect(io.lines.join("\n")).toContain("keychain:school-proxy (proxy.password secret)");
    expect(io.errors).toContain("Cancelled; nothing was deleted.");
    expect(api.identityExists("school", sb.env)).toBe(true);
    answer.yes = true;
    expect(await c.run("remove", ["school"], fakeIo(sb.env))).toBe(0);
    expect(api.identityExists("school", sb.env)).toBe(false);
  });

  it("--dry-run --json lists the plan and changes nothing", async () => {
    await school();
    const io = fakeIo(sb.env);
    expect(await cli(api).run("remove", ["school", "--dry-run", "--json"], io)).toBe(0);
    const r = json(io);
    expect(r).toMatchObject({ dryRun: true, complete: null, deleted: [] });
    expect(r.planned.map((p: { what: string }) => p.what)).toEqual(
      expect.arrayContaining([
        "vault credential of mail",
        "proxy.password secret",
        "profile (cookies, saved sign-ins)",
      ]),
    );
    expect(api.identityExists("school", sb.env)).toBe(true);
    expect(store.services()).toContain("turno-browser/vault/school/mail");
  });

  it("stops the background server, the Chrome on the profile and the identity's servers first", async () => {
    await school();
    const script = join(sb.home, "turno-browser-mcp");
    writeFileSync(script, "setInterval(() => {}, 1000);\n");
    const start = (args: string[], env: NodeJS.ProcessEnv = sb.env) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: "ignore", detached: true, env });
      children.push(child);
      return child.pid!;
    };
    const background = start(["--identity", "school", "--background"]);
    mkdirSync(join(identityStateDir("school", sb.env), "background"), { recursive: true });
    writeFileSync(
      backgroundStatePath("school", sb.env),
      JSON.stringify({ v: 1, pid: background, identity: "school", version: "0", startedAt: "s", idleMs: 0 }),
    );
    const stdio = start(["--identity", "school"]);
    writeFileSync(runtimeLockPath("school", sb.env), JSON.stringify({ nodePid: stdio, holder: "mcp", startedAt: "s" }));
    const chrome = start([`--user-data-dir=${identityDir("school", sb.env)}`]);
    symlinkSync(`${hostname()}-${chrome}`, join(identityDir("school", sb.env), "SingletonLock"));
    const idle = start(["--identity", "school"]); // an agent's server that never opened Chrome
    const other = start(["--identity", "work"]);
    // The same id under another HOME is another machine's identity as far as this one goes.
    const elsewhere = start(["--identity", "school"], { ...sb.env, HOME: join(sb.home, "elsewhere") });
    await new Promise((r) => setTimeout(r, 200));

    const io = fakeIo(sb.env);
    expect(await cli(api).run("remove", ["school", "--yes", "--json"], io)).toBe(0);
    const r = json(io);
    expect(
      r.deleted
        .filter((d: { kind: string }) => d.kind === "process")
        .map((d: { pid: number }) => d.pid)
        .sort(),
    ).toEqual([background, stdio, chrome, idle].sort());
    for (const pid of [background, stdio, chrome, idle]) expect(pidAlive(pid)).toBe(false);
    expect(pidAlive(other)).toBe(true);
    expect(pidAlive(elsewhere)).toBe(true);
  });

  it("keeps Chrome's own cookie key with keychain system, and reads the sites of a broken vault index", async () => {
    api.addIdentity("school", sb.env);
    api.writeIdentitySettings("school", { keychain: "system" }, sb.env);
    writeFileSync(vaultPath("school", sb.env), '{"version":1,"sites":{"github":{"origins":["https://github.com"],');
    store.write("turno-browser/vault/school/github", "{}");
    const io = fakeIo(sb.env);
    expect(await cli(api).run("remove", ["school", "--yes", "--json"], io)).toBe(0);
    const r = json(io);
    expect(r.kept).toEqual([expect.objectContaining({ item: "Chrome Safe Storage", what: "Chrome's cookie key" })]);
    expect(store.services()).toEqual([]);
  });

  it("runs the agent's command against the config folder the registration went to", async () => {
    api.addIdentity("school", sb.env);
    installed("claude");
    const profile = { ...sb.env, CLAUDE_CONFIG_DIR: join(sb.home, ".claude-work") };
    claudeHas("school", profile);
    recordRegistration("school", sb.env, {
      agent: "claude-code",
      server: "browser-school",
      file: join(profile.CLAUDE_CONFIG_DIR!, ".claude.json"),
      at: "2026-11-20T00:00:00.000Z",
    });
    expect(readRegistrations("school", sb.env)).toHaveLength(1);
    const seen: (string | undefined)[] = [];
    const inner = fakeAgentCli(profile);
    const exec: ExecCommand = async (command, args, env) => {
      seen.push(env.CLAUDE_CONFIG_DIR);
      return inner.exec(command, args, env);
    };
    const io = fakeIo(sb.env);
    expect(await cli(api, { exec }).run("remove", ["school", "--yes", "--json"], io)).toBe(0);
    expect(seen).toEqual([profile.CLAUDE_CONFIG_DIR]);
    expect(JSON.parse(readFileSync(join(profile.CLAUDE_CONFIG_DIR!, ".claude.json"), "utf8")).mcpServers).toEqual({});
  });

  it("refuses an identity that left nothing, and answers to destroy too", async () => {
    await expect(cli(api).run("remove", ["nope", "--yes"], fakeIo(sb.env))).rejects.toThrow(/does not exist/);
    await school();
    expect(await cli(api).run("destroy", ["school", "--yes"], fakeIo(sb.env))).toBe(0);
    expect(api.identityExists("school", sb.env)).toBe(false);
  });
});
