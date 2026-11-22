import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { verifyAudit } from "../accounts/audit.js";
import { SCAN_ORDER, adapter, mcpFileFor } from "../agents/index.js";
import { type Config, loadConfig } from "../core/config.js";
import { loadManifest } from "../core/manifest.js";
import { paths, privateRoots, tildify } from "../core/paths.js";
import { agentOf, listProfiles } from "../core/profiles.js";
import { describeSecretStore, secretStore } from "../core/secrets.js";
import { profileTokenFile, tokenProfile } from "../mcpd/tokens.js";
import type { Check } from "./commands/doctor.js";
import { isObject } from "../core/fsutil.js";

/**
 * `turno doctor --security`: who can read turno's files, who holds the mcpd port,
 * literal secrets left in configs and backups, MCP servers that run whatever version is newest,
 * the age of the gateway token, and the audit log's hash chain. Every check only reads, except
 * the permissions fix, which narrows modes under turno's own folders.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A gateway token older than this gets a rotation hint. */
export const TOKEN_MAX_AGE_DAYS = 90;
/** Paths listed in one finding before "and N more". */
const SHOWN = 5;
/** Entries walked under turno's folders before giving up (a runaway tree is a finding of its own). */
const WALK_LIMIT = 20_000;

type Finding = Omit<Check, "area">;
const check = (c: Finding): Check => ({ area: "security", ...c });

function listPaths(files: string[], env: NodeJS.ProcessEnv): string {
  const shown = files.slice(0, SHOWN).map((f) => tildify(f, env));
  return `${shown.join(", ")}${files.length > SHOWN ? ` and ${files.length - SHOWN} more` : ""}`;
}

// ---- secret store

function secretStoreCheck(env: NodeJS.ProcessEnv): Check {
  const store = secretStore(env);
  if (store) return check({ level: "ok", text: `secret store: ${secretStoreLabel(env)}` });
  let usesKeychain = false;
  try {
    usesKeychain = existsSync(paths(env).mcpFile) && readFileSync(paths(env).mcpFile, "utf8").includes("keychain:");
  } catch {
    /* unreadable: reported elsewhere */
  }
  return check({
    level: usesKeychain ? "fail" : "info",
    text: `secret store: none found (no security or secret-tool on PATH)${usesKeychain ? "; mcp.toml has keychain: references that cannot resolve" : ""}`,
    manual: usesKeychain
      ? "install secret-tool (libsecret), or write env:NAME in place of each keychain: reference in mcp.toml"
      : "use env:NAME references in mcp.toml",
  });
}

/** "macOS Keychain (security)" or "Secret Service (secret-tool)", or "none", for doctor and status. */
export function secretStoreLabel(env: NodeJS.ProcessEnv): string {
  const store = secretStore(env);
  if (!store) return "none";
  return describeSecretStore(store);
}

// ---- permissions

export interface PermissionFinding {
  path: string;
  mode: number;
  dir: boolean;
  uid: number;
}

/** Subtrees whose contents other programs own (npm installs, Chrome profiles): only their folder is checked. */
function opaqueDirs(env: NodeJS.ProcessEnv): Set<string> {
  const p = paths(env);
  return new Set([p.serversDir, p.chromeProfilesDir, p.browserDir]);
}

/**
 * Folders and files under turno's config, state and data roots that group or others can read or
 * write, or that belong to another user. Symbolic links are not followed.
 */
export function scanPermissions(env: NodeJS.ProcessEnv): {
  wide: PermissionFinding[];
  foreign: PermissionFinding[];
  truncated: boolean;
} {
  const uid = process.getuid?.();
  const opaque = opaqueDirs(env);
  const wide: PermissionFinding[] = [];
  const foreign: PermissionFinding[] = [];
  let seen = 0;
  const visit = (path: string): boolean => {
    if (++seen > WALK_LIMIT) return false;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return true;
    }
    if (st.isSymbolicLink()) return true;
    const f: PermissionFinding = { path, mode: st.mode & 0o777, dir: st.isDirectory(), uid: st.uid };
    if (uid !== undefined && st.uid !== uid) foreign.push(f);
    else if (f.mode & 0o077) wide.push(f);
    if (!f.dir || opaque.has(path) || basename(path) === "node_modules") return true;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return true;
    }
    for (const name of names) if (!visit(join(path, name))) return false;
    return true;
  };
  let truncated = false;
  for (const root of new Set(privateRoots(env))) {
    if (!existsSync(root)) continue;
    if (!visit(root)) {
      truncated = true;
      break;
    }
  }
  return { wide, foreign, truncated };
}

