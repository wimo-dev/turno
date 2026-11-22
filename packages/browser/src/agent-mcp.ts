import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { browserPaths, findOnPath } from "turno-core/paths";
import { identityStateDir } from "./ids.js";

/**
 * Where each coding agent keeps the MCP servers turno-browser gives it, and the agent's own
 * commands that add and remove one. `setup` prints them, `init --yes` runs the add command,
 * `remove` runs the remove command, and `doctor` and `status` read the agents' config files to
 * see which identities each agent has. The files are only ever read here: every change goes
 * through the agent's own command, so its format stays the agent's business.
 *
 * `init` also records each registration it made (or found) in the identity's state folder
 * (`agents.json`), so `remove` knows where to take the identity's server out even when the
 * agent's file has moved.
 */

export const MCP_AGENTS = ["claude-code", "codex", "cursor", "copilot", "gemini"] as const;
export type McpAgent = (typeof MCP_AGENTS)[number];

interface AgentInfo {
  label: string;
  /** The agent's program, whose `mcp add` and `mcp remove` change its config. */
  program?: string;
  /** The user-wide config file the agent keeps its MCP servers in. */
  file(env: NodeJS.ProcessEnv): string;
  format: "json" | "toml";
  /** The variable that moves the agent's config folder (and so `file`), when it has one. */
  homeEnv?: string;
  /** The command that adds a stdio server, as words. */
  add?(server: string, command: string, args: readonly string[]): string[];
  /** The command that removes it, as words. */
  remove?(server: string): string[];
}

const home = (env: NodeJS.ProcessEnv) => browserPaths(env).home;

export const AGENTS: Readonly<Record<McpAgent, AgentInfo>> = {
  "claude-code": {
    label: "Claude Code",
    program: "claude",
    // User scope lives in .claude.json, in CLAUDE_CONFIG_DIR when a launcher sets one.
    file: (env) => join(env.CLAUDE_CONFIG_DIR || home(env), ".claude.json"),
    format: "json",
    homeEnv: "CLAUDE_CONFIG_DIR",
    add: (server, command, args) => ["claude", "mcp", "add", "--scope", "user", server, "--", command, ...args],
    remove: (server) => ["claude", "mcp", "remove", "--scope", "user", server],
  },
  codex: {
    label: "Codex",
    program: "codex",
    file: (env) => join(env.CODEX_HOME || join(home(env), ".codex"), "config.toml"),
    format: "toml",
    homeEnv: "CODEX_HOME",
    add: (server, command, args) => ["codex", "mcp", "add", server, "--", command, ...args],
    remove: (server) => ["codex", "mcp", "remove", server],
  },
  cursor: {
    label: "Cursor",
    file: (env) => join(home(env), ".cursor", "mcp.json"),
    format: "json",
  },
  copilot: {
    label: "GitHub Copilot CLI",
    program: "copilot",
    file: (env) => join(home(env), ".copilot", "mcp-config.json"),
    format: "json",
    add: (server, command, args) => ["copilot", "mcp", "add", server, "--", command, ...args],
    remove: (server) => ["copilot", "mcp", "remove", server],
  },
  gemini: {
    label: "Gemini CLI",
    program: "gemini",
    file: (env) => join(home(env), ".gemini", "settings.json"),
    format: "json",
    add: (server, command, args) => ["gemini", "mcp", "add", "-s", "user", server, command, "--", ...args],
    remove: (server) => ["gemini", "mcp", "remove", "-s", "user", server],
  },
};

/** The name of an identity's server in every agent's config. */
export function serverName(id: string): string {
  return `browser-${id}`;
}

/**
 * The environment the agent's commands need to change `file`: the same one, or with the
 * agent's home variable pointing at the folder of `file` when it is not where `env` puts it
 * (a registration made under a launcher that set CLAUDE_CONFIG_DIR). Undefined when no
 * variable can point the agent there.
 */
