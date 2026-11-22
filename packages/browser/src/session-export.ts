import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import type { BrowserContext } from "patchright-core";
import { identityBrowserLaunch } from "./browsers.js";
import { clearHealth } from "./health.js";
import {
  IdentityError,
  addIdentity,
  assertIdentityId,
  identityDir,
  identityExists,
  inUseBy,
  isInUse,
} from "./identities.js";
import { identityStateDir } from "./ids.js";
import { startedChromePid } from "./lifecycle.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { SEALED_FORMAT, SealError, seal, unseal } from "./sealed.js";
import { names } from "./names.js";
import { chromeEnv, keychainArgs, launchSettings, readIdentitySettings, systemTimezone } from "./settings.js";

/**
 * Session export and import: an identity's cookies, localStorage and IndexedDB, as
 * Playwright's storageState, sealed under a passphrase (sealed.ts) with an expiry inside the
 * encrypted payload. For moving a signed-in identity to another machine or account, or keeping
 * a short-lived backup. The vault is never part of it: its values live in the secret
 * store, which the export does not read.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface Payload {
  kind: "turno-browser-session";
  identity: string;
  createdAt: string;
  expiresAt: string;
  storageState: StorageState;
}

export interface ExportOptions {
  passphrase: string;
  /** How long the export can be imported, in milliseconds (default 7 days, at most 90). */
  expiresInMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface SessionSummary {
  identity: string;
  createdAt: string;
  expiresAt: string;
  cookies: number;
  origins: number;
}

const DEFAULT_EXPIRY_MS = 7 * 24 * 3600_000;
const MAX_EXPIRY_MS = 90 * 24 * 3600_000;

/** Open the identity's profile headless, with its settings, hold its lock, and run `use`. */
async function withProfile<T>(
  id: string,
  env: NodeJS.ProcessEnv,
  holder: "export" | "import",
  use: (ctx: BrowserContext) => Promise<T>,
): Promise<T> {
  const holderMessage = inUseBy(id, env);
  if (holderMessage) throw new IdentityError(holderMessage);
  if (isInUse(id, env)) throw new IdentityError(`identity "${id}" is in use by a running Chrome; close it first`);
  const settings = readIdentitySettings(id, env);
  const held = acquireRuntimeLock(id, env, { holder });
  try {
    const dir = identityDir(id, env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const applied = launchSettings(settings, [], systemTimezone());
    const { chromium } = await import("patchright-core");
    const ctx = await chromium.launchPersistentContext(dir, {
      ...identityBrowserLaunch(settings, env, names().browser),
      headless: true,
      viewport: null,
      ...(applied.args.length ? { args: applied.args } : {}),
      ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
      ...keychainArgs(settings),
      // Chrome gets the caller's environment (HOME, XDG dirs), not this process's.
      env: chromeEnv(env),
    });
    const pid = startedChromePid(dir);
    if (pid !== undefined) held.update({ chromePid: pid, pgid: pid });
    try {
      return await use(ctx);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } finally {
    held.release();
  }
}

/** Most origins an export visits; a profile with more keeps only these (the first found). */
const MAX_ORIGINS = 2_000;

function originOf(text: string): string | undefined {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The origins that may hold site storage in a profile. Playwright's storageState reads
 * localStorage and IndexedDB only for origins the context opened since it started, which for a
 * profile just opened is none; these are what export opens first. They come from the IndexedDB
 * folder names (`https_example.com_0.indexeddb.leveldb`), the origin keys in the Local Storage
 * database (`META:https://example.com`), and the cookies' hosts.
 */
export function profileOrigins(profileDir: string, cookies: { domain: string; secure: boolean }[]): string[] {
  const found = new Set<string>();
  const add = (o: string | undefined) => {
    if (o && found.size < MAX_ORIGINS) found.add(o);
  };
  const base = join(profileDir, "Default");
  for (const name of listDir(join(base, "IndexedDB"))) {
    const m = /^(https?)_(.+)_(\d+)\.indexeddb\.(leveldb|blob)$/.exec(name);
    if (m) add(originOf(`${m[1]}://${m[2]}${m[3] === "0" ? "" : `:${m[3]}`}`));
  }
  const leveldb = join(base, "Local Storage", "leveldb");
  for (const name of listDir(leveldb)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(join(leveldb, name), "latin1");
    } catch {
      continue;
    }
    for (const m of text.matchAll(
      /(?:META:|_)(https?:\/\/[a-z0-9.-]+(?::\d{1,5})?|https?:\/\/\[[0-9a-f:]+\](?::\d{1,5})?)/gi,
    ))
      add(originOf(m[1]!));
  }
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, "");
    add(originOf(`https://${host}`));
    if (!c.secure) add(originOf(`http://${host}`));
  }
  return [...found];
}