/** Remove group and other bits from every finding this user owns. Returns how many changed. */
export function narrowPermissions(findings: PermissionFinding[]): number {
  let n = 0;
  for (const f of findings) {
    try {
      chmodSync(f.path, f.mode & 0o700);
      n++;
    } catch {
      /* gone or not ours: the next doctor run shows it again */
    }
  }
  return n;
}

function permissionChecks(env: NodeJS.ProcessEnv): Check[] {
  const { wide, foreign, truncated } = scanPermissions(env);
  const out: Check[] = [];
  const roots = privateRoots(env).filter((r) => existsSync(r));
  if (!roots.length) return [check({ level: "info", text: "permissions: turno has no folders yet" })];
  if (!wide.length && !foreign.length)
    out.push(
      check({
        level: "ok",
        text: `permissions: only you can read turno's folders (${roots.map((r) => tildify(r, env)).join(", ")})`,
      }),
    );
  if (wide.length) {
    const writable = wide.filter((f) => f.mode & 0o022);
    out.push(
      check({
        level: writable.length ? "fail" : "warn",
        text: `permissions: ${wide.length} item${wide.length === 1 ? "" : "s"} under turno's folders ${writable.length ? "can be changed" : "can be read"} by other users: ${listPaths(
          (writable.length ? writable : wide).map((f) => f.path),
          env,
        )}`,
        fix: {
          label: "turno doctor --security --fix",
          run: (io) => {
            const n = narrowPermissions(scanPermissions(io.env).wide);
            io.out(`narrowed ${n} item${n === 1 ? "" : "s"} to owner only`);
          },
        },
      }),
    );
  }
  if (foreign.length) {
    out.push(
      check({
        level: "warn",
        text: `permissions: ${foreign.length} item${foreign.length === 1 ? "" : "s"} under turno's folders belong to another user (a sudo run?): ${listPaths(
          foreign.map((f) => f.path),
          env,
        )}`,
        manual: `give them back to your user: sudo chown -R "$(id -un)" <path> for each one listed`,
      }),
    );
  }
  if (truncated)
    out.push(
      check({ level: "info", text: `permissions: stopped after ${WALK_LIMIT} entries; the rest was not checked` }),
    );
  return out;
}

// ---- mcpd port owner

async function portCheck(env: NodeJS.ProcessEnv): Promise<Check> {
  const { answersAsMcpd, mcpdPort, readToken } = await import("../mcpd/state.js");
  const { describeOwner, portOwner } = await import("../mcpd/peerpid.js");
  const port = mcpdPort(env);
  const owner = await portOwner(port, { env });
  const uid = process.getuid?.();
  if (!owner) return check({ level: "info", text: `mcpd port ${port}: nothing listens there (mcpd is not running)` });
  if (owner.uid !== undefined && uid !== undefined && owner.uid !== uid) {
    return check({
      level: "fail",
      text: `mcpd port ${port}: held by ${describeOwner(owner)}, another user, so sessions would send it the gateway token`,
      manual:
        "stop it or move mcpd (turno config set mcpd.port <port>, then turno mcp sync), then turno mcp token rotate",
    });
  }
  const ours = await answersAsMcpd(
    port,
    readToken(env, () => {}),
  );
  if (ours)
    return check({
      level: "ok",
      text: `mcpd port ${port}: held by mcpd${ours.pid ? ` (pid ${ours.pid})` : ""} under your user`,
    });
  return check({
    level: "warn",
    text: `mcpd port ${port}: held by ${describeOwner(owner)}, which does not answer as mcpd, so sessions would send it the gateway token`,
    manual: "stop that process, or move mcpd: turno config set mcpd.port <port>, then turno mcp sync",
  });
}

// ---- literal secrets

type Entry = Record<string, unknown>;

/** Entries turno wrote: their token is the gateway's, checked by the token age instead. */
function isGatewayEntry(e: Entry): boolean {
  const headers = { ...(isObject(e.headers) ? e.headers : {}), ...(isObject(e.http_headers) ? e.http_headers : {}) };
  if (Object.keys(headers).some((h) => h.toLowerCase() === "x-turno-profile")) return true;
  return e.bearer_token_env_var === "TURNO_MCPD_TOKEN";
}

