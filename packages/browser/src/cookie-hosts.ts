import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The host names an identity's Chrome profile holds cookies for, for `status`: read from the
 * profile's cookie store (SQLite), opened read only, selecting `host_key` alone. Cookie names and
 * values are never read; the values are encrypted anyway. While Chrome has the profile open the
 * store is not opened at all (Chrome keeps it locked, and a reader could make it wait), and the
 * caller says so instead.
 */

export type CookieHosts = { hosts: string[] } | { note: string };

/** The cookie store of a profile: newer Chrome keeps it under Network/. */
function cookieFile(profile: string): string | undefined {
  return ["Default/Network/Cookies", "Default/Cookies"].map((f) => join(profile, f)).find((f) => existsSync(f));
}

type SqliteModule = typeof import("node:sqlite");

/** node:sqlite, without its experimental warning on the Node versions that print one; undefined where it is missing. */
async function sqlite(): Promise<SqliteModule | undefined> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emit;
  }
}

/** The sorted host names (without a leading dot) of the profile's cookies. */
export async function cookieHosts(profile: string, inUse: boolean): Promise<CookieHosts> {
  const file = cookieFile(profile);
  if (!file) return { hosts: [] };
  if (inUse) return { note: "not read while Chrome has the profile open" };
  const mod = await sqlite();
  if (!mod) return { note: "this Node has no node:sqlite to read the cookie store (Node 22.13 or newer has it)" };
  let db: InstanceType<SqliteModule["DatabaseSync"]> | undefined;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT DISTINCT host_key FROM cookies").all() as { host_key?: unknown }[];
    const hosts = new Set<string>();
    for (const row of rows)
      if (typeof row.host_key === "string" && row.host_key) hosts.add(row.host_key.replace(/^\./, ""));
    return { hosts: [...hosts].sort() };
  } catch (err) {
    return { note: `the cookie store could not be read: ${(err as Error).message.split("\n")[0]}` };
  } finally {
    db?.close();
  }
}
