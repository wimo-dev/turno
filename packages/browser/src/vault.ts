import { readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { browserPaths, writePrivateFile } from "turno-core/paths";
import { type SecretStore, requireSecretStore } from "turno-core/secrets";
import { IdentityError, assertIdentityId, identityDir } from "./ids.js";
import { type TotpParams, parseTotpSecret } from "./totp.js";
import { names } from "./names.js";
import { readIdentitySettings } from "./settings.js";

/**
 * The credential vault of a browser identity: a username, a password and optionally
 * a TOTP secret per site, so `browser_login` can fill a sign-in form without the model ever
 * seeing them.
 *
 * - The values live only in the OS secret store (turno-core: the macOS Keychain or the Linux
 *   Secret Service), one item per site named `turno-browser/vault/<identity>/<site>`, holding one
 *   line of JSON. Nothing here writes a value to a file, a log or an error message.
 * - An index next to identity.json (`<data>/browser/identities/<id>.vault.json`, mode 600) lists
 *   the sites with their origins and whether they have a TOTP secret, plus the identity's submit
 *   policy. It holds no username, password or secret, so `vault list` never reads the store.
 * - A site's origins bind its credentials: `browser_login` fills them only into frames of those
 *   origins, never into whatever page the model happens to be on.
 */

export class VaultError extends IdentityError {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** `confirm` (the default): browser_login fills and the model clicks sign in itself. `auto`: it also submits. */
export type SubmitPolicy = "confirm" | "auto";

export interface VaultSite {
  site: string;
  /** The origins (scheme, host, port) the credentials may be filled into. */
  origins: string[];
  /** A TOTP secret is stored with the credentials. */
  totp: boolean;
  created: string;
  updated: string;
}

interface VaultIndex {
  version: 1;
  submit: SubmitPolicy;
  sites: Record<string, Omit<VaultSite, "site">>;
}

/** What the store holds for one site. Never logged, never returned to a model. */
export interface Credential {
  username: string;
  password: string;
  totp?: TotpParams;
}

export interface VaultOptions {
  env?: NodeJS.ProcessEnv;
  /** The secret store (tests pass a fake); default: this machine's. */
  store?: SecretStore;
  now?: Date;
}

const SITE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_ORIGINS = 10;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function assertSiteKey(site: string): void {
  if (!SITE.test(site))
    throw new VaultError(
      `invalid site key "${site}": use lowercase letters, digits, ".", "-" and "_" (for example "github")`,
    );
}

/**
 * The origin of a sign-in URL, refusing what the vault must never fill into: anything but
 * https, except http on this machine (localhost, 127.0.0.1, [::1]) for local development.
 */
export function vaultOrigin(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VaultError(`"${url}" is not a URL (for example https://github.com/login)`);
  }
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.origin;
  throw new VaultError(`${u.origin || url}: the vault fills only https:// pages (http:// only on localhost)`);
}

/** The item name of a site's credentials in the secret store. */
export function vaultItem(id: string, site: string): string {
  return `turno-browser/vault/${id}/${site}`;
}

export function vaultPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(browserPaths(env).identitiesDir, `${id}.vault.json`);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isIndex(v: unknown): v is VaultIndex {
  if (!isObject(v) || v.version !== 1 || (v.submit !== "confirm" && v.submit !== "auto") || !isObject(v.sites))
    return false;
  return Object.entries(v.sites).every(
    ([k, s]) =>
      SITE.test(k) &&
      isObject(s) &&
      Array.isArray(s.origins) &&
      s.origins.every((o) => typeof o === "string") &&
      typeof s.totp === "boolean" &&
      typeof s.created === "string" &&
      typeof s.updated === "string",
  );
}

function readIndex(id: string, env: NodeJS.ProcessEnv): VaultIndex {
  const file = vaultPath(id, env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, submit: "confirm", sites: {} };
    throw err;
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    v = undefined;
  }
  if (isObject(v) && typeof v.version === "number" && v.version > 1)
    throw new VaultError(`${file} is from a newer turno-browser; update turno-browser`);
  if (!isIndex(v))
    throw new VaultError(
      `${file} is not a valid vault index; fix or remove it (the credentials stay in the secret store)`,
    );
  return v;
}

