import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Page } from "patchright-core";
import { type PressureLevel, type PressureProbe, memoryPressureProbe } from "turno-core/memory";
import type { SecretStore } from "turno-core/secrets";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Sampler } from "./act-model.js";
import { refuseWhileBackground } from "./background-state.js";
import { coveredBeforeCall, explainFailure } from "./diagnose.js";
import {
  type Engine,
  type EngineFlags,
  type IdentityRef,
  type LaunchedBrowser,
  createEngine,
  engineChoice,
} from "./engine.js";
import { TabGovernor, type TabView } from "./governor.js";
import {
  type HealthContext,
  NEEDS_AUTH_HOLD_MS,
  healthDue,
  needsAuthMessage,
  readHealth,
  runHealthCheck,
  writeHealth,
} from "./health.js";
import { AgentCursor, CursorInput, cursorTools, resolveCursor } from "./agent-cursor.js";
import { HumanInput, adaptiveSites, humanizeTools } from "./human-input.js";
import { identityStateDir } from "./ids.js";
import { idleMs } from "./idle-timer.js";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  HUMAN_STEP_TOOL,
  type StepParams,
  parseStepCall,
  runStep,
  stepBusyMessage,
  stepRunResult,
  stillWaiting,
  stillWaitingResult,
} from "./human-step.js";
import {
  type LiveFlags,
  describeChanges,
  formatPause,
  pausedWhileRunningNote,
  resolveLive,
  resumeNote,
  timeoutMessage,
  viewRefusal,
} from "./live.js";
import { LiveServer } from "./live-server.js";
import { MemoryWatch } from "./memory.js";
import { names } from "./names.js";
import { NETWORK_TOOLS, redactNetworkText } from "./network-redact.js";
import { type PasskeyNote, type PasskeyPending, PasskeyWatch, installPasskeyProbe } from "./passkey.js";
import {
  type IdentityPolicy,
  blockedMessage,
  disabledTools,
  hostPatterns,
  policyEngineClash,
  policyRefusal,
} from "./policy.js";
import { NavigationGuard } from "./policy-guard.js";
import { FlowRecorder, type PendingStep } from "./recorder.js";
import { Recording, tracesTmpDir } from "./recordings.js";
import { Redactor, SCRIPT_TOOLS, VaultGuard } from "./redact.js";
import { type ChallengeEvent, recordChallenge, watchChallenges } from "./reputation.js";
import { installResources } from "./resources.js";
import {
  type PageField,
  SENSITIVE_MARK,
  TYPING_TOOLS,
  maskSnapshots,
  secretValues,
  sensitiveFields,
  sensitiveRefusal,
  typesIntoSensitive,
} from "./sensitive.js";
import {
  SESSION_CAPABILITY,
  SESSION_ENDED_METHOD,
  SESSION_META_KEY,
  clientFromMeta,
  sessionFromMeta,
} from "./session.js";
import { type SessionView, TabSharing, viewConfig } from "./sharing.js";
import { DEFAULT_TAB_LOCKS, DIRECT_SESSION, type TabLockPolicy } from "./tab-locks.js";
import { type IdentitySettings, readIdentitySettings } from "./settings.js";
import {
  DEFAULT_CAPS,
  type DefaultsContext,
  type EffectiveSettings,
  resolveDefaults,
  systemLocale,
} from "./defaults.js";
import { readDetectedHealth } from "./health-detect.js";
import type { RecordPlan } from "./recordings.js";
import {
  type Providers,
  type StockAccess,
  TURNO_TOOLS,
  type TurnoTool,
  checkTurnoTools,
  optInTools,
  parseArguments,
} from "./tools.js";
import { DEFAULT_STEP_WAIT_MS, type OpenStep, StepTable } from "./step-wait.js";
import { type Tuning, type TuningFlags, resolveTuning } from "./tuning.js";
import { type UiLocale, uiLocale, uiStrings } from "./ui-strings.js";
import { vaultHasSites } from "./vault.js";
import {
  type BrowserBackendInstance,
  type ClientInfo,
  type IdleTimerLike,
  type McpConfig,
  type ServerBackend,
  type ServerBackendFactory,
  type ToolResult,
  type ToolSchemaJson,
  type UpstreamTool,
  type ZodObject,
  backendContext,
  toMcpTool,
  upstream,
} from "./upstream.js";
import { type BrowserWatch, PlainWatch } from "./watch.js";

/**
 * turno-browser as the MCP server host.
 *
 * The command line is parsed by upstream's own option definitions (`decorateMCPCommand`), so
 * every Playwright MCP flag, its help text and its errors stay as they were; only the action
 * is turno's. The config is resolved by upstream (`resolveCLIConfigForMCP`: file, environment,
 * flags). Then, per MCP session, a `SessionBackend`:
 *
 * - lists the stock tools (upstream's `filteredTools`, rendered like upstream renders them),
 *   then the turno tools, then the tools a page registers through WebMCP;
 * - launches the browser on the first call that needs it, through the engine module, and
 *   wraps the context in upstream's `BrowserBackend`, which runs every stock tool;
 * - after the browser closes (idle limit, `browser_close`, a crash) launches it again on the
 *   next call, with the same profile;
 * - runs the tab governor on that browser and wraps each stock call with it: a parked
 *   tab loads again before a call uses it, and what the governor did since the last call is
 *   added to the result; a click or type that fails because of the element gets an error that
 *   says what is in the way (`diagnose.ts`);
 * - gives each browser its own copy of the config, so the identity's `settle` and a batch's
 *   snapshot-free steps change only that session;
 * - with `"sharing": "tabs"`, serves several agent sessions (mcpd's `_meta["io.turno/session"]`)
 *   in that one browser, each with its own backend, current tab and tab locks (`sharing.ts`);
 * - lists the opt-in tools of the identity (natural language actions, captcha solving) only when
 *   identity.json turns them on when the server starts, and hands those tools MCP sampling,
 *   routed to the calling session, when the client offers it;
 * - with the live view on (identity.json `live`, `--live`), holds every browser call while the
 *   user has paused the agent, and tells the held call what changed (`live.ts`, `live-server.ts`);
 *   a person step (`browser_request_human`, `human-step.ts`) holds them the same way, with the live
 *   view or without it (`watch.ts`);
 * - with a policy in identity.json (`policy.ts`), leaves its disabled tools out of the list and
 *   refuses them, checks every main-frame navigation against its allowed hosts
 *   (`policy-guard.ts`), and fails the call that met a blocked one;
 * - masks password and one-time code fields in every page snapshot and hides their values from
 *   every result, whoever typed them, refuses the agent's typing into them (`sensitive.ts`), drops
 *   credential values from network output (`network-redact.ts`), and says when a result ends on
 *   a challenge page (`reputation.ts`).
 *
 * stdio, the transport mcpd and every agent use, is served by turno with the MCP SDK.
 * `--port` keeps upstream's HTTP server (Host check, streamable HTTP and SSE) serving the
 * same session backends.
 */

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string }
).version;

/** The name and version the server reports in `initialize`. */
export const SERVER_INFO = { name: "turno-browser", version: PACKAGE_VERSION };

export interface HostOptions {
  config: McpConfig;
  cliOptions: Record<string, unknown>;
  /** Turno tools of this host (default: `TURNO_TOOLS`). */
  turnoTools?: readonly TurnoTool[];
  /** The engine for every launch, instead of the one the config selects (tests inject a fake). */
  engine?: Engine;
  /** The identity served (`--identity`): its runtime lock, settings, session health and reputation log. */
  identity?: IdentityRef;
  /** The `turno-browser-mcp` tab governor and throttling flags; they win over identity.json. */
  tuning?: TuningFlags;
  /** The secret store the vault reads (tests inject a fake); default: this machine's. */
  vaultStore?: SecretStore;
  /** With `"sharing": "tabs"`: how long a call waits for a held tab, and when an idle session lets go. */
  tabLocks?: Partial<TabLockPolicy>;
  /** `--engine` and `--attach`; they win over identity.json. */
  engineFlags?: EngineFlags;
  /** Stand-ins for the opt-in providers (tests inject fakes). */
  providers?: Providers;
  /** `--live` and `--live-wait`; they win over identity.json `live`. */
  live?: LiveFlags;
  /** Reads the memory pressure for `resources: "auto"` (tests inject one); default: turno-core's. */
  memory?: PressureProbe;
}

export interface Host {
  config: McpConfig;
  /** Stock tools first, in upstream's order, then turno's. */
  listTools(): ToolSchemaJson[];
  factory: ServerBackendFactory;
  /** Hides vault values in a text this server is about to send. */
  redact(text: string): string;
  /** The live view server, when the live view is on for the identity served. */
  live?: LiveServer;
}

/** Tells the client a long call is still at work: MCP progress, when the call asked for it. */
type Progress = (elapsedMs: number, message: string) => void;

/** Upstream joins the text parts of a result into one (`mergeTextParts`). */
export function mergeTextParts(result: ToolResult): ToolResult {
  const content: ToolResult["content"] = [];
  const texts: string[] = [];
  for (const part of result.content) {
    if (part.type === "text") {
      texts.push((part as { text: string }).text);
      continue;
    }
    if (texts.length) {
      content.push({ type: "text", text: texts.join("\n") });
      texts.length = 0;
    }
    content.push(part);
  }
  if (texts.length) content.push({ type: "text", text: texts.join("\n") });
  return { ...result, content };
}

/**
 * Adds what the tab governor did to a stock tool's result: parked tabs are marked in a tab list,
 * and closed or parked tabs are listed in a last section (under `turno.tabs` in JSON). With the
 * low-resource preset, a note when memory runs low follows (under `turno.memory`).
 */
function withGovernor(
  result: ToolResult,
  governor: TabGovernor,
  json: boolean,
  owner?: string,
  view?: TabView,
  memory?: string,
): ToolResult {
  const notes = governor.takeNotes(owner);
  const first = result.content[0];
  if (!first || first.type !== "text") return result;
  let text = governor.annotateTabs((first as { text: string }).text, view);
  if (notes.length || memory) {
    if (json) {
      try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        const turno = { ...(notes.length ? { tabs: notes } : {}), ...(memory ? { memory } : {}) };
        text = JSON.stringify({ ...payload, turno }, null, 2);
      } catch {
        /* not JSON after all: leave it */
      }
    } else {
      if (notes.length) text += `\n### Tab governor\n${notes.map((n) => `- ${n}`).join("\n")}`;
      if (memory) text += `\n### Memory\n- ${memory}`;
    }
  }
  return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}

/** What a step of a batch, a replay or an act run meets once the user pauses the agent. */
const PAUSED_STEP = "The user paused the browser";