/** Where an MCP entry holds a literal secret: `env.KEY`, `headers.Authorization`, `args`, `url`. */
export async function entrySecrets(e: Entry): Promise<string[]> {
  if (isGatewayEntry(e)) return [];
  const { argSecrets, isSecretValue, urlSecrets } = await import("../mcpd/importer.js");
  const out: string[] = [];
  for (const table of ["env", "headers", "http_headers"]) {
    const t = e[table];
    if (!isObject(t)) continue;
    for (const [k, v] of Object.entries(t)) if (typeof v === "string" && isSecretValue(k, v)) out.push(`${table}.${k}`);
  }
  if (Array.isArray(e.args) && argSecrets(e.args.map(String)).length) out.push("args");
  if (typeof e.url === "string" && urlSecrets(e.url).length) out.push("url");
  return out;
}

/** The server maps of an agent config: `mcpServers` (and Claude Code's per-project ones) or Codex's `mcp_servers`. */
function serverMaps(doc: Entry): Record<string, Entry>[] {
  const maps: Record<string, Entry>[] = [];
  const add = (v: unknown) => {
    if (isObject(v))
      maps.push(Object.fromEntries(Object.entries(v).filter(([, e]) => isObject(e))) as Record<string, Entry>);
  };
  add(doc.mcpServers);
  add(doc.mcp_servers);
  if (isObject(doc.projects)) for (const proj of Object.values(doc.projects)) if (isObject(proj)) add(proj.mcpServers);
  return maps;
}

function readDoc(file: string): Entry | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const v = /\.toml$/.test(file) ? parseToml(text) : (JSON.parse(text) as unknown);
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** `server.where` for every literal secret in an agent config (JSON or TOML). */
export async function configSecrets(file: string): Promise<string[]> {
  const doc = readDoc(file);
  if (!doc) return [];
  const out: string[] = [];
  for (const map of serverMaps(doc))
    for (const [name, e] of Object.entries(map)) for (const w of await entrySecrets(e)) out.push(`${name}.${w}`);
  return [...new Set(out)];
}

/** `server.where` for every literal secret in mcp.toml, variants included. */
async function manifestSecrets(file: string): Promise<string[]> {
  const doc = readDoc(file);
  if (!doc || !isObject(doc.server)) return [];
  const out: string[] = [];
  for (const [name, def] of Object.entries(doc.server)) {
    if (!isObject(def)) continue;
    for (const w of await entrySecrets(def)) out.push(`${name}.${w}`);
    if (isObject(def.variants)) {
      for (const [variant, v] of Object.entries(def.variants))
        if (isObject(v)) for (const w of await entrySecrets(v)) out.push(`${name}.variants.${variant}.${w}`);
    }
  }
  return out;
}

/** The agent config files on this machine that can hold MCP servers: hubs and every profile's. */
function agentConfigFiles(env: NodeJS.ProcessEnv, config: Config | undefined): string[] {
  const files = new Set<string>(SCAN_ORDER.map((id) => adapter(id).mcp.hubFile(env)));
  if (config) {
    for (const name of listProfiles(config, env)) files.add(mcpFileFor(name, agentOf(name, config), env));
  }
  return [...files].filter((f) => existsSync(f));
}

async function secretChecks(env: NodeJS.ProcessEnv, config: Config | undefined): Promise<Check[]> {
  const p = paths(env);
  const out: Check[] = [];
  const inManifest = existsSync(p.mcpFile) ? await manifestSecrets(p.mcpFile) : [];
  if (inManifest.length) {
    out.push(
      check({
        level: "warn",
        text: `literal secrets in ${tildify(p.mcpFile, env)}: ${inManifest.join(", ")}`,
        manual:
          "store each with turno secret set <name> and write keychain:<name> in its place (args and URLs cannot hold references; see docs/mcp.md)",
      }),
    );
  }
  let clean = 0;
  for (const file of agentConfigFiles(env, config)) {
    const found = await configSecrets(file);
    if (!found.length) {
      clean++;
      continue;
    }
    out.push(
      check({
        level: "warn",
        text: `literal secrets in ${tildify(file, env)}: ${found.join(", ")}`,
        hint: "turno mcp import --write --move-secrets && turno mcp sync",
      }),
    );
  }
  if (!out.length)
    out.push(
      check({ level: "ok", text: `no literal secrets in mcp.toml or ${clean} agent config${clean === 1 ? "" : "s"}` }),
    );
  out.push(...(await backupChecks(env)));
  return out;
}

