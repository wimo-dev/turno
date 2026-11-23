import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, posix, relative, sep, win32 } from "node:path";

/** The path functions of a platform, so a result never depends on the OS the tests run on. */
export function pathsFor(platform: NodeJS.Platform = process.platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/**
 * A variable of `env`. Windows names are case-insensitive, but a copy of `process.env` (an
 * object spread) keeps the case Windows gave them: `Path`, `ProgramFiles`, `LocalAppData`.
 */
export function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const value = env[name];
  if (value !== undefined || platform !== "win32") return value;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/**
 * turno's own roots, derived from HOME and the XDG variables so tests can run against a
 * sandbox home. turno-cli and turno-browser both build their paths on these, so the two
 * packages always agree on where turno keeps its files. Call it each time instead of caching:
 * tests change HOME.
 *
 * On Windows the defaults follow the platform instead of XDG: the config roams with the user
 * (`%APPDATA%\turno`), state and data (Chrome profiles, large) stay on the machine
 * (`%LOCALAPPDATA%\turno\state` and `\data`). An XDG variable that is set still wins there.
 */
export interface TurnoRoots {
  home: string;
  /** `TURNO_CONFIG_DIR`, else `$XDG_CONFIG_HOME/turno` (default `~/.config/turno`, Windows `%APPDATA%\turno`). */
  config: string;
  /** `TURNO_STATE_DIR`, else `$XDG_STATE_HOME/turno` (default `~/.local/state/turno`, Windows `%LOCALAPPDATA%\turno\state`). */
  state: string;
  /** `TURNO_DATA_DIR`, else `$XDG_DATA_HOME/turno` (default `~/.local/share/turno`, Windows `%LOCALAPPDATA%\turno\data`). */
  data: string;
}

export function turnoRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TurnoRoots {
  const get = (name: string) => envValue(env, name, platform) || undefined;
  const { join } = pathsFor(platform);
  if (platform === "win32") {
    // USERPROFILE first, as Node's os.homedir() and the agents read it; Git Bash may set HOME too.
    const home = get("USERPROFILE") || get("HOME") || homedir();
    const roaming = get("APPDATA") || join(home, "AppData", "Roaming");
    const local = get("LOCALAPPDATA") || join(home, "AppData", "Local");
    const xdg = (name: string) => (get(name) ? join(get(name)!, "turno") : undefined);
    return {
      home,
      config: get("TURNO_CONFIG_DIR") || xdg("XDG_CONFIG_HOME") || join(roaming, "turno"),
      state: get("TURNO_STATE_DIR") || xdg("XDG_STATE_HOME") || join(local, "turno", "state"),
      data: get("TURNO_DATA_DIR") || xdg("XDG_DATA_HOME") || join(local, "turno", "data"),
    };
  }
  const home = env.HOME || homedir();
  return {
    home,
    config: env.TURNO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "turno"),
    state: env.TURNO_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local", "state"), "turno"),
    data: env.TURNO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "turno"),
  };
}

/** Replace the home prefix with ~ for display. */
export function tildify(p: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const path = pathsFor(platform);
  const sepChars = platform === "win32" ? /[\\/]+$/ : /\/+$/;
  // HOME may come with a trailing slash or doubled slashes (HOME=/Users/a/): compare normalized.
  let home = path.normalize(turnoRoots(env, platform).home);
  if (home !== path.parse(home).root) home = home.replace(sepChars, "");
  const q = path.isAbsolute(p) ? path.normalize(p) : p;
  if (home === path.parse(home).root) return p;
  const same = (a: string, b: string) => (platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(q, home)) return "~";
  return same(q.slice(0, home.length + 1), `${home}${path.sep}`) ? `~${q.slice(home.length)}` : p;
}

/** Where turno-browser keeps its files. */
export interface BrowserPaths {
  home: string;
  state: string;
  data: string;
  /** Root of the browser package data: <data>/browser. */
  browserDir: string;
  /** Persistent Chrome profiles, one per identity. */
  identitiesDir: string;
  /** Bench reports: <state>/bench. */
  benchDir: string;
  /** Generated files per identity, outside the Chrome profile: <state>/browser/identities. */
  identityStateDir: string;
}

export function browserPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserPaths {
  const { home, state, data } = turnoRoots(env, platform);
  const { join } = pathsFor(platform);
  const browserDir = join(data, "browser");
  return {
    home,
    state,
    data,
    browserDir,
    identitiesDir: join(browserDir, "identities"),
    benchDir: join(state, "bench"),
    identityStateDir: join(state, "browser", "identities"),
  };
}

