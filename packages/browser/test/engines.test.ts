import { chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildArgv, extractEngine } from "../src/argv.js";
import { fixReply } from "../src/cdp-relay.js";
import { engineChoice, tuningClash } from "../src/engine.js";
import {
  defaultChromeUserDataDir,
  parseAttachTarget,
  parseDevToolsActivePort,
  resolveAttachEndpoint,
} from "../src/engine-attach.js";
import {
  READ_MODE_TOOLS,
  findLightpanda,
  lightpandaInstallHint,
  lightpandaMissing,
  readModeRefusal,
} from "../src/engine-lightpanda.js";
import { IDENTITY_FORMAT_VERSION, checkIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import { TURNO_TOOLS, allOptInTools } from "../src/tools.js";
import { upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The engine module without a browser: which engine a launch picks, attach targets and
 * `DevToolsActivePort`, Lightpanda discovery and the read mode tool list, the CDP relay's fix,
 * the server flags and the identity.json keys. The engines against real browsers are in
 * attach.test.ts and lightpanda.test.ts.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("engineChoice", () => {
  it("runs the default engine when nothing asks for another", () => {
    expect(engineChoice({}, undefined)).toEqual({ kind: "default" });
    expect(engineChoice({}, { engine: "chrome" })).toEqual({ kind: "default" });
  });

  it("takes identity.json's engine or attach", () => {
    expect(engineChoice({}, { engine: "lightpanda" })).toEqual({ kind: "lightpanda" });
    expect(engineChoice({}, { attach: "auto" })).toEqual({ kind: "attach", target: { kind: "auto" } });
  });

  it("lets a server flag win over both identity.json keys", () => {
    expect(engineChoice({ engine: "chrome" }, { attach: "auto" })).toEqual({ kind: "default" });
    expect(engineChoice({ engine: "lightpanda" }, { attach: "auto" })).toEqual({ kind: "lightpanda" });
    expect(engineChoice({ attach: "http://127.0.0.1:9222" }, { engine: "lightpanda" })).toEqual({
      kind: "attach",
      target: { kind: "endpoint", url: "http://127.0.0.1:9222" },
    });
  });

  it("refuses attach together with lightpanda, and a bad target", () => {
    expect(() => engineChoice({ engine: "lightpanda", attach: "auto" }, undefined)).toThrow(/pick one/);
    expect(() => engineChoice({}, { attach: "http://example.com:9222" })).toThrow(/on this computer/);
  });
});

describe("attach targets", () => {
  it("reads auto, a user data dir and a loopback endpoint", () => {
    expect(parseAttachTarget("auto")).toEqual({ kind: "auto" });
    expect(parseAttachTarget("/tmp/chrome-profile")).toEqual({ kind: "dir", dir: "/tmp/chrome-profile" });
    expect(parseAttachTarget("ws://localhost:9222/devtools/browser/x")).toMatchObject({ kind: "endpoint" });
    expect(parseAttachTarget("http://[::1]:9222")).toMatchObject({ kind: "endpoint" });
  });

  it("refuses a remote host, a relative path and other words", () => {
    expect(parseAttachTarget("http://192.168.1.5:9222")).toHaveProperty("error");
    expect(parseAttachTarget("profile")).toHaveProperty("error");
    expect(parseAttachTarget("yes")).toHaveProperty("error");
  });

  it("parses DevToolsActivePort and treats an empty, one-line or non-numeric file as not written yet", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc\n")).toEqual({
      port: 9222,
      path: "/devtools/browser/abc",
    });
    expect(parseDevToolsActivePort("")).toBeUndefined();
    expect(parseDevToolsActivePort("9222\n")).toBeUndefined();
    expect(parseDevToolsActivePort("x\n/y")).toBeUndefined();
  });

  it("resolves a dir through its DevToolsActivePort, and says how to turn debugging on when it is missing", async () => {
    const dir = join(sb.home, "chrome");
    sb.write("chrome/DevToolsActivePort", "51234\n/devtools/browser/0000\n");
    await expect(resolveAttachEndpoint({ kind: "dir", dir })).resolves.toBe(
      "ws://127.0.0.1:51234/devtools/browser/0000",
    );
    await expect(
      resolveAttachEndpoint({ kind: "dir", dir: join(sb.home, "none") }, sb.env, "darwin", 0),
    ).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
    await expect(resolveAttachEndpoint({ kind: "auto" }, sb.env, "darwin", 0)).rejects.toThrow(/no DevToolsActivePort/);
  });

  it("waits while Chrome is still writing DevToolsActivePort, and says so when the wait ends", async () => {
    const dir = join(sb.home, "chrome");
    sb.write("chrome/DevToolsActivePort", "");
    const resolving = resolveAttachEndpoint({ kind: "dir", dir }, sb.env, "darwin", 5_000);
    setTimeout(() => sb.write("chrome/DevToolsActivePort", "51234\n/devtools/browser/0000"), 100);
    await expect(resolving).resolves.toBe("ws://127.0.0.1:51234/devtools/browser/0000");

    sb.write("chrome/DevToolsActivePort", "51234\n");
    await expect(resolveAttachEndpoint({ kind: "dir", dir }, sb.env, "darwin", 200)).rejects.toThrow(
      /is still not a port and a path after 0.2s/,
    );
  });

  it("knows the default Chrome profile of each platform", () => {
    expect(defaultChromeUserDataDir(sb.env, "darwin")).toBe(
      join(sb.home, "Library", "Application Support", "Google", "Chrome"),
    );
    expect(defaultChromeUserDataDir(sb.env, "linux")).toBe(join(sb.home, ".config", "google-chrome"));
  });
});

