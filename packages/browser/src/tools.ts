import type { BrowserContext, Page } from "patchright-core";
import { actTool, extractTool, observeTool } from "./act.js";
import type { ActFallback } from "./act-chain.js";
import type { ActModel, Sampler } from "./act-model.js";
import { batchTool } from "./batch.js";
import { type CaptchaSolver, solveCaptchaTool } from "./captcha.js";
import type { CliSpawn } from "./cli-model.js";
import { requestHumanTool } from "./human-step.js";
import { type VaultAccess, loginTool } from "./login-tool.js";
import { readTool } from "./read-tool.js";
import { type FlowRecorder, recordTool } from "./recorder.js";
import { flowsTool, replayTool } from "./replay.js";
import {
  type ClientInfo,
  type McpConfig,
  type ToolResult,
  type ToolSchema,
  type UpstreamTool,
  type Zod,
  type ZodObject,
  upstream,
} from "./upstream.js";

/**
 * The turno tool registry. A turno tool is listed after the stock Playwright MCP
 * tools and called by the host itself; stock tools keep going to upstream's `BrowserBackend`.
 *
 * Rules, checked when the host starts and by the contract test:
 *
 * - A turno tool never takes the name of an upstream tool, whatever its capability, so a stock
 *   tool name always means the stock tool. An upgrade of patchright-core that adds a
 *   tool with the same name fails the contract test, not a user's session.
 * - Names are unique and match `^[a-z][a-z0-9_]*$`.
 * - The input schema is a zod object of the bundled zod (`turnoZod()`), so `tools/list` renders
 *   it exactly like a stock tool's and arguments are validated the same way.
 */

/** The session's stock tools, for a turno tool that runs them (`browser_batch`). */
export interface StockAccess {
  /** Input schema of each stock tool this session lists. */
  schemas: ReadonlyMap<string, ZodObject>;
  /** A zod error as upstream words it. */
  formatError(error: unknown): string;
  /**
   * Runs a stock tool the way a call of its own runs (tab governor, click diagnosis); with
   * `snapshot: false` the result leaves out the page snapshot an action would add.
   * `fromSecretStore` says the text typed was read from the secret store (a flow replay's
   * `keychain:` parameter), so it may go into a password or one-time code field.
   */
  call(
    name: string,
    args: Record<string, unknown>,
    options: { snapshot: boolean; fromSecretStore?: boolean },
  ): Promise<ToolResult>;
  /** URL and title of the current tab, when there is one. */
  page(): Promise<{ url: string; title: string } | undefined>;
  /** The current tab itself (`browser_login` fills it). */
  currentPage(): Page | undefined;
  /**
   * Why the session's browser calls are held right now (the user paused the agent in the live
   * view), or undefined. A tool that runs several steps stops before its next one.
   */
  held?(): string | undefined;
}

interface TurnoToolContext {
  config: McpConfig;
  clientInfo: ClientInfo;
  /** The session's browser context; launched on demand for a tool with `browser: true`. */
  browserContext?: BrowserContext;
  signal?: AbortSignal;
  /**
   * The client session mcpd relays this call for (`_meta["io.turno/session"]`): an
   * opaque id, the same for every call of one agent session and different for every other.
   * Undefined when the call did not come through mcpd.
   */
  session?: string;
  /** The session's stock tools; set by the host for a tool with `browser: true`. */
  stock?: StockAccess;
  /** The identity's vault, its redactor and guard; set by the host when it serves an identity. */
  vault?: VaultAccess;
  /** The session's flow recorder; set by the host when it serves an identity. */
  recorder?: FlowRecorder;
  /** The browser's recording (traces, screenshots), when identity.json asks for one. */
  recording?: { pauseForSecret(page: Page | undefined): Promise<void> };
  /** MCP sampling, routed to the calling session; set when the client offers it. */
  sample?: Sampler;
  /** The engine running the browser ("chrome", "lightpanda", "attach"), once it runs. */
  engine?: string;
  /** Providers that replace the configured ones (tests inject fakes). */
  providers?: Providers;
  /** What the server's environment offers natural language actions, resolved when it started. */
  actFallback?: ActFallback;
  /** Runs a person step on the session's tab (`browser_request_human`); set by the host for it. */
  human?: (params: Record<string, unknown>) => Promise<ToolResult>;
}

/** Stand-ins for the opt-in providers: a model for natural language actions, a captcha solver. */
export interface Providers {
  model?: ActModel;
  solver?: CaptchaSolver;
  /** The fetch the provider adapters use. */
  fetch?: typeof fetch;
  /** What the environment offers natural language actions, instead of this machine's. */
  actFallback?: ActFallback;
  /** Runs a subscription CLI, instead of spawning it. */
  spawn?: CliSpawn;
}

export interface TurnoTool {
  schema: ToolSchema;
  /** True (the default) when the tool needs the browser: the host launches it first. */
  browser?: boolean;
  handle(context: TurnoToolContext, params: Record<string, unknown>): Promise<ToolResult>;
}

/** The tools turno adds to every session. */
export const TURNO_TOOLS: readonly TurnoTool[] = [
  batchTool(),
  readTool(),
  loginTool(),
  recordTool(),
  replayTool(),
  flowsTool(),
  requestHumanTool(),
];

/** The natural language action tools, listed when `act-chain.ts` finds a model for them. */
export const ACT_TOOL_NAMES: readonly string[] = ["browser_act", "browser_extract", "browser_observe"];

/**
 * The tools an identity lists only when their feature has something to answer: natural language
 * actions when a model is found (`act-chain.ts`), captcha solving when a solver key is configured
 * (`captcha.ts`). Without one they are not listed at all.
 */
export function optInTools(on: { act: boolean; captcha: boolean }): TurnoTool[] {
  return [...(on.act ? [actTool(), extractTool(), observeTool()] : []), ...(on.captcha ? [solveCaptchaTool()] : [])];
}

/** Every opt-in tool, for the name checks (contract test). */
export function allOptInTools(): TurnoTool[] {
  return optInTools({ act: true, captcha: true });
}

/** The zod of the bundle, to build a turno tool's `inputSchema` with. */
export function turnoZod(): Zod {
  return upstream().utils.z;
}

const NAME = /^[a-z][a-z0-9_]*$/;

/** Throws when a turno tool would shadow an upstream tool or another turno tool. */
export function checkTurnoTools(turno: readonly TurnoTool[], upstreamTools: readonly UpstreamTool[]): void {
  const stock = new Set(upstreamTools.map((t) => t.schema.name));
  const seen = new Set<string>();
  for (const tool of turno) {
    const name = tool.schema.name;
    if (!NAME.test(name)) throw new Error(`turno tool name "${name}" must match ${NAME}`);
    if (stock.has(name)) throw new Error(`turno tool "${name}" has the name of a Playwright MCP tool`);
    if (seen.has(name)) throw new Error(`turno tool "${name}" is registered twice`);
    seen.add(name);
  }
}

/** Upstream's argument error, word for word, for a turno tool. */
export function parseArguments(
  tool: TurnoTool,
  args: Record<string, unknown>,
): { params: Record<string, unknown> } | { error: string } {
  const { z } = upstream().utils;
  const schema: ZodObject = tool.schema.inputSchema;
  const { _meta: _ignored, ...rest } = args;
  try {
    return { params: schema.parse(rest) };
  } catch (error) {
    if (error instanceof z.ZodError)
      return { error: `Invalid arguments for tool "${tool.schema.name}":\n${z.prettifyError(error)}` };
    throw error;
  }
}
