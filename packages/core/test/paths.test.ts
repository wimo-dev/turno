import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  browserPaths,
  ensurePrivateDir,
  envValue,
  findOnPath,
  isPrivatePath,
  resetPrivateDirCache,
  tildify,
  turnoRoots,
  writePrivateFile,
} from "../src/paths.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
  resetPrivateDirCache();
});
afterEach(() => sb.cleanup());

describe("turno's roots", () => {
  it("follow HOME, then XDG, then the TURNO_* overrides", () => {
    expect(turnoRoots({ HOME: "/h" }, "linux")).toEqual({
      home: "/h",
      config: "/h/.config/turno",
      state: "/h/.local/state/turno",
      data: "/h/.local/share/turno",
    });
    expect(
      turnoRoots({ HOME: "/h", XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s", XDG_DATA_HOME: "/x/d" }, "linux"),
    ).toMatchObject({
      config: "/x/c/turno",
      state: "/x/s/turno",
      data: "/x/d/turno",
    });
    expect(
      turnoRoots(
        {
          HOME: "/h",
          XDG_DATA_HOME: "/x/d",
          TURNO_DATA_DIR: "/t/d",
          TURNO_STATE_DIR: "/t/s",
          TURNO_CONFIG_DIR: "/t/c",
        },
        "linux",
      ),
    ).toMatchObject({
      config: "/t/c",
      state: "/t/s",
      data: "/t/d",
    });
  });

  it("place turno-browser's files under the data and state roots", () => {
    expect(browserPaths({ HOME: "/h" }, "linux")).toEqual({
      home: "/h",
      state: "/h/.local/state/turno",
      data: "/h/.local/share/turno",
      browserDir: "/h/.local/share/turno/browser",
      identitiesDir: "/h/.local/share/turno/browser/identities",
      benchDir: "/h/.local/state/turno/bench",
      identityStateDir: "/h/.local/state/turno/browser/identities",
    });
  });

  it("on Windows, keep the config in APPDATA and state and data in LOCALAPPDATA", () => {
    const env = { USERPROFILE: "C:\\Users\\a", AppData: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "D:\\local" };
    expect(turnoRoots(env, "win32")).toEqual({
      home: "C:\\Users\\a",
      config: "C:\\Users\\a\\AppData\\Roaming\\turno",
      state: "D:\\local\\turno\\state",
      data: "D:\\local\\turno\\data",
    });
    expect(browserPaths(env, "win32").identitiesDir).toBe("D:\\local\\turno\\data\\browser\\identities");
    // Without the variables (a sandbox env), from the profile folder; set XDG and TURNO_* still win.
    expect(turnoRoots({ HOME: "C:\\h", XDG_STATE_HOME: "C:\\x\\s", TURNO_DATA_DIR: "C:\\t\\d" }, "win32")).toEqual({
      home: "C:\\h",
      config: "C:\\h\\AppData\\Roaming\\turno",
      state: "C:\\x\\s\\turno",
      data: "C:\\t\\d",
    });
    expect(tildify("c:\\users\\a\\x\\y", env, "win32")).toBe("~\\x\\y");
  });

  it("read Windows variables whatever their case", () => {
    expect(envValue({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin");
    expect(envValue({ Path: "/bin" }, "PATH", "linux")).toBeUndefined();
  });
});

describe("private files", () => {
  // Windows has no POSIX modes; the user's profile folder is private to the user by its ACL.
  it.skipIf(process.platform === "win32")("creates folders 0700 and files 0600 inside turno's roots only", () => {
    const file = join(turnoRoots(sb.env).state, "a", "b.json");
    writePrivateFile(file, "{}", sb.env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(turnoRoots(sb.env).state, "a")).mode & 0o777).toBe(0o700);
    expect(statSync(turnoRoots(sb.env).state).mode & 0o777).toBe(0o700);
    expect(isPrivatePath(file, sb.env)).toBe(true);
    const outside = ensurePrivateDir(join(sb.home, "elsewhere"), sb.env);
    expect(isPrivatePath(outside, sb.env)).toBe(false);
  });
});

describe("findOnPath", () => {
  // The execute bit decides here; Windows has none (next test).
  it.skipIf(process.platform === "win32")("finds an executable on PATH and nothing else", () => {
    sb.write("bin/tool", "#!/bin/sh\n", 0o755);
    sb.write("bin/data", "x", 0o644);
    const env = { PATH: `${join(sb.home, "missing")}:${join(sb.home, "bin")}` };
    expect(findOnPath("tool", env)).toBe(join(sb.home, "bin", "tool"));
    expect(findOnPath("data", env)).toBeUndefined();
    expect(findOnPath(join(sb.home, "bin", "tool"), {})).toBe(join(sb.home, "bin", "tool"));
  });

  it.runIf(process.platform === "win32")(
    "on Windows, finds a command through PATHEXT, as claude finds claude.cmd",
    () => {
      sb.write("bin/tool.cmd", "@echo off\r\n");
      sb.write("bin/data.txt", "x");
      const env = { Path: `${join(sb.home, "missing")};${join(sb.home, "bin")}`, PATHEXT: ".EXE;.CMD" };
      expect(findOnPath("tool", env, "win32")?.toLowerCase()).toBe(join(sb.home, "bin", "tool.cmd").toLowerCase());
      expect(findOnPath("tool.cmd", env, "win32")?.toLowerCase()).toBe(join(sb.home, "bin", "tool.cmd").toLowerCase());
      expect(findOnPath("data", env, "win32")).toBeUndefined();
    },
  );
});
