/**
 * Vitest global setup (the same as packages/turno's): the whole run gets a throwaway HOME (and XDG dirs), so code that falls
 * back to `process.env` or `os.homedir()` instead of the sandbox env writes there, never to the
 * real home. That HOME is also a guard: when the run ends, anything found in it means a test or
 * the code under test ignored its sandbox, and the run fails with the list of paths.
 *
 * Variables of a live session (TURNO_*, CLAUDE*, CODEX_*, CURSOR_*, ANTHROPIC_*) are cleared too,
 * except the switches that select tests (TURNO_SKIP_E2E, TURNO_E2E_NETWORK, TURNO_SKIP_CHROME,
 * TURNO_SKIP_LIGHTPANDA), TURNO_LIGHTPANDA_PATH, which points the read mode tests at a Lightpanda,
 * and TURNO_CAMOUFOX_PATH and TURNO_PLAYWRIGHT_CORE, which turn on the Camoufox tests.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

const KEEP = new Set([
  "TURNO_SKIP_E2E",
  "TURNO_E2E_NETWORK",
  "TURNO_SKIP_CHROME",
  "TURNO_SKIP_LIGHTPANDA",
  "TURNO_LIGHTPANDA_PATH",
  "TURNO_CAMOUFOX_PATH",
  "TURNO_PLAYWRIGHT_CORE",
]);
const LIVE = /^(TURNO_|CLAUDE|CODEX_|CURSOR_|ANTHROPIC_|XDG_)/;

/**
 * What may appear under the guard HOME on Windows: the folders the setup itself makes (above),
 * and what Windows and Playwright keep under LOCALAPPDATA for any process, whatever turno does:
 * PowerShell's caches (every powershell.exe, the process table's included), Windows' own
 * caches, and Playwright's list of the browsers it serves (`ms-playwright\b`).
 */
const SETUP_DIRS = new Set(["AppData", join("AppData", "Local"), join("AppData", "Roaming")]);
const SYSTEM_DIRS = [
  join("AppData", "Local", "Microsoft", "Windows", "PowerShell"),
  join("AppData", "Local", "Microsoft", "Windows", "Caches"),
  join("AppData", "Local", "ms-playwright", "b"),
];
const allowed = (p: string) =>
  SETUP_DIRS.has(p) || SYSTEM_DIRS.some((d) => d === p || d.startsWith(`${p}${sep}`) || p.startsWith(`${d}${sep}`));

/** Paths written under the guard HOME, relative to it. */
export function guardFindings(home: string): string[] {
  try {
    return readdirSync(home, { recursive: true })
      .map(String)
      .sort()
      .filter((p) => !allowed(p));
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
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  process.env.XDG_DATA_HOME = join(home, ".local", "share");
  process.env.XDG_CACHE_HOME = join(home, ".cache");
  // Windows reads these instead of HOME: the profile folder, and turno's and Playwright's defaults.
  // PowerShell and Chrome create them when they are missing, so they are made here and not counted.
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    for (const dir of [process.env.APPDATA, process.env.LOCALAPPDATA]) mkdirSync(dir, { recursive: true });
  }
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
  process.env.PATH = `${guard}${delimiter}${process.env.PATH ?? ""}`;
  return () => {
    const found = guardFindings(home);
    rmSync(root, { recursive: true, force: true });
    if (found.length) {
      const shown = found.slice(0, 20).join("\n  ");
      throw new Error(
        `Tests wrote to HOME instead of their sandbox (test/helpers/sandbox.ts):\n  ${shown}${found.length > 20 ? "\n  ..." : ""}`,
      );
    }
  };
}