/** A held call's result with the resume note first (under `turno.live` in JSON). */
function withNote(result: ToolResult, note: string, json: boolean, key = "live", value: unknown = note): ToolResult {
  const first = result.content[0];
  if (!first || first.type !== "text") return { ...result, content: [{ type: "text", text: note }, ...result.content] };
  const text = (first as { text: string }).text;
  if (json) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const turno = (payload.turno ?? {}) as Record<string, unknown>;
      const out = JSON.stringify({ ...payload, turno: { ...turno, [key]: value } }, null, 2);
      return { ...result, content: [{ ...first, text: out }, ...result.content.slice(1)] };
    } catch {
      /* not JSON after all: put the note first */
    }
  }
  return { ...result, content: [{ ...first, text: `${note}\n\n${text}` }, ...result.content.slice(1)] };
}

function errorResultOf(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorResult(message: string, json: boolean): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}`,
      },
    ],
    isError: true,
  };
}

/** How long a one-time code read from a page stays redacted, as a vault one-time code. */
const FIELD_CODE_MS = 10 * 60_000;
/** Longest a result waits for the challenge check of the page it ended on. */
const CHALLENGE_WAIT_MS = 2_000;

/** A note after the rest of a result (under `turno.<key>` in JSON). */
function withTrailer(result: ToolResult, title: string, note: string, key: string, json: boolean): ToolResult {
  const first = result.content[0];
  if (!first || first.type !== "text")
    return { ...result, content: [...result.content, { type: "text", text: `### ${title}\n${note}` }] };
  const text = (first as { text: string }).text;
  if (json) {
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const turno = (payload.turno ?? {}) as Record<string, unknown>;
      const out = JSON.stringify({ ...payload, turno: { ...turno, [key]: note } }, null, 2);
      return { ...result, content: [{ ...first, text: out }, ...result.content.slice(1)] };
    } catch {
      /* not JSON after all: add a section */
    }
  }
  return { ...result, content: [{ ...first, text: `${text}\n### ${title}\n${note}` }, ...result.content.slice(1)] };
}

/** What the agent reads when the page it ended on is a challenge (`reputation.ts`). */
function challengeNote(event: Omit<ChallengeEvent, "ts">): string {
  const what =
    event.kind === "captcha"
      ? "a captcha"
      : event.kind === "verify"
        ? "a check that asks whether a person is there"
        : "a page that blocks this browser";
  return `This page (${event.site}) shows ${what}. A person should handle it: ask them to (with browser_request_human, if this server offers it), and go on once they are done.`;
}

/** A result's text parts with credentials replaced (`network-redact.ts`). */
function redactNetworkResult(result: ToolResult): ToolResult {
  return {
    ...result,
    content: result.content.map((part) =>
      part.type === "text" ? { ...part, text: redactNetworkText((part as { text: string }).text) } : part,
    ),
  };
}

/**
 * One MCP session. Implements upstream's server backend contract, so upstream's HTTP server
 * can serve it as well as turno's stdio server.
 */
/** A session's running browser, as the host drives it. */
/**
 * The idle limit as a session sees it: it counts from the end of the last tool call and never
 * while one runs. Upstream's `BrowserBackend` pokes the timer at the start of a call only, so a
 * call that took longer than the limit (a slow page, a busy machine, a short `TURNO_BROWSER_IDLE`)
 * had Chrome closed under it and failed with "Target page, context or browser has been closed".
 */
export class CallIdleTimer implements IdleTimerLike {
  private calls = 0;
  constructor(
    private readonly inner: IdleTimerLike,
    /** False once the browser closed: counting again would only close it a second time. */
    private readonly open: () => boolean,
  ) {}

  /** Upstream's poke at the start of a call: ignored while a call holds the timer. */
  poke(): void {
    if (this.calls === 0 && this.open()) this.inner.poke();
  }

  /** Stops the countdown until the returned function runs (once) at the end of the call. */
  begin(): () => void {
    this.calls++;
    this.inner.dispose();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.calls--;
      this.poke();
    };
  }

  dispose(): void {
    this.inner.dispose();
  }
}

interface Running {
  backend: BrowserBackendInstance;
  /** The config this browser's `BrowserBackend` reads on every call (a copy per launch). */
  config: McpConfig;
  launched: LaunchedBrowser;
  governor: TabGovernor;
  tuning: Tuning;
  /** With the low-resource preset: the note for tool results when memory runs low. */
  memory?: MemoryWatch;
  /** The idle limit, held by every call in flight. */
  idle?: CallIdleTimer;
  /** `"sharing": "tabs"`: each session's backend and its tab locks. */
  sharing?: TabSharing;
  /** Traces and screenshots of this browser, when identity.json `record` asks for them. */
  recording?: Recording;
  /** Human-like input, when humanize is on: also types a `browser_login` fill. */
  input?: HumanInput;
  /** The agent cursor, when someone can see the browser (`agent-cursor.ts`). */
  cursor?: AgentCursor;
  /** The language of what the person sees in this browser: the identity's (`ui-strings.ts`). */
  locale: UiLocale;
  /** The policy's domain check, when it has allowedDomains (`policy-guard.ts`). */
  guard?: NavigationGuard;
  /** The passkey prompts of this browser's pages (`passkey.ts`). */
  passkeys?: PasskeyWatch;
  /** The devtools recordings the agent runs in this browser now ("a trace", "a video"). */
  devtools: Set<string>;
}

/** The devtools capability's tools that start and stop a recording, and what each records. */
const DEVTOOLS_START: ReadonlyMap<string, string> = new Map([
  ["browser_start_tracing", "a trace"],
  ["browser_start_video", "a video"],
  ["browser_start_recording", "an action recording"],
]);
const DEVTOOLS_STOP: ReadonlyMap<string, string> = new Map([
  ["browser_stop_tracing", "a trace"],
  ["browser_stop_video", "a video"],
  ["browser_stop_recording", "an action recording"],
]);

class SessionBackend extends EventEmitter implements ServerBackend {
  private clientInfo: ClientInfo | undefined;
  private current: Promise<Running> | undefined;
  /** The backend of the running browser, for the WebMCP tools a page registers. */
  private live: BrowserBackendInstance | undefined;
  private launched: LaunchedBrowser | undefined;
  private disposed = false;
  /** What the last launch records, identity.json `record` and its defaults together. */
  private recordSettings: { flows: boolean } | undefined;
  /** Each client session's flow recorder: a recording belongs to the session that started it. */
  private readonly recorders = new Map<string, FlowRecorder>();
  /** The agent name each client session's calls came with (mcpd, a shared host), for the cursor. */
  private readonly clients = new Map<string, string>();
  /** When the sensitive fields of a page were last read (a snapshot reads them too). */
  private readonly fieldsRead = new WeakMap<Page, number>();
  /** The challenge check of each page's last load, until a result reports it. */
  private readonly challenges = new WeakMap<Page, Promise<Omit<ChallengeEvent, "ts"> | undefined>>();
  /** The pause gate and the tabs of this browser: the live server, or a plain watch without it. */
  private readonly watch: BrowserWatch;
  /** The person step a call waits for in pieces (`step-wait.ts`), with the watch's pause. */
  private readonly steps: StepTable<StepResultOf>;

  constructor(
    private readonly host: {
      config: McpConfig;
      cliOptions: Record<string, unknown>;
      stock: UpstreamTool[];
      stockSchemas: ReadonlyMap<string, ZodObject>;
      turno: Map<string, TurnoTool>;
      engine: Engine;
      identity?: IdentityRef;
      tuning: TuningFlags;
      redactor: Redactor;
      guard: VaultGuard;
      vaultStore?: SecretStore;
      /** Wins over identity.json `tabLocks` (tests); the defaults fill the rest. */
      tabLocks: Partial<TabLockPolicy>;
      stockTypes: ReadonlyMap<string, string>;
      providers?: Providers;
      live?: LiveServer;
      /** identity.json `policy` as the server started (`policy.ts`). */
      policy?: IdentityPolicy;
      /** `--engine` and `--attach`, for the engine the defaults resolve against. */
      engineFlags: EngineFlags;
      /** The memory pressure now, for `resources: "auto"`. */
      pressure: () => Promise<PressureLevel>;
      /** The server's own `--caps`, when given: then it is the whole list. */
      caps?: readonly string[];
    },
    private readonly title: (clientInfo: ClientInfo) => string,
  ) {
    super();
    this.watch = host.live ?? new PlainWatch();
    this.steps = stepTableOf(this.watch);
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this.clientInfo = clientInfo;
  }

  /** The flow recorder of a client session (identities only). */
  private recorderFor(session: string | undefined): FlowRecorder | undefined {
    const identity = this.host.identity;
    if (!identity) return undefined;
    const key = session ?? DIRECT_SESSION;
    let recorder = this.recorders.get(key);
    if (!recorder) {
      recorder = new FlowRecorder(identity, this.host.redactor, () => this.recordSettings?.flows === true);
      this.recorders.set(key, recorder);
    }
    return recorder;
  }

  dynamicTools(): ToolSchemaJson[] {
    return this.live?.dynamicTools() ?? [];
  }

  /** Before `initialize` (a call that skipped it), the process cwd, as upstream falls back to. */
  private info(): ClientInfo {
    return this.clientInfo ?? { cwd: process.cwd(), clientName: "Playwright MCP" };
  }