describe("Lightpanda discovery and read mode", () => {
  function fakeLightpanda(dir: string): string {
    const file = sb.write(`${dir}/lightpanda`, '#!/bin/sh\necho "1.1.0-nightly.1+test"\n');
    chmodSync(file, 0o755);
    return file;
  }

  it("finds lightpanda on PATH, or at TURNO_LIGHTPANDA_PATH, with its version", () => {
    const onPath = fakeLightpanda("bin");
    expect(findLightpanda({ ...sb.env, PATH: join(sb.home, "bin") })).toEqual({
      path: onPath,
      version: "1.1.0-nightly.1+test",
    });
    const configured = fakeLightpanda("opt");
    expect(findLightpanda({ ...sb.env, PATH: "", TURNO_LIGHTPANDA_PATH: configured })?.path).toBe(configured);
  });

  it("finds nothing when it is missing or the configured path is relative", () => {
    expect(findLightpanda({ ...sb.env, PATH: join(sb.home, "empty") })).toBeUndefined();
    fakeLightpanda("bin");
    expect(findLightpanda({ ...sb.env, TURNO_LIGHTPANDA_PATH: "bin/lightpanda" })).toBeUndefined();
  });

  it("says how to install it and that turno never downloads it", () => {
    expect(lightpandaInstallHint("darwin")).toBe("brew install lightpanda-io/browser/lightpanda");
    expect(lightpandaInstallHint("linux", "x64")).toBe(
      "curl -fL --create-dirs -o ~/.local/bin/lightpanda https://github.com/lightpanda-io/browser/releases/download/nightly/lightpanda-x86_64-linux && chmod +x ~/.local/bin/lightpanda",
    );
    expect(lightpandaInstallHint("linux", "arm64")).toContain("lightpanda-aarch64-linux");
    expect(lightpandaInstallHint("win32")).toMatch(/no build for this platform/);
    expect(lightpandaMissing({ PATH: "" }).message).toMatch(/not on PATH.*never downloads/);
  });

  it("runs the reading tools and refuses the rest with the reason", () => {
    for (const tool of ["browser_navigate", "browser_snapshot", "browser_click", "browser_evaluate", "browser_batch"])
      expect(readModeRefusal(tool)).toBeUndefined();
    expect(readModeRefusal("browser_take_screenshot")).toMatch(/does not lay pages out.*browser_snapshot/);
    expect(readModeRefusal("browser_login")).toMatch(/read mode/);
    expect(readModeRefusal("browser_something_new")).toMatch(/not checked against Lightpanda/);
  });

  it("names only tools that exist upstream or in turno's registry", () => {
    const stock = new Set(upstream().tools.browserTools.map((t) => t.schema.name));
    const turno = new Set([...TURNO_TOOLS, ...allOptInTools()].map((t) => t.schema.name));
    for (const tool of READ_MODE_TOOLS) expect(stock.has(tool) || turno.has(tool), tool).toBe(true);
  });
});

describe("CDP relay fixes", () => {
  it("turns an empty DOM.getDocument reply into a protocol error and passes the rest", () => {
    expect(fixReply("DOM.getDocument", { id: 16, sessionId: "S", result: {} })).toEqual({
      id: 16,
      sessionId: "S",
      error: { code: -32000, message: "No document on this target" },
    });
    expect(fixReply("DOM.getDocument", { id: 1, result: { root: { nodeId: 1 } } })).toBeUndefined();
    expect(fixReply("Page.navigate", { id: 2, result: {} })).toBeUndefined();
  });
});

