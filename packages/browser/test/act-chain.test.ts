import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ActFallback, chainModel, resolveAct, resolveActFallback } from "../src/act-chain.js";
import { actTool } from "../src/act.js";
import { ACT_CHILD_ENV, type CliRun, type CliSpawn, cliModel } from "../src/cli-model.js";
import { Redactor, VaultGuard } from "../src/redact.js";
import { writeIdentitySettings } from "../src/settings.js";
import { type StockAccess, parseArguments } from "../src/tools.js";
import { type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The provider chain of natural language actions: its order, and what each path may and may
 * not carry. The CLIs are fakes: a recording spawn, or a script on a sandbox PATH. Nothing here
 * calls a paid API or a real CLI.
 */

const VAULT_VALUE = "vault-password-do-not-send-1234";
const API_KEY = "sk-test-env-key-0123456789";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const onPath =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name) ? `/usr/local/bin/${name}` : undefined;

/** A spawn that records each run and answers like the CLI would. */
function recordingSpawn(answer: (args: readonly string[]) => Partial<CliRun> = () => ({})) {
  const runs: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; input: string }[] = [];
  const spawn: CliSpawn = async (command, args, options) => {
    runs.push({ command, args, env: options.env, input: options.input });
    return {
      code: 0,
      stdout: JSON.stringify({ type: "result", is_error: false, result: '{"done": true, "summary": "ok"}' }),
      stderr: "",
      stopped: false,
      ...answer(args),
    };
  };
  return { spawn, runs };
}