  /** The browser of this session, launched on first use and again after it closed. */
  private browser(): Promise<Running> {
    if (this.disposed) return Promise.reject(new Error("the session is closed"));
    if (this.current && this.launched && !this.launched.isOpen()) {
      // Closed (idle limit, crash) before Playwright reported it: let it go and launch again.
      const stale = this.current;
      this.current = undefined;
      this.live = undefined;
      this.launched = undefined;
      void stale.then(({ backend }) => backend.dispose()).catch(() => {});
    }
    if (this.current) return this.current;
    const clientInfo = this.info();
    const { config: hostConfig, cliOptions, stock, engine, identity } = this.host;
    const promise = (async (): Promise<Running> => {
      if (identity) {
        // While the identity's background server runs, it alone launches its browser.
        refuseWhileBackground(identity);
        refuseWhileNeedsAuth(identity);
      }
      const settings = identity ? readIdentitySettings(identity.id, identity.env) : undefined;
      const effective = await this.defaults(settings, hostConfig);
      const tuning = resolveTuning(settings, this.host.tuning, effective);
      const locale = uiLocale(settings);
      // The low-resource preset's idle limit, unless the user set one (`resolveTuning`).
      const config =
        tuning.browserIdleMs === undefined
          ? hostConfig
          : { ...hostConfig, timeouts: { ...hostConfig.timeouts, idle: tuning.browserIdleMs } };
      const plan: RecordPlan & { flows: boolean } = {
        flows: effective.record.flows.value === true,
        screenshots: effective.record.screenshots.value === true,
        traces: effective.record.traces.value ?? false,
        ...(settings?.record?.maxSize ? { maxSize: settings.record.maxSize } : {}),
      };
      this.recordSettings = plan;
      const traces = identity && plan.traces;
      const title = this.title(clientInfo);
      const launched = await engine.launch({
        // Playwright writes a trace's raw files to tracesDir as it records: an identity's
        // recording keeps them in its own folder instead of the workspace (`recordings.ts`).
        config: traces
          ? {
              ...config,
              browser: {
                ...config.browser,
                launchOptions: { ...config.browser.launchOptions, tracesDir: tracesTmpDir(identity.id, identity.env) },
              },
            }
          : config,
        clientInfo,
        cliOptions,
        title,
        tuning,
        // Proxy credentials read at launch leave no tool result or saved trace unredacted.
        secret: (value, label) => this.host.redactor.add(value, label),
        ...(identity ? { identity } : {}),
      });
      // The policy the server started with, against the engine a flag or identity.json picked.
      const clash = policyEngineClash(launched.engine, this.host.policy);
      if (clash) {
        await launched.close().catch(() => {});
        throw new Error(clash);
      }
      // Human-like input (`auto` by default): the input tools of this browser run on humanized tabs.
      const input =
        tuning.humanize.level === "off"
          ? undefined
          : new HumanInput(tuning.humanize, {
              ...(identity ? { persona: identity.id, challenged: adaptiveSites(identity.id, identity.env) } : {}),
            });
      // Read mode and attach mode never use the identity's Chrome profile, so the profile's
      // health check, challenge log and resource rules do not apply to them. Camoufox keeps a
      // profile of its own, so they do.
      const profile = launched.engine !== "lightpanda" && launched.engine !== "attach";
      if (identity && profile) {
        try {
          await afterIdentityLaunch(
            identity,
            launched,
            (event) => input?.noteChallenge(event.site),
            (page, found) => this.challenges.set(page, found),
          );
        } catch (error) {
          await launched.close().catch(() => {});
          throw error;
        }
      }
      const { BrowserBackend } = upstream().tools;
      const isCurrent = () => this.current === promise;
      let governor: TabGovernor | undefined;
      let sharing: TabSharing | undefined;
      let recording: Recording | undefined;
      let unbindLive: (() => void) | undefined;
      const gone = () => {
        unbindLive?.();
        governor?.dispose();
        sharing?.dispose();
        if (isCurrent()) {
          this.current = undefined;
          this.live = undefined;
          this.launched = undefined;
        }
      };
      const sessionConfig = configForSession(config, cliOptions, tuning);
      let guard: NavigationGuard | undefined;
      const idle = launched.idleTimer ? new CallIdleTimer(launched.idleTimer, () => launched.isOpen()) : undefined;
      // The agent cursor (on when someone can see this browser): the input tools move it. It wraps
      // the humanized tools, so it is the layer next to the page: humanize's pointer path runs
      // through the cursor's mouse and the arrow follows it step by step.
      const cursor = resolveCursor(tuning.cursor, {
        headless: config.browser?.launchOptions?.headless === true && !launched.userBrowser,
        live: this.host.live !== undefined,
        engine: launched.engine,
      })
        ? new AgentCursor({ title, locale, ...(identity ? { identity: identity.id } : {}) })
        : undefined;
      const humanized = input ? humanizeTools(stock, input) : stock;
      // Every backend of this browser (each session's too, with "sharing": "tabs") runs these tools.
      const tools = cursor ? cursorTools(humanized, new CursorInput(cursor, input !== undefined)) : humanized;
      const backend = new BrowserBackend(sessionConfig, launched.context, tools, {
        ...(idle ? { idleTimer: idle } : {}),
        dispose: async () => {
          gone();
          await recording?.close().catch(() => {});
          await launched.close();
        },
      });
      // Every snapshot of every page masks its password and one-time code fields.
      const masked = new WeakSet<Page>();
      const mask = (page: Page) => {
        if (masked.has(page)) return;
        masked.add(page);
        maskSnapshots(page, (fields) => this.noteFields(page, fields));
      };
      for (const page of launched.context.pages()) mask(page);
      launched.context.on("page", mask);
      try {
        await backend.initialize(clientInfo);
        this.hookUpstream(backend);
        // After upstream's own routes (--allowed-origins, --blocked-origins), so this one runs
        // first and hands every request it does not block or serve on to them.
        if (identity && profile)
          await installResources(
            launched.context,
            tuning.resources,
            join(identityStateDir(identity.id, identity.env), "resource-cache"),
          );
        // Last of the routes, so it runs before every other one (and before the agent's own,
        // which the policy turns off with the network tools).
        const patterns = hostPatterns(this.host.policy);
        if (patterns) guard = await NavigationGuard.install(launched.context, patterns);
        // Never in read or attach mode: the engine refuses traces and screenshots there first.
        const idleLimit = idleMs(sessionConfig);
        if (identity && profile)
          recording = await Recording.open({
            identity,
            settings: plan,
            context: launched.context,
            redactor: this.host.redactor,
            guard: this.host.guard,
            title,
            ...(idleLimit ? { idleMs: idleLimit } : {}),
            beforeSave: async () => {
              await Promise.all(launched.context.pages().map((page) => this.readFields(page)));
            },
          });
      } catch (error) {
        await launched.close();
        throw error;
      }
      if (tuning.sharing === "tabs") {
        const forViews = viewConfig(sessionConfig);
        sharing = new TabSharing({
          context: launched.context,
          root: { backend, config: sessionConfig },
          policy: { ...DEFAULT_TAB_LOCKS, ...tuning.tabLocks, ...this.host.tabLocks },
          createView: async () => {
            const config = viewConfig(forViews);
            const view = new BrowserBackend(config, launched.context, tools, {});
            await view.initialize(clientInfo);
            this.hookUpstream(view);
            return { backend: view, config };
          },
        });
      }
      const shared = sharing;
      governor = new TabGovernor(launched.context, tuning.tabs, {
        current: () => backendContext(backend)?.currentTab()?.page,
        tabs: () =>
          backendContext(backend)
            ?.tabs()
            .map((t) => t.page) ?? [],
        ...(shared
          ? {
              protected: () => shared.protectedPages(),
              owner: (page) => shared.owner(page),
              adopt: (page) => shared.adopt(page),
            }
          : {}),
        ...(launched.userBrowser ? { ownedOnly: true, onOwn: (page) => launched.own?.(page) } : {}),
      });
      governor.start();
      if (launched.userBrowser) {
        // The user's browser: the agent starts in a tab of its own, so its first navigation
        // never replaces one of the user's pages (upstream would pick the first open tab).
        try {
          const tab = await backendContext(backend)?.newTab();
          if (tab) governor.own(tab.page);
        } catch (error) {
          governor.dispose();
          await launched.close();
          throw error;
        }
      }
      // The watch (the live server, or a plain one without the live view) holds this browser
      // during a pause: the user's own, or a person step's.
      {
        const tabs = governor;
        let endIdle: (() => void) | undefined;
        unbindLive = this.watch.bind({
          context: launched.context,
          engine: launched.engine,
          userBrowser: launched.userBrowser === true,
          ...(shared ? { owner: (page) => shared.owner(page) } : {}),
          urlOf: (page) => tabs.parkedUrl(page) ?? page.url(),
          // While the user has the browser, the idle limit does not close it, the tab governor
          // parks and closes nothing (a popup the user opens stays), and no trace records it.
          onPause: async () => {
            tabs.beginCall();
            endIdle = idle?.begin();
            await cursor?.setPaused(launched.context.pages(), true);
            await recording?.pauseForUser();
          },
          onResume: () => {
            endIdle?.();
            endIdle = undefined;
            tabs.endCall();
            void cursor?.setPaused(launched.context.pages(), false);
          },
        });
      }
      const passkeys = await this.watchPasskeys(launched, governor, locale);
      backend.on("dynamictoolschange", () => this.emit("dynamictoolschange"));
      backend.once("disconnected", () => {
        recording?.abandon();
        gone();
        void backend.dispose().catch(() => {});
      });
      if (isCurrent()) {
        this.live = backend;
        this.launched = launched;
      }
      return {
        backend,
        config: sessionConfig,
        launched,
        governor,
        tuning,
        ...(tuning.lowResources ? { memory: new MemoryWatch() } : {}),
        ...(idle ? { idle } : {}),
        ...(sharing ? { sharing } : {}),
        ...(recording ? { recording } : {}),
        ...(input ? { input } : {}),
        ...(cursor ? { cursor } : {}),
        locale,
        ...(guard ? { guard } : {}),
        ...(passkeys ? { passkeys } : {}),
        devtools: new Set<string>(),
      };
    })();
    promise.catch(() => {
      if (this.current === promise) this.current = undefined;
    });
    this.current = promise;
    return promise;
  }

  /**
   * The defaults of this launch (`defaults.ts`): what the context says about the browser about
   * to start, resolved against identity.json and the server's flags.
   */
  private async defaults(settings: IdentitySettings | undefined, config: McpConfig): Promise<EffectiveSettings> {
    const { identity, engineFlags, tuning, live } = this.host;
    let choice = "default";
    try {
      choice = engineChoice(engineFlags, settings).kind;
    } catch {
      /* the engine's launch reports a setting that does not resolve */
    }
    const userArgs = (config.browser.launchOptions.args as string[] | undefined) ?? [];
    const ctx: DefaultsContext = {
      identity: identity !== undefined,
      headless: config.browser.launchOptions.headless === true,
      engine: choice === "default" ? "chrome" : choice,
      pressure: await this.host.pressure().catch(() => "normal" as const),
      ...(this.host.policy ? { policy: this.host.policy } : {}),
      serverUserAgent:
        config.browser.contextOptions?.userAgent !== undefined ||
        config.browser.launchOptions.proxy !== undefined ||
        userArgs.some((a) => a.startsWith("--user-agent") || a.startsWith("--proxy-server")),
      ...(identity ? { systemLocale: cachedSystemLocale() } : {}),
      ...(identity ? optional("detectedHealth", readDetectedHealth(identity.id, identity.env)) : {}),
      ...(this.host.caps ? { caps: this.host.caps } : {}),
    };
    return resolveDefaults(settings, ctx, {
      ...(live ? { live: true } : { live: false }),
      ...(tuning.resources ? { resources: tuning.resources } : {}),
      ...(tuning.humanize ? { humanize: tuning.humanize } : {}),
      ...(tuning.sharing ? { sharing: tuning.sharing } : {}),
      ...(tuning.backgroundThrottling !== undefined ? { backgroundThrottling: tuning.backgroundThrottling } : {}),
    });
  }

