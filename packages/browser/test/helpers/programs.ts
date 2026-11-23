import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * A stand-in program `name` in `dir`, in the form the system runs it: on macOS and Linux a script
 * with a shebang; on Windows a `.cmd` shim next to a `.js` file, as npm installs an agent there
 * (`claude.cmd`). `js` is the JavaScript it runs (its arguments in `process.argv.slice(2)`);
 * without it, the program exits 0. Returns the path a PATH lookup finds.
 */
export function fakeProgram(dir: string, name: string, js?: string): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const shim = join(dir, `${name}.cmd`);
    if (js === undefined) writeFileSync(shim, "@exit /b 0\r\n");
    else {
      writeFileSync(join(dir, `${name}.js`), js);
      writeFileSync(shim, `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    }
    return shim;
  }
  const file = join(dir, name);
  writeFileSync(file, js === undefined ? "#!/bin/sh\nexit 0\n" : `#!${process.execPath}\n${js}`);
  chmodSync(file, 0o755);
  return file;
}

/** `dirs` in front of `path`, joined the way the system's PATH is. */
export function pathWith(path: string | undefined, ...dirs: string[]): string {
  return [...dirs, ...(path ? [path] : [])].join(delimiter);
}

/** Output with Windows' separators turned into `/`, so one expectation reads paths on every OS. */
export function slashes(text: string): string {
  return process.platform === "win32" ? text.replaceAll("\\", "/") : text;
}
