import { createRequire } from "node:module";
import type { Browser, BrowserContext, Page } from "patchright-core";

/**
 * The parts of the Playwright MCP tool backend in patchright-core that turno-browser uses as a
 * library. They come from the package's own `exports` (`lib/coreBundle`,
 * `lib/utilsBundle`), not from a file path, but they are not documented API: the exact version
 * is pinned and `test/upstream-contract.test.ts` checks every name and signature used here.
 *
 * The types below describe only what turno touches. Everything else stays opaque.
 */

/** Resolved Playwright MCP config (`resolveCLIConfigForMCP`). Only the keys turno reads. */
export interface McpConfig {
  browser: {
    browserName: "chromium" | "firefox" | "webkit";
    isolated?: boolean;
    userDataDir?: string;
    launchOptions: Record<string, unknown> & {
      headless?: boolean;
      channel?: string;
      ignoreDefaultArgs?: boolean | string[];
    };
    contextOptions?: Record<string, unknown>;
    cdpEndpoint?: string;
    remoteEndpoint?: string | ({ endpoint: string; headers?: Record<string, string> } & Record<string, unknown>);
    remoteHeaders?: Record<string, string>;
  };
  extension?: boolean;
  sharedBrowserContext?: boolean;
  capabilities?: string[];
  outputDir?: string;
  skillMode?: boolean;
  timeouts?: { idle?: number; settle?: number };
  /** `snapshot.mode` is read on every call that includes a snapshot (`"full"` or `"none"`). */
  snapshot?: { mode?: string; [key: string]: unknown };
  server: { port?: number; host?: string; allowedHosts?: string[] };
  configFile?: string;
}

/** What the server learns about the client on its first tool call. */
export interface ClientInfo {
  /** First workspace root of the client, or the process cwd. */
  cwd: string;
  clientName: string;
}

/** A tool schema as upstream defines it: `inputSchema` is a zod object of the bundled zod. */
export interface ToolSchema {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodObject;
  type: "input" | "assertion" | "action" | "readOnly";
}

/** The subset of a zod v4 object schema turno calls. */
export interface ZodObject extends ZodType {
  parse(value: unknown): Record<string, unknown>;
  safeParse(value: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: unknown };
}

