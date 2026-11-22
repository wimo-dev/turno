import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "turno-core/secrets";
import { browserEntries, recordRegistration } from "../src/agent-mcp.js";
import { backgroundDir } from "../src/background-state.js";
import { type DoctorCheck, chromeVersionFromPlist, runDoctor } from "../src/doctor.js";
import { writeHealth } from "../src/health.js";
import { addIdentity, identityDir } from "../src/identities.js";
import { recordChallenge } from "../src/reputation.js";
import { acquireRuntimeLock, runtimeLockPath } from "../src/runtime-lock.js";
import { identitySettingsPath, systemTimezone } from "../src/settings.js";
import { vaultAdd, vaultItem } from "../src/vault.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `turno browser doctor`: Chrome and its version, the desktop session, a smoke launch on a
 * temporary profile, and per identity its identity.json, who holds it, its session health and
 * recent challenges, each problem with the command that fixes it. Chrome and the smoke launch
 * are injected here; chrome-lifecycle.test.ts runs the real smoke launch.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const NOW = new Date("2026-11-17T16:00:00.000Z");
const chrome = () => ({
  path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  version: "157.0.8103.79",
});
const smoke = async () => 840;

async function doctor(over: Parameters<typeof runDoctor>[0] = {}) {
  return runDoctor({ env: sb.env, platform: "darwin", chrome, smoke, now: NOW, ...over });
}

const find = (checks: DoctorCheck[], area: string, text: RegExp) =>
  checks.find((c) => c.area === area && text.test(c.text));