function writeIndex(id: string, index: VaultIndex, env: NodeJS.ProcessEnv): void {
  const file = vaultPath(id, env);
  const sites = Object.fromEntries(
    Object.keys(index.sites)
      .sort()
      .map((k) => [k, index.sites[k]!]),
  );
  const tmp = `${file}.${process.pid}.tmp`;
  writePrivateFile(tmp, `${JSON.stringify({ version: 1, submit: index.submit, sites }, null, 2)}\n`, env);
  renameSync(tmp, file);
}

function storeOf(options: VaultOptions): SecretStore {
  if (options.store) return options.store;
  try {
    return requireSecretStore(options.env ?? process.env);
  } catch (err) {
    throw new VaultError((err as Error).message);
  }
}

/** Store errors name the item, never the value; this keeps them that way and makes them VaultErrors. */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new VaultError(`${what}: ${(err as Error).message}`);
  }
}

export interface VaultInfo {
  identity: string;
  submit: SubmitPolicy;
  sites: (VaultSite & { stored: boolean })[];
}

/** The sites of an identity's vault and whether each item is still in the store (values are never read). */
export async function vaultList(id: string, options: VaultOptions = {}): Promise<VaultInfo> {
  const env = options.env ?? process.env;
  const index = readIndex(id, env);
  const entries = Object.entries(index.sites);
  const store = entries.length ? storeOf(options) : undefined;
  const sites = [];
  for (const [site, s] of entries) {
    const stored = await guarded(`checking ${site}`, () => store!.has(vaultItem(id, site)));
    sites.push({ site, ...s, stored });
  }
  return { identity: id, submit: index.submit, sites };
}

export interface VaultAddInput {
  /** The sign-in page, or any URL of each origin the credentials may be filled into. */
  urls: string[];
  username: string;
  password: string;
  /** A base32 TOTP secret or an otpauth://totp/ URI. */
  totp?: string;
}

/**
 * Store a site's credentials (replacing what was there) and record it in the index. The item is
 * deleted before it is written again: replacing a Keychain item in place makes macOS ask for
 * keychain access in a dialog, which a server or a script cannot answer.
 */
export async function vaultAdd(
  id: string,
  site: string,
  input: VaultAddInput,
  options: VaultOptions = {},
): Promise<VaultSite> {
  const env = options.env ?? process.env;
  assertIdentityId(id);
  assertSiteKey(site);
  if (!existsDir(identityDir(id, env)))
    throw new VaultError(`identity "${id}" does not exist (${names().browser} add ${id})`);
  if (!input.urls.length)
    throw new VaultError("give the sign-in page with --url (for example --url https://github.com/login)");
  const origins = [...new Set(input.urls.map(vaultOrigin))];
  if (origins.length > MAX_ORIGINS) throw new VaultError(`at most ${MAX_ORIGINS} origins per site`);
  if (!input.username) throw new VaultError("the username is empty");
  if (!input.password) throw new VaultError("the password is empty");
  const policy = readIdentitySettings(id, env)?.policy;
  if (policy?.disabled?.includes("login"))
    throw new VaultError(
      `identity "${id}" has "login" in its policy's disabled list: browser_login does not exist for it`,
    );
  if (input.totp && policy?.disabled?.includes("totp"))
    throw new VaultError(`identity "${id}" has "totp" in its policy's disabled list: store the site without --totp`);
  if (/[\0\r\n]/.test(input.username)) throw new VaultError("the username has a line break");
  const totp = input.totp ? parseTotpSecret(input.totp) : undefined;
  const index = readIndex(id, env);
  const store = storeOf(options);
  const item = vaultItem(id, site);
  const credential: Credential = { username: input.username, password: input.password, ...(totp ? { totp } : {}) };
  await guarded(`storing ${site}`, async () => {
    await store.remove(item);
    await store.set(item, JSON.stringify({ v: 1, ...credential }));
  });
  const stamp = (options.now ?? new Date()).toISOString();
  const entry = { origins, totp: !!totp, created: index.sites[site]?.created ?? stamp, updated: stamp };
  index.sites[site] = entry;
  writeIndex(id, index, env);
  return { site, ...entry };
}

