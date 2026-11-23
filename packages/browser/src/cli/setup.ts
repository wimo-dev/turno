import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import {
  type FlagSpec,
  type Io,
  JSON_FLAG,
  bool,
  closest,
  emit,
  fail,
  jsonOutput,
  parseFlags,
  str,
} from "turno-core/cli";
import { findOnPath } from "turno-core/paths";
import { AGENTS, serverName } from "../agent-mcp.js";
import type { Ctx } from "./context.js";

/**
 * `turno-browser setup <agent> [--identity <id>]`: the MCP config that gives a coding agent one
 * identity's browser, printed for the person to run or paste. It never writes a file: an
 * agent's config is the person's (inside turno, `turno mcp sync` writes it from mcp.toml).
 */

export const SETUP_AGENTS = ["claude-code", "codex", "cursor", "copilot", "gemini", "json"] as const;
export type SetupAgent = (typeof SETUP_AGENTS)[number];

/** `setup --json`: one object. */
export const SETUP_JSON = jsonOutput([
  "agent",
  "identity",
  "server",
  "command",
  "args",
  "file",
  "shell",
  "config",
  "notes",
]);

const SETUP_FLAGS: FlagSpec = { identity: { type: "string" }, ...JSON_FLAG };

/** What `setup` prints for one agent. */
export interface SetupConfig {
  agent: SetupAgent;
  identity: string;
  /** The server's name in the agent's config: `browser-<id>`. */
  server: string;
  command: string;
  args: string[];
  /** The file the config block goes in, when the agent reads one. */
  file: string | null;
  /** A command that adds the server, when the agent has one. */
  shell: string | null;
  /** The block to paste into `file`. */
  config: string | null;
  notes: string[];
}

/**
 * One word for a shell line: as it is when it needs no quotes; else in single quotes for a POSIX
 * shell, or on Windows in double quotes, which cmd.exe and PowerShell both read (a path there
 * has no `"` in it).
 */
