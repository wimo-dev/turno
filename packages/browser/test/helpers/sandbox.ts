import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";

/** A throwaway HOME with the env turno reads. Never touches the real home. */
export interface Sandbox {
  home: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string, mode?: number): string;
  cleanup(): void;
}

/**
 * Windows: what programs there need to start (SystemRoot, PATHEXT, the temp folder, where
 * browsers are installed), the profile folders inside the sandbox, and turno's folders in the
 * XDG layout, so a test reads the same relative paths on every OS. The Windows defaults
 * (APPDATA, LOCALAPPDATA) have their own unit test in turno-core.
 */
function windowsEnv(home: string): NodeJS.ProcessEnv {
  const keep = ["SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)"];
  return {
    ...Object.fromEntries(keep.map((k) => [k, process.env[k]])),
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
}

export function sandbox(): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "turno-test-")));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    // A Claude Code CLI or Codex on this machine's PATH must not change what a test's server
    // lists, nor answer its calls: the tests of the provider chain set their own CLIs.
    TURNO_BROWSER_ACT_CLI: "off",
    ...(process.platform === "win32" ? windowsEnv(home) : {}),
  };
  return {
    home,
    env,
    write(rel, content, mode) {
      const file = join(home, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, mode !== undefined ? { mode } : undefined);
      return file;
    },
    cleanup() {
      // Windows keeps a file busy for a moment after the Chrome that had it open exits.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

/**
 * Expects `path` to have exactly the permission bits `mode`. Windows has no POSIX modes (the
 * user's profile folder keeps turno's files private there by its access list), so it checks
 * nothing on Windows.
 */
export function expectMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  expect(statSync(path).mode & 0o777).toBe(mode);
}