/** Mode of every directory turno creates under its own config, state and data roots. */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of every file turno writes under those roots (logs, accounts.toml, audit log, mcpd.port). */
export const PRIVATE_FILE_MODE = 0o600;

/** turno's own roots (config, state, data): what `ensurePrivateDir` locks down. */
export function privateRoots(env: NodeJS.ProcessEnv): string[] {
  const r = turnoRoots(env);
  return [r.config, r.state, r.data];
}

function within(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The turno root (config, state or data) that holds `file`, if any. */
function rootOf(file: string, env: NodeJS.ProcessEnv): string | undefined {
  return privateRoots(env).find((root) => within(file, root));
}

/** True when `file` is one of turno's roots or lies inside one. */
export function isPrivatePath(file: string, env: NodeJS.ProcessEnv): boolean {
  return rootOf(file, env) !== undefined;
}

/** Roots already checked by this process (tests switch HOME, so the key is the path). */
const lockedRoots = new Set<string>();

function lockRoot(root: string): void {
  if (lockedRoots.has(root)) return;
  // Parents such as ~/.config keep the default mode; only turno's own folder is private.
  mkdirSync(dirname(root), { recursive: true });
  try {
    mkdirSync(root, { mode: PRIVATE_DIR_MODE });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = statSync(root);
  if ((st.mode & 0o777) !== PRIVATE_DIR_MODE && st.uid === process.getuid?.()) chmodSync(root, PRIVATE_DIR_MODE);
  lockedRoots.add(root);
}

/**
 * Create `dir` (and its parents) for turno's own state. Inside turno's config, state and data
 * roots every folder is created 0700, and an existing root with a wider mode is narrowed to
 * 0700 the first time a process uses it. Other folders are created with the default mode.
 * Returns `dir`.
 */
export function ensurePrivateDir(dir: string, env: NodeJS.ProcessEnv): string {
  const root = rootOf(dir, env);
  if (!root) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  lockRoot(root);
  // Recursive mkdir applies the mode to every folder it creates, the root included if it vanished.
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  return dir;
}

/**
 * Write a small file turno keeps for itself (a mark, a cache, a state file): its folder through
 * `ensurePrivateDir`, the file created 0600, and narrowed to 0600 when an older turno left it
 * wider. Not atomic; write to a temporary name and rename for files a reader must never see
 * half written.
 */
export function writePrivateFile(file: string, data: string, env: NodeJS.ProcessEnv): void {
  ensurePrivateDir(dirname(file), env);
  const fd = openSync(file, "w", PRIVATE_FILE_MODE);
  try {
    if (fstatSync(fd).mode & 0o077) fchmodSync(fd, PRIVATE_FILE_MODE);
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** Forget which roots were checked (tests). */
export function resetPrivateDirCache(): void {
  lockedRoots.clear();
}

/** The extensions Windows runs a bare command name with (PATHEXT), lower case. */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  return (envValue(env, "PATHEXT", "win32") || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => e.startsWith("."))
    .map((e) => e.toLowerCase());
}

/**
 * The first executable called `name` on the PATH of `env`, or undefined. On Windows a bare
 * name is tried with each PATHEXT extension (`claude` finds `claude.cmd`), and any file
 * counts, since Windows has no execute bit.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const path = pathsFor(platform);
  const windows = platform === "win32";
  const runnable = (file: string): boolean => {
    try {
      if (!windows) accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const exts = windows ? pathExts(env) : [];
  const forms = (file: string): string[] =>
    !windows || exts.includes(path.extname(file).toLowerCase()) ? [file] : exts.map((e) => `${file}${e}`);
  if (name.includes("/") || (windows && name.includes("\\"))) return forms(name).find(runnable);
  for (const dir of (envValue(env, "PATH", platform) ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const found = forms(path.join(dir, name)).find(runnable);
    if (found) return found;
  }
  return undefined;
}

const RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * `renameSync(from, to)`, replacing `to`. Windows refuses to replace a file another program
 * holds open for a moment (an antivirus scan, the search indexer, a reader without delete
 * sharing) with EPERM, EACCES or EBUSY; the rename is tried again for up to `ms` there.
 */
export function replaceFileSync(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  ms = 2000,
): void {
  const end = Date.now() + ms;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (platform !== "win32" || !RENAME_BUSY.has(code) || Date.now() >= end) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}
