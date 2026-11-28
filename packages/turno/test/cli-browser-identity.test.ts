import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api as browserPackage } from "turno-browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BROWSER_API,
  type BrowserApi,
  type BrowserDeps,
  browserCommand,
  loadBrowser,
  servedIdentities,
} from "../src/cli/commands/browser.js";
import { command as identity, loadCommand, setBrowserDeps } from "../src/cli/commands/identity.js";
import { parseManifest } from "../src/core/manifest.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The identity module of turno-browser 0.3 through the CLI: identity.json with
 * `identity add/show/set`, `browser doctor` and `browser reputation`. The real package from the
 * workspace runs against the sandbox HOME; doctor's Chrome checks come from a fake module.
 */

let sb: Sandbox;
let prev: BrowserDeps;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  if (prev) setBrowserDeps(prev);
  sb.cleanup();
});

const real = async (): Promise<BrowserApi> => (await import("turno-browser")).api;

function deps(load: () => Promise<BrowserApi | undefined>): BrowserDeps {
  return { load, interactive: () => false, confirm: async () => false };
}

const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);

describe("turno identity add/show/set for browser identities", () => {
  it("writes identity.json on add, shows it, and changes it with set", async () => {
    prev = setBrowserDeps(deps(real));
    const add = fakeIo(sb.env);
    expect(
      await identity.run(
        ["add", "browser:school", "--timezone", "Europe/Madrid", "--languages", "es-ES, es", "--region", "es"],
        add,
      ),
    ).toBe(0);
    expect(add.lines.join("\n")).toMatch(
      /settings \(time zone, languages, health check\) in ~\/\.local\/share\/turno\/browser\/identities\/school\.json/,
    );
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({
      version: 1,
      timezone: "Europe/Madrid",
      languages: ["es-ES", "es"],
      region: "ES",
    });

    const set = fakeIo(sb.env);
    expect(
      await identity.run(
        [
          "set",
          "browser:school",
          "--health-url",
          "https://mail.example.com/",
          "--health-text",
          "Inbox",
          "--region",
          "",
        ],
        set,
      ),
    ).toBe(0);
    expect(set.lines.join("\n")).toMatch(/health check +https:\/\/mail\.example\.com\/ shows "Inbox"/);

    const show = fakeIo(sb.env);
    expect(await identity.run(["show", "browser:school", "--json"], show)).toBe(0);
    const json = JSON.parse(show.lines.join("\n"));
    expect(json).toMatchObject({
      schemaVersion: 1,
      id: "browser:school",
      settingsFile: "~/.local/share/turno/browser/identities/school.json",
      settings: {
        timezone: "Europe/Madrid",
        languages: ["es-ES", "es"],
        health: { url: "https://mail.example.com/", text: "Inbox" },
      },
      problems: [],
      inUse: false,
      holder: null,
      health: null,
    });
    expect(json.settings.region).toBeUndefined();

    // Only the text changes; the URL stays.
    expect(await identity.run(["set", "browser:school", "--health-text", "Mailbox"], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).health).toEqual({
      url: "https://mail.example.com/",
      text: "Mailbox",
    });
    expect(await identity.run(["set", "browser:school", "--no-health"], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).health).toBeUndefined();
  });

  it("refuses bad values, unknown identities, empty sets and service accounts", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const before = readFileSync(settingsFile("school"), "utf8");
    await expect(identity.run(["set", "browser:school", "--timezone", "Mars/Base"], fakeIo(sb.env))).rejects.toThrow(
      /not an IANA time zone/,
    );
    await expect(identity.run(["set", "browser:school"], fakeIo(sb.env))).rejects.toThrow(/nothing to set/);
    await expect(identity.run(["set", "browser:school", "--health-text", "Inbox"], fakeIo(sb.env))).rejects.toThrow(
      /needs --health-url/,
    );
    await expect(identity.run(["set", "browser:nope", "--region", "MX"], fakeIo(sb.env))).rejects.toThrow(
      /identity "nope" does not exist/,
    );
    await expect(identity.run(["show", "linear:work"], fakeIo(sb.env))).rejects.toThrow(/works on browser identities/);
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);
    const dry = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--region", "MX", "--dry-run"], dry)).toBe(0);
    expect(dry.lines.join("\n")).toMatch(/\(dry run\) would update identity\.json of "school"/);
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);
  });

  it("sets the tab governor, throttling, settle, blocking and cache keys", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const file = () => JSON.parse(readFileSync(settingsFile("school"), "utf8"));
    const set = fakeIo(sb.env);
    expect(
      await identity.run(
        [
          "set",
          "browser:school",
          ...["--tabs-max", "8", "--tabs-popups", "keep", "--tabs-park", "5m", "--tabs-close", "1h"],
          ...["--background-throttling", "true", "--settle", "250ms"],
          ...["--block-trackers", "true", "--block-types", "image, font", "--block-patterns", "ads.example,*/promo/*"],
          ...["--cache-max-size", "200MB"],
        ],
        set,
      ),
    ).toBe(0);
    expect(file()).toMatchObject({
      version: 2,
      tabs: { max: 8, popups: "keep", park: "5m", close: "1h" },
      backgroundThrottling: true,
      settle: "250ms",
      block: { trackers: true, types: ["image", "font"], patterns: ["ads.example", "*/promo/*"] },
      cache: { maxSize: "200MB" },
    });
    const text = set.lines.join("\n");
    expect(text).toMatch(/tabs +at most 8 open, popups kept, parked after 5m, closed after 1h/);
    expect(text).toMatch(/throttling +background tabs throttled/);
    expect(text).toMatch(/settle +250ms/);
    expect(text).toMatch(/blocking +trackers, image, font, 2 patterns/);
    expect(text).toMatch(/cache +on, up to 200MB/);

    // One part of a group changes; the rest of it stays. An empty value removes that part.
    expect(
      await identity.run(
        ["set", "browser:school", "--tabs-max", "0", "--tabs-park", "", "--block-patterns", ""],
        fakeIo(sb.env),
      ),
    ).toBe(0);
    expect(file().tabs).toEqual({ max: 0, popups: "keep", close: "1h" });
    expect(file().block).toEqual({ trackers: true, types: ["image", "font"] });

    // --cache alone turns the cache on with its default size; --no-* removes a whole group.
    expect(await identity.run(["set", "browser:school", "--cache-max-size", ""], fakeIo(sb.env))).toBe(0);
    expect(file().cache).toEqual({});
    expect(
      await identity.run(
        [
          "set",
          "browser:school",
          "--no-tabs",
          "--no-block",
          "--no-cache",
          "--background-throttling",
          "",
          "--settle",
          "",
        ],
        fakeIo(sb.env),
      ),
    ).toBe(0);
    expect(file()).toMatchObject({ version: 1 });
    for (const key of ["tabs", "backgroundThrottling", "settle", "block", "cache"])
      expect(file()[key], key).toBeUndefined();
    expect(await identity.run(["set", "browser:school", "--cache"], fakeIo(sb.env))).toBe(0);
    expect(file()).toMatchObject({ version: 2, cache: {} });
    // Removing the last part of a group removes the group.
    expect(await identity.run(["set", "browser:school", "--block-trackers", "true"], fakeIo(sb.env))).toBe(0);
    expect(await identity.run(["set", "browser:school", "--block-trackers", ""], fakeIo(sb.env))).toBe(0);
    expect(file().block).toBeUndefined();
  });

  it("sets and removes human-like input with --humanize, keeping a seed written by hand", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const file = () => JSON.parse(readFileSync(settingsFile("school"), "utf8"));
    const set = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--humanize", "light"], set)).toBe(0);
    expect(file()).toMatchObject({ version: 4, humanize: { level: "light" } });
    expect(set.lines.join("\n")).toMatch(/input +human-like pointer and typing \(light\)/);
    const api = await real();
    api.writeIdentitySettings("school", { humanize: { level: "light", seed: 9 } }, sb.env);
    const shown = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--humanize", "adaptive"], shown)).toBe(0);
    expect(file().humanize).toEqual({ level: "adaptive", seed: 9 });
    expect(shown.lines.join("\n")).toMatch(
      /input +light, full on sites that showed a challenge \(adaptive\) \(seed 9\)/,
    );
    await expect(identity.run(["set", "browser:school", "--humanize", "max"], fakeIo(sb.env))).rejects.toThrow(
      /^--humanize must be "off", "light", "full", "adaptive", "auto"$/,
    );
    expect(await identity.run(["set", "browser:school", "--humanize", ""], fakeIo(sb.env))).toBe(0);
    expect(file().humanize).toBeUndefined();
    expect(file().version).toBe(1);
  });

  it("refuses bad tuning values with the flag's name, and writes nothing", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const before = readFileSync(settingsFile("school"), "utf8");
    const bad = async (args: string[], message: RegExp) => {
      await expect(identity.run(["set", "browser:school", ...args], fakeIo(sb.env)), args.join(" ")).rejects.toThrow(
        message,
      );
      await expect(
        identity.run(["set", "browser:school", ...args, "--dry-run"], fakeIo(sb.env)),
        `${args.join(" ")} --dry-run`,
      ).rejects.toThrow(message);
    };
    await bad(["--tabs-max", "many"], /^--tabs-max must be a whole number from 0 \(no cap\) to 100$/);
    await bad(["--tabs-max", "101"], /^--tabs-max must be a whole number from 0 \(no cap\) to 100$/);
    await bad(["--tabs-popups", "open"], /^--tabs-popups must be "close" or "keep"$/);
    await bad(["--tabs-park", "soon"], /^--tabs-park must be a duration like "5m" or "0" \(off\)$/);
    await bad(["--background-throttling", "maybe"], /^--background-throttling must be true or false/);
    await bad(["--settle", "20s"], /^--settle must be a duration from "0" to "10s", like "250ms"$/);
    await bad(["--block-trackers", "yes please"], /^--block-trackers must be true or false/);
    await bad(["--block-types", "image,script"], /^--block-types must be a list of "image", "media", "font"$/);
    await bad(
      ["--block-patterns", "a b"],
      /^--block-patterns must be a list of host names or URL patterns without spaces/,
    );
    await bad(["--cache-max-size", "1KB"], /^--cache-max-size must be a size from "1MB" to "10GB", like "100MB"$/);
    await bad(["--no-tabs", "--tabs-max", "3"], /--no-tabs does not go with the other --tabs flags/);
    await bad(["--no-block", "--block-trackers", "true"], /--no-block does not go with the other --block flags/);
    await bad(["--no-cache", "--cache"], /--no-cache does not go with --cache or --cache-max-size/);
    await bad(
      ["--sharing", "all"],
      /^--sharing must be "tabs" \(the default, each agent session in its own tabs\) or "session" \(one at a time\)$/,
    );
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);
  });

  it("sets tab sharing with --sharing, and says what mcp.toml needs", async () => {
    prev = setBrowserDeps(deps(real));
    const add = fakeIo(sb.env);
    expect(await identity.run(["add", "browser:team", "--sharing", "tabs"], add)).toBe(0);
    const snippet = add.lines.join("\n");
    expect(snippet).toContain("exclusive = false  # every agent session at once, each in its own tabs");
    expect(snippet).not.toContain("lease");
    // The block parses as mcp.toml as printed.
    const block = snippet.slice(snippet.indexOf("[server.browser-team]"), snippet.indexOf('idle = "30m"') + 12);
    expect(parseManifest(`${block}\n`).servers["browser-team"]).toMatchObject({ scope: "shared", exclusive: false });
    expect(JSON.parse(readFileSync(settingsFile("team"), "utf8"))).toMatchObject({ version: 5, sharing: "tabs" });

    const on = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:team", "--sharing", "tabs"], on)).toBe(0);
    expect(on.lines.join("\n")).toMatch(/sharing +every agent session at once, each in its own tabs/);
    expect(on.lines.join("\n")).toContain("set exclusive = false for [server.browser-team] (and drop lease)");

    const off = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:team", "--sharing", "session"], off)).toBe(0);
    expect(off.lines.join("\n")).toContain("set exclusive = true for [server.browser-team]");
    expect(JSON.parse(readFileSync(settingsFile("team"), "utf8")).sharing).toBe("session");
  });

  it("sets the tab lock wait and idle release, names the flag in an error, and removes one with an empty value", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:team", "--sharing", "tabs"], fakeIo(sb.env));
    const set = fakeIo(sb.env);
    expect(
      await identity.run(["set", "browser:team", "--tab-lock-wait", "30s", "--tab-lock-release", "10m"], set),
    ).toBe(0);
    expect(set.lines.join("\n")).toMatch(/tab locks +wait 30s, release after 10m/);
    expect(JSON.parse(readFileSync(settingsFile("team"), "utf8"))).toMatchObject({
      version: 9,
      tabLocks: { wait: "30s", release: "10m" },
    });
    await expect(identity.run(["set", "browser:team", "--tab-lock-wait", "1h"], fakeIo(sb.env))).rejects.toThrow(
      /--tab-lock-wait must be a duration from "0" \(fail at once\) to "10m"/,
    );
    expect(await identity.run(["set", "browser:team", "--tab-lock-wait", ""], fakeIo(sb.env))).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile("team"), "utf8")).tabLocks).toEqual({ release: "10m" });
  });

  it("reports what set changed with --json, and what it would change with --dry-run --json", async () => {
    prev = setBrowserDeps(deps(real));
    await identity.run(["add", "browser:school"], fakeIo(sb.env));
    const before = readFileSync(settingsFile("school"), "utf8");
    const dry = fakeIo(sb.env);
    expect(await identity.run(["set", "browser:school", "--tabs-max", "6", "--dry-run", "--json"], dry)).toBe(0);
    const planned = JSON.parse(dry.lines.join("\n"));
    expect(planned).toMatchObject({
      schemaVersion: 1,
      id: "browser:school",
      settingsFile: "~/.local/share/turno/browser/identities/school.json",
      dryRun: true,
      changes: { tabs: { max: 6 } },
      settings: { version: 2, tabs: { max: 6 } },
    });
    expect(readFileSync(settingsFile("school"), "utf8")).toBe(before);

    const io = fakeIo(sb.env);
    expect(await browserCommand(deps(real)).run(["set", "school", "--settle", "500ms", "--json"], io)).toBe(0);
    const done = JSON.parse(io.lines.join("\n"));
    expect(done).toMatchObject({
      dryRun: false,
      changes: { settle: "500ms" },
      settings: { version: 2, settle: "500ms" },
    });
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).settle).toBe("500ms");

    // The fields come from turno-browser, which the registry loads with the command.
    const fields = fakeIo(sb.env);
    expect(await (await loadCommand()).run(["set", "browser:school", "--json=fields"], fields)).toBe(0);
    expect(fields.lines.join("\n")).toMatch(/changes/);
  });

  it("refuses an installed turno-browser whose API_VERSION does not fit, with one message", async () => {
    const pkg = await import("turno-browser");
    const old = { ...pkg, API_VERSION: undefined };
    const newer = { ...pkg, API_VERSION: { major: pkg.API_VERSION.major + 1, minor: 0 } };
    prev = setBrowserDeps(deps(() => loadBrowser({ importer: async () => old })));
    await expect(identity.run(["show", "browser:school"], fakeIo(sb.env))).rejects.toThrow(
      "turno-browser is too old for this turno (it has no API_VERSION, this turno needs 1.15 or a later 1.x); update it: npm install --global turno-browser@latest",
    );
    // 1.11 has no `cli`: the commands were turno-cli's own.
    setBrowserDeps(
      deps(() => loadBrowser({ importer: async () => ({ ...pkg, API_VERSION: { major: 1, minor: 11 } }) })),
    );
    await expect(identity.run(["show", "browser:school"], fakeIo(sb.env))).rejects.toThrow(
      /its API is 1\.11, this turno needs 1\.15 or a later 1\.x/,
    );
    setBrowserDeps(deps(() => loadBrowser({ importer: async () => newer })));
    await expect(identity.run(["show", "browser:school"], fakeIo(sb.env))).rejects.toThrow(
      /^turno-browser is too new for this turno \(its API is 2\.0, this turno speaks 1\.x\); update turno: turno upgrade$/,
    );
  });

  it("is built against the API_VERSION of the workspace turno-browser", async () => {
    const pkg = await import("turno-browser");
    expect(BROWSER_API).toEqual(pkg.API_VERSION);
    expect(await loadBrowser()).toBe(pkg.api);
  });
});

