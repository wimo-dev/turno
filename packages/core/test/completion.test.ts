import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completionScripts } from "../src/cli/completion.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fake program whose `__complete` answers with the words it was given, one per line. */
function fakeProgram(name: string): string {
  dir = mkdtempSync(join(tmpdir(), "turno-completion-"));
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nshift; shift\nfor w in "$@"; do printf "<%s>\\n" "$w"; done\n');
  chmodSync(bin, 0o755);
  return dir;
}

describe("completion scripts", () => {
  it("name the program, its __complete call and a valid shell function", () => {
    const s = completionScripts("turno-browser");
    for (const text of Object.values(s)) expect(text).toContain("turno-browser __complete --");
    expect(s.zsh).toContain("compdef _turno_browser turno-browser");
    expect(s.bash).toContain("complete -o default -F _turno_browser turno-browser");
    expect(s.fish).toContain("complete -c turno-browser -f -a '(__turno_browser_complete)'");
  });

  // The fake program is a POSIX shell script.
  it.skipIf(process.platform === "win32")(
    "pass each word to the program on its own under bash, empty last word included",
    () => {
      const bin = fakeProgram("demo-prog");
      const script = completionScripts("demo-prog").bash;
      const r = spawnSync(
        "bash",
        [
          "--norc",
          "-c",
          `eval "$1"; COMP_WORDS=(demo-prog do "two words" ""); COMP_CWORD=3; _demo_prog; printf '%s\\n' "\${COMPREPLY[@]}"`,
          "x",
          script,
        ],
        { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } },
      );
      expect(r.stderr).toBe("");
      expect(r.stdout.trim().split("\n")).toEqual(["<do>", "<two words>", "<>"]);
    },
  );
});
