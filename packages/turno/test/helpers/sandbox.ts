import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway HOME with the env turno reads. Never touches the real home. */
export interface Sandbox {
  home: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string, mode?: number): string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "turno-test-")));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    TURNO_NO_UPDATE_CHECK: "1",
    // A Claude Code CLI or Codex on this machine's PATH must not change what turno-browser
    // reports for natural language actions.
    TURNO_BROWSER_ACT_CLI: "off",
    // A test run shows no notification of the system (`notify.ts`).
    TURNO_BROWSER_NOTIFY: "off",
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
      rmSync(home, { recursive: true, force: true });
    },
  };
}