export function envForFile(agent: McpAgent, file: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined {
  const info = AGENTS[agent];
  if (info.file(env) === file) return env;
  if (!info.homeEnv) return undefined;
  const moved = { ...env, [info.homeEnv]: dirname(file) };
  return info.file(moved) === file ? moved : undefined;
}

/** True when the agent's program is on the PATH, so its own commands can run. */
export function agentReachable(agent: McpAgent, env: NodeJS.ProcessEnv): boolean {
  const program = AGENTS[agent].program;
  return program !== undefined && Boolean(findOnPath(program, env));
}

/** One MCP server in an agent's config file. */
export interface McpEntry {
  agent: McpAgent;
  server: string;
  file: string;
  command?: string;
  args?: string[];
}

/** The servers of one agent's config file; `error` when the file exists and cannot be read. */
export interface AgentServers {
  agent: McpAgent;
  file: string;
  entries: McpEntry[];
  error?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((a) => typeof a === "string") ? (v as string[]) : undefined;
}

/** A TOML value of the kinds an `[mcp_servers.<name>]` table holds: a string or a list of strings. */
function tomlValue(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1);
  if (t.startsWith("[")) {
    try {
      return JSON.parse(t.replace(/'([^']*)'/g, (_m, s: string) => JSON.stringify(s)).replace(/,\s*\]$/, "]"));
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** The `[mcp_servers.<name>]` tables of a Codex config.toml, with their command and args. */
function tomlServers(text: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      const m = /^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
      current = m ? {} : undefined;
      if (m) out.set((m[1] ?? m[2] ?? m[3])!, current!);
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (kv) current[kv[1]!] = tomlValue(kv[2]!.replace(/\s+#.*$/, ""));
  }
  return out;
}

/** Every MCP server in the agent's config file (read only). A missing file has none. */
export function agentServers(agent: McpAgent, env: NodeJS.ProcessEnv): AgentServers {
  const info = AGENTS[agent];
  const file = info.file(env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { agent, file, entries: [] };
    return { agent, file, entries: [], error: (err as Error).message };
  }
  const entry = (server: string, e: unknown): McpEntry => {
    const o = isObject(e) ? e : {};
    const args = stringList(o.args);
    return {
      agent,
      server,
      file,
      ...(typeof o.command === "string" ? { command: o.command } : {}),
      ...(args ? { args } : {}),
    };
  };
  if (info.format === "toml")
    return { agent, file, entries: [...tomlServers(text)].map(([server, e]) => entry(server, e)) };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    return { agent, file, entries: [], error: `not valid JSON (${(err as Error).message})` };
  }
  const servers = isObject(v) && isObject(v.mcpServers) ? v.mcpServers : {};
  return { agent, file, entries: Object.entries(servers).map(([server, e]) => entry(server, e)) };
}

/** The identity's server in the agent's config, if it has one. */
export function findEntry(agent: McpAgent, id: string, env: NodeJS.ProcessEnv): McpEntry | undefined {
  return agentServers(agent, env).entries.find((e) => e.server === serverName(id));
}

/**
 * True when the entry runs turno-browser-mcp (by name, or this package's bin/mcp.js), the
 * standalone turno-browser executable with `mcp`, or turno. A server merely named
 * `browser-<something>` (browser-use, say) is someone else's.
 */
export function isTurnoEntry(e: McpEntry): boolean {
  const words = [e.command ?? "", ...(e.args ?? [])];
  if (/^turno-browser(\.exe)?$/i.test(e.command?.split(/[\\/]/).pop() ?? "") && e.args?.[0] === "mcp") return true;
  return words.some(
    (w) =>
      basename(w) === "turno-browser-mcp" || basename(w) === "turno" || /turno-browser[\\/].*bin[\\/]mcp\.js$/.test(w),
  );
}

/** The identity an entry serves: its `--identity` argument, else its `browser-<id>` name. */
export function entryIdentity(e: McpEntry): string | undefined {
  const args = e.args ?? [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--identity") return args[i + 1]?.replace(/^browser:/, "");
    if (args[i]!.startsWith("--identity=")) return args[i]!.slice("--identity=".length).replace(/^browser:/, "");
  }
  return e.server.startsWith("browser-") ? e.server.slice("browser-".length) : undefined;
}

/**
 * The turno-browser servers in every known agent's config: the entries that run
 * turno-browser-mcp (or turno). Config files that exist and cannot be read come back in `errors`.
 */
export function browserEntries(env: NodeJS.ProcessEnv): { entries: McpEntry[]; errors: AgentServers[] } {
  const entries: McpEntry[] = [];
  const errors: AgentServers[] = [];
  for (const agent of MCP_AGENTS) {
    const found = agentServers(agent, env);
    if (found.error) errors.push(found);
    entries.push(...found.entries.filter(isTurnoEntry));
  }
  return { entries, errors };
}

/** True when the entry's command can start: an absolute path that exists, or a name on the PATH. */
export function entryCommandFound(e: McpEntry, env: NodeJS.ProcessEnv): boolean {
  const command = e.command;
  if (!command) return false;
  if (command.includes("/")) return existsSync(command);
  return Boolean(findOnPath(command, env));
}

/** One registration `init` made or found: the agent, the server name and the file it went to. */
export interface Registration {
  agent: McpAgent;
  server: string;
  file: string;
  at: string;
}

/** `<state>/browser/identities/<id>/agents.json`. */
function registrationsPath(id: string, env: NodeJS.ProcessEnv): string {
  return join(identityStateDir(id, env), "agents.json");
}

/** The registrations recorded for the identity, oldest first; none when the file is missing or unreadable. */
export function readRegistrations(id: string, env: NodeJS.ProcessEnv): Registration[] {
  try {
    const v = JSON.parse(readFileSync(registrationsPath(id, env), "utf8")) as unknown;
    if (!isObject(v) || !Array.isArray(v.registrations)) return [];
    return v.registrations.filter(
      (r): r is Registration =>
        isObject(r) &&
        (MCP_AGENTS as readonly unknown[]).includes(r.agent) &&
        typeof r.server === "string" &&
        typeof r.file === "string" &&
        typeof r.at === "string",
    );
  } catch {
    return [];
  }
}

/** Record that the agent has the identity's server (one record per agent and server). */
export function recordRegistration(id: string, env: NodeJS.ProcessEnv, reg: Registration): void {
  const kept = readRegistrations(id, env).filter((r) => !(r.agent === reg.agent && r.server === reg.server));
  const file = registrationsPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, registrations: [...kept, reg] }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** What an agent's own command printed and how it ended. */
interface ExecResult {
  code: number;
  /** Its stdout and stderr, at most the last 4000 characters. */
  output: string;
}

/** Runs an agent's command with its output captured; tests replace it. */
export type ExecCommand = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;

/** The default: spawn it, without a shell, for at most a minute. A missing program is code 127. */
export const execCommand: ExecCommand = (command, args, env) =>
  new Promise((resolve) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    } catch (err) {
      resolve({ code: 127, output: (err as Error).message });
      return;
    }
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ code: err.code === "ENOENT" ? 127 : 1, output: err.message }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
