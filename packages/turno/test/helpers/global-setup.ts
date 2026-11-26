/**
 * Vitest global setup: the whole run gets a throwaway HOME (and XDG dirs), so code that falls
 * back to `process.env` or `os.homedir()` instead of the sandbox env writes there, never to the
 * real home. That HOME is also a guard: when the run ends, anything found in it means a test or
 * the code under test ignored its sandbox, and the run fails with the list of paths.
 *
 * Variables of a live session (TURNO_*, CLAUDE*, CODEX_*, COPILOT_*, CURSOR_*, ANTHROPIC_*) are cleared too,
 * except the switches that select tests (TURNO_SKIP_E2E, TURNO_E2E_NETWORK, TURNO_SKIP_CHROME).
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEP = new Set(["TURNO_SKIP_E2E", "TURNO_E2E_NETWORK", "TURNO_SKIP_CHROME"]);
const LIVE = /^(TURNO_|CLAUDE|CODEX_|COPILOT_|CURSOR_|ANTHROPIC_|XDG_)/;

/** Paths written under the guard HOME, relative to it. */
export function guardFindings(home: string): string[] {
  try {
    return readdirSync(home, { recursive: true }).map(String).sort();
  } catch {
    return [];
  }
}

export default function setup(): () => void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "turno-guard-")));
  const home = join(root, "home");
  mkdirSync(home);
  for (const key of Object.keys(process.env)) if (LIVE.test(key) && !KEEP.has(key)) delete process.env[key];
  process.env.HOME = home;
  // No notification of the system from a turno-browser host a test runs (`notify.ts`).
  process.env.TURNO_BROWSER_NOTIFY = "off";
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  process.env.XDG_DATA_HOME = join(home, ".local", "share");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  process.env.TURNO_NO_UPDATE_CHECK = "1";
  // No test reaches the real secret store: stand-ins for `security` and `secret-tool` that refuse
  // come first on PATH. A real Keychain call can open a macOS dialog that blocks the whole
  // session; tests use test/helpers/fake-secret-store.ts, which goes in front of these.
  const guard = join(root, "no-secret-store");
  mkdirSync(guard);
  for (const name of ["security", "secret-tool"]) {
    const file = join(guard, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name}: the real secret store is off in tests; use test/helpers/fake-secret-store.ts" >&2\nexit 1\n`,
    );
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${guard}:${process.env.PATH ?? ""}`;
  return () => {
    const found = guardFindings(home);
    rmSync(root, { recursive: true, force: true });
    if (found.length) {
      const shown = found.slice(0, 20).join("\n  ");
      throw new Error(
        `Tests wrote to HOME instead of their sandbox (test/helpers/README.md):\n  ${shown}${found.length > 20 ? "\n  ..." : ""}`,
      );
    }
  };
}