describe("the chain order", () => {
  it("takes an API key from the environment before a CLI, and the Claude Code CLI before Codex unless CLIs are off", () => {
    const both = onPath("claude", "codex");
    expect(resolveActFallback({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }, both)).toMatchObject({
      kind: "env",
      provider: { variable: "OPENAI_API_KEY" },
    });
    expect(resolveActFallback({ ANTHROPIC_API_KEY: "a" }, both)).toMatchObject({
      kind: "env",
      provider: { variable: "ANTHROPIC_API_KEY" },
    });
    expect(resolveActFallback({}, both)).toMatchObject({
      kind: "cli",
      clis: [{ cli: "claude" }, { cli: "codex" }],
    });
    expect(resolveActFallback({}, onPath("codex"))).toMatchObject({ kind: "cli", clis: [{ cli: "codex" }] });
    expect(resolveActFallback({}, onPath())).toMatchObject({ kind: "none" });
    expect(resolveActFallback({ TURNO_BROWSER_ACT_CLI: "off" }, onPath("claude", "codex")).kind).toBe("none");
  });

  it("puts the client's MCP sampling first, keeps an identity.json provider, and lists nothing without a model", () => {
    const cli = resolveActFallback({}, onPath("claude"));
    const none = resolveActFallback({}, onPath());
    expect(resolveAct(undefined, cli, true).path).toBe("sampling");
    expect(resolveAct(undefined, cli, false)).toMatchObject({ path: "cli", label: "the Claude Code CLI (haiku)" });
    expect(resolveAct(undefined, none, true).path).toBe("sampling");
    expect(resolveAct(undefined, none, false).path).toBe("off");
    expect(resolveAct(false, cli, true).path).toBe("off");
    const provider = { provider: "chat-completions" as const, endpoint: "https://m.example.com/v1", model: "m" };
    expect(resolveAct(provider, cli, false)).toMatchObject({
      path: "provider",
      reason: "identity.json names a provider",
    });
    expect(resolveAct({ ...provider, sampling: false }, cli, true).path).toBe("provider");
  });

  it("hands a call to the next CLI when the first fails, and keeps the one that worked first", async () => {
    const { spawn, runs } = recordingSpawn((args) =>
      args[0] === "-p"
        ? { code: 1, stdout: JSON.stringify({ is_error: true, result: "Not logged in" }) }
        : {
            stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}',
          },
    );
    const fallback = resolveActFallback({}, onPath("claude", "codex"));
    const model = chainModel({ fallback, env: {}, redactor: new Redactor(), spawn })!;
    const request = { system: "s", messages: [{ role: "user" as const, text: "u" }], maxTokens: 10 };
    expect(await model.complete(request)).toEqual({ text: "{}" });
    expect(model.label).toBe("Codex (gpt-5.6-terra)");
    await model.complete(request);
    expect(runs.map((r) => r.command)).toEqual([
      "/usr/local/bin/claude",
      "/usr/local/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });
});

describe("the CLI child", () => {
  const request = {
    system: "SYSTEM-PROMPT-TEXT",
    messages: [{ role: "user" as const, text: `USER-TEXT with ${API_KEY}` }],
    maxTokens: 600,
  };

  it("gets the whole prompt on stdin and nothing of it, or of any secret, on its command line", async () => {
    for (const cli of ["claude", "codex"] as const) {
      const { spawn, runs } = recordingSpawn(() =>
        cli === "codex" ? { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}' } : {},
      );
      await cliModel({ cli, command: cli, env: { OPENAI_TOKEN_EXAMPLE: API_KEY }, spawn }).complete(request);
      const argv = runs[0]!.args.join("\n");
      for (const secret of ["SYSTEM-PROMPT-TEXT", "USER-TEXT", API_KEY]) expect(argv).not.toContain(secret);
      expect(runs[0]!.input).toContain("SYSTEM-PROMPT-TEXT");
      expect(runs[0]!.input).toContain("USER-TEXT");
    }
  });

  it("loads no MCP server, so it cannot start turno-browser, and a server under it offers no CLI", async () => {
    const claude = recordingSpawn();
    await cliModel({ cli: "claude", command: "claude", env: {}, spawn: claude.spawn }).complete(request);
    const args = claude.runs[0]!.args;
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args).toContain("--safe-mode");
    const codex = recordingSpawn(() => ({
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}',
    }));
    await cliModel({ cli: "codex", command: "codex", env: {}, spawn: codex.spawn }).complete(request);
    expect(codex.runs[0]!.args).toContain("--ignore-user-config");
    for (const run of [...claude.runs, ...codex.runs]) expect(run.env[ACT_CHILD_ENV]).toBe("1");
    expect(resolveActFallback({ [ACT_CHILD_ENV]: "1" }, onPath("claude", "codex")).kind).toBe("none");
  });

  it("drops a safety flag never: an older CLI that refuses one fails instead of running without it", async () => {
    const old = recordingSpawn((args) =>
      args.includes("--safe-mode")
        ? { code: 1, stdout: "", stderr: "error: unknown option '--safe-mode'" }
        : args.includes("--strict-mcp-config")
          ? { code: 1, stdout: "", stderr: "error: unknown option '--strict-mcp-config'" }
          : {},
    );
    const model = cliModel({ cli: "claude", command: "claude", env: {}, spawn: old.spawn });
    await expect(model.complete(request)).rejects.toThrow(/the Claude Code CLI failed \(exit 1\)/);
    // --safe-mode is optional and was dropped; --strict-mcp-config never is.
    expect(old.runs).toHaveLength(2);
    expect(old.runs[1]!.args).not.toContain("--safe-mode");
    expect(old.runs.every((r) => r.args.includes("--strict-mcp-config"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "runs a real child with the prompt on stdin, and stops it at the deadline",
    async () => {
      const bin = join(sb.home, "bin");
      mkdirSync(bin);
      const seen = join(sb.home, "seen.json");
      writeFileSync(
        join(bin, "claude"),
        `#!${process.execPath}
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), input }));
  if (input.includes("HANG")) setTimeout(() => {}, 60000);
  else process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "{\\"ok\\":1}" }));
});
`,
      );
      chmodSync(join(bin, "claude"), 0o755);
      // Only the fake on PATH: a real CLI must never answer here.
      const env = { ...sb.env, PATH: bin, TURNO_BROWSER_ACT_CLI: undefined };
      const fallback = resolveActFallback(env);
      expect(fallback).toEqual({ kind: "cli", clis: [{ cli: "claude", command: join(bin, "claude") }] });
      const model = chainModel({ fallback, env, redactor: new Redactor() })!;
      expect(await model.complete(request)).toEqual({ text: '{"ok":1}' });
      const got = JSON.parse(readFileSync(seen, "utf8")) as { argv: string[]; input: string };
      expect(got.input).toContain("USER-TEXT");
      expect(got.argv.join(" ")).not.toContain("USER-TEXT");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      await expect(
        model.complete({ ...request, messages: [{ role: "user", text: "HANG" }], signal: controller.signal }),
      ).rejects.toThrow(/did not answer in time/);
    },
  );
});

describe("the environment key", () => {
  it("goes only in the authorization header, to the provider's endpoint, and is hidden from later text", async () => {
    const bodies: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      bodies.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
    }) as typeof globalThis.fetch;
    const redactor = new Redactor();
    const fallback = resolveActFallback({ OPENAI_API_KEY: API_KEY }, onPath("claude"));
    const model = chainModel({ fallback, env: {}, redactor, fetch })!;
    await model.complete({ system: "s", messages: [{ role: "user", text: "u" }], maxTokens: 600 });
    expect(bodies[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((bodies[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(bodies[0]!.init.body)) as Record<string, unknown>;
    expect(String(bodies[0]!.init.body)).not.toContain(API_KEY);
    expect(body).toMatchObject({ model: "gpt-6-luna", max_completion_tokens: 600, reasoning_effort: "none" });
    expect(body).not.toHaveProperty("temperature");
    expect(redactor.text(`echo ${API_KEY}`)).not.toContain(API_KEY);
  });
});

describe("browser_act on the chain", () => {
  const SNAPSHOT = `### Page\n- Page URL: http://127.0.0.1/\n### Snapshot\n\`\`\`yaml\n- textbox "Password" [ref=e2]: ${VAULT_VALUE}\n\`\`\``;
  const stock: StockAccess = {
    schemas: new Map(upstream().tools.browserTools.map((t) => [t.schema.name, t.schema.inputSchema])),
    formatError: (e) => upstream().utils.z.prettifyError(e),
    call: async () => ({ content: [{ type: "text", text: SNAPSHOT }] }),
    page: async () => ({ url: "http://127.0.0.1/", title: "" }),
    currentPage: () => undefined,
  };

  async function act(fallback: ActFallback, spawn?: CliSpawn) {
    const redactor = new Redactor();
    redactor.add(VAULT_VALUE, "password of mail");
    const tool = actTool();
    const parsed = parseArguments(tool, { instruction: "press Go" });
    if ("error" in parsed) throw new Error(parsed.error);
    const res = await tool.handle(
      {
        config: {} as McpConfig,
        clientInfo: { cwd: "/", clientName: "t" },
        stock,
        vault: { identity: { id: "work", env: sb.env }, redactor, guard: new VaultGuard() },
        actFallback: fallback,
        ...(spawn ? { providers: { spawn } } : {}),
      },
      parsed.params,
    );
    return { text: (res.content[0] as { text: string }).text, isError: !!res.isError };
  }

  it("never sends a vault value to the CLI, and the result names the CLI that answered", async () => {
    writeIdentitySettings("work", { region: "MX" }, sb.env);
    const { spawn, runs } = recordingSpawn();
    const r = await act(resolveActFallback({}, onPath("claude")), spawn);
    expect(r.text).toContain("Model: the Claude Code CLI (haiku)");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input).toContain("[vault:");
    expect(JSON.stringify(runs)).not.toContain(VAULT_VALUE);
  });

  it("is refused, saying why, when nothing answers", async () => {
    writeIdentitySettings("work", { region: "MX" }, sb.env);
    const r = await act(resolveActFallback({}, onPath()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/natural language actions of "work" have no model: the client does not offer MCP sampling/);
  });
});
