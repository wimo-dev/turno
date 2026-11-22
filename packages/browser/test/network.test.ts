import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserPaths } from "turno-core/paths";
import { secretStore } from "turno-core/secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  camoufoxCacheDir,
  camoufoxRefusal,
  findCamoufox,
  findPlaywrightCore,
  playwrightMinor,
} from "../src/engine-camoufox.js";
import { type Engine, createEngine, engineChoice } from "../src/engine.js";
import { extractEngine } from "../src/argv.js";
import { runDoctor } from "../src/doctor.js";
import { chromeNetwork } from "../src/network-chrome.js";
import { addIdentity } from "../src/identities.js";
import {
  type ObservedIdentity,
  coherenceProblems,
  networkEngineClash,
  reducedUserAgent,
  resolveProxy,
} from "../src/network.js";
import { type IdentitySettings, readIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import type { McpConfig } from "../src/upstream.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The opt-in network and user agent settings (identity.json format 11) and the Camoufox engine,
 * without a browser: validation, the combinations refused before anything starts, reading the
 * proxy credentials from a fake secret store (never a real Keychain), the launch check of a
 * coherent user agent, and what `turno browser doctor` says. Secret values are compared, never
 * printed.
 */

let sb: Sandbox;
let store: FakeSecretStore;
beforeEach(() => {
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(() => sb.cleanup());

const PASSWORD = "Pr0xy pass&<word>";

describe("identity.json userAgent and proxy (format 11)", () => {
  it("takes userAgent coherent only, and writes format 11 while a format 11 key is set", () => {
    const s = writeIdentitySettings("ua", { userAgent: "coherent", timezone: "Europe/Madrid" }, sb.env);
    expect(s.version).toBe(11);
    expect(readIdentitySettings("ua", sb.env)?.userAgent).toBe("coherent");
    for (const bad of ["Mozilla/5.0 (Windows NT 10.0)", "windows", true])
      expect(() => writeIdentitySettings("ua", { userAgent: bad as "coherent" }, sb.env)).toThrow(
        /userAgent must be "coherent": turno builds the user agent from the installed Chrome and never takes a typed one/,
      );
    expect(writeIdentitySettings("ua", { userAgent: null }, sb.env).version).toBe(1);
  });

  it("checks the proxy: a URL with no credentials in it, the password only from the secret store", () => {
    const ok = writeIdentitySettings(
      "px",
      { proxy: { server: "http://proxy.example.com:8080", username: "alice", password: "keychain:proxy-pass" } },
      sb.env,
    );
    expect(ok.version).toBe(11);
    expect(ok.proxy).toEqual({
      server: "http://proxy.example.com:8080",
      username: "alice",
      password: "keychain:proxy-pass",
    });
    const refused: [unknown, RegExp][] = [
      [{ server: "ftp://proxy.example.com" }, /must start with http:\/\/, https:\/\/, socks4:\/\/ or socks5:\/\//],
      [{ server: "http://alice:secret@proxy.example.com:8080" }, /must not carry a user name or password/],
      [{ server: "not a url" }, /is not a URL/],
      [{ server: "http://proxy.example.com/path" }, /a host and port only/],
      [
        { server: "http://proxy.example.com", username: "alice", password: PASSWORD },
        /proxy\.password must be a keychain:<item> reference/,
      ],
      [{ server: "http://proxy.example.com", username: "alice" }, /proxy\.username needs proxy\.password/],
      [{ server: "http://proxy.example.com", password: "keychain:p" }, /proxy\.password needs proxy\.username/],
      [
        { server: "socks5://proxy.example.com:1080", username: "alice", password: "keychain:p" },
        /Chrome cannot sign in to a SOCKS proxy/,
      ],
      [{ server: "http://proxy.example.com", via: "x" }, /unknown key "proxy\.via"/],
      ["http://proxy.example.com", /proxy must be an object/],
    ];
    for (const [proxy, message] of refused)
      expect(() => writeIdentitySettings("px", { proxy: proxy as never }, sb.env)).toThrow(message);
    expect(() =>
      writeIdentitySettings(
        "px",
        { proxy: { server: "http://p.example.com", username: "a", password: "keychain:p" }, record: { traces: true } },
        sb.env,
      ),
    ).toThrow(/record\.traces does not go with a proxy password: a trace keeps the browser's launch options/);
    expect(
      writeIdentitySettings("rec", { proxy: { server: "http://p.example.com" }, record: { traces: true } }, sb.env)
        .version,
    ).toBe(11);
    // A refused write leaves the file as it was, so a literal password never lands on disk.
    expect(JSON.stringify(readIdentitySettings("px", sb.env))).not.toContain(PASSWORD);
  });

  it("refuses userAgent and proxy with attach and read mode, and userAgent with Camoufox", () => {
    expect(() =>
      writeIdentitySettings("c1", { proxy: { server: "http://p.example.com" }, attach: "auto" }, sb.env),
    ).toThrow(/proxy does not go with attach mode: that is your own Chrome/);
    expect(() => writeIdentitySettings("c2", { userAgent: "coherent", engine: "lightpanda" }, sb.env)).toThrow(
      /userAgent does not go with engine "lightpanda"/,
    );
    expect(() => writeIdentitySettings("c3", { userAgent: "coherent", engine: "camoufox" }, sb.env)).toThrow(
      /userAgent does not go with engine "camoufox": Camoufox is Firefox, which sends no client hints/,
    );
    const cf = writeIdentitySettings(
      "c4",
      { proxy: { server: "socks5://p.example.com:1080" }, engine: "camoufox" },
      sb.env,
    );
    expect(cf.version).toBe(11);
    expect(() => writeIdentitySettings("c5", { engine: "camoufox", attach: "auto" }, sb.env)).toThrow(
      /attach does not go with engine "camoufox"/,
    );
    expect(() => writeIdentitySettings("c6", { engine: "camoufox", keychain: "system" }, sb.env)).toThrow(
      /keychain does not go with engine "camoufox"/,
    );
    // Camoufox alone is format 11: an older turno-browser refuses it instead of misreading it.
    expect(writeIdentitySettings("c7", { engine: "camoufox" }, sb.env).version).toBe(11);
    // Captcha solving needs Patchright's script worlds; act and the live view's pause work.
    const captcha = { provider: "task-api", endpoint: "https://solver.example.com", key: "keychain:solver" } as const;
    expect(() => writeIdentitySettings("c8", { engine: "camoufox", captcha }, sb.env)).toThrow(
      /captcha does not go with engine "camoufox": the token is set from Patchright's isolated script world/,
    );
    expect(writeIdentitySettings("c9", { engine: "camoufox", act: {}, live: { enabled: true } }, sb.env).version).toBe(
      11,
    );
    expect(networkEngineClash("chrome", { userAgent: "coherent", proxy: {} })).toBeUndefined();
    expect(networkEngineClash("attach", { userAgent: "coherent", proxy: {} })).toMatch(
      /^userAgent and proxy do not go with attach mode/,
    );
  });
});

describe("the proxy credentials", () => {
  it("come from the secret store, and every form of them joins the redactor", async () => {
    store.write("proxy-pass", PASSWORD);
    store.write("proxy-user", "alice-zone-1");
    const hidden: [string, string][] = [];
    const resolved = await resolveProxy(
      { server: "http://127.0.0.1:3128", username: "keychain:proxy-user", password: "keychain:proxy-pass" },
      sb.env,
      (value, label) => hidden.push([value, label]),
    );
    expect(resolved.username).toBe("alice-zone-1");
    expect(resolved.password === PASSWORD).toBe(true);
    const basic = Buffer.from(`alice-zone-1:${PASSWORD}`).toString("base64");
    expect(hidden.map(([, l]) => l)).toEqual(["proxy user name", "proxy password", "proxy password, Basic encoded"]);
    expect(hidden.map(([v]) => v).includes(basic)).toBe(true);
  });

  it("fails with the item's name, never a value, when the store lacks it", async () => {
    const error = await resolveProxy(
      { server: "http://127.0.0.1:3128", username: "alice", password: "keychain:missing-item" },
      sb.env,
      () => {},
      secretStore(sb.env),
    ).catch((e: Error) => e);
    expect(String(error)).toMatch(
      /the secret store has no item "missing-item" for the proxy password \(store it with: turno-browser secret set missing-item\)/,
    );
  });

  it("is not read for a proxy without credentials", async () => {
    store.failWrites(true);
    expect(await resolveProxy({ server: "http://127.0.0.1:3128" }, sb.env, () => {})).toEqual({
      server: "http://127.0.0.1:3128",
    });
  });
});

describe("a coherent user agent", () => {
  const coherent: ObservedIdentity = {
    userAgent: reducedUserAgent(157, "darwin"),
    platform: "MacIntel",
    languages: ["es-MX", "es"],
    timezone: "America/Mexico_City",
    intlLocale: "es-419",
    uaData: {
      brands: [
        { brand: "Not-A.Brand", version: "99" },
        { brand: "Google Chrome", version: "157" },
        { brand: "Chromium", version: "157" },
      ],
      platform: "macOS",
      mobile: false,
    },
  };

  it("is Chrome's reduced string for each OS, with only the major version", () => {
    expect(reducedUserAgent(157, "darwin")).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    );
    expect(reducedUserAgent(157, "linux")).toContain("(X11; Linux x86_64)");
    expect(reducedUserAgent(157, "win32")).toContain("(Windows NT 10.0; Win64; x64)");
  });

  it("passes the launch check when every part agrees", () => {
    expect(coherenceProblems(coherent, { languages: ["es-MX", "es"], timezone: "America/Mexico_City" })).toEqual([]);
  });

  it("names each contradiction", () => {
    const headless = { ...coherent, userAgent: coherent.userAgent.replace("Chrome/", "HeadlessChrome/") };
    expect(coherenceProblems(headless)).toContain("the user agent says HeadlessChrome");
    const windows = { ...coherent, userAgent: reducedUserAgent(157, "win32") };
    expect(coherenceProblems(windows)).toEqual([
      "the user agent is Windows but the client hints platform is macOS",
      "the user agent is Windows but navigator.platform is MacIntel",
    ]);
    const version = { ...coherent, userAgent: reducedUserAgent(150, "darwin") };
    expect(coherenceProblems(version)[0]).toMatch(/do not name Chrome 150/);
    expect(coherenceProblems(coherent, { languages: ["de-DE", "de"], timezone: "Europe/Berlin" })).toEqual([
      "navigator.languages is es-MX, es, not de-DE, de",
      expect.stringMatching(/^dates and numbers are formatted in es-419, but the first language is de-DE/),
      "the time zone is America/Mexico_City, not Europe/Berlin",
    ]);
    expect(coherenceProblems({ ...coherent, uaData: null })).toContain("navigator.userAgentData is missing");
    const blank = {
      ...coherent,
      uaData: { ...coherent.uaData!, high: { fullVersionList: [], architecture: "", platformVersion: "" } },
    };
    expect(coherenceProblems(blank)).toContain(
      "the client hints high entropy values (full version list, architecture, platform version) are blank",
    );
    const full = {
      ...coherent,
      uaData: {
        ...coherent.uaData!,
        high: {
          fullVersionList: [{ brand: "Google Chrome", version: "157.0.8103.79" }],
          architecture: "arm",
          platformVersion: "26.5.0",
        },
      },
    };
    expect(coherenceProblems(full)).toEqual([]);
    // What the page reads must be the metadata the headless Chrome was given.
    expect(coherenceProblems(full, { high: full.uaData.high })).toEqual([]);
    expect(coherenceProblems(full, { high: { ...full.uaData.high, architecture: "x86" } })).toEqual([
      "the client hints high entropy values (arm, platform version 26.5.0) differ from this Chrome's own (x86, platform version 26.5.0)",
    ]);
  });

  it("takes Linux's empty platform version, and only there", () => {
    // Chrome on Linux reports no platform version (ReduceUserAgentDataLinuxPlatformVersion).
    const high = {
      fullVersionList: [{ brand: "Google Chrome", version: "157.0.8103.79" }],
      architecture: "x86",
      platformVersion: "",
    };
    const linux = {
      ...coherent,
      userAgent: reducedUserAgent(157, "linux"),
      platform: "Linux x86_64",
      uaData: { ...coherent.uaData!, platform: "Linux", high },
    };
    expect(coherenceProblems(linux)).toEqual([]);
    expect(coherenceProblems(linux, { high })).toEqual([]);
    expect(coherenceProblems(linux, { high: { ...high, platformVersion: "6.8.0" } })).toEqual([
      "the client hints high entropy values (x86, platform version empty) differ from this Chrome's own (x86, platform version 6.8.0)",
    ]);
    expect(coherenceProblems({ ...linux, uaData: { ...linux.uaData, high: { ...high, architecture: "" } } })).toContain(
      "the client hints high entropy values (full version list, architecture, platform version) are blank",
    );
    const mac = { ...coherent, uaData: { ...coherent.uaData!, high } };
    expect(coherenceProblems(mac)).toContain(
      "the client hints high entropy values (full version list, architecture, platform version) are blank",
    );
  });
});

describe("the camoufox engine without a browser", () => {
  it("is picked by identity.json or --engine, never with attach", () => {
    expect(engineChoice({}, { engine: "camoufox" })).toEqual({ kind: "camoufox" });
    expect(engineChoice({ engine: "camoufox" }, undefined)).toEqual({ kind: "camoufox" });
    expect(engineChoice({ engine: "chrome" }, { engine: "camoufox" })).toEqual({ kind: "default" });
    expect(() => engineChoice({ engine: "camoufox", attach: "auto" }, undefined)).toThrow(
      "attach and the camoufox engine do not go together: pick one",
    );
    expect(extractEngine(["--engine", "camoufox", "--headless"])).toEqual({
      engineFlags: { engine: "camoufox" },
      rest: ["--headless"],
    });
    expect(() => extractEngine(["--engine", "firefox"])).toThrow(
      '--engine must be "chrome", "lightpanda" (read mode) or "camoufox", not "firefox"',
    );
  });

  // The fake Camoufox is a shell script.
  it.skipIf(process.platform === "win32")(
    "finds Camoufox at TURNO_CAMOUFOX_PATH or in its installer's cache, and never downloads it",
    () => {
      expect(findCamoufox(sb.env, "darwin")).toBeUndefined();
      const app = join(
        camoufoxCacheDir(sb.env, "darwin"),
        "browsers",
        "official",
        "152.0",
        "Camoufox.app",
        "Contents",
        "MacOS",
      );
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, "camoufox"), "#!/bin/sh\necho 'Camoufox 152.0'\n");
      chmodSync(join(app, "camoufox"), 0o755);
      expect(findCamoufox(sb.env, "darwin")).toEqual({ path: join(app, "camoufox"), version: "Camoufox 152.0" });
      expect(findCamoufox({ ...sb.env, TURNO_CAMOUFOX_PATH: "relative/camoufox" }, "darwin")).toBeUndefined();
      expect(findCamoufox({ ...sb.env, TURNO_CAMOUFOX_PATH: join(app, "camoufox") }, "linux")?.path).toBe(
        join(app, "camoufox"),
      );
      expect(camoufoxCacheDir({ ...sb.env, XDG_CACHE_HOME: "/x/cache" }, "linux")).toBe("/x/cache/camoufox");
    },
  );

  it("needs stock playwright-core of patchright-core's minor version", () => {
    const dir = join(sb.home, "pw");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "playwright-core", version: "1.10.0" }));
    expect(findPlaywrightCore({ ...sb.env, TURNO_PLAYWRIGHT_CORE: dir })).toEqual({
      dir,
      version: "1.10.0",
      ok: false,
    });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "playwright-core", version: `${playwrightMinor()}.0` }),
    );
    expect(findPlaywrightCore({ ...sb.env, TURNO_PLAYWRIGHT_CORE: dir })?.ok).toBe(true);
    expect(findPlaywrightCore({ ...sb.env, TURNO_PLAYWRIGHT_CORE: join(sb.home, "none") })).toBeUndefined();
  });

  it("refuses browser_run_code_unsafe and browser_solve_captcha only", () => {
    for (const tool of ["browser_click", "browser_act", "browser_extract", "browser_observe", "browser_login"])
      expect(camoufoxRefusal(tool)).toBeUndefined();
    expect(camoufoxRefusal("browser_run_code_unsafe")).toMatch(/not available with the Camoufox engine/);
    expect(camoufoxRefusal("browser_solve_captcha")).toMatch(
      /^browser_solve_captcha is not available with the Camoufox engine: it sets the token from Patchright's isolated script world/,
    );
  });

  it("reports a missing Camoufox at launch with the install command", async () => {
    addIdentity("fox", sb.env);
    writeIdentitySettings("fox", { engine: "camoufox" }, sb.env);
    const engine = createEngine(chromeConfig(sb), {}, fake());
    const error = await engine
      .launch({ ...request(sb, "fox"), config: chromeConfig(sb) })
      .catch((e: Error) => e.message);
    expect(error).toMatch(
      /the camoufox engine needs Camoufox, and no Camoufox build is in .*camoufox\. Install it: pip install -U camoufox/,
    );
  });
});

