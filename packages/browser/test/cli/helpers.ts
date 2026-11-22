import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "turno-core/cli";
import type { ExecCommand } from "../../src/agent-mcp.js";
import type { BrowserFunctions } from "../../src/api.js";
import { type BrowserCli, browserCli } from "../../src/cli/commands.js";
import { type BrowserCliHost, type CliDeps, type Ctx, context, standaloneHost } from "../../src/cli/context.js";

/** An Io that records output lines. */
export function fakeIo(env: NodeJS.ProcessEnv): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    env,
    isTty: false,
    out: (line = "") => lines.push(...line.split("\n")),
    err: (line = "") => errors.push(...line.split("\n")),
  };
}

/** The dependencies of the commands: `api` (often a fake), nobody to ask, then `over`. */
export function deps(api: BrowserFunctions, over: Partial<CliDeps> = {}): CliDeps {
  return { api, interactive: () => false, confirm: async () => false, ...over };
}

/** A command context on turno-browser's own host. */
export function ctx(api: BrowserFunctions, over: Partial<CliDeps> = {}, host: BrowserCliHost = standaloneHost()): Ctx {
  return context(host, deps(api, over));
}

/** The commands on turno-browser's own host. */
export function cli(
  api: BrowserFunctions,
  over: Partial<CliDeps> = {},
  host: BrowserCliHost = standaloneHost(),
): BrowserCli {
  return browserCli(host, deps(api, over));
}

/** The real functions, as the commands call them. */
export async function real(): Promise<BrowserFunctions> {
  return (await import("../../src/api.js")).api;
}

/**
 * A stand-in for the agents' own `mcp add` and `mcp remove`: it records each command and edits
 * the agent's config file in the sandbox HOME the way the agent would. Never the real agent.
 */
export function fakeAgentCli(env: NodeJS.ProcessEnv, over: { code?: number; output?: string } = {}) {
  const calls: string[][] = [];
  const claudeJson = join(env.HOME!, ".claude.json");
  const read = (): { mcpServers: Record<string, { command: string; args: string[] }> } =>
    existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, "utf8")) : { mcpServers: {} };
  const exec: ExecCommand = async (command, args) => {
    calls.push([command, ...args]);
    if (over.code !== undefined) return { code: over.code, output: over.output ?? "" };
    if (command !== "claude" || args[0] !== "mcp") return { code: 0, output: "" };
    const config = read();
    if (args[1] === "add") {
      const name = args[4]!;
      if (config.mcpServers[name]) return { code: 1, output: `MCP server ${name} already exists in user config` };
      const rest = args.slice(args.indexOf("--") + 1);
      config.mcpServers[name] = { command: rest[0]!, args: rest.slice(1) };
    } else if (args[1] === "remove") {
      const name = args[4]!;
      if (!config.mcpServers[name]) return { code: 1, output: `No user-scoped MCP server found with name: ${name}` };
      delete config.mcpServers[name];
    }
    writeFileSync(claudeJson, JSON.stringify(config));
    return { code: 0, output: `${args[1]} ${args[4]}` };
  };
  return { calls, exec, config: read };
}
