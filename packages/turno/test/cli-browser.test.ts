import { api as browserPackage } from "turno-browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserDeps,
  type BrowserApi,
  NOT_INSTALLED,
  browserCommand,
  loadCommand,
} from "../src/cli/commands/browser.js";
import { command as identity, setBrowserDeps } from "../src/cli/commands/identity.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

interface Calls {
  bench: unknown[];
  added: string[];
  login: unknown[];
}

/** A fake of the parts of turno-browser's API these commands call; the rest are never reached. */
function fakeModule(calls: Calls): BrowserApi {
  const fake = {
    ENGINES: ["engine-a", "engine-b"],
    engineId: (name: string) => (["engine-a", "engine-b"].includes(name) ? name : undefined),
    inUseBy: () => undefined,
    identitySettingsPath: (id: string) => `/x/${id}.json`,
    listIdentities: () => [],
    addIdentity: (id: string) => {
      calls.added.push(id);
      return { id, dir: `/x/${id}`, inUse: false };
    },
    removeIdentity: () => undefined,
    vaultClear: async () => 0,
    isInUse: () => false,
    assertIdentityId: (id: string) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`invalid identity id "${id}"`);
    },
    manifestSnippet: (id: string) => `[server.browser-${id}]\n`,
    loginIdentity: async (id: string, options: { url?: string }) => {
      calls.login.push({ id, url: options.url });
    },
    runBench: async (options: unknown) => {
      calls.bench.push(options);
      return { version: 1, results: [] };
    },
    formatBenchTable: () => "TABLE",
    // The commands themselves are turno-browser's; they call the fakes above.
    cli: browserPackage.cli,
  };
  return fake as unknown as BrowserApi;
}

function setup(over: Partial<BrowserDeps> = {}, answer = false) {
  const calls: Calls = { bench: [], added: [], login: [] };
  const asked: string[] = [];
  const deps: BrowserDeps = {
    load: async () => fakeModule(calls),
    interactive: () => false,
    confirm: async (q) => {
      asked.push(q);
      return answer;
    },
    ...over,
  };
  return { calls, asked, deps, cmd: browserCommand(deps) };
}