/** A config the chrome engine would launch, on the sandbox's identity profile. */
function chromeConfig(s: Sandbox): McpConfig {
  return {
    browser: { browserName: "chromium", userDataDir: join(s.home, "profile"), launchOptions: { headless: true } },
    server: {},
  };
}

function request(s: Sandbox, id: string) {
  return {
    config: chromeConfig(s),
    clientInfo: { cwd: s.home, clientName: "test" },
    cliOptions: {},
    title: "test",
    identity: { id, env: s.env },
  };
}

/** An engine that records whether it launched: the refusals come before it. */
function fake(): Engine & { launched: number } {
  const e = {
    id: "upstream" as const,
    launched: 0,
    async launch(): Promise<never> {
      e.launched++;
      throw new Error("launched");
    },
  };
  return e;
}

describe("combinations refused before anything starts", () => {
  it("refuses identity.json proxy or userAgent when a flag picks attach or read mode", async () => {
    addIdentity("mix", sb.env);
    writeIdentitySettings("mix", { proxy: { server: "http://127.0.0.1:3128" }, userAgent: "coherent" }, sb.env);
    for (const flags of [{ attach: "http://127.0.0.1:9" }, { engine: "lightpanda" as const }]) {
      const fallback = fake();
      // An upstream config: the chrome engine is not chosen, the flag's engine is.
      const engine = createEngine(
        { ...chromeConfig(sb), browser: { ...chromeConfig(sb).browser, isolated: true } },
        flags,
        fallback,
      );
      const error = await engine.launch(request(sb, "mix")).catch((e: Error) => e.message);
      expect(error).toMatch(/userAgent and proxy do not go with (attach mode|engine "lightpanda")/);
      expect(fallback.launched).toBe(0);
    }
  });
});