  /**
   * `session` is the client session mcpd put in the call's `_meta`. Only turno tools
   * see it; stock tools run exactly as before. Upstream's HTTP server (`--port`) never passes it.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
    sample?: Sampler,
    client?: string,
    progress?: Progress,
  ): Promise<ToolResult> {
    if (client && session) this.clients.set(session, client);
    const started = performance.now();
    const refused = this.refusePolicy(name, args);
    if (refused) return errorResult(refused, !!(args._meta as { json?: boolean } | undefined)?.json);
    let result = await this.callLive(name, args, signal, session, sample, progress);
    if (this.touchesBrowser(name)) {
      const json = !!(args._meta as { json?: boolean } | undefined)?.json;
      result = await this.afterCall(name, args, result, session, started);
      result = await this.afterPolicy(result, session, started, json);
      // After the policy: a call it turns into an error (the passkey page went to a host it does
      // not allow) still says how the passkey prompt went.
      const notes = (await this.current?.catch(() => undefined))?.passkeys?.takeNotes() ?? [];
      result = withPasskeyNotes(result, notes, json);
    }
    // Every result and error of this server leaves through the redactor.
    return this.host.redactor.result(result);
  }

  /** Why the identity's policy refuses this call before it runs (`policy.ts`), or undefined. */
  private refusePolicy(name: string, args: Record<string, unknown>): string | undefined {
    const { policy, identity } = this.host;
    if (!policy || !identity) return undefined;
    return policyRefusal({ id: identity.id, policy, cwd: this.info().cwd, env: identity.env }, name, args);
  }

  /**
   * After a browser call: a navigation the domain check stopped during the call makes the call
   * an error that names the host and the allowed list; one that happened between calls (a page's
   * own timer) is told in a last section of this result.
   */
  private async afterPolicy(
    result: ToolResult,
    session: string | undefined,
    started: number,
    json: boolean,
  ): Promise<ToolResult> {
    const running = await this.current?.catch(() => undefined);
    const guard = running?.guard;
    const { policy, identity } = this.host;
    if (!guard || !policy || !identity) return result;
    await guard.settled();
    const seen = guard.take();
    if (!seen.length) return result;
    const targets = [...new Set(seen.map((v) => v.target))].join(", ");
    const page = await this.currentPageOf(session ?? DIRECT_SESSION);
    const where = page ? ` The tab is on ${page.url()} now.` : "";
    const message = `${blockedMessage(identity.id, targets, policy)}${where}`;
    if (seen.some((v) => v.at >= started)) return errorResult(message, json);
    return withTrailer(result, "Policy", `Before this call: ${message}`, "policy", json);
  }