/** Backups (journal copies) of configs that held literal secrets when they were taken. */
async function backupChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const dir = paths(env).backupsDir;
  let stamps: string[];
  try {
    stamps = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const holding: string[] = [];
  for (const stamp of stamps) {
    const files = join(dir, stamp, "files");
    let names: string[];
    try {
      names = readdirSync(files);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(files, name);
      try {
        if (!statSync(file).isFile() || statSync(file).size > 16 * 1024 * 1024) continue;
      } catch {
        continue;
      }
      if (/\.(json|toml)$/.test(name) && ((await configSecrets(file)).length || (await manifestSecrets(file)).length)) {
        holding.push(stamp);
        break;
      }
    }
  }
  if (!holding.length) return [];
  return [
    check({
      level: "warn",
      text: `${holding.length} backup${holding.length === 1 ? "" : "s"} in ${tildify(dir, env)} hold configs with literal secrets (oldest ${holding[0]}); backups are pruned after 30 days`,
      hint: "turno undo --prune --older-than 1d",
    }),
  ];
}

// ---- versions

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether an npm spec names one exact version: `pkg@1.2.3`, `@scope/pkg@1.2.3`. */
export function isExactNpmSpec(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  return at > 0 && EXACT.test(spec.slice(at + 1));
}

/** Whether a uvx/pipx spec names one exact version: `pkg==1.2.3` or `pkg@1.2.3`. */
function isExactPySpec(spec: string): boolean {
  const m = /(?:==|@)([^=@]+)$/.exec(spec);
  return Boolean(m && /^\d+(?:\.\d+)*\S*$/.test(m[1]!));
}

/** The package a runner command fetches at start (npx, bunx, pnpm dlx, uvx), if it is one. */
async function fetchedPackage(
  command: string,
  args: string[],
): Promise<{ runner: string; spec: string; exact: boolean } | undefined> {
  const bin = basename(command);
  const { parseNpx } = await import("../mcpd/importer.js");
  if (bin === "npx" || bin === "bunx") {
    const { pkg } = parseNpx(args);
    return pkg ? { runner: bin, spec: pkg, exact: isExactNpmSpec(pkg) } : undefined;
  }
  if (bin === "pnpm" && args[0] === "dlx") {
    const pkg = args.slice(1).find((a) => !a.startsWith("-"));
    return pkg ? { runner: "pnpm dlx", spec: pkg, exact: isExactNpmSpec(pkg) } : undefined;
  }
  if (bin === "uvx") {
    const from = args.indexOf("--from");
    const pkg = from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith("-"));
    return pkg ? { runner: bin, spec: pkg, exact: isExactPySpec(pkg) } : undefined;
  }
  return undefined;
}

async function versionChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  let manifest;
  try {
    manifest = loadManifest(env);
  } catch {
    return []; // a broken mcp.toml is reported by turno doctor
  }
  const serversDir = paths(env).serversDir;
  const loose: string[] = [];
  /** Loose servers that `turno mcp install` can pin (an npm package); the others need an edit. */
  const pinnable: string[] = [];
  const runtime: string[] = [];
  let stdio = 0;
  for (const s of Object.values(manifest.servers)) {
    if (s.kind !== "stdio" || s.builtin) continue;
    stdio++;
    if (s.package) {
      if (!isExactNpmSpec(s.package)) {
        loose.push(`${s.name} (package ${s.package})`);
        pinnable.push(s.name);
      } else if (!existsSync(join(serversDir, s.name, "node_modules", ".bin", s.command))) runtime.push(s.name);
      continue;
    }
    for (const launch of [
      { command: s.command, args: s.args },
      ...Object.values(s.variants).map((v) => ({ command: v.command ?? s.command, args: v.args ?? s.args })),
    ]) {
      const f = await fetchedPackage(launch.command, launch.args);
      if (f && !f.exact) {
        loose.push(`${s.name} (${f.runner} ${f.spec} fetches the newest version at each start)`);
        break;
      }
    }
  }
  const out: Check[] = [];
  if (loose.length) {
    const all = pinnable.length === loose.length;
    out.push(
      check({
        level: "warn",
        text: `MCP servers without an exact version: ${loose.join("; ")}`,
        ...(all
          ? { hint: `turno mcp install ${pinnable.join(" ")}` }
          : {
              manual: `write an exact version (pkg@1.2.3) in each command in mcp.toml${pinnable.length ? `; turno mcp install ${pinnable.join(" ")} pins the npm packages` : ""}`,
            }),
      }),
    );
  }
  if (runtime.length)
    out.push(
      check({
        level: "info",
        text: `pinned but not installed, so npx downloads them at each start: ${runtime.join(", ")}`,
        hint: "turno mcp install",
      }),
    );
  if (!loose.length && stdio)
    out.push(
      check({ level: "ok", text: `every stdio MCP server runs an exact version or a fixed command (${stdio})` }),
    );
  return out;
}