describe("turno browser doctor", () => {
  it("says whether the secret store holds the proxy credentials, without reading them", async () => {
    addIdentity("px", sb.env);
    writeIdentitySettings(
      "px",
      { proxy: { server: "http://proxy.example.com:8080", username: "alice", password: "keychain:px-pass" } },
      sb.env,
    );
    const run = () =>
      runDoctor({
        env: sb.env,
        launch: false,
        chrome: () => ({ path: "/chrome", version: "157.0.0.1" }),
        lightpanda: () => undefined,
        camoufox: () => undefined,
        playwrightCore: () => undefined,
        procTable: () => new Map(),
      });
    const missing = (await run()).checks.filter((c) => c.area === "identity px");
    expect(
      missing.find((c) => /proxy http:\/\/proxy\.example\.com:8080: the proxy's operator sees/.test(c.text))?.level,
    ).toBe("info");
    const fail = missing.find((c) => c.text.startsWith("proxy credentials"));
    expect(fail).toMatchObject({ level: "fail", fix: "turno-browser secret set px-pass" });
    store.write("px-pass", PASSWORD);
    const present = (await run()).checks.filter((c) => c.area === "identity px");
    expect(present.find((c) => c.text.startsWith("proxy credentials"))?.level).toBe("ok");
    expect(JSON.stringify(present)).not.toContain(PASSWORD);
  });

  it("fails on a missing Camoufox or playwright-core only when an identity uses the engine", async () => {
    const run = () =>
      runDoctor({
        env: sb.env,
        launch: false,
        chrome: () => ({ path: "/chrome" }),
        lightpanda: () => undefined,
        camoufox: () => undefined,
        playwrightCore: () => undefined,
        procTable: () => new Map(),
      });
    const idle = (await run()).checks.filter((c) => c.area === "engines" && /Camoufox/.test(c.text));
    expect(idle).toEqual([
      expect.objectContaining({ level: "info", fix: expect.stringContaining("pip install -U camoufox") }),
    ]);
    addIdentity("fox", sb.env);
    writeIdentitySettings("fox", { engine: "camoufox" }, sb.env);
    const used = (await run()).checks.filter((c) => c.area === "engines" && /Camoufox|playwright-core/.test(c.text));
    expect(used.map((c) => c.level)).toEqual(["fail", "fail"]);
    expect(used[1]?.fix).toContain(`playwright-core@${playwrightMinor()}`);
  });
});

/** Saved settings with only the keys a test sets. */
const settingsOf = (keys: Partial<IdentitySettings>): IdentitySettings => ({ created: "", updated: "", ...keys });

describe("the chrome engine's network launch options", () => {
  const config = (launchOptions: Record<string, unknown>, contextOptions?: Record<string, unknown>): McpConfig => ({
    browser: {
      browserName: "chromium",
      userDataDir: join(sb.home, "profile"),
      launchOptions,
      ...(contextOptions ? { contextOptions } : {}),
    },
    server: {},
  });

  it("gives a headless Chrome the installed version's own user agent, and a headed one none", async () => {
    const exe = join(sb.home, "chrome");
    writeFileSync(exe, "#!/bin/sh\necho 'Google Chrome 157.0.8103.79'\n");
    chmodSync(exe, 0o755);
    // Where Windows keeps the version: a folder next to the executable.
    mkdirSync(join(sb.home, "157.0.8103.79"));
    // The metadata this Chrome reports, as a first headless launch would have read and kept it.
    const metadata = {
      brands: [{ brand: "Google Chrome", version: "157" }],
      fullVersionList: [{ brand: "Google Chrome", version: "157.0.8103.79" }],
      platform: "macOS",
      platformVersion: "26.5.0",
      architecture: "arm",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    };
    const cache = join(browserPaths(sb.env).state, "browser", "chrome-ua");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `157.0.8103.79-${process.platform}-${process.arch}.json`), JSON.stringify(metadata));
    const headless = await chromeNetwork(
      settingsOf({ userAgent: "coherent", timezone: "Europe/Berlin" }),
      config({ headless: true, executablePath: exe }),
      sb.env,
      () => {},
    );
    expect(headless.args).toEqual([`--user-agent=${reducedUserAgent(157)}`]);
    // The launch check expects every page to read back the metadata the pin gives.
    expect(headless.verify).toEqual({
      timezone: "Europe/Berlin",
      high: {
        fullVersionList: metadata.fullVersionList,
        architecture: metadata.architecture,
        platformVersion: metadata.platformVersion,
      },
    });
    expect(headless.pin).toEqual({ userAgent: reducedUserAgent(157), metadata });
    const headed = await chromeNetwork(
      settingsOf({ userAgent: "coherent" }),
      config({ headless: false }),
      sb.env,
      () => {},
    );
    expect(headed.args).toEqual([]);
    expect(headed.pin).toBeUndefined();
  });

  it("refuses a second user agent or proxy from the server's own flags or config", async () => {
    const refused: [Parameters<typeof chromeNetwork>[0], McpConfig, RegExp][] = [
      [
        settingsOf({ userAgent: "coherent" }),
        config({ args: ["--user-agent=x"] }),
        /userAgent "coherent" and a user agent of the server's own/,
      ],
      [
        settingsOf({ userAgent: "coherent" }),
        config({}, { userAgent: "x" }),
        /userAgent "coherent" and a user agent of the server's own/,
      ],
      [
        settingsOf({ proxy: { server: "http://p.example.com" } }),
        config({ args: ["--proxy-server=http://q"] }),
        /a proxy of the server's own/,
      ],
      [
        settingsOf({ proxy: { server: "http://p.example.com" } }),
        config({ proxy: { server: "http://q" } }),
        /a proxy of the server's own/,
      ],
    ];
    for (const [settings, c, message] of refused)
      await expect(chromeNetwork(settings, c, sb.env, () => {})).rejects.toThrow(message);
  });

  it("routes WebRTC through the proxy too", async () => {
    const out = await chromeNetwork(
      settingsOf({ proxy: { server: "http://p.example.com:8080" } }),
      config({}),
      sb.env,
      () => {},
    );
    expect(out.proxy).toEqual({ server: "http://p.example.com:8080" });
    expect(out.args).toEqual(["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]);
  });
});
