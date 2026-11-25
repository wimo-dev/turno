import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTree } from "turno-core/process";
import { type ActModel, ModelError, type ModelRequest } from "./act-model.js";
import { spawnPlan } from "./agent-mcp.js";

/**
 * The user's subscription CLI as the model behind natural language actions: the Claude Code CLI
 * (`claude -p`) or Codex (`codex exec`), run headless, once per model call, with the login the
 * user already has. turno holds no key for it.
 *
 * - The prompt goes on stdin, never on the command line: argv holds only fixed flags and the
 *   model name, so no page text, vault value or key can show up in a process list.
 * - The child loads no MCP server (the Claude Code CLI with a strict, empty MCP config and safe
 *   mode; Codex without the user's config.toml, where its MCP servers live), so it can never
 *   start turno-browser again. It also gets `ACT_CHILD_ENV`, and a turno-browser that sees it
 *   never offers this path (`act-chain.ts`).
 * - It runs in an empty temporary folder, with its tools turned off, for at most `CLI_TIMEOUT_MS`
 *   or the call's own time limit, whichever ends first.
 */

/** Set in the child's environment: a turno-browser started under it never runs a CLI again. */
export const ACT_CHILD_ENV = "TURNO_BROWSER_ACT_CHILD";

/** Longest one CLI call may run before it is stopped. */
const CLI_TIMEOUT_MS = 90_000;

/** The system prompt on the command line: fixed text, never a page or an instruction. */
const CLI_SYSTEM =
  "Follow the instructions at the top of the message and reply only with what they ask for. Use no tools.";

/** Most output kept from a child: the reply is one JSON object, the rest is for errors. */
const OUTPUT_CHARS = 2_000_000;

export type CliId = "claude" | "codex";

interface CliSpec {
  /** How results and messages name it. */
  label: string;
  /** The default model: an intermediate one, picked by measured latency (see the docs). */
  model: string;
  /**
   * The flags, in order. `optional` ones are dropped (and stay dropped) when the installed
   * version does not know them; the rest keep the child away from MCP servers and tools.
   */
  args(model: string, cwd: string): { arg: string[]; optional?: boolean }[];
  /** The flag an "unknown" error names, when the installed version refused one. */
  unknown(stderr: string): string | undefined;
  parse(stdout: string): { text: string } | { error: string };
}

const CLAUDE: CliSpec = {
  label: "the Claude Code CLI",
  model: "haiku",
  args: (model) => [
    { arg: ["-p", "--model", model, "--output-format", "json"] },
    { arg: ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] },
    { arg: ["--system-prompt", CLI_SYSTEM] },
    { arg: ["--tools", ""], optional: true },
    { arg: ["--safe-mode"], optional: true },
    { arg: ["--no-session-persistence"], optional: true },
    { arg: ["--disable-slash-commands"], optional: true },
  ],
  unknown: (stderr) => /unknown option '(--[a-z-]+)'/i.exec(stderr)?.[1],
  parse(stdout) {
    let out: { result?: unknown; is_error?: unknown; subtype?: unknown };
    try {
      out = JSON.parse(stdout.trim().split("\n").pop() ?? "") as typeof out;
    } catch {
      return { error: "it did not answer with JSON" };
    }
    if (out.is_error === true || typeof out.result !== "string")
      return { error: typeof out.result === "string" && out.result ? out.result : String(out.subtype ?? "an error") };
    return { text: out.result };
  },
};

/** Codex features that are tools; turned off so the child only answers. */
const CODEX_TOOLS = ["shell_tool", "apps", "plugins", "hooks", "browser_use", "computer_use", "image_generation"];

const CODEX: CliSpec = {
  label: "Codex",
  model: "gpt-5.6-terra",
  args: (model, cwd) => [
    { arg: ["exec", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config"] },
    { arg: ["--sandbox", "read-only", "-C", cwd, "-m", model, "--json", "--color", "never"] },
    { arg: ["-c", 'model_reasoning_effort="low"'], optional: true },
    { arg: ["--ignore-rules"], optional: true },
    ...CODEX_TOOLS.map((f) => ({ arg: ["--disable", f], optional: true })),
    { arg: ["-"] },
  ],
  unknown: (stderr) =>
    /Unknown feature flag: ([a-z_]+)/i.exec(stderr)?.[1] ?? /unexpected argument '(--[a-z-]+)'/i.exec(stderr)?.[1],
  parse(stdout) {
    let text: string | undefined;
    let failed: string | undefined;
    for (const line of stdout.split("\n")) {
      let event: { type?: string; item?: { type?: string; text?: unknown }; error?: { message?: unknown } };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      )
        text = event.item.text;
      if (event.type === "turn.failed" || event.type === "error")
        failed = String(event.error?.message ?? (event as { message?: unknown }).message ?? "the turn failed");
    }
    if (text !== undefined) return { text };
    return { error: failed ?? "it gave no answer" };
  },
};

export const CLIS: Record<CliId, CliSpec> = { claude: CLAUDE, codex: CODEX };

/** What one child run printed and how it ended. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  /** True when it was stopped by the time limit or the call's signal. */
  stopped: boolean;
}