describe("turno browser doctor", () => {
  const checks = [
    { area: "chrome", level: "ok", text: "Google Chrome 157.0.8103.79 at /Applications/Google Chrome.app" },
    { area: "chrome", level: "info", text: "smoke launch skipped (--no-launch)" },
    { area: "identity school", level: "ok", text: "free: no process holds it" },
    {
      area: "identity school",
      level: "warn",
      text: "stale runtime lock of pid 12 (that process is gone)",
      fix: "turno browser doctor --fix",
      auto: true,
    },
    {
      area: "identity bank",
      level: "fail",
      text: "NEEDS_AUTH: not signed in at https://bank.example.com/",
      fix: "turno browser login bank",
    },
  ] as const;

  function doctorModule(seen: unknown[]): BrowserApi {
    return {
      runDoctor: async (o: unknown) => {
        seen.push(o);
        return { checks: checks.map((c) => ({ ...c })), fixed: [] };
      },
      cli: browserPackage.cli,
    } as unknown as BrowserApi;
  }

  it("prints sections, fix lines and counts, and exits 1 on a failure", async () => {
    const seen: unknown[] = [];
    const cmd = browserCommand(deps(async () => doctorModule(seen)));
    const io = fakeIo(sb.env);
    expect(await cmd.run(["doctor", "--no-launch"], io)).toBe(1);
    expect(seen).toEqual([{ env: sb.env, fix: false, launch: false, servers: [] }]);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^Browsers\n/m);
    expect(text).toMatch(/^Identities\n {2}browser:school\n/m);
    expect(text).toMatch(/stale runtime lock of pid 12.*\n +fix: turno browser doctor --fix \(runs with --fix\)/);
    expect(text).toMatch(/NEEDS_AUTH.*\n +fix: turno browser login bank/);
    expect(io.lines.at(-1)).toBe("2 ok, 1 warning, 1 failure");
  });

  it("gives every check a status, fix, auto and manual with --json, and passes --fix", async () => {
    const seen: unknown[] = [];
    const cmd = browserCommand(deps(async () => doctorModule(seen)));
    const io = fakeIo(sb.env);
    expect(await cmd.run(["doctor", "--json", "--fix"], io)).toBe(1);
    expect(seen).toEqual([{ env: sb.env, fix: true, launch: true, servers: [] }]);
    const json = JSON.parse(io.lines.join("\n"));
    expect(json).toMatchObject({
      schemaVersion: 1,
      ok: false,
      counts: { ok: 2, warn: 1, fail: 1, skip: 1 },
      fixed: [],
    });
    expect(json.checks[1]).toEqual({
      area: "chrome",
      status: "skip",
      text: "smoke launch skipped (--no-launch)",
      fix: null,
      auto: false,
      manual: null,
    });
    expect(json.checks[3]).toMatchObject({ status: "warn", fix: "turno browser doctor --fix", auto: true });
  });
});

