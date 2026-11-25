import { findOnPath } from "turno-core/paths";
import { type ActModel, ModelError, type Sampler, chatCompletionsModel, samplingModel } from "./act-model.js";
import { ACT_CHILD_ENV, CLIS, type CliId, type CliSpawn, cliModel } from "./cli-model.js";
import type { ActSettings } from "./opt-in-settings.js";
import type { Redactor } from "./redact.js";

/**
 * Where natural language actions (`browser_act`, `browser_extract`, `browser_observe`) get a
 * model when identity.json names no provider. The first that works, in this order:
 *
 * 1. MCP sampling, when the connected client offers it (decided per connection);
 * 2. an API key in the environment, for a provider the chat completions adapter speaks
 *    (`ENV_PROVIDERS`);
 * 3. the user's subscription CLI on PATH, run headless with an intermediate model
 *    (`cli-model.ts`): the Claude Code CLI, then Codex;
 * 4. none: the tools are not listed.
 *
 * Steps 2 and 3 depend only on the server's environment, so `resolveActFallback` decides them
 * once when the server starts; `resolveAct` adds the connection's sampling on top. An
 * identity.json `act` group with a provider keeps its own order (sampling unless turned off,
 * then that provider); `act: false` turns the tools off. Whatever path answers, the prompt is
 * the one `act.ts` builds from the instruction and a redacted snapshot, so vault values never
 * reach it.
 */

/** API keys in the environment, in the order they are tried, for the chat completions adapter. */
const ENV_PROVIDERS = [
  {
    variable: "OPENAI_API_KEY",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-6-luna",
    // A reasoning model: it takes max_completion_tokens and no temperature, and answers
    // fastest with no reasoning, which one step of a browser task does not need.
    dialect: { tokens: "max_completion_tokens", temperature: false, extra: { reasoning_effort: "none" } },
  },
  {
    variable: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1",
    model: "claude-haiku-5-5",
    // Its chat completions layer refuses a temperature below 1 on current models.
    dialect: { tokens: "max_tokens", temperature: false },
  },
] as const;

/** `off` keeps the subscription CLIs out of the chain (their quota stays the person's alone). */
const ACT_CLI_ENV = "TURNO_BROWSER_ACT_CLI";

/** The subscription CLIs, in the order they are tried. */
const CLI_ORDER: readonly CliId[] = ["claude", "codex"];

type EnvProvider = (typeof ENV_PROVIDERS)[number];

/** What the server's environment offers when the client has no sampling. */
export type ActFallback =
  | { kind: "env"; provider: EnvProvider; key: string }
  | { kind: "cli"; clis: { cli: CliId; command: string }[] }
  | { kind: "none"; reason: string };

/** An identity's `act` key: a group, an explicit `false`, or absent. */
export type ActKey = ActSettings | false | undefined;

/** The path one connection resolved to, and why, in words for results, `show` and `doctor`. */
export interface ActResolution {
  path: "provider" | "sampling" | "env" | "cli" | "off";
  /** "MCP sampling", "OpenAI (gpt-6-luna) with OPENAI_API_KEY", "the Claude Code CLI (haiku)". */
  label: string;
  reason: string;
}

/** The session-independent part of the chain: an API key in the environment, else a CLI. */
export function resolveActFallback(
  env: NodeJS.ProcessEnv,
  find: (name: string, env: NodeJS.ProcessEnv) => string | undefined = findOnPath,
): ActFallback {
  for (const provider of ENV_PROVIDERS) {
    const key = env[provider.variable]?.trim();
    if (key) return { kind: "env", provider, key };
  }
  // A CLI that turno-browser itself started must never start another one.
  if (env[ACT_CHILD_ENV])
    return { kind: "none", reason: "this server runs under a CLI that natural language actions started" };
  if (env[ACT_CLI_ENV] === "off")
    return { kind: "none", reason: `${ACT_CLI_ENV}=off keeps the Claude Code CLI and Codex out of it` };
  const clis = CLI_ORDER.flatMap((cli) => {
    const command = find(cli, env);
    return command ? [{ cli, command }] : [];
  });
  if (clis.length) return { kind: "cli", clis };
  return {
    kind: "none",
    reason: `no ${ENV_PROVIDERS.map((p) => p.variable).join(" or ")} in the environment, and neither claude nor codex on PATH`,
  };
}

function fallbackLabel(fallback: Exclude<ActFallback, { kind: "none" }>): string {
  if (fallback.kind === "env")
    return `${fallback.provider.label} (${fallback.provider.model}) with ${fallback.provider.variable}`;
  const first = fallback.clis[0]!;
  return `${CLIS[first.cli].label} (${CLIS[first.cli].model})`;
}

function fallbackReason(fallback: Exclude<ActFallback, { kind: "none" }>): string {
  if (fallback.kind === "env") return `${fallback.provider.variable} is set in the environment`;
  const found = fallback.clis.map((c) => c.command).join(", then ");
  return `found ${found} on PATH, run headless with your own login`;
}

