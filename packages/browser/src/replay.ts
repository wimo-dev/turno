import { differences, fingerprintOf, refusal } from "./fingerprint.js";
import { fileURLToPath } from "node:url";
import { secretStore } from "turno-core/secrets";
import {
  type Flow,
  FlowError,
  type FlowStep,
  type FlowTarget,
  describeStep,
  fillParams,
  listFlows,
  paramRefs,
  readFlow,
  resolveParams,
  setPath,
} from "./flows.js";
import { loginTool } from "./login-tool.js";
import type { Slot } from "./recorder.js";
import type { StockAccess, TurnoTool } from "./tools.js";
import { type ToolResult, type ToolSchema, upstream } from "./upstream.js";
import { names } from "./names.js";

/**
 * `browser_replay` and `browser_flows`: run a saved flow again, and list the saved ones.
 *
 * Each step runs through the same path as a call of its own (tab governor, click diagnosis,
 * recordings), with the element found again from the step's locators, in order: the first that
 * matches exactly one visible element is passed to the stock tool as its target. When a step
 * fails, the replay stops and says which step, every locator it tried and why each did not
 * fit, which steps did not run, and how to continue (`from`), with a fresh snapshot of the page:
 * the agent does that step by hand and lets the replay go on.
 *
 * Parameters: a sensitive one (no stored value) must be given. A value written
 * `keychain:<item>` is read from the secret store (`turno secret set <item>`), so the model
 * never sees it; every sensitive or secret-store value joins the redactor, and before one goes
 * into a page the recording stops its trace and holds the page like a vault fill.
 */

/** Longest wait for one step's element, in seconds. */
const MAX_WAIT_S = 30;
const DEFAULT_WAIT_S = 5;
/** How deep a flow may replay other flows. */
const MAX_DEPTH = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

/** The sections of an upstream result text (`### Title` then the body). */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    out.set(part.slice(0, nl), part.slice(nl + 1).trim());
  }
  return out;
}

/** The first locator of a target that finds exactly one visible element, waiting up to `ms`. */
async function findTarget(
  stock: StockAccess,
  target: FlowTarget,
  ms: number,
  signal?: AbortSignal,
): Promise<{ selector: string; kind: string } | { tried: string[] }> {
  const end = Date.now() + ms;
  for (;;) {
    const page = stock.currentPage();
    const tried: string[] = [];
    let unchecked: { selector: string; kind: string } | undefined;
    for (const l of target.locators) {
      if (!page) break;
      const locator = page.locator(l.selector);
      const n = await locator.count().catch(() => -1);
      if (n === 1 && (await locator.isVisible().catch(() => false))) return { selector: l.selector, kind: l.kind };
      if (n < 0 && l.kind === "generated") unchecked ??= { selector: l.selector, kind: l.kind };
      tried.push(
        `${l.kind} ${l.selector}: ${n < 0 ? "not a selector this page can check" : n === 0 ? "no element" : n === 1 ? "not visible" : `${n} elements`}`,
      );
    }
    // A locator the agent wrote in Playwright's JavaScript syntax: upstream parses it itself.
    if (unchecked && tried.length === target.locators.length && tried.every((t) => !t.endsWith("not visible")))
      return unchecked;
    if (!page) tried.push("no page is open");
    if (Date.now() >= end || signal?.aborted) return { tried };
    await sleep(250);
  }
}

interface RunState {
  lines: string[];
  /** The step that failed, its 1-based number, and what to tell the agent. */
  failure?: { n: number; total: number; step: FlowStep; message: string };
}

interface RunContext {
  ctx: Parameters<TurnoTool["handle"]>[0];
  stock: StockAccess;
  waitMs: number;
  depth: number;
}

