import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { browserPaths, turnoRoots } from "turno-core/paths";
import { type ProcTable, pidAlive, readProcTable, signalProcess } from "turno-core/process";
import { type SecretStore, secretStore } from "turno-core/secrets";
import {
  AGENTS,
  type ExecCommand,
  MCP_AGENTS,
  type McpAgent,
  agentReachable,
  agentServers,
  envForFile,
  readRegistrations,
  serverName,
} from "./agent-mcp.js";
import { liveBackground } from "./background-state.js";
import { stopBackground } from "./client.js";
import { flowsDir } from "./flows.js";
import { identityDir, identityStateDir, isValidIdentityId } from "./ids.js";
import { findProfileChrome, stopChrome, usesProfile } from "./lifecycle.js";
import { names } from "./names.js";
import { readRuntimeLock, runtimeLockAlive } from "./runtime-lock.js";
import { exportFiles } from "./session-export.js";
import { identitySettingsPath } from "./settings.js";
import { vaultItem, vaultPath } from "./vault.js";

/**
 * Everything `remove` takes off this machine for one identity, planned first (read only, for
 * the confirmation and `--dry-run`), then done and checked:
 *
 * - processes: the identity's background server, the process that holds its runtime lock
 *   (an agent's turno-browser-mcp, a login window), a Chrome on its profile, and every other
 *   turno-browser-mcp started for it. They stop first; when one does not, nothing else is
 *   touched.
 * - MCP entries: the identity's server in each agent that has it (recorded by `init`, or found
 *   in the agent's config file), taken out with the agent's own `mcp remove`. An agent without
 *   one (Cursor), or whose program is not on the PATH, is left with the step to do by hand.
 * - secret store items: the vault's credentials (the sites of its index, read leniently so a
 *   broken index still names them) and the `keychain:` items identity.json references. An item
 *   another identity or turno's mcp.toml also references is kept. Items go through turno-core's
 *   secret store; nothing else reads or writes them.
 * - files: the profile, identity.json, the vault index, the state folder (runtime state,
 *   recordings, the Camoufox profile), saved flows, and the session exports it wrote that are
 *   still where it wrote them.
 *
 * Chrome's own cookie key ("Chrome Safe Storage", used with identity.json `"keychain": "system"`)
 * is shared by every Chrome profile of the machine, the person's own Chrome included, so it is
 * kept and said so.
 */

type RemovalKind = "process" | "mcp" | "keychain" | "path";

/** One thing `remove` deletes, keeps, or could not delete. */
export interface RemovalItem {
  kind: RemovalKind;
  /** What it is, in a few words: "profile", "background server", "vault credential of github". */
  what: string;
  path?: string;
  /** A secret store item name (without `keychain:`). */
  item?: string;
  pid?: number;
  agent?: McpAgent;
  server?: string;
  /** The agent's config file. */
  file?: string;
  /** The command that removes it (an agent's `mcp remove`), or the step to do by hand. */
  command?: string;
  /** Why it is kept, or why it is still here. */
  reason?: string;
  /** What went wrong while deleting it. */
  error?: string;
}

export interface RemovalPlan {
  id: string;
  /** False when nothing of the identity is on this machine. */
  exists: boolean;
  /** In the order they go: processes, MCP entries, secret store items, files. */
  items: RemovalItem[];
  /** Kept on purpose, with the reason. */
  kept: RemovalItem[];
  /** Planned but known not to be doable here (no secret store, no agent program). */
  left: RemovalItem[];
}

export interface RemovalReport {
  deleted: RemovalItem[];
  failed: RemovalItem[];
  /** Still on this machine after the check, with the reason and the step that removes it. */
  left: RemovalItem[];
  kept: RemovalItem[];
  /** True when the check found nothing of the identity left. */
  complete: boolean;
}

