import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Install dir of patchright-core, resolved from this package. */
function patchrightDir(): string {
  return dirname(require.resolve("patchright-core/package.json"));
}

/**
 * The Playwright MCP program shipped inside patchright-core. The subpath is not in
 * the package `exports`, so it is resolved from the install dir. `turno-browser-mcp` no longer
 * runs it (turno's host serves the same tools); the contract test still starts it
 * to compare tool lists.
 */
export function mcpEntryPath(): string {
  return join(patchrightDir(), "lib", "entry", "mcp.js");
}

/**
 * The patchright-core release the reputation suite last passed with, and the Chrome it ran
 * on. turno's init scripts rely on internals of this release (see `passkey.ts`), so a bump is
 * verified before it ships: run `pnpm bench:reputation` on the new version, then update this
 * record (`doctor` and `pnpm check` compare the installed version with it).
 */
export const VERIFIED_PATCHRIGHT = { version: "1.64.3", chrome: "158", date: "2026-11-25" } as const;

/** The version of the patchright-core this package loads, or undefined when it cannot be read. */
export function patchrightCoreVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(require.resolve("patchright-core/package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function resolveFrom(name: string): string | undefined {
  for (const base of [import.meta.url, join(process.cwd(), "noop.js")]) {
    try {
      return createRequire(base).resolve(name);
    } catch {
      // try the next base
    }
  }
  return undefined;
}