  /**
   * After a browser call, before the redactor: the sensitive fields of the tab it ended on are
   * read unless a snapshot of the call read them (the values join the redactor, whoever typed
   * them), credentials leave a network tool's output, and a challenge page is pointed out.
   */
  private async afterCall(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    session: string | undefined,
    started: number,
  ): Promise<ToolResult> {
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    const page = await this.currentPageOf(session ?? DIRECT_SESSION);
    if (NETWORK_TOOLS.has(name)) result = redactNetworkResult(result);
    if (!page) return result;
    if ((this.fieldsRead.get(page) ?? -1) < started) await this.readFields(page);
    const check = this.challenges.get(page);
    if (!check) return result;
    this.challenges.delete(page);
    let timer: NodeJS.Timeout | undefined;
    const event = await Promise.race([
      check,
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), CHALLENGE_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    return event ? withTrailer(result, "Challenge", challengeNote(event), "challenge", json) : result;
  }

  /** Values of a page's sensitive fields join the redactor, shown as `[sensitive field]`. */
  private noteFields(page: Page, fields: readonly PageField[]): void {
    this.fieldsRead.set(page, performance.now());
    for (const f of fields)
      this.host.redactor.addField(f.value, SENSITIVE_MARK, f.kind === "one-time code" ? FIELD_CODE_MS : undefined);
  }

  private async readFields(page: Page): Promise<void> {
    if (page.isClosed()) return;
    this.noteFields(page, await sensitiveFields(page).catch(() => []));
  }

  /**
   * Chains the redactor into upstream's own (`redactSecrets`), which every text result, written
   * file (a snapshot or a network request saved with `filename`) and session log line passes
   * through, and, while a network tool runs, the credential rules of `network-redact.ts`.
   */
  private hookUpstream(backend: BrowserBackendInstance): void {
    const context = backendContext(backend);
    if (!context || typeof context.redactSecrets !== "function") return;
    const own = context.redactSecrets.bind(context);
    let network = 0;
    context.redactSecrets = (text) => this.host.redactor.text(network ? redactNetworkText(own(text)) : own(text));
    const call = backend.callTool.bind(backend);
    backend.callTool = async (name, args, signal) => {
      const counted = NETWORK_TOOLS.has(name);
      if (counted) network++;
      try {
        return await call(name, args, signal);
      } finally {
        if (counted) network--;
      }
    };
  }

  /**
   * Typing into a password or one-time code field is the person's or the vault's: the call is
   * refused, unless the text was read from the secret store (a flow replay's `keychain:` value).
   */
  private async refuseSensitive(
    name: string,
    args: Record<string, unknown>,
    page: Page | undefined,
    options: { fromSecretStore?: boolean },
  ): Promise<string | undefined> {
    if (!page || options.fromSecretStore || !TYPING_TOOLS.has(name)) return undefined;
    const kind = await typesIntoSensitive(page, name, args).catch(() => undefined);
    return kind ? sensitiveRefusal(name, kind) : undefined;
  }

  /** True when a call needs the browser, so a pause holds it. */
  private touchesBrowser(name: string): boolean {
    const tool = this.host.turno.get(name);
    return tool ? tool.browser !== false : true;
  }

  /**
   * A call through the pause gate (`live.ts`): it runs at once unless the user paused the agent
   * (the live view) or a person step holds the browser; then it waits, and on resume it runs, or
   * returns an error with a fresh snapshot when the browser changed and the call does more than
   * read. A person step itself is not counted as a call in flight: it waits for those.
   *
   * A browser call's result also says how a page's passkey prompt went (`passkey.ts`), once: the
   * call that was running when the prompt started waits for the person's step to end first.
   */
  private async callLive(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    session: string | undefined,
    sample?: Sampler,
    progress?: Progress,
  ): Promise<ToolResult> {
    if (!this.touchesBrowser(name)) return await this.callAny(name, args, signal, session, sample, progress);
    return await this.callGated(name, args, signal, session, sample, progress);
  }

  private async callGated(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    session: string | undefined,
    sample?: Sampler,
    progress?: Progress,
  ): Promise<ToolResult> {
    const watch = this.watch;
    const step = name === HUMAN_STEP_TOOL;
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    const key = session ?? DIRECT_SESSION;
    // A step call while a step is open (to wait for it, or to be told one is open) is not held
    // behind the step it is about.
    if (step && (this.steps.running || (args.continue !== undefined && args.continue !== false)))
      return await this.callAny(name, args, signal, session, sample, progress);
    const outcome = await watch.gate.wait(watch.waitMs, signal);
    if (outcome.kind === "timeout")
      return errorResult(
        timeoutMessage(this.host.identity?.id ?? "", name, outcome.pausedMs, outcome.by, watch.waitMs),
        json,
      );
    if (outcome.kind === "aborted") return errorResult(`${name} was cancelled while the user had the browser`, json);
    const end = step ? () => {} : watch.begin();
    try {
      if (outcome.kind === "open") {
        const result = await this.callAny(name, args, signal, session, sample, progress);
        const passkey = step ? undefined : (await this.current?.catch(() => undefined))?.passkeys?.running;
        const open = passkey ? this.steps.running : undefined;
        if (open) {
          // Done first: the person's step waits for the calls in flight before it shows its banner.
          end();
          // As a step call waits: one piece, then the agent continues with browser_request_human.
          const waited = await this.steps.wait(open, DEFAULT_STEP_WAIT_MS, {
            ...(signal ? { signal } : {}),
            ...(progress ? { progress: stepProgress(progress) } : {}),
          });
          if (waited.kind === "ended") return result;
          const { text, data } = stillWaiting(open, waited.elapsedMs);
          return withNote(result, text, json, "step", json ? data : text);
        }
        const paused = watch.gate.paused;
        if (!paused || step) return result;
        return withNote(result, pausedWhileRunningNote(paused.step), json);
      }
      const beforePage = watch.lastPage(key);
      const afterPage = beforePage ? await this.currentPageOf(key) : undefined;
      const after = await watch.tabStates();
      const { changed, lines } = describeChanges(
        outcome.before,
        after,
        beforePage ? watch.idOf(beforePage) : undefined,
        afterPage ? watch.idOf(afterPage) : undefined,
        outcome.inputs,
      );
      const note = {
        pausedMs: outcome.pausedMs,
        by: outcome.by,
        step: outcome.step,
        lines,
        tool: name,
        recordingFlow: this.recorderFor(session)?.recording !== undefined,
      };
      if (!changed || this.readsOnly(name)) {
        const result = await this.callAny(name, args, signal, session, sample, progress);
        return withNote(result, resumeNote({ ...note, ran: true }), json);
      }
      // A call that was not run is an error, so a client that reads only the outcome (a script,
      // turno browser do) does not take it for done.
      const notRun = `### Error\n${name} was not run: ${outcome.step ? "the person" : "the user"} changed the browser while you waited (below).`;
      if (!this.launched?.isOpen()) {
        const text = `${notRun}\n\n${resumeNote({ ...note, ran: false, noBrowser: true })}`;
        return errorResultOf(json ? JSON.stringify({ isError: true, error: text }, null, 2) : text);
      }
      const snapshot = await this.callAny("browser_snapshot", {}, signal, session);
      const noted = withNote(snapshot, resumeNote({ ...note, ran: false }), json);
      return { ...(json ? noted : withNote(noted, notRun, false)), isError: true };
    } finally {
      end();
    }
  }

  /** True for a call that changes nothing on the page (a snapshot, the tab list, `browser_extract`). */
  private readsOnly(name: string): boolean {
    return (this.host.stockTypes.get(name) ?? this.host.turno.get(name)?.schema.type) === "readOnly";
  }

  /** The tab a session's backend calls current now, without starting anything. */
  private async currentPageOf(key: string): Promise<Page | undefined> {
    const running = await this.current?.catch(() => undefined);
    if (!running || !running.launched.isOpen()) return undefined;
    if (!running.sharing) return backendContext(running.backend)?.currentTab()?.page;
    const view = await running.sharing.view(key).catch(() => undefined);
    return view ? running.sharing.tabView(view).current() : undefined;
  }

  private async callAny(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    session?: string,
    sample?: Sampler,
    progress?: Progress,
  ): Promise<ToolResult> {
    const tool = this.host.turno.get(name);
    if (!tool) return await this.callStock(name, args, signal, {}, session);
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    // A batch is refused up front when one of its steps would be, before the browser launches.
    const steps =
      name === "browser_batch" && Array.isArray(args.actions)
        ? (args.actions as { tool?: unknown; args?: unknown }[])
        : [];
    for (const step of [{ tool: name, args: {} }, ...steps]) {
      if (typeof step?.tool !== "string") continue;
      const stepArgs =
        typeof step.args === "object" && step.args !== null ? (step.args as Record<string, unknown>) : {};
      const refusal =
        this.host.engine.refuse?.(step.tool, this.host.identity) ?? this.refusePolicy(step.tool, stepArgs);
      if (refusal) return errorResult(refusal, json);
    }
    const parsed = parseArguments(tool, args);
    if ("error" in parsed) return errorResult(parsed.error, json);
    const clientInfo = this.info();
    let browserContext: LaunchedBrowser["context"] | undefined;
    let stock: StockAccess | undefined;
    let endCall: (() => void) | undefined;
    let shared: { sharing: TabSharing; view: SessionView; key: string } | undefined;
    let recording: Recording | undefined;
    let engine: string | undefined;
    let input: HumanInput | undefined;
    let human: ((params: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    let devtools: (() => string | undefined) | undefined;
    if (tool.browser !== false) {
      const running = await this.browser();
      devtools = () => [...running.devtools][0];
      engine = running.launched.engine;
      input = running.input;
      endCall = running.idle?.begin();
      browserContext = running.launched.context;
      let view: SessionView = { backend: running.backend, config: running.config };
      if (running.sharing) {
        // The tool works in the session's own tab, locked like a stock call's.
        const key = session ?? DIRECT_SESSION;
        running.sharing.locks.begin(key, name);
        try {
          view = await running.sharing.view(key);
          const refused = await running.sharing.before(key, name, {}, view, signal);
          if (refused) {
            running.sharing.locks.end(key);
            endCall?.();
            return errorResult(refused, json);
          }
        } catch (error) {
          running.sharing.locks.end(key);
          endCall?.();
          throw error;
        }
        shared = { sharing: running.sharing, view, key };
      }
      stock = this.stockAccess(view, signal, session);
      recording = running.recording;
      if (name === HUMAN_STEP_TOOL) {
        const access = stock;
        human = (params) => this.requestHuman(running, access, params, json, session, signal, progress);
      }
    }
    const recorder = this.recorderFor(session);
    const secretHook = this.secretHook(recording);
    try {
      await recording?.beforeCall();
      const context = {
        config: this.host.config,
        clientInfo,
        ...(browserContext ? { browserContext } : {}),
        ...(stock ? { stock } : {}),
        ...(signal ? { signal } : {}),
        ...(session ? { session } : {}),
        ...(recorder ? { recorder } : {}),
        ...(secretHook ? { recording: { pauseForSecret: secretHook } } : {}),
        ...(sample ? { sample } : {}),
        ...(engine ? { engine } : {}),
        ...(this.host.providers ? { providers: this.host.providers } : {}),
        ...(human ? { human } : {}),
        ...(this.host.identity
          ? {
              vault: {
                identity: this.host.identity,
                redactor: this.host.redactor,
                guard: this.host.guard,
                ...(this.host.vaultStore ? { store: this.host.vaultStore } : {}),
                ...(secretHook ? { beforeFill: (page: Page) => secretHook(page) } : {}),
                ...(input ? { input } : {}),
                ...(this.host.policy ? { policy: this.host.policy } : {}),
                ...(devtools ? { devtools } : {}),
              },
            }
          : {}),
      };
      const result = await tool.handle(context, parsed.params);
      if (stock) this.watch.follow(session ?? DIRECT_SESSION, stock.currentPage());
      if (name === "browser_login") {
        if (!result.isError) recorder?.record("browser_login", { site: parsed.params.site });
        await recording?.afterStep({ tool: name, ok: !result.isError, screenshot: false });
      }
      return result;
    } catch (error) {
      return errorResult(String(error), json);
    } finally {
      recording?.callEnded();
      if (shared) {
        shared.sharing.after(shared.key, shared.view);
        shared.sharing.locks.end(shared.key);
      }
      endCall?.();
    }
  }

  /**
   * A stock tool through upstream's `BrowserBackend`, wrapped by the tab governor: a parked tab
   * the call is about to use loads again first, and with `backgroundThrottling` the current tab
   * comes to the front (a tab in the background would not render, and an action on it would
   * wait for its timeout).
   */
  private async callStock(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options: { snapshot?: boolean; fromSecretStore?: boolean } = {},
    session?: string,
  ): Promise<ToolResult> {
    // A batch, a replay or an act run calls stock tools here: the policy checks each step.
    const refusal = this.host.engine.refuse?.(name, this.host.identity) ?? this.refusePolicy(name, args);
    if (refusal) return errorResult(refusal, !!(args._meta as { json?: boolean } | undefined)?.json);
    const running = await this.browser();
    const { governor, tuning, idle, sharing, launched } = running;
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    if (sharing) return await this.callShared(running, sharing, session ?? DIRECT_SESSION, name, args, signal, options);
    const endCall = idle?.begin();
    const { backend, config } = running;
    const refused = this.refuseScript(name, backend);
    if (refused) {
      endCall?.();
      return errorResult(refused, json);
    }
    const snapshot = config.snapshot ?? {};
    const mode = snapshot.mode;
    if (options.snapshot === false) config.snapshot = { ...snapshot, mode: "none" };
    governor.beginCall();
    let result: ToolResult;
    try {
      await governor.quiet();
      // A parked tab loads again first, so the field a call would type into is the one it reaches.
      await governor.prepare(name, args);
      const refusedField = await this.refuseSensitive(name, args, backendContext(backend)?.currentTab()?.page, options);
      if (refusedField) result = errorResult(refusedField, json);
      else {
        const pending = await this.beforeStock(
          running,
          session,
          name,
          args,
          backendContext(backend)?.currentTab()?.page,
        );
        if (tuning.backgroundThrottling && !launched.userBrowser && name !== "browser_tabs")
          await backendContext(backend)
            ?.currentTab()
            ?.page.bringToFront()
            .catch(() => {});
        const page = backendContext(backend)?.currentTab()?.page;
        const key = session ?? DIRECT_SESSION;
        await running.cursor?.begin(page, key, this.clients.get(key));
        result =
          (launched.engine === "lightpanda" ? undefined : await coveredBeforeCall(page, name, args, json)) ??
          (await this.withCursor(running, name, page, () => backend.callTool(name, args, signal)));
        void running.cursor?.end(backendContext(backend)?.currentTab()?.page, key);
        this.watch.follow(key, backendContext(backend)?.currentTab()?.page);
        if (result.isError)
          result = await explainFailure(backendContext(backend)?.currentTab()?.page, name, args, result, json);
        await this.afterStock(
          running,
          session,
          name,
          args,
          pending,
          result,
          backendContext(backend)?.currentTab()?.page,
        );
        await governor.afterCall();
      }
    } finally {
      running.recording?.callEnded();
      endCall?.();
      governor.endCall();
      if (options.snapshot === false) config.snapshot = { ...snapshot, ...(mode === undefined ? {} : { mode }) };
    }
    return withGovernor(result, governor, json, undefined, undefined, running.memory?.take());
  }

  /**
   * A stock call with `"sharing": "tabs"`: the same steps as `callStock`, on the session's own
   * backend, after its tab is locked (`sharing.ts`). `browser_close` closes only its tabs.
   */
  private async callShared(
    running: Running,
    sharing: TabSharing,
    key: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    options: { snapshot?: boolean; fromSecretStore?: boolean },
  ): Promise<ToolResult> {
    const { governor, tuning, idle } = running;
    const json = !!(args._meta as { json?: boolean } | undefined)?.json;
    // Counted first, so the session is active (and its backend kept) from the first await on.
    sharing.locks.begin(key, name);
    const endCall = idle?.begin();
    governor.beginCall();
    let view: SessionView | undefined;
    let result: ToolResult;
    let restore: (() => void) | undefined;
    try {
      await governor.quiet();
      view = await sharing.view(key);
      const { backend, config } = view;
      const refused = name === "browser_close" ? undefined : await sharing.before(key, name, args, view, signal);
      if (refused) result = errorResult(refused, json);
      else if (name === "browser_close") result = await sharing.close(key);
      else {
        const why = this.refuseScript(name, backend);
        if (why) result = errorResult(why, json);
        else {
          const snapshot = config.snapshot ?? {};
          const mode = snapshot.mode;
          if (options.snapshot === false) {
            config.snapshot = { ...snapshot, mode: "none" };
            restore = () => {
              config.snapshot = { ...snapshot, ...(mode === undefined ? {} : { mode }) };
            };
          }
          const tabs = sharing.tabView(view);
          await governor.prepare(name, args, tabs);
          const refusedField = await this.refuseSensitive(name, args, tabs.current(), options);
          if (refusedField) result = errorResult(refusedField, json);
          else {
            const pending = await this.beforeStock(running, key, name, args, tabs.current());
            if (tuning.backgroundThrottling && name !== "browser_tabs")
              await tabs
                .current()
                ?.bringToFront()
                .catch(() => {});
            await running.cursor?.begin(tabs.current(), key, this.clients.get(key));
            result =
              (running.launched.engine === "lightpanda"
                ? undefined
                : await coveredBeforeCall(tabs.current(), name, args, json)) ??
              (await this.withCursor(running, name, tabs.current(), () => backend.callTool(name, args, signal)));
            void running.cursor?.end(tabs.current(), key);
            this.watch.follow(key, tabs.current());
            if (result.isError) result = await explainFailure(tabs.current(), name, args, result, json);
            await this.afterStock(running, key, name, args, pending, result, tabs.current());
            // The tab the call left current is the session's before the cap counts its tabs.
            sharing.after(key, view);
            await governor.afterCall();
          }
        }
      }
    } finally {
      running.recording?.callEnded();
      if (view && name !== "browser_close") sharing.after(key, view);
      sharing.locks.end(key);
      endCall?.();
      governor.endCall(view ? sharing.tabView(view) : undefined);
      restore?.();
    }
    if (!view || name === "browser_close") return result;
    const tabs = sharing.tabView(view);
    const annotated = withGovernor(result, governor, json, key, tabs, running.memory?.take());
    const first = annotated.content[0];
    if (!first || first.type !== "text") return annotated;
    const text = sharing.annotate((first as { text: string }).text, key, view);
    return { ...annotated, content: [{ ...first, text }, ...annotated.content.slice(1)] };
  }

  /** A stock call, with the agent cursor hidden while it takes the model's screenshot. */
  private async withCursor(
    running: Running,
    name: string,
    page: Page | undefined,
    call: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (!running.cursor || name !== "browser_take_screenshot") return await call();
    return await running.cursor.hiddenDuring(page, call);
  }

  /**
   * Before a stock call: the flow step it may become (`recorder.ts`), and a trace stopped and
   * saved before a value goes into a secret field, as before a vault fill (`recordings.ts`).
   */
  private async beforeStock(
    running: Running,
    session: string | undefined,
    name: string,
    args: Record<string, unknown>,
    page: Page | undefined,
  ): Promise<PendingStep | undefined> {
    const { recording } = running;
    // The agent's own trace or video and turno's trace use the same Playwright tracer.
    const starts = DEVTOOLS_START.get(name);
    if (starts) await recording?.yieldToDevtools(starts);
    await recording?.beforeCall();
    // While a trace records, a value the person typed since the last call is known before it is traced.
    if (recording && page) await this.readFields(page);
    const recorder = this.recorderFor(session);
    const pending = recorder?.active ? await recorder.capture(name, args, page).catch(() => undefined) : undefined;
    const secretHook = this.secretHook(recording);
    if (secretHook && page && (name === "browser_type" || name === "browser_fill_form")) {
      const secrets = await secretValues(page, name, args);
      if (secrets.length) {
        for (const v of secrets) this.host.redactor.add(v, "sensitive value");
        await secretHook(page);
      }
    }
    return pending;
  }

  /**
   * What runs before a secret goes into a page (a vault fill, a password typed, a sensitive
   * parameter of a replay), when something could show it: the page is held by the vault guard,
   * the live view stops showing it, and a recording saves its trace. Undefined when neither a
   * recording nor the live view is on.
   */
  private secretHook(recording: Recording | undefined): ((page: Page | undefined) => Promise<void>) | undefined {
    const live = this.host.live;
    if (!recording && !live) return undefined;
    return async (page) => {
      if (page) {
        this.host.guard.mark(page);
        live?.hide(page);
      }
      await recording?.pauseForSecret(page);
    };
  }

  /** After a stock call: keep the flow step when it worked, and the recording's screenshot. */
  private async afterStock(
    running: Running,
    session: string | undefined,
    name: string,
    args: Record<string, unknown>,
    pending: PendingStep | undefined,
    result: ToolResult,
    page: Page | undefined,
  ): Promise<void> {
    if (pending && !result.isError) this.recorderFor(session)?.commit(pending);
    const starts = DEVTOOLS_START.get(name);
    const stops = DEVTOOLS_STOP.get(name);
    if (starts && !result.isError) running.devtools.add(starts);
    if (starts && result.isError) running.recording?.devtoolsDone(starts);
    if (stops && !result.isError) {
      running.devtools.delete(stops);
      running.recording?.devtoolsDone(stops);
    }
    const type = this.host.stockTypes.get(name);
    if (running.recording && type !== "readOnly" && type !== "assertion")
      await running.recording.afterStep({
        tool: name,
        element: args.element ?? args.startElement,
        ok: !result.isError,
        ...(page ? { page } : {}),
        screenshot: true,
      });
  }

  /**
   * Passkey prompts of this browser's pages (`passkey.ts`): a modal one hands the browser to the
   * person until it settles, when they can see Chrome's own window (headed, or attach mode, where
   * only the agent's tabs count). The probe goes in only when someone can see the browser, the rule
   * of the agent cursor's `auto`: a headless Chrome with no live view could hand no step to anyone,
   * so it gets no script at all. With the live view on, a headless Chrome still cannot show Chrome's
   * passkey window (the view shows only the page), so it tells the agent. Read mode and Camoufox are
   * left out: Lightpanda has no WebAuthn, and the probe is checked on Chrome only.
   */
  private async watchPasskeys(
    launched: LaunchedBrowser,
    governor: TabGovernor,
    locale: UiLocale,
  ): Promise<PasskeyWatch | undefined> {
    if (launched.engine === "lightpanda" || launched.engine === "camoufox") return undefined;
    const headless = this.host.config.browser?.launchOptions?.headless === true && !launched.userBrowser;
    if (!resolveCursor("auto", { headless, live: this.host.live !== undefined, engine: launched.engine }))
      return undefined;
    const agents = (page: Page) => !launched.userBrowser || governor.governs(page);
    const strings = uiStrings(locale).passkey;
    let pending: PasskeyPending | undefined;
    const passkeys = new PasskeyWatch({
      pending: async (frame, id) => (pending ? await pending(frame, id) : true),
      // Its step waits in pieces like browser_request_human's, and `continue` reaches it.
      opened: (done) => {
        this.steps.open(
          { by: "a passkey prompt", instruction: strings.instruction, timeoutMs: DEFAULT_STEP_TIMEOUT_MS },
          done.then(() => passkeyStepResult),
        );
      },
      unseen: () => (headless ? passkeyUnseenReason(this.host.identity?.id) : undefined),
      paused: () => this.watch.gate.paused !== undefined,
      handoff: async (page, settle) =>
        await runStep(
          {
            instruction: strings.instruction,
            urlChanges: false,
            done: true,
            timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
            requireHumanClick: false,
          },
          {
            page,
            watch: this.watch,
            guard: this.host.guard,
            by: "a passkey prompt",
            settle,
            locale,
            banner: { title: strings.title, hint: strings.hint },
            window: !headless && !launched.userBrowser,
            json: false,
            currentPage: () => (page.isClosed() ? undefined : page),
          },
        ),
    });
    try {
      pending = await installPasskeyProbe(
        launched.context,
        (report, page, frame) => {
          if (agents(page)) passkeys.report(report, page, frame);
        },
        agents,
      );
    } catch {
      // A browser the probe cannot go into still works; its passkey prompts are just not seen.
      return undefined;
    }
    return passkeys;
  }

  /**
   * A person step on the session's current tab (`human-step.ts`). The person must be able to see
   * the browser: a Chrome window (headed, or attach mode), or the live view open on a headless one.
   */
  private async requestHuman(
    running: Running,
    stock: StockAccess,
    raw: Record<string, unknown>,
    json: boolean,
    session: string | undefined,
    signal: AbortSignal | undefined,
    progress: Progress | undefined,
  ): Promise<ToolResult> {
    const parsed = parseStepCall(raw);
    if ("error" in parsed) return errorResult(parsed.error, json);
    // A cancelled call (the agent stopped) ends the step: nobody is left to wait for it.
    const wait = async (step: OpenStep<StepResultOf>) => {
      const waited = await this.steps.wait(step, parsed.waitMs, {
        cancelOnAbort: true,
        ...(signal ? { signal } : {}),
        ...(progress ? { progress: stepProgress(progress) } : {}),
      });
      return waited.kind === "ended" ? waited.result(json) : stillWaitingResult(step, waited.elapsedMs, json);
    };
    if (parsed.kind === "continue") {
      const step = this.steps.find(parsed.step);
      if (!step)
        return errorResult(
          parsed.step === true
            ? "no person step is open (a call already returned how the last one ended)"
            : `no person step ${parsed.step} is open (it may have ended, and a call returned how)`,
          json,
        );
      return await wait(step);
    }
    const busy = this.steps.running;
    if (busy) return errorResult(stepBusyMessage(busy, Date.now() - busy.began), json);
    const { params } = parsed;
    const page = stock.currentPage();
    if (!page) return errorResult("no page is open; navigate to the page of the step first", json);
    const { launched } = running;
    const headless = this.host.config.browser?.launchOptions?.headless === true && !launched.userBrowser;
    const unseen = headless ? unseenReason(this.host.live, this.host.identity?.id) : undefined;
    // The step runs on its own: a call that stops waiting leaves it up for the next one.
    const stop = new AbortController();
    const run = runStep(params, {
      page,
      watch: this.watch,
      guard: this.host.guard,
      session: session ?? DIRECT_SESSION,
      ...(unseen ? { unseen } : {}),
      window: !headless && !launched.userBrowser,
      json,
      signal: stop.signal,
      currentPage: () => stock.currentPage(),
      locale: running.locale,
    });
    const step = this.steps.open(
      { by: HUMAN_STEP_TOOL, instruction: params.instruction, timeoutMs: params.timeoutMs },
      settledStep(params, run),
      () => stop.abort(),
    );
    if ("busy" in step) return errorResult(stepBusyMessage(step.busy, Date.now() - step.busy.began), json);
    return await wait(step);
  }

  /**
   * The script tools near the vault: `browser_evaluate` and `browser_run_code_unsafe`
   * are refused on a page browser_login filled, until it navigates; `browser_run_code_unsafe`
   * runs code in this process, which can read the secret store, so it is refused for an
   * identity that has vault credentials at all.
   */
  private refuseScript(name: string, backend: BrowserBackendInstance): string | undefined {
    if (!SCRIPT_TOOLS.has(name)) return undefined;
    const identity = this.host.identity;
    if (name === "browser_run_code_unsafe" && identity && vaultHasSites(identity.id, identity.env)) {
      return `${name} is refused for browser identity "${identity.id}" because it has vault credentials: it runs code in the server process, which can read the secret store. Use the other browser tools, or an identity without a vault.`;
    }
    if (this.host.guard.holds(backendContext(backend)?.currentTab()?.page)) {
      return `${name} is refused on this page: it holds values browser_login filled from the vault (or a password typed while recording or with the live view on). Submit the form or navigate away first.`;
    }
    return undefined;
  }

  /** The stock tools of this session, for a turno tool that runs them (`browser_batch`). */
  private stockAccess(view: SessionView, signal?: AbortSignal, session?: string): StockAccess {
    return {
      schemas: this.host.stockSchemas,
      formatError: (error) => upstream().utils.z.prettifyError(error),
      // A batch, a replay or an act run stops at its next step once the user pauses the agent.
      call: (name, args, options) =>
        this.watch.paused
          ? Promise.resolve(
              errorResult(
                `${PAUSED_STEP}: this step and the ones after it were not run. Your next call waits until they resume.`,
                !!(args._meta as { json?: boolean } | undefined)?.json,
              ),
            )
          : this.callStock(name, args, signal, options, session),
      held: () => (this.watch.paused ? PAUSED_STEP : undefined),
      page: async () => {
        const page = backendContext(view.backend)?.currentTab()?.page;
        if (!page) return undefined;
        return { url: page.url(), title: await page.title().catch(() => "") };
      },
      currentPage: () => backendContext(view.backend)?.currentTab()?.page,
    };
  }

  /** mcpd said a client session ended: with `"sharing": "tabs"` its tabs are free at once. */
  async endSession(session: string): Promise<void> {
    // A flow the session was recording and never stopped is dropped with it.
    this.recorders.get(session)?.cancel();
    this.recorders.delete(session);
    this.clients.delete(session);
    const current = this.current;
    if (!current) return;
    const running = await current.catch(() => undefined);
    await running?.sharing?.endSession(session);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const current = this.current;
    this.current = undefined;
    this.live = undefined;
    this.launched = undefined;
    if (current) await current.then(({ backend }) => backend.dispose()).catch(() => {});
  }
}

/**
 * The config of one launch: a copy, so a change for this session (a batch's snapshot-free
 * steps) does not reach another, with the identity's `settle` unless the user set
 * Playwright's own `--timeout-settle`, `PLAYWRIGHT_MCP_TIMEOUT_SETTLE` or `timeouts.settle` in a
 * config file, which win.
 */
export function configForSession(config: McpConfig, cliOptions: Record<string, unknown>, tuning: Tuning): McpConfig {
  const timeouts = { ...config.timeouts };
  if (tuning.settleMs !== undefined && !userSetSettle(config, cliOptions)) timeouts.settle = tuning.settleMs;
  return { ...config, timeouts, snapshot: { ...config.snapshot } };
}

function userSetSettle(config: McpConfig, cliOptions: Record<string, unknown>): boolean {
  if (cliOptions.timeoutSettle !== undefined) return true;
  if (!config.configFile) return false;
  try {
    const file = JSON.parse(readFileSync(resolve(config.configFile), "utf8")) as { timeouts?: { settle?: unknown } };
    return file.timeouts?.settle !== undefined;
  } catch {
    return false;
  }
}

/** After NEEDS_AUTH, fail at once for a short while instead of opening Chrome on every call. */
function refuseWhileNeedsAuth(identity: IdentityRef): void {
  const health = readIdentitySettings(identity.id, identity.env)?.health;
  const last = readHealth(identity.id, identity.env);
  if (
    health &&
    last?.status === "needs_auth" &&
    last.url === health.url &&
    Date.now() - Date.parse(last.checkedAt) < NEEDS_AUTH_HOLD_MS
  ) {
    throw new Error(needsAuthMessage(identity.id, last));
  }
}

/**
 * Once an identity's Chrome runs: watch its pages for challenges (the reputation
 * log) and, when identity.json has a health check that is due, run it; a page without the
 * proof of a signed-in session throws NEEDS_AUTH, and the call fails with that message.
 */
async function afterIdentityLaunch(
  identity: IdentityRef,
  launched: LaunchedBrowser,
  onChallenge?: (event: Omit<ChallengeEvent, "ts">) => void,
  onCheck?: (page: Page, found: Promise<Omit<ChallengeEvent, "ts"> | undefined>) => void,
): Promise<void> {
  const { id, env } = identity;
  watchChallenges(
    launched.context,
    (event) => {
      onChallenge?.(event);
      try {
        recordChallenge(id, env, event);
      } catch {
        /* the log is best effort; a full disk must not break a tool call */
      }
    },
    onCheck ? { onCheck: (page, found) => onCheck(page as unknown as Page, found) } : {},
  );
  const own = readIdentitySettings(id, env)?.health;
  // The check `login` found is a guess: it is run and reported, but it never refuses the launch.
  const detected = own === undefined ? readDetectedHealth(id, env) : undefined;
  const check = own || detected;
  if (!check || !healthDue(readHealth(id, env), check)) return;
  const record = await runHealthCheck(launched.context as unknown as HealthContext, check);
  writeHealth(id, env, record);
  if (record.status === "needs_auth") {
    process.stderr.write(`turno-browser-mcp: ${id} needs a new sign-in (${record.detail} at ${record.url})\n`);
    if (!detected) throw new Error(needsAuthMessage(id, record));
  }
}

/**
 * identity.json as the server starts: its opt-in keys and its policy. The tool list is fixed for
 * the life of the server, so turning a feature on or changing the policy takes a restart;
 * turning a feature off is honored at the next call, since each opt-in tool reads identity.json
 * again. An invalid file lists nothing extra (the first launch reports the problem).
 */
function startSettings(identity: IdentityRef | undefined): IdentitySettings | undefined {
  if (!identity) return undefined;
  try {
    return readIdentitySettings(identity.id, identity.env);
  } catch {
    return undefined;
  }
}

/**
 * A capability (`--caps`, the config's `capabilities`) whose every tool the policy turns off
 * would add nothing but a way around it: the server refuses to start with one.
 */
function refuseCaps(
  config: McpConfig,
  policy: IdentityPolicy | undefined,
  disabled: ReadonlyMap<string, string>,
  identity: IdentityRef | undefined,
): void {
  if (!policy || !identity) return;
  const all = upstream().tools.browserTools;
  for (const cap of config.capabilities ?? []) {
    const of = all.filter((t) => t.capability === cap);
    if (of.length && of.every((t) => disabled.has(t.schema.name)))
      throw new Error(
        `--caps ${cap} does not go with the policy of browser identity "${identity.id}": it turns off ${of.map((t) => t.schema.name).join(", ")}. Start the server without that capability.`,
      );
  }
}

/** The system locale, read once per process (on macOS it runs `defaults`). */
let systemLocaleRead: { value: string | undefined } | undefined;
function cachedSystemLocale(): string | undefined {
  systemLocaleRead ??= { value: systemLocale() };
  return systemLocaleRead.value;
}

/** `{ [key]: value }`, or nothing when the value is undefined. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/**
 * The capabilities the server lists: the server's own `--caps` (or its config's) when given,
 * else the defaults (`defaults.ts`): vision, pdf, devtools (not with record.traces, which uses the
 * same tracer) and network (not when the policy turns it off).
 */
function defaultCaps(config: McpConfig, settings: IdentitySettings | undefined, options: HostOptions): McpConfig {
  if (config.capabilities) return config;
  let engine = "chrome";
  try {
    const kind = engineChoice(options.engineFlags ?? {}, settings).kind;
    engine = kind === "default" ? "chrome" : kind;
  } catch {
    /* the first launch reports a bad engine setting */
  }
  const policy = options.identity ? settings?.policy : undefined;
  const effective = resolveDefaults(settings, {
    identity: options.identity !== undefined,
    engine,
    ...(policy ? { policy } : {}),
  });
  return { ...config, capabilities: DEFAULT_CAPS.filter((cap) => effective.caps[cap].value === true) };
}

/** Builds the host for a resolved config: tool list, engine and session factory. */
export function createHost(options: HostOptions): Host {
  const { tools } = upstream();
  const { cliOptions } = options;
  const atStart = startSettings(options.identity);
  const given = options.config.capabilities;
  const config = defaultCaps(options.config, atStart, options);
  const policy = options.identity ? atStart?.policy : undefined;
  // The tools a policy turns off are not listed, and the session's browser does not know them.
  const disabled = disabledTools(policy);
  // Only a capability the server was given is refused: a default one the policy turns off is left out.
  refuseCaps(options.config, policy, disabled, options.identity);
  const stock = tools.filteredTools(config).filter((t) => !disabled.has(t.schema.name));
  const stockSchemas = new Map(stock.map((t) => [t.schema.name, t.schema.inputSchema]));
  const stockTypes = new Map(stock.map((t) => [t.schema.name, t.schema.type]));
  const turnoTools = [...(options.turnoTools ?? TURNO_TOOLS), ...optInTools(atStart)].filter(
    (t) => !disabled.has(t.schema.name),
  );
  checkTurnoTools(turnoTools, tools.browserTools);
  const turno = new Map(turnoTools.map((t) => [t.schema.name, t]));
  const engine = options.engine ?? createEngine(config, options.engineFlags);
  const schemas = [...stock.map((t) => t.schema), ...turnoTools.map((t) => t.schema)];
  const sessionsByName = new Map<string, number>();
  const title = (clientInfo: ClientInfo) => {
    const count = (sessionsByName.get(clientInfo.clientName) ?? 0) + 1;
    sessionsByName.set(clientInfo.clientName, count);
    return count > 1 ? `${clientInfo.clientName} (${count})` : clientInfo.clientName;
  };
  const redactor = new Redactor();
  const guard = new VaultGuard();
  const live = options.identity ? liveServerFor(options, options.identity, redactor, guard) : undefined;
  const shared = {
    config,
    cliOptions,
    stock,
    stockSchemas,
    stockTypes,
    turno,
    engine,
    tuning: options.tuning ?? {},
    redactor,
    guard,
    tabLocks: options.tabLocks ?? {},
    engineFlags: options.engineFlags ?? {},
    pressure: options.memory ?? memoryPressureProbe(),
    ...(given ? { caps: given } : {}),
    ...(live ? { live } : {}),
    ...(options.identity ? { identity: options.identity } : {}),
    ...(options.vaultStore ? { vaultStore: options.vaultStore } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(policy ? { policy } : {}),
  };
  return {
    config,
    ...(live ? { live } : {}),
    redact: (text) => redactor.text(text),
    listTools: () => schemas.map(toMcpTool),
    factory: {
      name: SERVER_INFO.name,
      nameInConfig: "playwright",
      version: SERVER_INFO.version,
      toolSchemas: schemas,
      create: async () => new SessionBackend(shared, title),
    },
  };
}

/**
 * The live view server of an identity, when `--live` or identity.json `live.enabled` turns it
 * on; it starts listening at once, so a pause works before the browser starts.
 */
function liveServerFor(
  options: HostOptions,
  identity: IdentityRef,
  redactor: Redactor,
  guard: VaultGuard,
): LiveServer | undefined {
  const settings = (): IdentitySettings | undefined => {
    try {
      return readIdentitySettings(identity.id, identity.env);
    } catch {
      return undefined; // the first launch reports a bad identity.json
    }
  };
  const policy = resolveLive(settings()?.live, options.live);
  if (!policy.enabled) return undefined;
  const log = (line: string) => process.stderr.write(`turno-browser-mcp: ${line}\n`);
  const server = new LiveServer({
    identity,
    policy,
    guard,
    redactor,
    headless: options.config.browser.launchOptions?.headless === true,
    // Before a launch, the engine identity.json and the flags would pick.
    viewRefusal: (engine) => {
      if (engine) return viewRefusal(engine);
      try {
        return viewRefusal(engineChoice(options.engineFlags ?? {}, settings()).kind);
      } catch {
        return undefined;
      }
    },
    log,
    uiLocale: () => uiLocale(settings()),
  });
  server.start().catch((error) => log(`the live view did not start: ${(error as Error).message}`));
  return server;
}

/** The workspace roots the client offers, as upstream reads them (first root, or cwd). */
async function clientInfoOf(server: Server): Promise<ClientInfo> {
  let cwd = process.cwd();
  if (server.getClientCapabilities()?.roots) {
    const { roots } = await server.listRoots().catch(() => ({ roots: [] as { uri: string }[] }));
    for (const root of roots) {
      try {
        cwd = fileURLToPath(new URL(root.uri));
        break;
      } catch {
        /* not a file URL: try the next root */
      }
    }
  }
  return { cwd, clientName: server.getClientVersion()?.name ?? "Playwright MCP" };
}

/**
 * MCP sampling for a tool call, when the client declared it. `relatedRequestId` in `_meta` is
 * how mcpd routes a server's request back to the session whose call is in flight (several
 * sessions share one server with `"sharing": "tabs"`).
 */
function samplerFor(server: Server, requestId: string | number): Sampler | undefined {
  if (!server.getClientCapabilities()?.sampling) return undefined;
  return async (request, signal) => {
    const result = await server.createMessage(
      {
        ...request,
        includeContext: "none",
        temperature: 0,
        _meta: { relatedRequestId: requestId },
      },
      { ...(signal ? { signal } : {}), timeout: 600_000 },
    );
    const content = result.content as { type: string; text?: string } | { type: string; text?: string }[];
    const parts = Array.isArray(content) ? content : [content];
    return {
      text: parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n"),
      model: result.model,
    };
  };
}

/** Progress notifications for a call whose client gave a progress token. */
function progressFor(
  token: string | number | undefined,
  send: (notification: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>,
): Progress | undefined {
  if (token === undefined) return undefined;
  return (elapsedMs, message) => {
    void send({
      method: "notifications/progress",
      params: { progressToken: token, progress: Math.round(elapsedMs / 1000), message },
    }).catch(() => {});
  };
}

/** The one session backend that every connection of a shared host uses (`shareHost`). */
interface SharedBackend {
  /** The backend, created on the first use, with the first connection's client info. */
  get(server: Server): Promise<SessionBackend>;
  /** The backend when it exists, without creating it. */
  peek(): Promise<SessionBackend> | undefined;
  /** The servers connected now, told when the page's tools change. */
  servers: Set<Server>;
}

/**
 * An MCP server for one connection of this host, on any transport: with its own session
 * backend (stdio, one browser per connection), or on the backend of a shared host.
 */
function createServer(host: Host, shared?: SharedBackend): Server {
  // The experimental capability asks mcpd to say when a client session ends (`session.ts`).
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: true }, experimental: { [SESSION_CAPABILITY]: {} } },
  });
  let own: Promise<SessionBackend> | undefined;
  const session = (): Promise<SessionBackend> => {
    if (shared) return shared.get(server);
    own ??= (async () => {
      const clientInfo = await clientInfoOf(server);
      const b = (await host.factory.create(clientInfo)) as SessionBackend;
      await b.initialize(clientInfo);
      b.on("dynamictoolschange", () => void server.sendToolListChanged().catch(() => {}));
      return b;
    })();
    own.catch(() => {
      own = undefined;
    });
    return own;
  };
  const existing = () => (shared ? shared.peek() : own);
  shared?.servers.add(server);
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const live = await existing()?.catch(() => undefined);
    return { tools: [...host.listTools(), ...(live?.dynamicTools() ?? [])] as ToolSchemaJson[] as never };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    try {
      const b = await session();
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const meta = request.params._meta;
      const sessionId = sessionFromMeta(meta);
      // The agent behind the call: mcpd says it; on a shared host each connection is one agent.
      const client = clientFromMeta(meta) ?? (shared && sessionId ? server.getClientVersion()?.name : undefined);
      const result = await b.callTool(
        request.params.name,
        args,
        extra.signal,
        sessionId,
        samplerFor(server, extra.requestId),
        client,
        progressFor(meta?.progressToken, extra.sendNotification),
      );
      return mergeTextParts(result) as CallToolResult;
    } catch (error) {
      return { content: [{ type: "text", text: `### Error\n${host.redact(String(error))}` }], isError: true };
    }
  });
  server.fallbackNotificationHandler = async (notification) => {
    // On a shared host the sessions are the connections, which the host ends itself.
    if (shared || notification.method !== SESSION_ENDED_METHOD) return;
    const session = sessionFromMeta({ [SESSION_META_KEY]: notification.params?.session });
    if (session !== undefined) await (await own?.catch(() => undefined))?.endSession(session);
  };
  const previous = server.onclose;
  server.onclose = () => {
    previous?.();
    if (shared) shared.servers.delete(server);
    else void own?.then((b) => b.dispose()).catch(() => {});
  };
  return server;
}