/** Delete a site's credentials and its index entry; false when the vault had neither. */
export async function vaultRemove(id: string, site: string, options: VaultOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  assertSiteKey(site);
  const index = readIndex(id, env);
  const removed = await guarded(`removing ${site}`, () => storeOf(options).remove(vaultItem(id, site)));
  const listed = site in index.sites;
  if (listed) {
    delete index.sites[site];
    writeIndex(id, index, env);
  }
  return removed || listed;
}

/** Delete every credential of an identity and its index (before the identity itself is removed). */
export async function vaultClear(id: string, options: VaultOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const index = readIndex(id, env);
  const sites = Object.keys(index.sites);
  if (sites.length) {
    const store = storeOf(options);
    for (const site of sites) await guarded(`removing ${site}`, () => store.remove(vaultItem(id, site)));
  }
  rmSync(vaultPath(id, env), { force: true });
  return sites.length;
}

/** Choose whether browser_login submits the form itself (`auto`) or leaves that to the model. */
export function vaultSetSubmit(
  id: string,
  submit: SubmitPolicy,
  options: Pick<VaultOptions, "env"> = {},
): SubmitPolicy {
  const env = options.env ?? process.env;
  if (submit !== "confirm" && submit !== "auto") throw new VaultError(`submit must be "confirm" or "auto"`);
  if (!existsDir(identityDir(id, env)))
    throw new VaultError(`identity "${id}" does not exist (${names().browser} add ${id})`);
  if (submit === "auto" && readIdentitySettings(id, env)?.policy?.autoSubmit === false)
    throw new VaultError(
      `identity "${id}" has "autoSubmit": false in its policy: browser_login never submits the form`,
    );
  const index = readIndex(id, env);
  index.submit = submit;
  writeIndex(id, index, env);
  return submit;
}

/** One site's entry and the identity's submit policy, for browser_login; undefined when the site is not in the vault. */
export function vaultSite(
  id: string,
  site: string,
  env: NodeJS.ProcessEnv = process.env,
): { site: VaultSite; submit: SubmitPolicy } | undefined {
  assertSiteKey(site);
  const index = readIndex(id, env);
  const s = index.sites[site];
  return s ? { site: { site, ...s }, submit: index.submit } : undefined;
}

function isCredential(v: unknown): v is Credential & { v: 1 } {
  if (!isObject(v) || v.v !== 1 || typeof v.username !== "string" || typeof v.password !== "string") return false;
  if (v.totp === undefined) return true;
  const t = v.totp;
  return (
    isObject(t) &&
    typeof t.secret === "string" &&
    typeof t.digits === "number" &&
    typeof t.period === "number" &&
    ["SHA1", "SHA256", "SHA512"].includes(t.algorithm as string)
  );
}

/** A site's credentials from the store, for browser_login only. Errors never include the item's content. */
export async function readCredential(id: string, site: string, options: VaultOptions = {}): Promise<Credential> {
  const raw = await guarded(`reading ${site}`, () => storeOf(options).get(vaultItem(id, site)));
  if (raw === undefined)
    throw new VaultError(
      `the credentials of "${site}" are missing from the secret store; add them again with ${names().browser} vault add ${id} ${site}`,
    );
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    v = undefined;
  }
  if (!isCredential(v))
    throw new VaultError(
      `the secret store item of "${site}" is not a turno-browser credential; add it again with ${names().browser} vault add ${id} ${site}`,
    );
  return { username: v.username, password: v.password, ...(v.totp ? { totp: v.totp } : {}) };
}

/** True when the identity's vault lists any site (an unreadable index counts as yes). */
export function vaultHasSites(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Object.keys(readIndex(id, env).sites).length > 0;
  } catch {
    return true;
  }
}

/** True when `url` is on one of the site's origins. */
export function originAllowed(site: Pick<VaultSite, "origins">, url: string): boolean {
  try {
    return site.origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function existsDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The vault's sites and submit policy from the index alone (the store is never read); undefined when the index is unreadable. */
export function vaultSummary(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): { sites: string[]; submit: SubmitPolicy } | undefined {
  try {
    const index = readIndex(id, env);
    return { sites: Object.keys(index.sites).sort(), submit: index.submit };
  } catch {
    return undefined;
  }
}