export interface UpstreamTool {
  capability: string;
  schema: ToolSchema;
  skillOnly?: boolean;
}

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: string; [key: string]: unknown })[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface IdleTimerLike {
  poke(): void;
  dispose(): void;
}

/** One MCP session's view of a browser context: upstream's `BrowserBackend`. */
export interface BrowserBackendInstance {
  initialize(clientInfo: ClientInfo): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  dynamicTools(): ToolSchemaJson[];
  dispose(): Promise<void>;
  on(event: "dynamictoolschange" | "disconnected", listener: () => void): unknown;
  once(event: "disconnected", listener: () => void): unknown;
}

/** One tab of upstream's `Context` (`tab.ts`). */
export interface UpstreamTab {
  page: Page;
  /** The session's `Context`, whose config the tab reads on every call. */
  context: { config: McpConfig };
  /** Open dialogs and file choosers: while one is open the page runs no script. */
  modalStates(): readonly { type: string }[];
  /** Runs an action and waits for what it started (`action-wait.ts` replaces it). */
  waitForCompletion(callback: () => Promise<unknown>): Promise<void>;
  /** Resolves once the tab has read the page's console messages and requests. */
  _initializedPromise: Promise<unknown>;
  /** Runs `action` until it ends or a dialog or file chooser opens. */
  _raceAgainstModalStates(action: () => Promise<unknown>): Promise<unknown>;
}

/** Upstream's per-session `Context` (`context.ts`), which `BrowserBackend` keeps in `_context`. */
export interface UpstreamContext {
  /** Every tab, in the order `browser_tabs` numbers them. */
  tabs(): UpstreamTab[];
  /** The tab the stock tools act on. */
  currentTab(): UpstreamTab | undefined;
  /**
   * Builds the tab list (every page of the browser context, then each new one) on first use.
   * `"sharing": "tabs"` calls it as soon as a session's view exists, so the view knows every tab.
   */
  ensureBrowserContext(): Promise<unknown>;
  /** Opens a page and makes it the current tab (`browser_tabs` action `new`). */
  newTab(): Promise<UpstreamTab>;
  /** Points the stock tools at a tab without bringing it to the front (`"sharing": "tabs"`). */
  _setCurrentTab(tab: UpstreamTab | undefined): void;
  /**
   * What upstream passes every text result, written file and session log line through (its own
   * `secrets` config). The host chains its redactor here, so a file a tool writes is redacted too.
   */
  redactSecrets(text: string): string;
}

/**
 * The tabs of a `BrowserBackend`, for the tab governor: `initialize` builds the
 * `Context` and keeps it in `_context` (pinned by the contract test). Undefined before that.
 */
export function backendContext(backend: BrowserBackendInstance): UpstreamContext | undefined {
  return (backend as unknown as { _context?: UpstreamContext })._context;
}

/** A tool as it goes out in `tools/list`. */
export interface ToolSchemaJson {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

interface BrowserBackendCtor {
  new (
    config: McpConfig,
    browserContext: BrowserContext,
    tools: UpstreamTool[],
    options?: { idleTimer?: IdleTimerLike; dispose?: () => Promise<void> },
  ): BrowserBackendInstance;
}

/** What upstream's `createBrowserWithInfo` returns. */
interface UpstreamBrowserInfo {
  browser: Browser;
  endpoint: string;
  ownership: "own" | "attached";
  idleTimer?: IdleTimerLike;
}

/** The server backend factory upstream's `start` serves (one backend per MCP session). */
export interface ServerBackendFactory {
  name: string;
  nameInConfig: string;
  version: string;
  toolSchemas: ToolSchema[];
  create(clientInfo: ClientInfo): Promise<ServerBackend>;
}

export interface ServerBackend {
  initialize?(clientInfo: ClientInfo): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  dynamicTools?(): ToolSchemaJson[];
  dispose?(): Promise<void>;
  on?(event: "dynamictoolschange", listener: () => void): unknown;
  once(event: "disconnected", listener: () => void): unknown;
}

/** A commander `Command` (the bundled commander), only the calls turno makes. */
interface Command {
  version(text: string): Command;
  name(text: string): Command;
  action(fn: (options: Record<string, unknown>) => Promise<void> | void): Command;
  parseAsync(argv: string[], options: { from: "user" }): Promise<Command>;
}

export interface UpstreamTools {
  BrowserBackend: BrowserBackendCtor;
  browserTools: UpstreamTool[];
  filteredTools(config: McpConfig): UpstreamTool[];
  decorateMCPCommand(command: Command): void;
  resolveCLIConfigForMCP(options: Record<string, unknown>, env?: NodeJS.ProcessEnv): Promise<McpConfig>;
  createBrowserWithInfo(
    config: McpConfig,
    clientInfo: ClientInfo,
    cliOptions: Record<string, unknown>,
    bindOptions: { title: string; workspaceDir: string },
  ): Promise<UpstreamBrowserInfo>;
  setupExitWatchdog(): void;
  start(factory: ServerBackendFactory, options: McpConfig["server"]): Promise<void>;
  isProfileLocked(userDataDir: string): boolean;
  outputDir(options: { config: McpConfig; cwd: string }): string;
}

interface CoreBundle {
  tools: UpstreamTools;
  utils: {
    gracefullyProcessExitDoNotHang(code: number): void;
    /** What upstream's exit watchdog awaits before the process exits (stdin closed, SIGTERM). */
    gracefullyCloseSet: Set<() => Promise<void>>;
  };
}

/** A zod schema of the bundled zod, as far as turno tools build one. */
interface ZodType {
  describe(text: string): ZodType;
  optional(): ZodType;
}

interface ZodArray extends ZodType {
  min(n: number): ZodArray;
  max(n: number): ZodArray;
}

/** The bundled zod v4: the constructors a turno tool uses, and what the host needs. */
export interface Zod {
  object(shape: Record<string, ZodType>): ZodObject;
  string(): ZodType;
  number(): ZodType;
  boolean(): ZodType;
  unknown(): ZodType;
  array(item: ZodType): ZodArray;
  record(key: ZodType, value: ZodType): ZodType;
  union(options: ZodType[]): ZodType;
  toJSONSchema(schema: ZodObject): Record<string, unknown>;
  ZodError: new (...args: never[]) => Error;
  prettifyError(error: unknown): string;
}

interface UtilsBundle {
  program: Command & { constructor: new () => Command };
  z: Zod;
}

interface PackageJson {
  version: string;
}

const require = createRequire(import.meta.url);

let loaded: { core: CoreBundle; utils: UtilsBundle; version: string } | undefined;

/** Loads the library once. `patchright-core` itself first: its entry runs `lib/bootstrap`. */
export function upstream(): { tools: UpstreamTools; core: CoreBundle; utils: UtilsBundle; version: string } {
  if (!loaded) {
    require("patchright-core");
    loaded = {
      core: require("patchright-core/lib/coreBundle") as CoreBundle,
      utils: require("patchright-core/lib/utilsBundle") as UtilsBundle,
      version: (require("patchright-core/package.json") as PackageJson).version,
    };
  }
  return { tools: loaded.core.tools, ...loaded };
}

/** The in-process Playwright object of the same bundle (so upstream's exit hooks see it). */
export function playwright(): Record<McpConfig["browser"]["browserName"], typeof import("patchright-core").chromium> {
  upstream();
  return require("patchright-core") as Record<
    McpConfig["browser"]["browserName"],
    typeof import("patchright-core").chromium
  >;
}

/**
 * A tool schema as it goes out in `tools/list`, built the way upstream's `toMcpTool` builds it
 * (the contract test compares the whole list with the stock program's).
 */
export function toMcpTool(schema: ToolSchema): ToolSchemaJson {
  const readOnly = schema.type === "readOnly" || schema.type === "assertion";
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: upstream().utils.z.toJSONSchema(schema.inputSchema),
    annotations: {
      title: schema.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true,
    },
  };
}