async function runStep(
  run: RunContext,
  step: FlowStep,
  values: Record<string, string>,
  secret: ReadonlySet<string>,
  /** The sensitive parameters the agent did not pass: read from the secret store, or typed by the person. */
  trusted: ReadonlySet<string>,
): Promise<{ ok: true; note?: string } | { ok: false; message: string }> {
  const { ctx, stock } = run;
  if (step.tool === "browser_login") {
    try {
      const result = await loginTool().handle(ctx, { site: step.args.site });
      if (result.isError) return { ok: false, message: sections(textOf(result)).get("Error") ?? textOf(result) };
      return { ok: true };
    } catch (error) {
      return { ok: false, message: (error as Error).message ?? String(error) };
    }
  }
  if (step.tool === "browser_replay") {
    if (run.depth >= MAX_DEPTH) return { ok: false, message: `flows replay other flows at most ${MAX_DEPTH} deep` };
    const vault = ctx.vault!;
    let inner: Flow;
    try {
      inner = readFlow(vault.identity.id, String(step.args.flow), vault.identity.env);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const given = fillParams(step.args.params ?? {}, values) as Record<string, string>;
    const prepared = await prepareParams(ctx, inner, given);
    if ("error" in prepared) return { ok: false, message: prepared.error };
    const state = await runSteps(
      { ...run, depth: run.depth + 1 },
      inner,
      prepared.values,
      prepared.secret,
      prepared.trusted,
      1,
    );
    if (state.failure)
      return {
        ok: false,
        message: `step ${state.failure.n} of flow "${inner.name}" (${describeStep(state.failure.step)}) failed: ${state.failure.message}`,
      };
    return { ok: true, note: `${inner.steps.length} steps` };
  }
  const args = fillParams(step.args, values) as Record<string, unknown>;
  const used: string[] = [];
  let checked = 0;
  for (const [path, target] of Object.entries(step.targets ?? {})) {
    const found = await findTarget(stock, target, run.waitMs, ctx.signal);
    if ("tried" in found) {
      const what = target.description ? `"${target.description}"` : "the element";
      return {
        ok: false,
        message: `no locator of ${what} found exactly one visible element within ${run.waitMs / 1000}s:\n${found.tried.map((t) => `- ${t}`).join("\n")}`,
      };
    }
    // The selector found one element; it must be the recorded one, or the step does not run.
    const page = stock.currentPage();
    const recorded = target.fingerprint ?? (page ? ctx.recorder?.cache.get(page.url(), found.selector) : undefined);
    if (recorded && page) {
      // A locator in Playwright's JavaScript syntax cannot be read here: the step runs unchecked.
      const now = await fingerprintOf(page.locator(found.selector), page.url());
      if (now) {
        const diffs = differences(recorded, now);
        if (!target.fingerprint) ctx.recorder?.cache.count(page.url(), found.selector, diffs.length === 0);
        if (diffs.length) return { ok: false, message: refusal(`${found.kind} ${found.selector}`, diffs) };
        checked++;
      }
    }
    setPath(args, path, found.selector);
    used.push(found.kind);
    const element =
      path === "target"
        ? "element"
        : path === "startTarget"
          ? "startElement"
          : path === "endTarget"
            ? "endElement"
            : undefined;
    if (element && target.description && args[element] === undefined) args[element] = target.description;
  }
  const schema = stock.schemas.get(step.tool);
  if (!schema) return { ok: false, message: `this server does not offer ${step.tool} (its capability is off)` };
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { ok: false, message: `invalid arguments: ${stock.formatError(parsed.error)}` };
  const secrets = paramRefs(step.args).filter((name) => secret.has(name));
  if (secrets.length) await ctx.recording?.pauseForSecret(stock.currentPage());
  // A password or one-time code field takes only a value the agent did not pass.
  const fromSecretStore = secrets.length > 0 && secrets.every((name) => trusted.has(name));
  const result = await stock.call(step.tool, args, {
    snapshot: false,
    ...(fromSecretStore ? { fromSecretStore } : {}),
  });
  if (result.isError) return { ok: false, message: sections(textOf(result)).get("Error") ?? textOf(result) };
  const note = [
    ...(used.length ? [`found by ${used.join(", ")}`] : []),
    ...(checked ? [checked === used.length ? "same element" : `${checked} same element`] : []),
  ].join(", ");
  return { ok: true, ...(note ? { note } : {}) };
}

async function runSteps(
  run: RunContext,
  flow: Flow,
  values: Record<string, string>,
  secret: ReadonlySet<string>,
  trusted: ReadonlySet<string>,
  from: number,
): Promise<RunState> {
  const state: RunState = { lines: [] };
  const total = flow.steps.length;
  for (let i = from - 1; i < total; i++) {
    const step = flow.steps[i]!;
    const done = await runStep(run, step, values, secret, trusted);
    if (!done.ok) {
      state.lines.push(`${i + 1}. ${describeStep(step)}: failed`);
      state.failure = { n: i + 1, total, step, message: done.message };
      return state;
    }
    state.lines.push(`${i + 1}. ${describeStep(step)}: ok${done.note ? ` (${done.note})` : ""}`);
  }
  return state;
}

/**
 * The values a flow runs with: given ones (a `keychain:<item>` read from the secret store),
 * then defaults. Sensitive and secret-store values join the redactor first.
 */
async function prepareParams(
  ctx: Parameters<TurnoTool["handle"]>[0],
  flow: Flow,
  given: Record<string, string>,
): Promise<
  { values: Record<string, string>; secret: Set<string>; refs: Set<string>; trusted: Set<string> } | { error: string }
> {
  const vault = ctx.vault!;
  const { values, missing, unknown } = resolveParams(flow, given);
  if (unknown.length)
    return {
      error: `flow "${flow.name}" has no parameter ${unknown.map((u) => `"${u}"`).join(", ")} (its parameters: ${flow.params.map((p) => p.name).join(", ") || "none"})`,
    };
  if (missing.length)
    return {
      error: `flow "${flow.name}" needs ${missing.map((p) => `"${p.name}"${p.sensitive ? " (sensitive)" : ""}`).join(", ")}: pass them in params; a value written keychain:<item> is read from the secret store (${names().secretSet("<item>")}) so it never passes through you.`,
    };
  const secret = new Set<string>();
  const refs = new Set<string>();
  // Sensitive values the person typed at the hidden prompt of `turno-browser replay`.
  const prompted = new Set((vault.identity.env[PROMPTED_ENV] ?? "").split(",").filter(Boolean));
  const trusted = new Set<string>();
  for (const p of flow.params) {
    let v = values[p.name]!;
    if (v.startsWith("keychain:")) {
      const item = v.slice("keychain:".length);
      const store = vault.store ?? secretStore(vault.identity.env);
      if (!store) return { error: `parameter "${p.name}" names ${v}, but this machine has no secret store` };
      const read = await store.get(item).catch(() => undefined);
      if (read === undefined)
        return {
          error: `parameter "${p.name}": the secret store has no item "${item}" (store it with: ${names().secretSet(item)})`,
        };
      v = read;
      values[p.name] = v;
      refs.add(p.name);
      trusted.add(p.name);
      secret.add(p.name);
    } else if (p.sensitive) {
      secret.add(p.name);
      if (prompted.has(p.name)) trusted.add(p.name);
    }
    if (secret.has(p.name)) vault.redactor.add(v, `sensitive parameter ${p.name}`);
  }
  return { values, secret, refs, trusted };
}

function replaySchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_replay",
    title: "Replay a saved browser flow",
    description: [
      "Run a flow saved with browser_record (list them with browser_flows) on this browser identity, step by step, finding each element again by its saved locators.",
      "Pass the flow's parameters in params; sensitive ones have no saved value and must be given. Write a value as keychain:<item> to have it read from the secret store instead of passing it yourself.",
      "When a step fails it stops and reports the step, the locators it tried and a fresh snapshot: do that step yourself, then call browser_replay again with from set to the next step.",
    ].join(" "),
    inputSchema: z.object({
      flow: z.string().describe("The flow name"),
      params: z.record(z.string(), z.string()).optional().describe("Parameter values by name"),
      from: z
        .number()
        .optional()
        .describe("Start at this step (1 is the first), to continue after a step done by hand"),
      wait: z
        .number()
        .optional()
        .describe(`Seconds to wait for each step's element (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S})`),
      snapshot: z.boolean().optional().describe("Return a snapshot of the page after the last step (default true)"),
    }),
    type: "action",
  };
}

