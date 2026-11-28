import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBrowser } from "../src/cli/commands/browser.js";
import { CliError } from "../src/cli/io.js";
import { OPTIONAL, apiMismatch, isMissingModule, loadOptional, notInstalled } from "../src/cli/optional.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const missing = () => Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
const PKG = { name: "turno-example", install: "npm install --global turno-example" };
const isExample = (m: unknown): m is { hello(): string } => typeof (m as { hello?: unknown }).hello === "function";

/** A package `name` in a fake global npm folder, exporting `body`. */
function globalPackage(name: string, body: string): string {
  const root = join(sb.home, "global/lib/node_modules");
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, type: "module", main: "index.js", exports: "./index.js" }),
  );
  writeFileSync(join(dir, "index.js"), body);
  return root;
}

describe("loadOptional", () => {
  it("names each optional package and how to install it", () => {
    expect(notInstalled(OPTIONAL.browser)).toBe("turno-browser is not installed: npm install --global turno-browser");
    expect(OPTIONAL.tui.name).toBe("turno-tui");
    expect(isMissingModule(missing())).toBe(true);
    expect(isMissingModule(new Error("boom"))).toBe(false);
  });

  it("returns the module next to this install, checked by the guard", async () => {
    const mod = await loadOptional(PKG, { importer: async () => ({ hello: () => "hi" }), guard: isExample });
    expect(mod?.hello()).toBe("hi");
  });

  it("is undefined when the package is missing everywhere, and never asks npm without global", async () => {
    let asked = false;
    const opts = {
      importer: async () => Promise.reject(missing()),
      globalRoot: () => {
        asked = true;
        return undefined;
      },
    };
    expect(await loadOptional(PKG, opts)).toBeUndefined();
    expect(asked).toBe(false);
    expect(await loadOptional(PKG, { ...opts, global: true })).toBeUndefined();
    expect(asked).toBe(true);
  });

  it("falls back to the global npm folder", async () => {
    const root = globalPackage("turno-example", "export const hello = () => 'from global';\n");
    const seen: string[] = [];
    const mod = await loadOptional(PKG, {
      global: true,
      guard: isExample,
      globalRoot: () => root,
      importer: async (s) => {
        seen.push(s);
        if (!s.startsWith("file:")) throw missing();
        return import(s);
      },
    });
    expect(mod?.hello()).toBe("from global");
    expect(seen[1]).toBe(pathToFileURL(join(root, "turno-example/index.js")).href);
  });

  it("throws other import errors, and a module the guard rejects is a CliError with the update command", async () => {
    await expect(loadOptional(PKG, { importer: async () => Promise.reject(new SyntaxError("bad")) })).rejects.toThrow(
      SyntaxError,
    );
    const old = loadOptional(PKG, { importer: async () => ({ other: 1 }), guard: isExample });
    await expect(old).rejects.toThrow(CliError);
    await expect(loadOptional(PKG, { importer: async () => ({}), guard: isExample })).rejects.toThrow(
      "this turno-example is too old or not a turno-example for this turno; update it: npm install --global turno-example@latest",
    );
  });

  it("compares API_VERSION: same major and at least the minor it was built for", () => {
    const wanted = { major: 1, minor: 2 };
    expect(apiMismatch(PKG, { major: 1, minor: 2 }, wanted)).toBeUndefined();
    expect(apiMismatch(PKG, { major: 1, minor: 5 }, wanted)).toBeUndefined();
    expect(apiMismatch(PKG, { major: 1, minor: 1 }, wanted)).toBe(
      "turno-example is too old for this turno (its API is 1.1, this turno needs 1.2 or a later 1.x); update it: npm install --global turno-example@latest",
    );
    expect(apiMismatch(PKG, { major: 0, minor: 9 }, wanted)).toMatch(
      /^turno-example is too old for this turno \(its API is 0\.9,/,
    );
    for (const none of [undefined, null, 1, "1.2", { major: 1 }, { major: -1, minor: 0 }, { major: 1.5, minor: 0 }]) {
      expect(apiMismatch(PKG, none, wanted)).toBe(
        "turno-example is too old for this turno (it has no API_VERSION, this turno needs 1.2 or a later 1.x); update it: npm install --global turno-example@latest",
      );
    }
    expect(apiMismatch(PKG, { major: 2, minor: 0 }, wanted)).toBe(
      "turno-example is too new for this turno (its API is 2.0, this turno speaks 1.x); update turno: turno upgrade",
    );
  });

  it("checks API_VERSION before the guard and refuses with one message", async () => {
    const wanted = { major: 1, minor: 0 };
    const ok = await loadOptional(PKG, {
      importer: async () => ({ API_VERSION: { major: 1, minor: 3 }, hello: () => "hi" }),
      guard: isExample,
      api: wanted,
    });
    expect(ok?.hello()).toBe("hi");
    await expect(
      loadOptional(PKG, { importer: async () => ({ hello: () => "old" }), guard: isExample, api: wanted }),
    ).rejects.toThrow(
      new CliError(
        "turno-example is too old for this turno (it has no API_VERSION, this turno needs 1.0 or a later 1.x); update it: npm install --global turno-example@latest",
      ),
    );
    await expect(
      loadOptional(PKG, {
        importer: async () => ({ API_VERSION: { major: 2, minor: 0 } }),
        guard: isExample,
        api: wanted,
      }),
    ).rejects.toThrow(/too new for this turno/);
  });

  it("loadBrowser finds the workspace turno-browser, checks its API version and returns its API object", async () => {
    const mod = await loadBrowser();
    expect(mod && Array.isArray(mod.ENGINES)).toBe(true);
    expect(typeof mod?.listIdentities).toBe("function");
    const pkg = await import("turno-browser");
    expect(mod).toBe(pkg.api);
  });

  it("loadBrowser refuses a turno-browser without API_VERSION (0.2) with the update command", async () => {
    const root = globalPackage(
      "turno-browser",
      "export const ENGINES = ['chrome-headed'];\nexport function listIdentities() { return []; }\nexport async function runBench() { return {}; }\n",
    );
    await expect(
      loadBrowser({
        global: true,
        importer: async (s: string) => (s.startsWith("file:") ? import(s) : Promise.reject(missing())),
        globalRoot: () => root,
      }),
    ).rejects.toThrow(
      "turno-browser is too old for this turno (it has no API_VERSION, this turno needs 1.15 or a later 1.x); update it: npm install --global turno-browser@latest",
    );
  });
});