describe("turno browser doctor and mcp.toml", () => {
  it("passes the servers that run turno-browser-mcp for an identity, with exclusive, scope and --sharing", () => {
    sb.write(
      ".config/turno/mcp.toml",
      [
        "[server.browser-school]",
        'command = "turno-browser-mcp"',
        'args = ["--identity", "school"]',
        'scope = "shared"',
        "exclusive = false",
        "",
        "[server.bank]",
        'command = "node"',
        'args = ["/opt/turno/bin/turno-browser-mcp", "--identity=browser:bank", "--sharing", "tabs"]',
        'scope = "shared"',
        "exclusive = true",
        "",
        "[server.other]",
        'command = "other-mcp"',
        'args = ["--identity", "x"]',
        "",
      ].join("\n"),
    );
    expect(servedIdentities(sb.env)).toEqual([
      { name: "browser-school", identity: "school", exclusive: false, scope: "shared" },
      { name: "bank", identity: "bank", exclusive: true, scope: "shared", sharing: "tabs" },
    ]);
  });

  it("warns, through the real package, when sessions of a one-session identity would share a tab", async () => {
    const mod = await real();
    mod.addIdentity("school", sb.env, { sharing: "session" });
    sb.write(
      ".config/turno/mcp.toml",
      '[server.browser-school]\ncommand = "turno-browser-mcp"\nargs = ["--identity", "school"]\nexclusive = false\n',
    );
    const report = await mod.runDoctor({ env: sb.env, launch: false, servers: servedIdentities(sb.env) });
    expect(report.checks.find((c) => c.area === "identity school" && c.level === "warn")).toMatchObject({
      text: expect.stringMatching(
        /^\[server\.browser-school\] in mcp\.toml lets several sessions in \(exclusive = false\)/,
      ),
      fix: "turno browser set school --sharing tabs",
    });
    mod.writeIdentitySettings("school", { sharing: "tabs" }, sb.env);
    const after = await mod.runDoctor({ env: sb.env, launch: false, servers: servedIdentities(sb.env) });
    expect(after.checks.some((c) => c.text.includes("lets several sessions in"))).toBe(false);
  });
});

