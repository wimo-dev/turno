import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { browserPaths as paths } from "turno-core/paths";
import { pidAlive } from "turno-core/process";
import { IdentityError, assertIdentityId, identityDir, identityStateDir, isValidIdentityId } from "./ids.js";
import { removeFlows } from "./flows.js";
import { inUseMessage, readRuntimeLock, runtimeLockAlive } from "./runtime-lock.js";
import { type SettingsPatch, identitySettingsPath, systemTimezone, writeIdentitySettings } from "./settings.js";
import { vaultHasSites, vaultPath } from "./vault.js";
import { names } from "./names.js";

export { IdentityError, assertIdentityId, identityDir, identityStateDir, isValidIdentityId };

/**
 * A browser identity is a persistent Chrome user data dir (cookies, local storage, saved
 * logins) under `<data>/browser/identities/<id>`. One identity maps to one mcpd server
 * (`browser-<id>`), so a site login done once by hand is reused by every session.
 */

export interface IdentityInfo {
  id: string;
  dir: string;
  /** A live Chrome holds the profile (its SingletonLock points to a running PID). */
  inUse: boolean;
}

export function identityExists(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = identityDir(id, env);
  return existsSync(dir) && statSync(dir).isDirectory();
}

export function listIdentities(env: NodeJS.ProcessEnv = process.env): IdentityInfo[] {
  const root = paths(env).identitiesDir;
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidIdentityId(d.name))
      .map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.sort().map((id) => ({ id, dir: join(root, id), inUse: isInUse(id, env) }));
}

/**
 * Create the identity dir (mode 700) and return its info. A new identity also gets its
 * identity.json, pinned to the system time zone plus the settings given, so it keeps the same
 * zone and languages from then on. Adding an existing identity changes nothing,
 * unless settings are given: then they are written to its identity.json.
 */
export function addIdentity(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  settings: SettingsPatch = {},
  now: Date = new Date(),
): IdentityInfo {
  const dir = identityDir(id, env);
  const created = !existsSync(dir);
  const given = Object.values(settings).some((v) => v !== undefined);
  if (created && !existsSync(identitySettingsPath(id, env))) {
    // Validate before creating anything, so a bad setting leaves no half-made identity.
    writeIdentitySettings(id, { timezone: systemTimezone(), ...settings }, env, now);
  } else if (given) {
    writeIdentitySettings(id, settings, env, now);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir, inUse: isInUse(id, env) };
}

/**
 * Delete the identity: its profile, its identity.json and what turno wrote for it (runtime
 * state, health, reputation log). Refuses while Chrome holds it, and while its vault still has
 * credentials (their secret store items would be left behind; `vaultClear` removes them first).
 */
export function removeIdentity(id: string, env: NodeJS.ProcessEnv = process.env): void {
  const dir = identityDir(id, env);
  if (!existsSync(dir)) throw new IdentityError(`identity "${id}" does not exist`);
  const holder = inUseBy(id, env);
  if (holder) throw new IdentityError(`${holder} Remove it after that.`);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use by a running Chrome; close it first`);
  if (vaultHasSites(id, env))
    throw new IdentityError(
      `identity "${id}" still has vault credentials; remove them first (${names().browser} remove does)`,
    );
  rmSync(dir, { recursive: true, force: true });
  rmSync(vaultPath(id, env), { force: true });
  rmSync(identitySettingsPath(id, env), { force: true });
  rmSync(identityStateDir(id, env), { recursive: true, force: true });
  removeFlows(id, env);
}

/**
 * Chrome writes `SingletonLock` as a symlink whose target is `<hostname>-<pid>`.
 * Returns the PID, or undefined when the target does not have that shape.
 */
export function parseSingletonLock(target: string): number | undefined {
  const m = /-(\d+)$/.exec(target);
  if (!m) return undefined;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Who holds the identity right now (its runtime lock), as a message; undefined when nobody does. */
export function inUseBy(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lock = readRuntimeLock(id, env);
  return lock && runtimeLockAlive(lock) ? inUseMessage(id, lock) : undefined;
}

/**
 * True while a Chrome holds the profile on Windows: it keeps `lockfile` open without sharing it
 * and deletes it when it exits (the check Playwright makes before a launch there).
 */
export function windowsProfileLocked(userDataDir: string): boolean {
  try {
    closeSync(openSync(join(userDataDir, "lockfile"), "r+"));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** True when a live process holds the identity's runtime lock or its Chrome profile. */
export function isInUse(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (inUseBy(id, env)) return true;
  if (platform === "win32") return windowsProfileLocked(identityDir(id, env));
  let target: string;
  try {
    target = readlinkSync(join(identityDir(id, env), "SingletonLock"));
  } catch {
    return false;
  }
  const pid = parseSingletonLock(target);
  return pid !== undefined && pidAlive(pid);
}