describe("server flags", () => {
  it("takes --engine and --attach out of the Playwright flags", () => {
    expect(extractEngine(["--engine", "lightpanda", "--headless"])).toEqual({
      engineFlags: { engine: "lightpanda" },
      rest: ["--headless"],
    });
    expect(extractEngine(["--attach=auto"])).toEqual({ engineFlags: { attach: "auto" }, rest: [] });
    expect(extractEngine(["--headless"])).toEqual({ rest: ["--headless"] });
  });

  it("refuses a bad engine, a bad target and the two together", () => {
    expect(() => extractEngine(["--engine", "firefox"])).toThrow(/"chrome", "lightpanda" \(read mode\) or "camoufox"/);
    expect(() => extractEngine(["--attach", "http://10.0.0.2:9222"])).toThrow(/^--attach/);
    expect(() => extractEngine(["--attach"])).toThrow(/needs a value/);
    expect(() => extractEngine(["--engine", "lightpanda", "--attach", "auto"])).toThrow(/pick one/);
  });

  it("creates no Chrome profile for read or attach mode without an identity", () => {
    const made: string[] = [];
    const tmp = () => {
      made.push("x");
      return join(sb.home, "tmp");
    };
    const lp = buildArgv(["--engine", "lightpanda"], { env: sb.env, makeTempDir: tmp });
    expect(lp.userDataDir).toBeUndefined();
    expect(lp.args).not.toContain("--user-data-dir");
    expect(lp.engineFlags).toEqual({ engine: "lightpanda" });
    // The idle limit still applies: it closes Lightpanda, or disconnects from the user's Chrome.
    expect(lp.config?.data.timeouts.idle).toBeGreaterThan(0);
    const withId = buildArgv(["--identity", "work", "--attach", "auto"], { env: sb.env, makeTempDir: tmp });
    expect(withId.userDataDir).toContain("work");
    expect(() => buildArgv(["--attach", "auto", "--cdp-endpoint", "http://127.0.0.1:1"], { env: sb.env })).toThrow(
      /cannot be combined with --cdp-endpoint/,
    );
  });
});

describe("identity.json engine and attach", () => {
  it("writes them as format 6 and validates them", () => {
    expect(IDENTITY_FORMAT_VERSION).toBeGreaterThanOrEqual(6);
    const s = writeIdentitySettings("reader", { engine: "lightpanda" }, sb.env);
    expect(s).toMatchObject({ version: 6, engine: "lightpanda" });
    expect(() => writeIdentitySettings("reader", { attach: "auto" }, sb.env)).toThrow(/pick one/);
    expect(() => writeIdentitySettings("mine", { engine: "firefox" as never }, sb.env)).toThrow(/engine must be/);
    expect(() => writeIdentitySettings("mine", { attach: "remote" }, sb.env)).toThrow(/attach must be/);
    expect(writeIdentitySettings("mine", { attach: "auto" }, sb.env)).toMatchObject({ version: 6, attach: "auto" });
    expect(writeIdentitySettings("mine", { attach: null }, sb.env).version).toBe(1);
  });

  it("keeps humanize (format 4) and sharing (format 5) and refuses the pairs that cannot work", () => {
    expect(writeIdentitySettings("mine", { humanize: { level: "light" } }, sb.env).version).toBe(4);
    expect(writeIdentitySettings("mine", { sharing: "tabs" }, sb.env).version).toBe(5);
    expect(() => writeIdentitySettings("mine", { attach: "auto" }, sb.env)).toThrow(
      /attach does not go with sharing "tabs"/,
    );
    expect(writeIdentitySettings("mine", { sharing: null, humanize: null, engine: "lightpanda" }, sb.env).version).toBe(
      6,
    );
    expect(() => writeIdentitySettings("mine", { humanize: { level: "light" } }, sb.env)).toThrow(
      /humanize does not go with engine "lightpanda"/,
    );
    // Read mode and sharing go together.
    expect(writeIdentitySettings("reader2", { engine: "lightpanda", sharing: "tabs" }, sb.env)).toMatchObject({
      version: 6,
      sharing: "tabs",
    });
  });

  it("refuses the same pairs when they come from server flags", () => {
    const humanize = { level: "off" as const };
    expect(tuningClash("attach", { sharing: "tabs", humanize })).toMatch(/does not go with attach mode/);
    expect(tuningClash("lightpanda", { sharing: "tabs", humanize })).toBeUndefined();
    expect(tuningClash("lightpanda", { sharing: "session", humanize: { level: "full" } })).toMatch(
      /humanize does not go with read mode/,
    );
    expect(tuningClash("attach", { sharing: "session", humanize: { level: "full" } })).toBeUndefined();
    expect(tuningClash("chrome", { sharing: "tabs", humanize: { level: "full" } })).toBeUndefined();
  });

  it("reads a hand-written format 6 file", () => {
    sb.write(
      ".local/share/turno/browser/identities/old.json",
      JSON.stringify({
        version: 6,
        engine: "lightpanda",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      }),
    );
    expect(checkIdentitySettings("old", sb.env)).toMatchObject({ problems: [], settings: { engine: "lightpanda" } });
  });
});