describe("turno browser reputation", () => {
  it("shows counts and the trend per site from the identity's log", async () => {
    const mod = await real();
    mod.addIdentity("school", sb.env);
    const now = Date.now();
    const line = (days: number, site: string, kind: string) =>
      JSON.stringify({ ts: new Date(now - days * 86_400_000).toISOString(), site, kind, markers: [] });
    const log = [line(1, "a.example", "captcha"), line(2, "a.example", "verify"), line(9, "b.example", "block")].join(
      "\n",
    );
    sb.write(".local/state/turno/browser/identities/school/reputation.jsonl", `${log}\n`);
    const cmd = browserCommand(deps(real));

    const io = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "school"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^browser:school$/m);
    expect(text).toMatch(/a\.example +2 +1 +1 +0 +2 +0 +up/);
    expect(text).toMatch(/b\.example +1 +0 +0 +1 +0 +1 +down/);

    const json = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "browser:school", "--json"], json)).toBe(0);
    expect(JSON.parse(json.lines.join("\n"))[0]).toMatchObject({
      schemaVersion: 1,
      id: "browser:school",
      total: 3,
      file: "~/.local/state/turno/browser/identities/school/reputation.jsonl",
    });
    const picked = fakeIo(sb.env);
    expect(await cmd.run(["reputation", "school", "--json=id,total"], picked)).toBe(0);
    expect(JSON.parse(picked.lines.join("\n"))).toEqual([{ schemaVersion: 1, id: "browser:school", total: 3 }]);
    await expect(cmd.run(["reputation", "nope"], fakeIo(sb.env))).rejects.toThrow(/identity "nope" does not exist/);
  });
});