/**
 * The chain for one connection. `sampling` is whether its client offers MCP sampling; undefined
 * when that is not known (the CLI commands, which have no client), which describes both cases.
 */
export function resolveAct(act: ActKey, fallback: ActFallback, sampling: boolean | undefined): ActResolution {
  if (act === false) return { path: "off", label: "off", reason: "identity.json turns natural language actions off" };
  if (act?.provider) {
    const provider = `${act.provider} ${act.model ?? ""} at ${act.endpoint ?? ""}`.replace(/\s+/g, " ").trim();
    if (act.sampling !== false && sampling !== false)
      return {
        path: sampling ? "sampling" : "provider",
        label: sampling ? "MCP sampling" : `MCP sampling when the client offers it, else ${provider}`,
        reason: "identity.json names a provider",
      };
    return { path: "provider", label: provider, reason: "identity.json names a provider" };
  }
  if (sampling) return { path: "sampling", label: "MCP sampling", reason: "the client offers MCP sampling" };
  if (fallback.kind === "none") {
    if (sampling === undefined)
      return {
        path: "sampling",
        label: "MCP sampling when the client offers it, else off",
        reason: fallback.reason,
      };
    return { path: "off", label: "off", reason: `the client does not offer MCP sampling, ${fallback.reason}` };
  }
  const label = fallbackLabel(fallback);
  return {
    path: fallback.kind,
    label: sampling === undefined ? `MCP sampling when the client offers it, else ${label}` : label,
    reason: sampling === undefined ? fallbackReason(fallback) : `no MCP sampling; ${fallbackReason(fallback)}`,
  };
}

/** True when a connection lists the tools: anything but "off". */
export function actListed(act: ActKey, fallback: ActFallback, sampling: boolean): boolean {
  return resolveAct(act, fallback, sampling).path !== "off";
}

/**
 * The model of the fallback, for a call whose client has no sampling. An environment key joins
 * the redactor before the first request, so an error that echoes it never shows it. With more
 * than one CLI on PATH, a CLI that fails hands the call to the next one, and the one that worked
 * stays first.
 */
function fallbackModel(
  fallback: Exclude<ActFallback, { kind: "none" }>,
  options: { env: NodeJS.ProcessEnv; redactor: Redactor; fetch?: typeof fetch; spawn?: CliSpawn },
): ActModel {
  const cached = models.get(fallback);
  if (cached) return cached;
  const model = buildFallback(fallback, options);
  models.set(fallback, model);
  return model;
}

/** One model per fallback, which a server resolves once: the CLI that worked stays first. */
const models = new WeakMap<ActFallback, ActModel>();

function buildFallback(
  fallback: Exclude<ActFallback, { kind: "none" }>,
  options: { env: NodeJS.ProcessEnv; redactor: Redactor; fetch?: typeof fetch; spawn?: CliSpawn },
): ActModel {
  if (fallback.kind === "env") {
    const p = fallback.provider;
    options.redactor.add(fallback.key, "act model key");
    return chatCompletionsModel({
      endpoint: p.endpoint,
      model: p.model,
      key: fallback.key,
      dialect: p.dialect,
      label: `${p.label} (${p.model}) with ${p.variable}`,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
  const clis = fallback.clis.map((c) =>
    cliModel({ ...c, env: options.env, ...(options.spawn ? { spawn: options.spawn } : {}) }),
  );
  if (clis.length === 1) return clis[0]!;
  return {
    get label() {
      return clis[0]!.label;
    },
    async complete(request) {
      const errors: string[] = [];
      for (const [i, model] of [...clis].entries()) {
        try {
          const reply = await model.complete(request);
          if (i > 0) clis.unshift(...clis.splice(clis.indexOf(model), 1));
          return reply;
        } catch (error) {
          if (request.signal?.aborted) throw error;
          errors.push((error as Error).message);
        }
      }
      throw new ModelError(errors.join("; "));
    },
  };
}

/**
 * The model for one call without an identity.json provider: the client's sampling when it offers
 * it, else the fallback. Undefined when nothing answers.
 */
export function chainModel(options: {
  fallback: ActFallback;
  sample?: Sampler;
  env: NodeJS.ProcessEnv;
  redactor: Redactor;
  fetch?: typeof fetch;
  spawn?: CliSpawn;
}): ActModel | undefined {
  if (options.sample) return samplingModel(options.sample);
  if (options.fallback.kind === "none") return undefined;
  return fallbackModel(options.fallback, options);
}

/**
 * How an identity's natural language actions get a model, for `show`, `status` and `doctor`:
 * from this process's environment, without a client (so sampling reads "when the client offers
 * it"). A server started by an agent or mcpd may see a different environment.
 */
export function describeAct(act: ActKey, env: NodeJS.ProcessEnv): ActResolution {
  return resolveAct(act, resolveActFallback(env), undefined);
}