/**
 * One browser for many connections: the background server's host. Each connection gets its own
 * MCP server, and every one of them calls the same session backend, so the connections share the
 * identity's one Chrome the way mcpd's client sessions share one stdio server. The caller puts
 * each connection's client session in the `_meta` of its calls (`SESSION_META_KEY`), which keys
 * the tabs of `"sharing": "tabs"`, and ends it with `endSession`.
 */
export interface SharedHost {
  /** Serves one connection on `transport`. Closing it leaves the browser open. */
  connect(transport: Transport): Promise<Server>;
  /** A client session ended: with `"sharing": "tabs"` its tabs are free at once. */
  endSession(session: string): Promise<void>;
  /** Closes the browser. */
  dispose(): Promise<void>;
}

export function shareHost(host: Host): SharedHost {
  let backend: Promise<SessionBackend> | undefined;
  const servers = new Set<Server>();
  const shared: SharedBackend = {
    servers,
    peek: () => backend,
    get(server) {
      backend ??= (async () => {
        const clientInfo = await clientInfoOf(server);
        const b = (await host.factory.create(clientInfo)) as SessionBackend;
        await b.initialize(clientInfo);
        b.on("dynamictoolschange", () => {
          for (const s of servers) void s.sendToolListChanged().catch(() => {});
        });
        return b;
      })();
      backend.catch(() => {
        backend = undefined;
      });
      return backend;
    },
  };
  return {
    async connect(transport) {
      const server = createServer(host, shared);
      await server.connect(transport);
      return server;
    },
    async endSession(session) {
      await (await backend?.catch(() => undefined))?.endSession(session);
    },
    async dispose() {
      const b = await backend?.catch(() => undefined);
      backend = undefined;
      await b?.dispose();
    },
  };
}