/** The snapshot sections of a stock result, for the end of a replay's result. */
async function pageSections(stock: StockAccess, snapshot: boolean): Promise<string[]> {
  if (!snapshot) {
    const page = await stock.page();
    return page ? ["### Page", `- Page URL: ${page.url}`, ...(page.title ? [`- Page Title: ${page.title}`] : [])] : [];
  }
  const snap = sections(textOf(await stock.call("browser_snapshot", {}, { snapshot: true })));
  const out: string[] = [];
  for (const title of ["Open tabs", "Page", "Modal state", "Snapshot", "Tab governor"]) {
    const body = snap.get(title);
    if (body) out.push(`### ${title}`, body);
  }
  return out;
}

/** `browser_replay`. */
export function replayTool(): TurnoTool {
  let built: ToolSchema | undefined;
  return {
    get schema() {
      built ??= replaySchema();
      return built;
    },
    async handle(ctx, params) {
      const vault = ctx.vault;
      const stock = ctx.stock;
      if (!vault || !stock)
        throw new FlowError("browser_replay needs a browser identity: this server runs without --identity");
      const flow = readFlow(vault.identity.id, String(params.flow), vault.identity.env);
      const from = params.from === undefined ? 1 : Number(params.from);
      if (!Number.isInteger(from) || from < 1 || from > flow.steps.length)
        throw new FlowError(`from must be a step number from 1 to ${flow.steps.length}`);
      const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(params.wait ?? DEFAULT_WAIT_S)));
      const given = (params.params as Record<string, string> | undefined) ?? {};
      const prepared = await prepareParams(ctx, flow, given);
      if ("error" in prepared)
        return { content: [{ type: "text", text: `### Error\nNothing ran: ${prepared.error}` }], isError: true };
      const run: RunContext = { ctx, stock, waitMs: wait * 1000, depth: 0 };
      const exec = () => runSteps(run, flow, prepared.values, prepared.secret, prepared.trusted, from);
      const state = ctx.recorder ? await ctx.recorder.suspend(exec) : await exec();
      const out: string[] = [];
      if (state.failure) {
        const { n, total, step, message } = state.failure;
        const left = total - n;
        out.push(
          "### Error",
          `Step ${n} of ${total} (${describeStep(step)}) failed: ${message}`,
          left
            ? `Steps ${n + 1} to ${total} did not run. Do step ${n} yourself on the page below, then continue with browser_replay {"flow": "${flow.name}", "from": ${n + 1}} and the same params.`
            : `It was the last step: do it yourself on the page below.`,
        );
      }
      out.push("### Replay", `Flow "${flow.name}"${from > 1 ? ` from step ${from}` : ""}:`, ...state.lines);
      if (state.failure && state.failure.n < flow.steps.length)
        out.push(
          "### Remaining steps",
          ...flow.steps.slice(state.failure.n).map((s, i) => `${state.failure!.n + i + 1}. ${describeStep(s)}`),
        );
      out.push(...(await pageSections(stock, params.snapshot !== false || state.failure !== undefined)));
      if (!state.failure && from === 1 && ctx.recorder) {
        // A recording session keeps the replay as one step; a value read from the secret store
        // keeps its keychain: reference, which is not a secret.
        const slots: Slot[] = flow.params.map((p) => {
          const raw = given[p.name];
          const ref = raw?.startsWith("keychain:");
          return {
            path: `params.${p.name}`,
            value: ref ? raw! : prepared.values[p.name]!,
            sensitive: !ref && prepared.secret.has(p.name),
            label: p.name,
          };
        });
        ctx.recorder.record(
          "browser_replay",
          { flow: flow.name, params: Object.fromEntries(flow.params.map((p) => [p.name, ""])) },
          slots,
        );
      }
      return { content: [{ type: "text", text: out.join("\n") }], ...(state.failure ? { isError: true } : {}) };
    },
  };
}

function flowsSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_flows",
    title: "List saved browser flows",
    description:
      "List the flows saved for this browser identity (browser_record saves them), with their steps and parameters; name one to see its steps.",
    inputSchema: z.object({ name: z.string().optional().describe("A flow name, to see its steps") }),
    type: "readOnly",
  };
}

/** `browser_flows`. */
export function flowsTool(): TurnoTool {
  let built: ToolSchema | undefined;
  return {
    get schema() {
      built ??= flowsSchema();
      return built;
    },
    browser: false,
    async handle(ctx, params) {
      const vault = ctx.vault;
      if (!vault) throw new FlowError("browser_flows needs a browser identity: this server runs without --identity");
      const { id, env } = vault.identity;
      const describeParam = (p: { name: string; sensitive: boolean; hasDefault: boolean }) =>
        `${p.name}${p.sensitive ? " (sensitive, required)" : p.hasDefault ? "" : " (required)"}`;
      if (typeof params.name === "string") {
        const flow = readFlow(id, params.name, env);
        const lines = [
          `### Flow ${flow.name}`,
          ...(flow.description ? [flow.description] : []),
          ...flow.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
          "### Parameters",
          ...(flow.params.length
            ? flow.params.map(
                (p) =>
                  `- ${describeParam({ name: p.name, sensitive: p.sensitive, hasDefault: p.default !== undefined })}`,
              )
            : ["(none)"]),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      const flows = listFlows(id, env);
      const lines = flows.length
        ? flows.map(
            (f) =>
              `- ${f.name}: ${f.steps} step${f.steps === 1 ? "" : "s"}${f.start ? `, starts at ${f.start}` : ""}${f.params.length ? `; params ${f.params.map(describeParam).join(", ")}` : ""}${f.description ? `. ${f.description}` : ""}`,
          )
        : [`Identity "${id}" has no saved flows yet: record one with browser_record.`];
      return { content: [{ type: "text", text: ["### Flows", ...lines].join("\n") }] };
    },
  };
}

export interface ReplayOptions {
  params?: Record<string, string>;
  /** The sensitive parameters the person typed at a hidden prompt, so they may go into a password field. */
  prompted?: readonly string[];
  from?: number;
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Names the parameters of `ReplayOptions.prompted` for the server `replayFlow` starts. Only
 * that server, which serves this one replay and no agent, reads it.
 */
const PROMPTED_ENV = "TURNO_BROWSER_PROMPTED_PARAMS";

/**
 * Replays a flow outside an agent (`turno browser replay`): starts this package's MCP server
 * on the identity and calls `browser_replay`, so the run goes through exactly the path an agent's
 * does (lock, vault, redaction, recordings). Parameter values travel over the server's stdin.
 */
export async function replayFlow(
  id: string,
  flow: string,
  options: ReplayOptions = {},
): Promise<{ ok: boolean; text: string }> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = options.env ?? process.env;
  const bin = fileURLToPath(new URL("./bin/mcp.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, ...(options.headless ? ["--headless"] : [])],
    env: {
      ...Object.fromEntries(
        Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== PROMPTED_ENV),
      ),
      ...(options.prompted?.length ? { [PROMPTED_ENV]: options.prompted.join(",") } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: `${names().browser} replay`, version: "1" });
  await client.connect(transport);
  try {
    const result = await client.callTool(
      {
        name: "browser_replay",
        arguments: {
          flow,
          ...(options.params ? { params: options.params } : {}),
          ...(options.from ? { from: options.from } : {}),
          snapshot: false,
        },
      },
      undefined,
      { timeout: 10 * 60_000 },
    );
    const text = ((result.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");
    return { ok: !result.isError, text };
  } finally {
    await client.close().catch(() => {});
  }
}