/** Runs one child with `input` on stdin; tests replace it. */
export type CliSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; cwd: string; input: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<CliRun>;

const spawnCli: CliSpawn = (command, args, options) =>
  new Promise((resolve) => {
    const plan = spawnPlan(command, args, options.env);
    const windows = process.platform === "win32";
    let stdout = "";
    let stderr = "";
    let stopped = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.file, plan.args, {
        env: options.env,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: plan.verbatim,
        windowsHide: true,
        // Its own process group, so a stop takes the CLI's own children with it.
        detached: !windows,
      });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: (error as Error).message, stopped: false });
      return;
    }
    const stop = () => {
      if (stopped || child.exitCode !== null) return;
      stopped = true;
      if (child.pid) killTree(child.pid, true);
    };
    const timer = setTimeout(stop, options.timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (c: Buffer) => {
      stdout = (stdout + c.toString("utf8")).slice(-OUTPUT_CHARS);
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-OUTPUT_CHARS);
    });
    child.stdin?.on("error", () => {}); // a child that exits early closes its stdin
    child.stdin?.end(options.input);
    const done = (code: number) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, stopped });
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      stderr += err.message;
      done(err.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code) => done(code ?? 1));
  });

/** The whole prompt as the child reads it on stdin: the instructions first, then the turns. */
function cliPrompt(request: ModelRequest): string {
  const turns =
    request.messages.length === 1 && request.messages[0]!.role === "user"
      ? request.messages[0]!.text
      : request.messages.map((m) => `[${m.role}]\n${m.text}`).join("\n\n");
  return `<instructions>\n${request.system}\n</instructions>\n\n${turns}`;
}

/** Last lines of a child's error output, for a message. */
function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * One subscription CLI as an `ActModel`. Its replies carry no token count: the CLI adds its own
 * system context, which act does not control, so act counts what it sent and got back.
 */
export function cliModel(options: {
  cli: CliId;
  /** The command found on PATH. */
  command: string;
  model?: string;
  env: NodeJS.ProcessEnv;
  spawn?: CliSpawn;
}): ActModel {
  const spec = CLIS[options.cli];
  const model = options.model ?? spec.model;
  const run = options.spawn ?? spawnCli;
  const env = { ...options.env, [ACT_CHILD_ENV]: "1" };
  /** Optional flags this installed version refused, dropped from every later call. */
  const dropped = new Set<string>();
  return {
    label: `${spec.label} (${model})`,
    async complete(request) {
      const input = cliPrompt(request);
      const cwd = mkdtempSync(join(tmpdir(), "turno-act-"));
      try {
        for (;;) {
          const groups = spec.args(model, cwd);
          const args = groups.filter((g) => !(g.optional && dropped.has(g.arg.join(" ")))).flatMap((g) => g.arg);
          const result = await run(options.command, args, {
            env,
            cwd,
            input,
            timeoutMs: CLI_TIMEOUT_MS,
            ...(request.signal ? { signal: request.signal } : {}),
          });
          if (result.stopped || request.signal?.aborted) throw new ModelError(`${spec.label} did not answer in time`);
          if (result.code !== 0) {
            const flag = spec.unknown(result.stderr);
            const group = flag
              ? groups.find((g) => g.optional && !dropped.has(g.arg.join(" ")) && g.arg.includes(flag))
              : undefined;
            if (group) {
              dropped.add(group.arg.join(" "));
              continue;
            }
            if (result.code === 127) throw new ModelError(`${spec.label} could not start: ${tail(result.stderr)}`);
            const parsed = spec.parse(result.stdout);
            const why = "error" in parsed && result.stdout.trim() ? parsed.error : tail(result.stderr);
            throw new ModelError(`${spec.label} failed (exit ${result.code})${why ? `: ${why}` : ""}`);
          }
          const parsed = spec.parse(result.stdout);
          if ("error" in parsed) throw new ModelError(`${spec.label} failed: ${parsed.error}`);
          return { text: parsed.text };
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