describe("browser doctor: Chrome and the system", () => {
  it("reports Chrome with its version and a smoke launch on a temporary profile", async () => {
    const { checks } = await doctor();
    expect(checks.slice(0, 3)).toEqual([
      {
        area: "chrome",
        level: "ok",
        text: "Google Chrome 157.0.8103.79 at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      { area: "chrome", level: "ok", text: "smoke launch: Chrome started and closed in 0.8s on a temporary profile" },
      {
        area: "system",
        level: "ok",
        text: "macOS: driving Chrome through its DevTools pipe needs no Accessibility or Screen Recording permission",
      },
    ]);
  });

  it("fails without Chrome, and when the smoke launch fails", async () => {
    const { checks } = await doctor({
      chrome: () => undefined,
      smoke: async () => {
        throw new Error("browserType.launchPersistentContext: Chromium distribution 'chrome' is not found\nmore");
      },
    });
    expect(find(checks, "chrome", /not found/)).toMatchObject({
      level: "fail",
      text: "Google Chrome not found",
      manual: expect.stringMatching(/install Google Chrome/),
    });
    expect(find(checks, "chrome", /smoke launch/)).toMatchObject({
      level: "fail",
      text: "smoke launch failed: browserType.launchPersistentContext: Chromium distribution 'chrome' is not found",
    });
  });

  it("skips the smoke launch when asked", async () => {
    let launched = false;
    const { checks } = await doctor({
      launch: false,
      smoke: async () => {
        launched = true;
        return 1;
      },
    });
    expect(launched).toBe(false);
    expect(find(checks, "chrome", /smoke launch/)).toMatchObject({
      level: "info",
      text: "smoke launch skipped (--no-launch)",
    });
  });

  it("warns that a headed Chrome needs the desktop session over SSH, or a display on Linux", async () => {
    const ssh = await doctor({ env: { ...sb.env, SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" } });
    expect(find(ssh.checks, "system", /SSH/)).toMatchObject({ level: "warn" });
    const linux = await doctor({ platform: "linux" });
    expect(find(linux.checks, "system", /display/)).toMatchObject({
      level: "warn",
      manual: expect.stringMatching(/--headless/),
    });
    const withDisplay = await doctor({ platform: "linux", env: { ...sb.env, DISPLAY: ":0" } });
    expect(find(withDisplay.checks, "system", /display/)).toMatchObject({ level: "ok" });
  });

  it("reads Chrome's version from its Info.plist", () => {
    const plist = `<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Chrome</string>
      <key>CFBundleShortVersionString</key>
      <string>157.0.8103.79</string></dict></plist>`;
    expect(chromeVersionFromPlist(plist)).toBe("157.0.8103.79");
    expect(chromeVersionFromPlist("<plist/>")).toBeUndefined();
  });
});

describe("browser doctor: identities", () => {
  it("says how to make one when there is none", async () => {
    const { checks } = await doctor();
    expect(find(checks, "identities", /no browser identities/)).toMatchObject({
      level: "info",
      fix: "turno-browser add <id>",
    });
  });

  it("checks a healthy identity: settings, free, signed in", async () => {
    addIdentity("school", sb.env, {
      timezone: "Europe/Madrid",
      languages: ["es-ES", "es"],
      region: "ES",
      health: { url: "https://mail.example.com/", text: "Inbox" },
    });
    writeHealth("school", sb.env, {
      status: "ok",
      url: "https://mail.example.com/",
      checkedAt: "2026-11-17T15:50:00.000Z",
    });
    const { checks } = await doctor();
    expect(checks.filter((c) => c.area === "identity school")).toEqual([
      {
        area: "identity school",
        level: "ok",
        text: "identity.json: time zone Europe/Madrid, languages es-ES, es, region ES",
      },
      { area: "identity school", level: "ok", text: "not in use: no process holds it" },
      {
        area: "identity school",
        level: "info",
        text: "never signed in by hand here: the agent starts signed out on every site",
        fix: "turno-browser login school",
      },
      {
        area: "identity school",
        level: "ok",
        text: "signed in at https://mail.example.com/ (checked 2026-11-17T15:50:00.000Z)",
      },
    ]);
  });

  it("explains a missing identity.json and health check, with the optional commands", async () => {
    mkdirSync(identityDir("old", sb.env), { recursive: true });
    const { checks } = await doctor();
    expect(find(checks, "identity old", /identity\.json/)).toEqual({
      area: "identity old",
      level: "info",
      text: "no identity.json: Chrome's own time zone and languages, which follow this computer",
      fix: `turno-browser set old --timezone ${systemTimezone()}`,
    });
    expect(find(checks, "identity old", /health/)).toMatchObject({
      level: "info",
      fix: "turno-browser set old --health-url <url> --health-text <text>",
    });
  });

  it("fails an invalid identity.json with every problem and where it is", async () => {
    addIdentity("bad", sb.env);
    writeFileSync(
      identitySettingsPath("bad", sb.env),
      JSON.stringify({ version: 1, timezone: "Nowhere/City", created: NOW.toISOString(), updated: NOW.toISOString() }),
    );
    const { checks } = await doctor();
    expect(find(checks, "identity bad", /identity\.json/)).toMatchObject({
      level: "fail",
      text: 'identity.json is invalid: timezone "Nowhere/City" is not an IANA time zone (for example "Europe/Madrid")',
      fix: "turno-browser set bad --timezone <zone>",
    });
  });

  it("fails NEEDS_AUTH with the login command, and warns when the check could not run", async () => {
    addIdentity("bank", sb.env, { health: { url: "https://bank.example.com/", selector: "#account" } });
    writeHealth("bank", sb.env, {
      status: "needs_auth",
      url: "https://bank.example.com/",
      checkedAt: NOW.toISOString(),
      detail: "no element matched #account",
    });
    const { checks } = await doctor();
    expect(find(checks, "identity bank", /NEEDS_AUTH/)).toEqual({
      area: "identity bank",
      level: "fail",
      text: `NEEDS_AUTH: not signed in at https://bank.example.com/: no element matched #account (checked ${NOW.toISOString()})`,
      fix: "turno-browser login bank",
    });
    writeHealth("bank", sb.env, {
      status: "error",
      url: "https://bank.example.com/",
      checkedAt: NOW.toISOString(),
      detail: "could not load the page: net::ERR_NAME_NOT_RESOLVED",
    });
    expect(find((await doctor()).checks, "identity bank", /health check/)).toMatchObject({
      level: "warn",
      text: expect.stringContaining("net::ERR_NAME_NOT_RESOLVED"),
    });
  });

  it("names who holds an identity in use, and repairs a stale runtime lock with --fix", async () => {
    addIdentity("school", sb.env);
    const held = acquireRuntimeLock("school", sb.env, { holder: "mcp", now: NOW });
    held.update({ chromePid: 4242, pgid: 4242 });
    expect(find((await doctor()).checks, "identity school", /in use/)).toMatchObject({
      level: "ok",
      text: `in use by turno-browser-mcp (pid ${process.pid}, Chrome pid 4242) since ${NOW.toISOString()}`,
    });
    held.release();

    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(
      runtimeLockPath("school", sb.env),
      JSON.stringify({ nodePid: gone.pid, holder: "mcp", startedAt: NOW.toISOString() }),
    );
    const stale = find((await doctor()).checks, "identity school", /stale/);
    expect(stale).toMatchObject({ level: "warn", fix: "turno-browser doctor --fix", auto: true });
    const fixed = await doctor({ fix: true });
    expect(fixed.fixed).toEqual([`school: removed the stale runtime lock of pid ${gone.pid}`]);
    expect(existsSync(runtimeLockPath("school", sb.env))).toBe(false);
    expect(find(fixed.checks, "identity school", /not in use/)).toMatchObject({ level: "ok" });
  });

  it("names a running background server and the command that stops it", async () => {
    addIdentity("school", sb.env);
    expect(find((await doctor()).checks, "identity school", /background server/)).toBeUndefined();
    const dir = backgroundDir("school", sb.env);
    mkdirSync(dir, { recursive: true });
    // This test's own pid stands for a live server.
    const state = {
      v: 1,
      pid: process.pid,
      identity: "school",
      version: "0.0.0",
      startedAt: NOW.toISOString(),
      idleMs: 900_000,
      transport: "socket",
      socket: join(dir, "sock"),
    };
    writeFileSync(join(dir, "server.json"), JSON.stringify(state));
    expect(find((await doctor()).checks, "identity school", /background server/)).toEqual({
      area: "identity school",
      level: "info",
      text: `background server (pid ${process.pid}) since ${NOW.toISOString()} serves it to turno-browser do; an agent's server of this identity cannot open the browser until it stops; it exits after 15m without a request`,
      fix: "turno-browser background stop school",
    });
  });

  it("treats a profile lock of a Chrome that is gone as free", async () => {
    addIdentity("school", sb.env);
    // A lock left by a Chrome that is gone: Chrome clears it on the next start, nothing to do.
    symlinkSync(`${hostname()}-999999`, join(identityDir("school", sb.env), "SingletonLock"));
    expect(find((await doctor()).checks, "identity school", /not in use/)).toMatchObject({ level: "ok" });
  });

  it("summarizes recent challenges and points at the reputation report", async () => {
    addIdentity("school", sb.env);
    recordChallenge(
      "school",
      sb.env,
      { site: "a.example", kind: "captcha", markers: ["captcha"] },
      new Date(NOW.getTime() - 86_400_000),
    );
    recordChallenge("school", sb.env, { site: "b.example", kind: "verify", markers: ["verify it's you"] }, NOW);
    expect(find((await doctor()).checks, "identity school", /challenge/)).toEqual({
      area: "identity school",
      level: "warn",
      text: "2 challenges in the last 7 days on 2 sites (1 captcha, 1 verify)",
      fix: "turno-browser reputation school",
    });
  });
});

describe("browser doctor: mcp.toml against the identity's sharing", () => {
  const shared = (over: Partial<{ exclusive: boolean; scope: string; sharing: string }> = {}) => ({
    name: "browser-work",
    identity: "work",
    exclusive: false,
    scope: "shared",
    ...over,
  });
  const warned = async (servers: ReturnType<typeof shared>[]) =>
    find((await doctor({ servers })).checks, "identity work", /lets several sessions in/);

  it("warns when a one-session identity is served to several sessions at once", async () => {
    addIdentity("work", sb.env);
    expect(await warned([shared()])).toEqual({
      area: "identity work",
      level: "warn",
      text: '[server.browser-work] in mcp.toml lets several sessions in (exclusive = false), but this identity serves one at a time ("sharing": "session"), so those sessions share one current tab',
      fix: "turno-browser set work --sharing tabs",
    });
  });

  it("says nothing for exclusive servers, one server per session, --sharing tabs, or another identity", async () => {
    addIdentity("work", sb.env);
    expect(await warned([shared({ exclusive: true })])).toBeUndefined();
    expect(await warned([shared({ scope: "session" })])).toBeUndefined();
    expect(await warned([shared({ sharing: "tabs" })])).toBeUndefined();
    expect(await warned([{ ...shared(), identity: "school" }])).toBeUndefined();
    writeFileSync(identitySettingsPath("work", sb.env), JSON.stringify({ format: 7, sharing: "tabs" }));
    expect(await warned([shared()])).toBeUndefined();
  });
});

/** A secret store in memory: lookups only, as the doctor makes them. */
function memoryStore(items: string[], fail = false): SecretStore {
  const have = new Set(items);
  return {
    kind: "keychain",
    label: "macOS Keychain",
    get: async () => {
      throw new Error("the doctor never reads a value");
    },
    has: async (s) => {
      if (fail) throw new Error("User interaction is not allowed.");
      return have.has(s);
    },
    set: async () => {
      throw new Error("the doctor never writes");
    },
    remove: async () => {
      throw new Error("the doctor never deletes");
    },
  };
}

describe("browser doctor: the vault's credentials in the secret store", () => {
  async function withVault() {
    addIdentity("school", sb.env);
    const store = memoryStore([]);
    const fake = { ...store, set: async () => undefined, remove: async () => false };
    for (const site of ["canvas", "github"])
      await vaultAdd(
        "school",
        site,
        { urls: [`https://${site}.example.com/login`], username: "u", password: "p" },
        {
          env: sb.env,
          store: fake,
        },
      );
  }

  it("is quiet for an empty vault, ok when every item is there, fails for a missing one or no store, warns when locked", async () => {
    addIdentity("empty", sb.env);
    const none = await doctor({ secrets: memoryStore([]) });
    expect(none.checks.filter((c) => /vault/.test(c.text))).toEqual([]);
    await withVault();
    const all = await doctor({ secrets: memoryStore([vaultItem("school", "canvas"), vaultItem("school", "github")]) });
    expect(
      find(all.checks, "identity school", /^vault: macOS Keychain has the credentials of canvas, github$/)?.level,
    ).toBe("ok");
    const some = await doctor({ secrets: memoryStore([vaultItem("school", "canvas")]) });
    const missing = find(some.checks, "identity school", /no item for the credentials of github/);
    expect(missing).toMatchObject({ level: "fail", fix: expect.stringContaining("vault add school github") });
    const locked = await doctor({ secrets: memoryStore([], true) });
    expect(find(locked.checks, "identity school", /did not answer for the vault: User interaction/)?.level).toBe(
      "warn",
    );
    const linux = await doctor({ platform: "linux", env: { ...sb.env, PATH: "/nonexistent" } });
    expect(find(linux.checks, "identity school", /the vault has 2 credentials .* this machine has none/)?.level).toBe(
      "fail",
    );
  });
});

describe("browser doctor: the agents that have each identity", () => {
  const agents = () => browserEntries(sb.env);

  it("names each agent with the identity, and the ones without", async () => {
    addIdentity("school", sb.env);
    addIdentity("work", sb.env);
    sb.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: { "browser-school": { command: "turno-browser-mcp", args: ["--identity", "school"] } },
      }),
    );
    const bin = join(sb.home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "turno-browser-mcp"), "#!/bin/sh\n", { mode: 0o755 });
    const env = { ...sb.env, PATH: `${bin}:${sb.env.PATH}` };
    const { checks } = await doctor({ env, agents: browserEntries(env) });
    expect(find(checks, "identity school", /^Claude Code has it \(browser-school in ~\/\.claude\.json\)$/)?.level).toBe(
      "ok",
    );
    expect(find(checks, "identity work", /no agent here has browser-work/)?.level).toBe("info");
  });

  it("warns about a server whose command is gone, one whose identity is gone, and a broken config", async () => {
    addIdentity("school", sb.env);
    sb.write(
      ".claude.json",
      JSON.stringify({
        mcpServers: {
          "browser-school": { command: "/gone/turno-browser-mcp", args: ["--identity", "school"] },
          "browser-old": { command: "turno-browser-mcp", args: ["--identity", "old"] },
          "browser-use": { command: "uvx", args: ["browser-use"] },
        },
      }),
    );
    sb.write(".cursor/mcp.json", "{ not json");
    const { checks } = await doctor({ agents: agents() });
    expect(
      find(checks, "identity school", /runs browser-school with \/gone\/turno-browser-mcp, which is not there/),
    ).toMatchObject({
      level: "warn",
      fix: "turno-browser setup claude-code --identity school",
    });
    expect(find(checks, "agents", /still has the MCP server browser-old .* no identity "old"/)).toMatchObject({
      level: "warn",
      fix: "claude mcp remove --scope user browser-old",
    });
    expect(find(checks, "agents", /could not read Cursor's config ~\/\.cursor\/mcp\.json: not valid JSON/)?.level).toBe(
      "warn",
    );
    // browser-use is not turno's: no identity "use" is asked about.
    expect(checks.some((c) => /browser-use/.test(c.text))).toBe(false);
  });

  it("warns when an agent lost a server init registered", async () => {
    addIdentity("school", sb.env);
    recordRegistration("school", sb.env, {
      agent: "claude-code",
      server: "browser-school",
      file: join(sb.home, ".claude.json"),
      at: NOW.toISOString(),
    });
    sb.write(".claude.json", JSON.stringify({ mcpServers: {} }));
    const { checks } = await doctor({ agents: agents() });
    expect(
      find(checks, "identity school", /Claude Code no longer has browser-school, which init registered/),
    ).toMatchObject({
      level: "warn",
    });
  });
});