export interface RemovalOptions {
  env?: NodeJS.ProcessEnv;
  /** The secret store (tests pass a fake); default: this machine's, null for none. */
  store?: SecretStore | null;
  /** Runs an agent's `mcp remove`. */
  exec: ExecCommand;
  /** The process table (tests pass one); default: `ps`. */
  procTable?: () => ProcTable | undefined;
  /** How long a process gets after SIGTERM before SIGKILL. */
  graceMs?: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The `keychain:<item>` references in one identity.json's text. */
function keychainRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/"keychain:([^"\\]+)"/g)].map((m) => m[1]!))].sort();
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Which setting names each reference, for the plan: proxy.password, act.key... */
function refOwners(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return out;
  }
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string" && node.startsWith("keychain:")) out.set(node.slice(9), path);
    else if (typeof node === "object" && node !== null)
      for (const [k, child] of Object.entries(node)) walk(child, path ? `${path}.${k}` : k);
  };
  walk(v, "");
  return out;
}

/** The sites of the vault index, also from an index too broken to load: what its items are named after. */
function vaultSites(id: string, env: NodeJS.ProcessEnv): string[] {
  const files = [vaultPath(id, env), ...leftoverTemps(id, env).filter((f) => f.includes(".vault.json."))];
  const sites = new Set<string>();
  for (const file of files) {
    const text = readText(file);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const listed =
      typeof parsed === "object" && parsed !== null && typeof (parsed as { sites?: unknown }).sites === "object"
        ? Object.keys((parsed as { sites: object }).sites)
        : [...text.matchAll(/"([a-z0-9][a-z0-9._-]{0,62})"\s*:\s*\{\s*"origins"/g)].map((m) => m[1]!);
    for (const site of listed) if (/^[a-z0-9][a-z0-9._-]{0,62}$/.test(site)) sites.add(site);
  }
  return [...sites].sort();
}

/** Half-written `<id>.json.<pid>.tmp` and `<id>.vault.json.<pid>.tmp` files an interrupted write left. */
function leftoverTemps(id: string, env: NodeJS.ProcessEnv): string[] {
  const dir = browserPaths(env).identitiesDir;
  const own = new RegExp(`^${escapeRegExp(id)}(\\.vault)?\\.json\\.\\d+\\.tmp$`);
  try {
    return readdirSync(dir)
      .filter((f) => own.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Who else references a secret store item: other identities, and turno's mcp.toml. */
function otherUsers(item: string, id: string, env: NodeJS.ProcessEnv): string[] {
  const users: string[] = [];
  const root = browserPaths(env).identitiesDir;
  let others: string[] = [];
  try {
    others = readdirSync(root)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".vault.json"))
      .map((f) => f.slice(0, -".json".length))
      .filter((other) => other !== id && isValidIdentityId(other));
  } catch {
    /* no identities */
  }
  for (const other of others.sort()) {
    const text = readText(identitySettingsPath(other, env));
    if (text && keychainRefs(text).includes(item)) users.push(`identity "${other}"`);
  }
  const manifest = readText(join(turnoRoots(env).config, "mcp.toml"));
  if (manifest && new RegExp(`keychain:${escapeRegExp(item)}(?![A-Za-z0-9._/-])`).test(manifest))
    users.push("turno's mcp.toml");
  return users;
}

/**
 * The variables of a running process that place turno's data folder, read where the system lets
 * a user read them for their own processes (`/proc/<pid>/environ` on Linux, `ps -E` on macOS).
 * Undefined when they cannot be read.
 */
function processDataEnv(pid: number): NodeJS.ProcessEnv | undefined {
  const keys = ["HOME", "XDG_DATA_HOME", "TURNO_DATA_DIR"];
  try {
    if (process.platform === "linux") {
      const env: NodeJS.ProcessEnv = {};
      for (const pair of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
        const at = pair.indexOf("=");
        if (at > 0 && keys.includes(pair.slice(0, at))) env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      return env.HOME ? env : undefined;
    }
    if (process.platform !== "darwin") return undefined;
    const text = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/bin:/usr/bin", LC_ALL: "C" },
      timeout: 5000,
    });
    const env: NodeJS.ProcessEnv = {};
    for (const m of text.matchAll(/(?:^|\s)(HOME|XDG_DATA_HOME|TURNO_DATA_DIR)=(\S*)/g)) env[m[1]!] = m[2]!;
    return env.HOME ? env : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The turno-browser-mcp processes started for the identity: `--identity <id>` on their command
 * line, and turno's data folder where this one's is (the same id under another HOME or
 * TURNO_DATA_DIR is another identity). A process whose variables cannot be read is not counted.
 */
function identityServers(table: ProcTable | undefined, id: string, env: NodeJS.ProcessEnv): number[] {
  if (!table) return [];
  const ours = browserPaths(env).identitiesDir;
  const out: number[] = [];
  for (const p of table.values()) {
    if (p.pid === process.pid) continue;
    const words = p.command.split(/\s+/);
    if (!words.some((w) => /(^|\/)turno-browser-mcp$/.test(w) || /turno-browser\/dist\/bin\/mcp\.js$/.test(w)))
      continue;
    const at = words.indexOf("--identity");
    const given = at >= 0 ? words[at + 1] : words.find((w) => w.startsWith("--identity="))?.slice(11);
    if (given !== id && given !== `browser:${id}`) continue;
    const theirs = processDataEnv(p.pid);
    if (theirs && browserPaths(theirs).identitiesDir === ours) out.push(p.pid);
  }
  return out;
}

/** The processes of the identity that run now: what has to stop before anything is deleted. */
function processItems(id: string, env: NodeJS.ProcessEnv, table: ProcTable | undefined): RemovalItem[] {
  const out: RemovalItem[] = [];
  const seen = new Set<number>();
  const add = (pid: number, what: string) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    out.push({ kind: "process", what, pid });
  };
  const background = liveBackground(id, env);
  if (background) add(background.pid, "background server");
  const lock = readRuntimeLock(id, env);
  if (lock && runtimeLockAlive(lock)) {
    // A lock whose pid the system gave to another program since is stale, not a holder.
    const command = table?.get(lock.nodePid)?.command;
    if (command === undefined || /turno|mcp\.js/.test(command))
      add(
        lock.nodePid,
        lock.holder === "mcp" ? "turno-browser-mcp that holds the identity" : `${names().browser} ${lock.holder}`,
      );
  }
  const chrome = findProfileChrome(identityDir(id, env), table ? { table } : {});
  if (chrome) add(chrome.pid, "Chrome on the profile");
  for (const pid of identityServers(table, id, env)) add(pid, "turno-browser-mcp started for the identity");
  return out;
}

/** Each agent with the identity's server: recorded by init, or found in the agent's file. */
function mcpItems(id: string, env: NodeJS.ProcessEnv): { items: RemovalItem[]; left: RemovalItem[] } {
  const server = serverName(id);
  const files = new Map<string, { agent: McpAgent; file: string }>();
  for (const r of readRegistrations(id, env)) files.set(`${r.agent}\0${r.file}`, { agent: r.agent, file: r.file });
  for (const agent of MCP_AGENTS) {
    const file = AGENTS[agent].file(env);
    files.set(`${agent}\0${file}`, { agent, file });
  }
  const items: RemovalItem[] = [];
  const left: RemovalItem[] = [];
  for (const { agent, file } of files.values()) {
    const info = AGENTS[agent];
    const agentEnv = envForFile(agent, file, env);
    if (!agentEnv) continue;
    if (!agentServers(agent, agentEnv).entries.some((e) => e.server === server)) continue;
    const words = info.remove?.(server);
    const prefix = agentEnv === env || !info.homeEnv ? "" : `${info.homeEnv}=${agentEnv[info.homeEnv]} `;
    const item: RemovalItem = {
      kind: "mcp",
      what: `${info.label}'s MCP server ${server}`,
      agent,
      server,
      file,
      command: words ? `${prefix}${words.join(" ")}` : `delete the "${server}" entry from ${file}`,
    };
    if (!words) left.push({ ...item, reason: `${info.label} has no command that removes it` });
    else if (!agentReachable(agent, env))
      left.push({ ...item, reason: `${info.program} is not on the PATH, so ${info.label} cannot be reached` });
    else items.push(item);
  }
  return { items, left };
}

/** Plan the removal of `id`: nothing is changed. */
export async function planRemoval(id: string, options: RemovalOptions): Promise<RemovalPlan> {
  const env = options.env ?? process.env;
  const table = (options.procTable ?? readProcTable)();
  const items: RemovalItem[] = [];
  const kept: RemovalItem[] = [];
  const left: RemovalItem[] = [];

  items.push(...processItems(id, env, table));
  const mcp = mcpItems(id, env);
  items.push(...mcp.items);
  left.push(...mcp.left);

  // Secret store items: the vault's, then the ones identity.json references.
  const settingsText = readText(identitySettingsPath(id, env));
  const owners = settingsText ? refOwners(settingsText) : new Map<string, string>();
  const secrets: RemovalItem[] = vaultSites(id, env).map((site) => ({
    kind: "keychain" as const,
    what: `vault credential of ${site}`,
    item: vaultItem(id, site),
  }));
  for (const item of settingsText ? keychainRefs(settingsText) : []) {
    const what = `${owners.get(item) ?? "identity.json"} secret`;
    const users = otherUsers(item, id, env);
    if (users.length) kept.push({ kind: "keychain", what, item, reason: `also used by ${users.join(", ")}` });
    else secrets.push({ kind: "keychain", what, item });
  }
  if (secrets.length) {
    const store = options.store === undefined ? secretStore(env) : options.store;
    if (!store)
      left.push(
        ...secrets.map((s) => ({
          ...s,
          reason: "this machine has no secret store to check it in (Keychain or secret-tool)",
        })),
      );
    else
      for (const s of secrets) {
        // A lookup of the item's attributes, never its value. An error still plans the delete,
        // which then says what went wrong.
        const has = await store.has(s.item!).catch(() => true);
        if (has) items.push(s);
      }
  }
  if (/"keychain"\s*:\s*"system"/.test(settingsText ?? ""))
    kept.push({
      kind: "keychain",
      what: "Chrome's cookie key",
      item: "Chrome Safe Storage",
      reason:
        'identity.json "keychain": "system" uses the key every Chrome profile of this machine shares, your own Chrome included',
    });

  // Files.
  const paths: [string, string][] = [
    [identityDir(id, env), "profile (cookies, saved sign-ins)"],
    [identitySettingsPath(id, env), "identity.json"],
    [vaultPath(id, env), "vault index"],
    [identityStateDir(id, env), "state folder (runtime state, recordings)"],
    [flowsDir(id, env), "saved flows"],
    ...leftoverTemps(id, env).map((f): [string, string] => [f, "half-written settings file"]),
    ...exportFiles(id, env).map((f): [string, string] => [f, "session export"]),
  ];
  for (const [path, what] of paths) if (existsSync(path)) items.push({ kind: "path", what, path });

  return { id, exists: items.length > 0 || left.length > 0, items, kept, left };
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

async function stopProcess(id: string, item: RemovalItem, env: NodeJS.ProcessEnv, graceMs: number): Promise<void> {
  const pid = item.pid!;
  if (item.what === "background server") {
    await stopBackground(id, { env, timeoutMs: graceMs });
    if (!(await waitGone(pid, 1000))) throw new Error(`pid ${pid} is still running`);
    return;
  }
  if (item.what === "Chrome on the profile") {
    const chrome = findProfileChrome(identityDir(id, env));
    if (chrome && (await stopChrome(chrome, { graceMs })) === "survived") throw new Error(`pid ${pid} did not stop`);
    return;
  }
  signalProcess(pid, "SIGTERM");
  if (await waitGone(pid, graceMs)) return;
  signalProcess(pid, "SIGKILL");
  if (!(await waitGone(pid, 5000))) throw new Error(`pid ${pid} did not stop`);
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

/** Do the plan, then check what is still there. */
export async function runRemoval(plan: RemovalPlan, options: RemovalOptions): Promise<RemovalReport> {
  const env = options.env ?? process.env;
  const id = plan.id;
  const graceMs = options.graceMs ?? 10_000;
  const deleted: RemovalItem[] = [];
  const failed: RemovalItem[] = [];
  const left: RemovalItem[] = [...plan.left];
  const kept = [...plan.kept];
  const done = (item: RemovalItem) => deleted.push(item);
  const broke = (item: RemovalItem, err: unknown) =>
    failed.push({ ...item, error: (err as Error).message ?? String(err) });

  // 1. Processes: nothing else goes while one of them still runs.
  for (const item of plan.items.filter((i) => i.kind === "process")) {
    try {
      await stopProcess(id, item, env, graceMs);
      done(item);
    } catch (err) {
      broke(item, err);
    }
  }
  if (failed.length) {
    for (const item of plan.items.filter((i) => i.kind !== "process"))
      left.push({ ...item, reason: "not removed: a process of the identity did not stop" });
    return { deleted, failed, left, kept, complete: false };
  }

  // 2. The agents' MCP entries, with each agent's own command.
  for (const item of plan.items.filter((i) => i.kind === "mcp")) {
    const agent = item.agent!;
    const agentEnv = envForFile(agent, item.file!, env) ?? env;
    const [bin, ...rest] = AGENTS[agent].remove!(item.server!);
    const result = await options.exec(bin!, rest, agentEnv);
    const still = agentServers(agent, agentEnv).entries.some((e) => e.server === item.server);
    if (!still) done(item);
    else
      failed.push({
        ...item,
        error: `${bin} ended with code ${result.code}${result.output ? `: ${lastLine(result.output)}` : ""}`,
      });
  }

  // 3. Secret store items.
  const secrets = plan.items.filter((i) => i.kind === "keychain");
  const store = secrets.length ? (options.store === undefined ? secretStore(env) : options.store) : undefined;
  for (const item of secrets) {
    try {
      if (!store) throw new Error("no secret store");
      await store.remove(item.item!);
      done(item);
    } catch (err) {
      broke(item, err);
    }
  }

  // 4. Files.
  for (const item of plan.items.filter((i) => i.kind === "path")) {
    try {
      rmSync(item.path!, { recursive: true, force: true });
      done(item);
    } catch (err) {
      broke(item, err);
    }
  }

  // The check: anything that is still there moves from deleted to left.
  const table = (options.procTable ?? readProcTable)();
  const remains = async (item: RemovalItem): Promise<boolean> => {
    switch (item.kind) {
      case "path":
        return existsSync(item.path!);
      case "process":
        return pidAlive(item.pid!);
      case "mcp": {
        const agentEnv = envForFile(item.agent!, item.file!, env) ?? env;
        return agentServers(item.agent!, agentEnv).entries.some((e) => e.server === item.server);
      }
      case "keychain":
        return store ? await store.has(item.item!).catch(() => true) : true;
    }
  };
  const verified: RemovalItem[] = [];
  for (const item of deleted) {
    if (await remains(item)) left.push({ ...item, reason: "still there after it was deleted" });
    else verified.push(item);
  }
  const profile = identityDir(id, env);
  const servers = identityServers(table, id, env);
  const stray = table
    ? [...table.values()].filter(
        (p) => p.pid !== process.pid && (usesProfile(p.command, profile) || servers.includes(p.pid)),
      )
    : [];
  for (const p of stray)
    if (!left.some((l) => l.pid === p.pid))
      left.push({
        kind: "process",
        what: "a process of the identity",
        pid: p.pid,
        reason: "still running",
        command: `kill ${p.pid}`,
      });
  return { deleted: verified, failed, left, kept, complete: failed.length === 0 && left.length === 0 };
}