/** Serves the host: stdio by turno, `--port` by upstream's HTTP server. */
export async function serve(host: Host, transport?: Transport): Promise<Server | undefined> {
  if (host.config.server.port !== undefined && !transport) {
    await upstream().tools.start(host.factory, host.config.server);
    return undefined;
  }
  const server = createServer(host);
  await server.connect(transport ?? new StdioServerTransport());
  return server;
}

/**
 * Parses the Playwright MCP flags with upstream's definitions and serves them with turno's
 * host. Mirrors the action of upstream's program: exit watchdog, `--vision`, `tracing`, config.
 */
export async function runHost(
  args: string[],
  options: {
    identity?: IdentityRef;
    tuning?: TuningFlags;
    engineFlags?: EngineFlags;
    live?: LiveFlags;
    /**
     * Serves the host instead of stdio or `--port` (`--background`). Such a server has no client
     * on stdin, so upstream's watchdog, which exits when stdin closes, is not installed.
     */
    serve?: (host: Host) => Promise<void>;
  } = {},
): Promise<void> {
  const { utils, core, version } = upstream();
  const { identity, tuning, engineFlags, live } = options;
  const serveWith = options.serve;
  const Command = utils.program.constructor;
  const program = new Command().version(`Version ${version}`).name("Playwright MCP");
  upstream().tools.decorateMCPCommand(program);
  program.action(async (options) => {
    if (!serveWith) upstream().tools.setupExitWatchdog();
    if (options.vision) {
      console.error("The --vision option is deprecated, use --caps=vision instead");
      options.caps ??= [];
      (options.caps as string[]).push("vision");
    }
    if ((options.caps as string[] | undefined)?.includes("tracing")) (options.caps as string[]).push("devtools");
    const config = await upstream().tools.resolveCLIConfigForMCP(options);
    const host = createHost({
      config,
      cliOptions: options,
      ...(identity ? { identity } : {}),
      ...(tuning ? { tuning } : {}),
      ...(engineFlags ? { engineFlags } : {}),
      ...(live ? { live } : {}),
    });
    if (serveWith) await serveWith(host);
    else await serve(host);
  });
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    console.error((error as Error).message);
    core.utils.gracefullyProcessExitDoNotHang(1);
  }
}

