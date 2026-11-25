import { type SecretStore, secretStore } from "turno-core/secrets";
import type { ActSettings } from "./opt-in-settings.js";
import type { Redactor } from "./redact.js";
import { names } from "./names.js";

/**
 * The model behind `browser_act`, `browser_extract` and `browser_observe`, kept small and
 * provider-neutral: one interface and two adapters.
 *
 * - `samplingModel`: MCP sampling. The agent's own client answers with a model it chooses and
 *   the user approves there; turno holds no key. Used first when the client offers it.
 * - `chatCompletionsModel`: an HTTP API in the widely implemented chat completions shape
 *   (`POST <endpoint>/chat/completions`), which hosted providers and local model servers alike
 *   speak. The user names the endpoint and the model; the key, when there is one, comes from
 *   the secret store through a `keychain:` reference and joins the redactor before the first
 *   request, so an error that echoes it never shows it.
 *
 * Neither adapter sees a tool argument: what they send is built by `act.ts` from the
 * instruction and a redacted snapshot.
 */

interface ModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  /** Most tokens the reply may use. */
  maxTokens: number;
  signal?: AbortSignal;
}

interface ModelReply {
  text: string;
  /** Tokens the provider counted, when it says; otherwise the caller estimates. */
  usage?: { input: number; output: number };
}

export interface ActModel {
  /** How the result names it: "MCP sampling", "chat-completions example-model at models.example.com". */
  readonly label: string;
  complete(request: ModelRequest): Promise<ModelReply>;
}

/** What the host passes for MCP sampling: `server.createMessage`, routed to the calling session. */
export type Sampler = (
  request: {
    systemPrompt: string;
    messages: { role: "user" | "assistant"; content: { type: "text"; text: string } }[];
    maxTokens: number;
  },
  signal?: AbortSignal,
) => Promise<{ text: string; model?: string }>;

/** A rough token count for budgets when a provider does not report one: 4 characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

export function samplingModel(sample: Sampler): ActModel {
  return {
    label: "MCP sampling (your client's model)",
    async complete(request) {
      const reply = await sample(
        {
          systemPrompt: request.system,
          messages: request.messages.map((m) => ({ role: m.role, content: { type: "text", text: m.text } })),
          maxTokens: request.maxTokens,
        },
        request.signal,
      );
      return { text: reply.text };
    },
  };
}

type Fetch = typeof fetch;

/** Longest provider error body kept in a message. */
const ERROR_CHARS = 300;

/**
 * Where providers of the chat completions shape differ: the name of the reply budget, whether
 * they take a temperature, and fields of their own. The default is the original shape.
 */
export interface ChatDialect {
  tokens: "max_tokens" | "max_completion_tokens";
  temperature: boolean;
  extra?: Readonly<Record<string, unknown>>;
}

const DEFAULT_DIALECT: ChatDialect = { tokens: "max_tokens", temperature: true };

export function chatCompletionsModel(options: {
  endpoint: string;
  model: string;
  key?: string;
  fetch?: Fetch;
  dialect?: ChatDialect;
  label?: string;
}): ActModel {
  const dialect = options.dialect ?? DEFAULT_DIALECT;
  const url = `${options.endpoint.replace(/\/+$/, "")}/chat/completions`;
  const host = new URL(options.endpoint).host;
  const doFetch = options.fetch ?? fetch;
  return {
    label: options.label ?? `chat-completions ${options.model} at ${host}`,
    async complete(request) {
      const body = {
        model: options.model,
        messages: [
          { role: "system", content: request.system },
          ...request.messages.map((m) => ({ role: m.role, content: m.text })),
        ],
        [dialect.tokens]: request.maxTokens,
        ...(dialect.temperature ? { temperature: 0 } : {}),
        ...dialect.extra,
      };
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
          },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        if (request.signal?.aborted) throw new ModelError("the model did not answer in time");
        throw new ModelError(`cannot reach ${host}: ${(error as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const detail = text.replace(/\s+/g, " ").slice(0, ERROR_CHARS);
        throw new ModelError(`${host} answered ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      let parsed: {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        throw new ModelError(`${host} did not answer with JSON`);
      }
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new ModelError(`${host} answered without a message`);
      const input = parsed.usage?.prompt_tokens;
      const output = parsed.usage?.completion_tokens;
      return {
        text: content,
        ...(typeof input === "number" && typeof output === "number" ? { usage: { input, output } } : {}),
      };
    },
  };
}

/**
 * The model for one call: MCP sampling when the identity allows it and the client offers it,
 * else the configured provider with its key from the secret store. The error says what to set
 * when neither is there.
 */
export async function resolveModel(options: {
  settings: ActSettings;
  sample?: Sampler;
  store?: SecretStore;
  env: NodeJS.ProcessEnv;
  redactor: Redactor;
  fetch?: Fetch;
  id: string;
}): Promise<ActModel> {
  const { settings, sample, redactor } = options;
  if (settings.sampling !== false && sample) return samplingModel(sample);
  if (!settings.provider || !settings.endpoint || !settings.model) {
    throw new ModelError(
      settings.sampling === false
        ? `natural language actions of "${options.id}" have no provider (${names().identity("set", options.id)} --act-provider chat-completions --act-endpoint <url> --act-model <name>)`
        : `this client does not offer MCP sampling and identity "${options.id}" names no provider: set one with ${names().identity("set", options.id)} --act-provider chat-completions --act-endpoint <url> --act-model <name> [--act-key keychain:<item>]`,
    );
  }
  let key: string | undefined;
  if (settings.key) {
    const item = settings.key.slice("keychain:".length);
    const store = options.store ?? secretStore(options.env);
    if (!store) throw new ModelError(`act.key names ${settings.key}, but this machine has no secret store`);
    key = await store.get(item).catch(() => undefined);
    if (key === undefined)
      throw new ModelError(
        `the secret store has no item "${item}" for act.key (store it with: ${names().secretSet(item)})`,
      );
    redactor.add(key, "act model key");
  }
  return chatCompletionsModel({
    endpoint: settings.endpoint,
    model: settings.model,
    ...(key ? { key } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