describe("turno browser", () => {
  it("prints help with --help, without the package, as a developer diagnostic", async () => {
    const { cmd } = setup({ load: async () => undefined });
    for (const args of [["--help"], [], ["bench", "--help"], ["help"]]) {
      const io = fakeIo(sb.env);
      expect(await cmd.run(args, io)).toBe(0);
      expect(io.lines.join("\n")).toMatch(/Usage:/);
    }
    const io = fakeIo(sb.env);
    await cmd.run(["--help"], io);
    const text = io.lines.join("\n");
    expect(text).toMatch(/developer diagnostic for browser engine compatibility/);
    expect(text).toMatch(/npm install --global turno-browser/);
  });

  it("keeps detection and evasion wording out of its help", async () => {
    const browser = await loadCommand();
    const io = fakeIo(sb.env);
    await browser.run(["--help"], io);
    const text = `${browser.summary}\n${browser.usage}\n${io.lines.join("\n")}`;
    expect(text).not.toMatch(/bot|detector|fingerprint|stealth|camoufox|patchright|evad/i);
  });

  it("says how to install turno-browser when it is missing", async () => {
    const { cmd } = setup({ load: async () => undefined });
    const io = fakeIo(sb.env);
    expect(await cmd.run(["identities"], io)).toBe(1);
    expect(io.errors.join("\n")).toBe(`turno: ${NOT_INSTALLED}`);
    expect(NOT_INSTALLED).toBe("turno-browser is not installed: npm install --global turno-browser");
  });

  it("rejects unknown flags and extra arguments", async () => {
    const { cmd } = setup();
    await expect(cmd.run(["bench", "--bogus", "--yes"], fakeIo(sb.env))).rejects.toThrow(/unknown option --bogus/);
    await expect(cmd.run(["add", "school", "--bogus"], fakeIo(sb.env))).rejects.toThrow(/unknown option --bogus/);
    await expect(cmd.run(["add", "school", "extra"], fakeIo(sb.env))).rejects.toThrow(/unexpected argument/);
    await expect(cmd.run(["login", "school", "--url"], fakeIo(sb.env))).rejects.toThrow(/--url needs a value/);
    await expect(cmd.run(["nope"], fakeIo(sb.env))).rejects.toThrow(/unknown browser command/);
  });

  it("refuses bench without a terminal unless --yes, and --json is not consent", async () => {
    const { cmd, calls, asked } = setup();
    await expect(cmd.run(["bench"], fakeIo(sb.env))).rejects.toThrow(/--yes/);
    await expect(cmd.run(["bench", "--json"], fakeIo(sb.env))).rejects.toThrow(/--yes/);
    expect(calls.bench).toHaveLength(0);
    expect(asked).toHaveLength(0);
    const io = fakeIo(sb.env);
    expect(await cmd.run(["bench", "--json", "--yes"], io)).toBe(0);
    expect(calls.bench).toHaveLength(1);
    expect(JSON.parse(io.lines.join("\n"))).toEqual({ schemaVersion: 1, version: 1, results: [] });
  });

  it("asks only when main left a way to ask (a terminal, no --no-input, no agent session)", async () => {
    const { defaultDeps } = await import("../src/cli/commands/browser.js");
    expect(defaultDeps.interactive({ ...fakeIo(sb.env), ask: async () => "y" })).toBe(true);
    expect(defaultDeps.interactive(fakeIo(sb.env))).toBe(false);
    const { cmd, calls, asked } = setup({ interactive: defaultDeps.interactive }, true);
    await expect(cmd.run(["bench"], fakeIo(sb.env))).rejects.toThrow(
      "browser bench needs an answer; pass --yes (or run it in a terminal)",
    );
    expect(calls.bench).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("asks in a terminal and opens nothing on no", async () => {
    const { cmd, calls, asked } = setup({ interactive: () => true }, false);
    const io = fakeIo(sb.env);
    expect(await cmd.run(["bench", "--json"], io)).toBe(1);
    expect(asked).toEqual(["This opens Chrome and visits third-party test pages. Continue? [y/N] "]);
    expect(calls.bench).toHaveLength(0);
    expect(io.errors.join("\n")).toMatch(/Cancelled/);
  });

  it("runs bench after a yes, with engines, urls and --only-urls", async () => {
    const { cmd, calls } = setup({ interactive: () => true }, true);
    const io = fakeIo(sb.env);
    expect(
      await cmd.run(["bench", "--engine", "engine-a,engine-b", "--url", "https://example.com", "--only-urls"], io),
    ).toBe(0);
    expect(calls.bench[0]).toMatchObject({
      engines: ["engine-a", "engine-b"],
      urls: ["https://example.com"],
      detectors: false,
    });
    expect(io.lines).toContain("TABLE");
    await expect(cmd.run(["bench", "--engine", "nope", "--yes"], fakeIo(sb.env))).rejects.toThrow(/unknown engine/);
    await expect(cmd.run(["bench", "--only-urls", "--yes"], fakeIo(sb.env))).rejects.toThrow(
      /needs at least one --url/,
    );
    await expect(cmd.run(["bench", "--url", "file:///etc/passwd", "--yes"], fakeIo(sb.env))).rejects.toThrow(
      /must start with http/,
    );
  });

  it("passes an engine's current id when the package knows an older name for it", async () => {
    const calls: Calls = { bench: [], added: [], login: [] };
    const mod = {
      ...fakeModule(calls),
      engineId: (name: string) => ({ "engine-a": "engine-a", "old-a": "engine-a" })[name],
    } as unknown as BrowserApi;
    const cmd = browserCommand({ load: async () => mod, interactive: () => false, confirm: async () => false });
    expect(await cmd.run(["bench", "--engine", "old-a", "--yes"], fakeIo(sb.env))).toBe(0);
    expect(calls.bench[0]).toMatchObject({ engines: ["engine-a"] });
    await expect(cmd.run(["bench", "--engine", "engine-b", "--yes"], fakeIo(sb.env))).rejects.toThrow(
      /unknown engine "engine-b" \(known: engine-a, engine-b\)/,
    );
  });

  it("adds an identity, and --dry-run writes nothing", async () => {
    const { cmd, calls } = setup();
    const io = fakeIo(sb.env);
    expect(await cmd.run(["add", "school", "--dry-run"], io)).toBe(0);
    expect(calls.added).toEqual([]);
    expect(await cmd.run(["add", "school"], io)).toBe(0);
    expect(calls.added).toEqual(["school"]);
    await expect(cmd.run(["add", "Bad Id"], fakeIo(sb.env))).rejects.toThrow(/invalid identity/);
  });
});

describe("turno identity with browser identities", () => {
  let prev: BrowserDeps;
  afterEach(() => {
    setBrowserDeps(prev);
  });

  it("passes --yes and --json of a browser identity's remove on to turno-browser", async () => {
    const { deps } = setup({ load: async () => browserPackage });
    prev = setBrowserDeps(deps);
    expect(await identity.run(["add", "browser:school"], fakeIo(sb.env))).toBe(0);
    await expect(identity.run(["remove", "browser:school"], fakeIo(sb.env))).rejects.toThrow(/pass --yes/);
    const dry = fakeIo(sb.env);
    expect(await identity.run(["remove", "browser:school", "--dry-run"], dry)).toBe(0);
    expect(dry.lines.join("\n")).toContain('(dry run) This deletes browser identity "school"');
    const io = fakeIo(sb.env);
    expect(await identity.run(["remove", "browser:school", "--yes", "--json"], io)).toBe(0);
    expect(JSON.parse(io.lines.join("\n"))).toMatchObject({ identity: "school", complete: true });
    expect(browserPackage.identityExists("school", sb.env)).toBe(false);
  });

  it("suggests turno identity add in the empty state", async () => {
    const { deps } = setup();
    prev = setBrowserDeps(deps);
    const io = fakeIo(sb.env);
    expect(await identity.run([], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).toMatch(/turno identity add linear:work/);
    expect(text).toMatch(/turno identity add browser:<id>/);
    expect(text).not.toMatch(/turno accounts add/);
  });

  it("names the install command when turno-browser is missing", async () => {
    const { deps } = setup({ load: async () => undefined });
    prev = setBrowserDeps(deps);
    const io = fakeIo(sb.env);
    expect(await identity.run(["list"], io)).toBe(0);
    expect(io.lines.join("\n")).toMatch(/turno-browser is not installed: npm install --global turno-browser/);
    const add = fakeIo(sb.env);
    await expect(identity.run(["add", "browser:school"], add)).rejects.toThrow(/turno-browser/);
    expect(add.errors.join("\n")).toBe(`turno: ${NOT_INSTALLED}`);
  });

  it("parses browser flags strictly and passes --url to login", async () => {
    const { deps, calls } = setup();
    prev = setBrowserDeps(deps);
    await expect(identity.run(["add", "browser:school", "--bogus"], fakeIo(sb.env))).rejects.toThrow(
      /unknown option --bogus/,
    );
    await expect(identity.run(["login", "browser:school", "--bogus"], fakeIo(sb.env))).rejects.toThrow(
      /unknown option --bogus/,
    );
    expect(await identity.run(["login", "browser:school", "--url", "https://example.com"], fakeIo(sb.env))).toBe(0);
    expect(calls.login).toEqual([{ id: "school", url: "https://example.com" }]);
    const help = fakeIo(sb.env);
    expect(await identity.run(["add", "--help"], help)).toBe(0);
    expect(help.lines.join("\n")).toMatch(/turno identity add/);
  });
});
