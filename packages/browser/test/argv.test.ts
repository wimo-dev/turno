import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_IDLE_MS, buildArgv, extractIdentity, parseIdle } from "../src/argv.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const fakeTemp = () => "/tmp/turno-browser-test";

describe("buildArgv", () => {
  it("adds the chrome channel and a temporary profile without an identity", () => {
    const b = buildArgv([], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual([
      "--browser",
      "chrome",
      "--user-data-dir",
      "/tmp/turno-browser-test/profile",
      "--config",
      "/tmp/turno-browser-test/mcp-config.json",
    ]);
    expect(b.tempDir).toBe("/tmp/turno-browser-test");
    expect(b.identity).toBeUndefined();
  });

  it("returns turno's tuning flags apart and never passes them to upstream", () => {
    const b = buildArgv(["--identity", "school", "--max-tabs", "3", "--headless"], {
      env: sb.env,
      makeTempDir: fakeTemp,
    });
    expect(b.tuning).toEqual({ maxTabs: 3 });
    expect(b.args).not.toContain("--max-tabs");
    expect(b.args).toContain("--headless");
  });

  it("takes --live and --live-wait out for the host, only with an identity", () => {
    const b = buildArgv(["--identity", "school", "--live", "--live-wait=90s", "--headless"], {
      env: sb.env,
      makeTempDir: fakeTemp,
    });
    expect(b.live).toEqual({ live: true, waitMs: 90_000 });
    expect(b.args.some((a) => a.startsWith("--live"))).toBe(false);
    expect(buildArgv(["--identity", "school", "--live-wait", "5s"], { env: sb.env }).live).toEqual({ waitMs: 5_000 });
    expect(() => buildArgv(["--live"], { env: sb.env, makeTempDir: fakeTemp })).toThrow(
      "--live and --live-wait apply only with --identity",
    );
    expect(() => buildArgv(["--identity", "school", "--live-wait", "1s"], { env: sb.env })).toThrow(
      '--live-wait must be a duration from "5s" to "30m", like "2m", not "1s"',
    );
    expect(() => buildArgv(["--identity", "school", "--live=yes"], { env: sb.env })).toThrow("--live takes no value");
  });

  it("uses the identity dir under the data dir", () => {
    const b = buildArgv(["--identity", "school"], { env: sb.env, makeTempDir: fakeTemp });
    const dir = join(sb.home, ".local", "share", "turno", "browser", "identities", "school");
    const config = join(sb.home, ".local", "state", "turno", "browser", "identities", "school", "mcp-config.json");
    expect(b.args).toEqual(["--browser", "chrome", "--user-data-dir", dir, "--config", config]);
    expect(b.identity).toBe("school");
    expect(b.tempDir).toBeUndefined();
  });

  it("honors XDG_DATA_HOME and the --identity=<id> form", () => {
    const env = { ...sb.env, XDG_DATA_HOME: join(sb.home, "xdg") };
    const b = buildArgv(["--identity=bank"], { env });
    expect(b.userDataDir).toBe(join(sb.home, "xdg", "turno", "browser", "identities", "bank"));
  });

  it("never adds headless, viewport or init-script flags", () => {
    const b = buildArgv(["--identity", "work"], { env: sb.env });
    expect(b.args.join(" ")).not.toMatch(/--headless|--viewport-size|--init-script|--isolated/);
  });

  it("keeps user flags and lets them win over defaults", () => {
    const b = buildArgv(["--browser", "msedge", "--user-data-dir", "/x/profile", "--headless"], {
      env: sb.env,
      makeTempDir: fakeTemp,
    });
    expect(b.args.slice(0, 5)).toEqual(["--browser", "msedge", "--user-data-dir", "/x/profile", "--headless"]);
    expect(b.userDataDir).toBeUndefined();
  });

  it("accepts the --flag=value form as an override", () => {
    const b = buildArgv(["--browser=chrome-beta"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args.filter((a) => a.startsWith("--browser"))).toEqual(["--browser=chrome-beta"]);
  });

  it("adds nothing browser-related when attaching to an external browser", () => {
    const b = buildArgv(["--cdp-endpoint", "http://127.0.0.1:9222"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual(["--cdp-endpoint", "http://127.0.0.1:9222"]);
  });

  it("keeps --isolated in memory without a profile dir", () => {
    const b = buildArgv(["--isolated"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args).toEqual([
      "--isolated",
      "--browser",
      "chrome",
      "--config",
      "/tmp/turno-browser-test/mcp-config.json",
    ]);
    expect(b.userDataDir).toBeUndefined();
    expect(b.tempDir).toBe("/tmp/turno-browser-test");
  });

  it("rejects an identity combined with another profile source", () => {
    expect(() => buildArgv(["--identity", "school", "--user-data-dir", "/x"], { env: sb.env })).toThrow(
      /cannot be combined/,
    );
    expect(() => buildArgv(["--identity", "school", "--isolated"], { env: sb.env })).toThrow(/cannot be combined/);
  });

  it("rejects invalid or missing identity values", () => {
    expect(() => extractIdentity(["--identity"])).toThrow(/needs a value/);
    expect(() => extractIdentity(["--identity", "../etc"])).toThrow(/invalid identity/);
    expect(() => extractIdentity(["--identity", "School"])).toThrow(/invalid identity/);
  });

  it("refuses to serve a signed-in identity over HTTP without an explicit opt-in", () => {
    expect(() => buildArgv(["--identity", "school", "--port", "8931"], { env: sb.env })).toThrow(
      /--allow-http-identity/,
    );
    expect(() => buildArgv(["--identity=school", "--port=8931"], { env: sb.env })).toThrow(/--allow-http-identity/);
    expect(() => buildArgv(["--identity", "school", "--host", "127.0.0.1"], { env: sb.env })).toThrow(
      /--allow-http-identity/,
    );
  });

  it("with --allow-http-identity binds to 127.0.0.1 only and drops the turno flag", () => {
    const b = buildArgv(["--identity", "school", "--port", "8931", "--allow-http-identity"], { env: sb.env });
    expect(b.args).not.toContain("--allow-http-identity");
    expect(b.args.slice(0, 4)).toEqual(["--port", "8931", "--host", "127.0.0.1"]);
    const local = buildArgv(
      ["--identity", "school", "--port", "8931", "--host", "localhost", "--allow-http-identity"],
      { env: sb.env },
    );
    expect(local.args.filter((a) => a === "--host")).toHaveLength(1);
  });

  it("never serves an identity on a public address or with the host check off", () => {
    const opt = ["--identity", "school", "--port", "8931", "--allow-http-identity"];
    expect(() => buildArgv([...opt, "--host", "0.0.0.0"], { env: sb.env })).toThrow(/loopback/);
    expect(() => buildArgv([...opt, "--host=192.168.1.5"], { env: sb.env })).toThrow(/loopback/);
    expect(() => buildArgv([...opt, "--allowed-hosts", "*"], { env: sb.env })).toThrow(/allowed-hosts/);
  });

  it("keeps --port without an identity (temporary profile, nothing signed in)", () => {
    const b = buildArgv(["--port", "8931"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.args.slice(0, 2)).toEqual(["--port", "8931"]);
    expect(() =>
      buildArgv(["--port", "8931", "--allow-http-identity"], { env: sb.env, makeTempDir: fakeTemp }),
    ).toThrow(/only with --identity/);
  });
});

describe("generated Playwright MCP config", () => {
  it("closes the browser after 15 idle minutes by default, headed included", () => {
    const b = buildArgv(["--identity", "school"], { env: sb.env });
    expect(DEFAULT_BROWSER_IDLE_MS).toBe(15 * 60_000);
    expect(b.config).toEqual({
      path: join(sb.home, ".local", "state", "turno", "browser", "identities", "school", "mcp-config.json"),
      data: { timeouts: { idle: DEFAULT_BROWSER_IDLE_MS } },
    });
    expect(b.args.join(" ")).not.toMatch(/--headless|--idle-timeout/);
  });

  it("takes the idle limit from TURNO_BROWSER_IDLE", () => {
    expect(buildArgv(["--identity", "school"], { env: { ...sb.env, TURNO_BROWSER_IDLE: "2s" } }).config?.data).toEqual({
      timeouts: { idle: 2000 },
    });
    expect(buildArgv(["--identity", "school"], { env: { ...sb.env, TURNO_BROWSER_IDLE: "0" } }).config?.data).toEqual({
      timeouts: { idle: 0 },
    });
    expect(() => buildArgv(["--identity", "school"], { env: { ...sb.env, TURNO_BROWSER_IDLE: "soon" } })).toThrow(
      /TURNO_BROWSER_IDLE/,
    );
  });

  it("marks an idle limit the user set, which the low-resource preset keeps", () => {
    expect(buildArgv(["--identity", "school"], { env: sb.env }).tuning?.idleSet).toBeUndefined();
    for (const [args, env] of [
      [[], { TURNO_BROWSER_IDLE: "30m" }],
      [[], { PLAYWRIGHT_MCP_IDLE_TIMEOUT: "60000" }],
      [["--idle-timeout", "60000"], {}],
      [["--config", "/x/pw.json"], {}],
    ] as const) {
      const b = buildArgv(["--identity", "school", ...args], { env: { ...sb.env, ...env } });
      expect(b.tuning?.idleSet).toBe(true);
    }
  });

  it("follows TURNO_STATE_DIR for the identity's config", () => {
    const b = buildArgv(["--identity", "school"], { env: { ...sb.env, TURNO_STATE_DIR: join(sb.home, "st") } });
    expect(b.config?.path).toBe(join(sb.home, "st", "browser", "identities", "school", "mcp-config.json"));
  });

  it("leaves a config of the user's own alone", () => {
    for (const flag of [["--config", "/x/pw.json"], ["--config=/x/pw.json"]]) {
      const b = buildArgv(["--identity", "school", ...flag], { env: sb.env });
      expect(b.config).toBeUndefined();
      expect(b.args.filter((a) => a.startsWith("--config"))).toHaveLength(1);
    }
    const env = buildArgv(["--identity", "school"], { env: { ...sb.env, PLAYWRIGHT_MCP_CONFIG: "/x/pw.json" } });
    expect(env.config).toBeUndefined();
    expect(env.args).not.toContain("--config");
  });

  it("adds no config for a browser it does not launch", () => {
    const b = buildArgv(["--cdp-endpoint", "http://127.0.0.1:9222"], { env: sb.env, makeTempDir: fakeTemp });
    expect(b.config).toBeUndefined();
  });

  it("parses idle durations", () => {
    expect(parseIdle("15m")).toBe(900_000);
    expect(parseIdle("90s")).toBe(90_000);
    expect(parseIdle("1h")).toBe(3_600_000);
    expect(parseIdle("500ms")).toBe(500);
    expect(parseIdle("0")).toBe(0);
    for (const bad of ["", "5", "-1m", "1.5m", "m", "1d"]) expect(() => parseIdle(bad)).toThrow();
  });
});