function shellWord(word: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return /^[\w@+=:,./\\-]+$/.test(word) ? word : `"${word.replace(/"/g, '\\"')}"`;
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(words: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return words.map((w) => shellWord(w, platform)).join(" ");
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

/**
 * The command an agent runs, and the arguments that go before the identity's. The standalone
 * executable (a Node.js single executable application, with this package inside it) runs
 * itself as `<executable> mcp`. Otherwise `turno-browser-mcp` when it is on the PATH, else this
 * install's full path (a `pnpm add` or a local checkout puts it nowhere on the PATH); `onPath`
 * is false only then. On Windows npm installs it as a `.cmd` shim, which an agent can start
 * only through cmd.exe (`cmd /c`, as Claude Code's docs say for npx); off the PATH, Node runs
 * the script itself.
 */
export function mcpCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; onPath: boolean } {
  if (isSea()) return { command: process.execPath, args: ["mcp"], onPath: true };
  const onPath = Boolean(findOnPath("turno-browser-mcp", env, platform));
  const script = fileURLToPath(new URL("../bin/mcp.js", import.meta.url));
  if (platform === "win32")
    return onPath
      ? { command: "cmd", args: ["/c", "turno-browser-mcp"], onPath }
      : { command: process.execPath, args: [script], onPath };
  return onPath ? { command: "turno-browser-mcp", args: [], onPath } : { command: script, args: [], onPath };
}

/** The config of `agent` for identity `id`, run as `command` with `lead` before `--identity`. */
export function setupConfig(agent: SetupAgent, id: string, command: string, lead: readonly string[] = []): SetupConfig {
  const server = serverName(id);
  const args = [...lead, "--identity", id];
  const base = { agent, identity: id, server, command, args };
  const stdio = { command, args };
  switch (agent) {
    case "claude-code":
      return {
        ...base,
        file: null,
        shell: shellLine(AGENTS["claude-code"].add!(server, command, args)),
        config: null,
        notes: ["--scope user adds it to every project; leave it out to add it to the current folder only."],
      };
    case "codex":
      return {
        ...base,
        file: "~/.codex/config.toml",
        shell: shellLine(AGENTS.codex.add!(server, command, args)),
        config: `[mcp_servers.${server}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args).replace(/","/g, '", "')}`,
        notes: [],
      };
    case "cursor":
      return {
        ...base,
        file: "~/.cursor/mcp.json (every project) or .cursor/mcp.json (one project)",
        shell: null,
        config: json({ mcpServers: { [server]: { type: "stdio", ...stdio } } }),
        notes: [`When the file has other servers, add the "${server}" entry to its mcpServers.`],
      };
    case "copilot":
      return {
        ...base,
        file: "~/.copilot/mcp-config.json",
        shell: shellLine(AGENTS.copilot.add!(server, command, args)),
        config: json({ mcpServers: { [server]: { type: "local", ...stdio, tools: ["*"] } } }),
        notes: [`When the file has other servers, add the "${server}" entry to its mcpServers.`],
      };
    case "gemini":
      return {
        ...base,
        file: "~/.gemini/settings.json (or .gemini/settings.json in a project)",
        shell: shellLine(AGENTS.gemini.add!(server, command, args)),
        config: json({ mcpServers: { [server]: stdio } }),
        notes: [`When the file has other settings, add the "${server}" entry to its mcpServers.`],
      };
    case "json":
      return {
        ...base,
        file: null,
        shell: null,
        config: json({ mcpServers: { [server]: stdio } }),
        notes: ["The mcpServers entry for an MCP client that reads this format; the command speaks MCP over stdio."],
      };
  }
}

export const AGENT_NAMES: Record<SetupAgent, string> = {
  "claude-code": AGENTS["claude-code"].label,
  codex: AGENTS.codex.label,
  cursor: AGENTS.cursor.label,
  copilot: AGENTS.copilot.label,
  gemini: AGENTS.gemini.label,
  json: "any MCP client",
};

export const SETUP_DETAILS = `Prints how a coding agent gets one identity's browser: the command to run, or the block to
paste into its config file. It writes nothing; run or paste it yourself.

Agents:
  claude-code  a claude mcp add command
  codex        a [mcp_servers] block for ~/.codex/config.toml, and the codex mcp add command
  cursor       an mcpServers entry for ~/.cursor/mcp.json
  copilot      an mcpServers entry for ~/.copilot/mcp-config.json, and the copilot mcp add command
  gemini       an mcpServers entry for ~/.gemini/settings.json, and the gemini mcp add command
  json         the generic mcpServers entry other MCP clients read

Without --identity it uses the only identity there is. The agent then starts turno-browser-mcp
for the identity when it needs the browser.`;

/** "unknown agent", with the agent the person most likely meant: claude for claude-code, cursr for cursor. */
export function unknownAgent(agent: string): string {
  const prefix = SETUP_AGENTS.find((a) => a.startsWith(agent.toLowerCase()) && agent.length >= 3);
  const guess = prefix ?? closest(agent.toLowerCase(), SETUP_AGENTS);
  return `unknown agent "${agent}"${guess ? `; did you mean ${guess}?` : ""} (agents: ${SETUP_AGENTS.join(", ")})`;
}

/** The identity `setup` is for: --identity, or the only one there is. */
function pickIdentity(c: Ctx, flag: string | undefined, io: Io): string {
  const b = c.names.browser;
  if (flag !== undefined) {
    try {
      c.api.assertIdentityId(flag);
    } catch (err) {
      return fail((err as Error).message);
    }
    if (!c.api.identityExists(flag, io.env)) return fail(`identity "${flag}" does not exist (${b} add ${flag})`);
    return flag;
  }
  const ids = c.api.listIdentities(io.env).map((i) => i.id);
  if (ids.length === 1) return ids[0]!;
  if (!ids.length)
    return fail(`no identity yet: create one with ${b} add <id>, then ${b} setup <agent> --identity <id>`);
  return fail(`pick an identity with --identity: ${ids.join(", ")}`);
}

/** What `setup` prints for one config, before the closing line. */
export function setupLines(cfg: SetupConfig): string[] {
  const name = AGENT_NAMES[cfg.agent];
  const id = cfg.identity;
  const out: string[] = [];
  if (cfg.agent === "claude-code") {
    out.push(`Run this once to give ${name} the browser identity "${id}":`, "", cfg.shell!);
  } else if (cfg.file) {
    out.push(`Add this to ${cfg.file} to give ${name} the browser identity "${id}":`, "", cfg.config!);
    if (cfg.shell) out.push("", `Or run: ${cfg.shell}`);
  } else {
    out.push(`The browser identity "${id}" for ${name}:`, "", cfg.config!);
  }
  out.push("", ...cfg.notes);
  return out;
}

/** `<browser> setup <agent> [--identity <id>] [--json]`. */
export function setup(c: Ctx, args: string[], io: Io): number {
  const p = parseFlags(args, SETUP_FLAGS, 1);
  const agent = p.positionals[0];
  const b = c.names.browser;
  if (!agent) return fail(`setup needs an agent: ${b} setup <${SETUP_AGENTS.join("|")}> [--identity <id>]`);
  if (!(SETUP_AGENTS as readonly string[]).includes(agent)) return fail(unknownAgent(agent));
  const id = pickIdentity(c, str(p, "identity"), io);
  const { command, args: lead, onPath } = mcpCommand(io.env);
  const cfg = setupConfig(agent as SetupAgent, id, command, lead);
  if (!onPath) cfg.notes.push("turno-browser-mcp is not on the PATH here, so this names it by its full path.");
  if (bool(p, "json")) {
    emit(io, p, SETUP_JSON, cfg);
    return 0;
  }
  for (const l of setupLines(cfg)) io.out(l);
  io.out(`Start a new agent session to load it. Sign in to your sites once with ${b} login ${id}.`);
  return 0;
}