// ---- gateway token

function tokenAgeCheck(env: NodeJS.ProcessEnv, now = Date.now()): Check[] {
  const file = paths(env).mcpdToken;
  let mtime: number;
  let master: string;
  try {
    mtime = statSync(file).mtimeMs;
    master = readFileSync(file, "utf8").trim();
  } catch {
    return [];
  }
  // Profile tokens derive from the master token, so they share its age; a token file
  // that does not match it was written before a rotation and no longer opens mcpd.
  const dir = dirname(profileTokenFile("x", env));
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".token"));
  } catch {
    /* no profile token files */
  }
  const stale: string[] = [];
  for (const f of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf8").trim();
    } catch {
      /* unreadable: counted as stale */
    }
    if (tokenProfile(master, text) !== f.slice(0, -".token".length)) stale.push(join(dir, f));
  }
  const fresh = names.length - stale.length;
  const derived = fresh ? ` (${fresh} profile token${fresh === 1 ? "" : "s"} derived from it)` : "";
  const days = Math.floor((now - mtime) / DAY_MS);
  const out: Check[] = [];
  if (days > TOKEN_MAX_AGE_DAYS) {
    out.push(
      check({
        level: "warn",
        text: `the mcpd token is ${days} days old (more than ${TOKEN_MAX_AGE_DAYS})${derived}`,
        hint: "turno mcp token rotate && turno mcp sync",
      }),
    );
  } else out.push(check({ level: "ok", text: `the mcpd token is ${days} day${days === 1 ? "" : "s"} old${derived}` }));
  if (stale.length) {
    const one = stale.length === 1;
    out.push(
      check({
        level: "warn",
        text: `${stale.length} profile token file${one ? " predates" : "s predate"} the mcpd token, so ${one ? "its agent" : "their agents"} cannot reach mcpd (${listPaths(stale, env)})`,
        hint: "turno mcp sync",
      }),
    );
  }
  return out;
}

// ---- audit log

function auditCheck(env: NodeJS.ProcessEnv): Check | undefined {
  let v;
  try {
    v = verifyAudit(env);
  } catch (err) {
    return check({
      level: "warn",
      text: `audit log: cannot read it: ${(err as Error).message}`,
      manual: `check the owner and mode of ${tildify(paths(env).auditLog, env)} (yours, 600)`,
    });
  }
  if (v.lines === 0) return undefined;
  if (!v.ok) {
    return check({
      level: "fail",
      text: `audit log: line ${v.line}: ${v.reason}`,
      manual: `find out who changed ${tildify(paths(env).auditLog, env)} after it was written; turno identity log --verify shows the line`,
    });
  }
  return check({
    level: "ok",
    text: `audit log: hash chain intact (${v.lines} line${v.lines === 1 ? "" : "s"}${v.legacy ? `, ${v.legacy} before the chain` : ""})`,
  });
}

/** Every security check, in the order `turno doctor --security` prints them. */
export async function securityChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  let config: Config | undefined;
  try {
    config = loadConfig(env);
  } catch {
    config = undefined;
  }
  const out: Check[] = [secretStoreCheck(env), ...permissionChecks(env)];
  out.push(await portCheck(env));
  out.push(...(await secretChecks(env, config)));
  out.push(...(await versionChecks(env)));
  out.push(...tokenAgeCheck(env));
  const audit = auditCheck(env);
  if (audit) out.push(audit);
  return out;
}