/** Why the person cannot answer Chrome's passkey window: a headless Chrome has none to show. */
function passkeyUnseenReason(id: string | undefined): string {
  const b = names().browser;
  const login = id
    ? `, or to sign in to this site once in a window with \`${b} login ${id}\` after this session ends`
    : "";
  return `this Chrome runs without a window (--headless) and the live view shows only the page, never Chrome's own windows, so the person cannot see that window. Ask the person to start turno-browser-mcp without --headless${login}.`;
}

/** A result with the passkey notes a call takes, first (under `turno.passkey` in JSON). */
function withPasskeyNotes(result: ToolResult, notes: readonly PasskeyNote[], json: boolean): ToolResult {
  if (!notes.length) return result;
  const text = notes.map((n) => `### Passkey\n${n.text}`).join("\n\n");
  const all = notes.map((n) => ({ ...n.data, note: n.text }));
  const data = all.length === 1 ? all[0] : all;
  return withNote(result, text, json, "passkey", json ? data : text);
}

/** How a step ended, for a call that asked as text or as JSON. */
type StepResultOf = (json: boolean) => ToolResult;

/** The step table of a watch: every session of one browser shares its pause, and its step. */
const STEP_TABLES = new WeakMap<BrowserWatch, StepTable<StepResultOf>>();
function stepTableOf(watch: BrowserWatch): StepTable<StepResultOf> {
  const table = STEP_TABLES.get(watch) ?? new StepTable<StepResultOf>();
  STEP_TABLES.set(watch, table);
  return table;
}

/** A step's run as a result; a step that threw still ends (and its pause with it). */
function settledStep(params: StepParams, run: ReturnType<typeof runStep>): Promise<StepResultOf> {
  return run.then(
    (r) => (json: boolean) => stepRunResult(params, r, json),
    (error: unknown) => (json: boolean) => errorResult(`the person step failed: ${(error as Error).message}`, json),
  );
}

/** A passkey prompt's step ended: the passkey note this call carries says how. */
function passkeyStepResult(json: boolean): ToolResult {
  const text = "The person step for the page's passkey prompt has ended; the passkey section says how it went.";
  return {
    content: [{ type: "text", text: json ? JSON.stringify({ ended: true }, null, 2) : `### Person step\n${text}` }],
  };
}

/** Progress for a call that waits for a step, as a client that asked for it hears it. */
function stepProgress(progress: Progress): (elapsedMs: number) => void {
  return (ms) => progress(ms, `Waiting for the person (${formatPause(ms)})`);
}

/** Why the person cannot see a headless Chrome now, or undefined when the live view shows it. */
export function unseenReason(live: { viewerCount: number } | undefined, id: string | undefined): string | undefined {
  const b = names().browser;
  if (live && live.viewerCount > 0) return undefined;
  if (live && id)
    return `Chrome runs without a window here, so the person sees the page only in the live view, and it is not open. Ask the person to run \`${b} live ${id}\` (it opens the view in their browser), then call ${HUMAN_STEP_TOOL} again.`;
  const start = id
    ? `\`${b} set ${id} --live true\` and a new session, then \`${b} live ${id}\``
    : "an identity with the live view on";
  return `Chrome runs without a window here (--headless) and the live view is off, so the person cannot see the page. Ask the person to run the browser with a window (start turno-browser-mcp without --headless), or to turn the live view on (${start}), then call ${HUMAN_STEP_TOOL} again.`;
}