/**
 * Open each origin in one page whose requests are all answered locally with an empty
 * document, so the context knows them and storageState reads their storage. Nothing goes to
 * the network.
 */
async function visitOrigins(ctx: BrowserContext, origins: string[]): Promise<void> {
  if (!origins.length) return;
  const page = await ctx.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title></title>" }),
    );
    for (const origin of origins)
      await page.goto(`${origin}/`, { waitUntil: "commit", timeout: 10_000 }).catch(() => undefined);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function summary(p: Payload): SessionSummary {
  return {
    identity: p.identity,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    cookies: p.storageState.cookies.length,
    origins: p.storageState.origins.length,
  };
}

/** The sealed export of an identity's session, and what it holds (counts only). */
export async function exportSession(
  id: string,
  options: ExportOptions,
): Promise<{ sealed: string; summary: SessionSummary }> {
  const env = options.env ?? process.env;
  assertIdentityId(id);
  if (!identityExists(id, env)) throw new IdentityError(`identity "${id}" does not exist`);
  const expiresIn = options.expiresInMs ?? DEFAULT_EXPIRY_MS;
  if (!(expiresIn > 0 && expiresIn <= MAX_EXPIRY_MS))
    throw new SealError("the expiry must be more than 0 and at most 90 days");
  const storageState = await withProfile(id, env, "export", async (ctx) => {
    await visitOrigins(ctx, profileOrigins(identityDir(id, env), await ctx.cookies()));
    return await ctx.storageState({ indexedDB: true });
  });
  const now = options.now ?? new Date();
  const payload: Payload = {
    kind: "turno-browser-session",
    identity: id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresIn).toISOString(),
    storageState,
  };
  return { sealed: await seal(payload, options.passphrase), summary: summary(payload) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isPayload(v: unknown): v is Payload {
  if (!isObject(v) || v.kind !== "turno-browser-session" || typeof v.identity !== "string") return false;
  if (typeof v.createdAt !== "string" || typeof v.expiresAt !== "string" || Number.isNaN(Date.parse(v.expiresAt)))
    return false;
  const s = v.storageState;
  return isObject(s) && Array.isArray(s.cookies) && Array.isArray(s.origins);
}

/** Decrypt and check an export without touching any identity: what `import --dry-run` shows. */
export async function readSessionExport(
  text: string,
  passphrase: string,
  now: Date = new Date(),
): Promise<{ payload: Payload; summary: SessionSummary }> {
  const v = await unseal(text, passphrase);
  if (!isPayload(v)) throw new SealError("this session export is damaged (its content is not a session)");
  if (now.getTime() > Date.parse(v.expiresAt))
    throw new SealError(`this session export expired on ${v.expiresAt}; export it again`);
  return { payload: v, summary: summary(v) };
}

export interface ImportOptions {
  passphrase: string;
  /** Import into this identity instead of the one the export came from. */
  as?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/**
 * Replace an identity's cookies, localStorage and IndexedDB with an export's (creating the
 * identity when it does not exist). The caller confirms first when the identity exists: what
 * it had is gone afterwards.
 */
export async function importSession(
  text: string,
  options: ImportOptions,
): Promise<SessionSummary & { created: boolean }> {
  const env = options.env ?? process.env;
  const { payload, summary: s } = await readSessionExport(text, options.passphrase, options.now);
  const id = options.as ?? payload.identity;
  assertIdentityId(id);
  const created = !identityExists(id, env);
  if (created) addIdentity(id, env);
  await withProfile(id, env, "import", (ctx) => ctx.setStorageState(payload.storageState));
  clearHealth(id, env);
  return { ...s, identity: id, created };
}

/** `<state>/browser/identities/<id>/exports.json`: the files `export` wrote, for `remove`. */
function exportsRecordPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(identityStateDir(id, env), "exports.json");
}

function recordedExports(id: string, env: NodeJS.ProcessEnv): string[] {
  try {
    const v = JSON.parse(readFileSync(exportsRecordPath(id, env), "utf8")) as { files?: unknown };
    return Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a file `export` wrote for the identity (an absolute path), so `remove` can delete it. */
export function recordExportFile(id: string, file: string, env: NodeJS.ProcessEnv = process.env): void {
  const files = [...new Set([...recordedExports(id, env), file])];
  const record = exportsRecordPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${record}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, files }, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, record);
}

/**
 * The exports of the identity that are still where `export` wrote them and still hold a sealed
 * session: a file replaced by something else since is not one of them.
 */
export function exportFiles(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return recordedExports(id, env).filter((file) => {
    if (!existsSync(file)) return false;
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { format?: unknown }).format === SEALED_FORMAT;
    } catch {
      return false;
    }
  });
}
