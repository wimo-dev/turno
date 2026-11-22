import type { ElementHandle, Frame, Page } from "patchright-core";
import { type StepCommand, type StepReport, type StepView, humanStepOverlay } from "./human-step-overlay.js";
import { describeChanges, formatPause } from "./live.js";
import { names } from "./names.js";
import type { VaultGuard } from "./redact.js";
import type { TurnoTool } from "./tools.js";
import { DEFAULT_STEP_WAIT_MS, MAX_STEP_WAIT_MS, type StepInfo, parseWaitMs } from "./step-wait.js";
import { type UiLocale, uiStrings } from "./ui-strings.js";
import type { ToolResult, ToolSchema } from "./upstream.js";
import { upstream } from "./upstream.js";
import type { BrowserWatch } from "./watch.js";

/**
 * A person step: `browser_request_human`, the tool an agent calls for what only the person may
 * do (a password, a captcha, an emailed code, a second factor, accepting terms or consent).
 *
 * - The tab comes to the front (and its window out of the dock, when Chrome has one), and a
 *   banner at the bottom of the page says what to do, with a Done button; a ring marks the
 *   target when the agent names one (`human-step-overlay.ts`). The banner is drawn again on each
 *   new document while the step lasts, and removed when it ends. The live view shows it too.
 * - The step pauses the browser like the live view's Pause (`live.ts`): every call of every
 *   session waits until the step ends, the idle limit and the tab governor hold, a trace stops.
 *   Calls already running finish first, so no agent input lands while the person acts.
 * - It ends on the first of: the URL matches or changes, a selector is visible, Done (a trusted
 *   click only), the person resumes the agent, the tab closes, the timeout (5 minutes by
 *   default, up to 10: typing a password and solving a captcha, or fetching a code from an
 *   email, takes minutes, longer than the 2 minutes the live view holds an unplanned pause).
 * - The result says why it ended, where the tab is, what changed in the tabs and how many
 *   clicks and changed fields the person made, never what they typed. A page where the person
 *   changed a password or code field is held by the vault guard until it navigates, so the
 *   script tools cannot read the value back.
 * - A call waits for the step at most `waitMs` (`step-wait.ts`); then it says the step is still
 *   open, and the agent calls again with `continue` to wait another piece. A new instruction
 *   while a step is open is refused: the banner shows the first one, so joining would answer the
 *   new instruction with what the person did for the old one, and changing the banner would
 *   change what the person reads while they act. The refusal names the open step and how to
 *   wait for it.
 */

export const HUMAN_STEP_TOOL = "browser_request_human";

export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;
const MAX_STEP_TIMEOUT_MS = 10 * 60_000;
const MIN_STEP_TIMEOUT_MS = 1_000;
const MAX_INSTRUCTION = 500;
/** How often the banner is checked (and drawn again on a new document). */
const POLL_MS = 150;
/** How long the step waits for calls already running to finish before it shows the banner. */
const DRAIN_MS = 15_000;
/** How often a client that asked for progress hears that the step still waits. */
const PROGRESS_MS = 15_000;
const REF = /^(f\d+)?e\d+$/;

export interface StepParams {
  instruction: string;
  element?: string;
  target?: string;
  url?: string;
  urlChanges: boolean;
  selector?: string;
  done: boolean;
  timeoutMs: number;
  requireHumanClick: boolean;
}

function schema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: HUMAN_STEP_TOOL,
    title: "Ask the person to do a step",
    description: [
      "Hand the browser to the person for a step only they may do: typing a password, solving a captcha, entering a code from an email or a text message, a second factor, accepting terms or giving consent, or anything that must be their own action.",
      "Never type or click these yourself. The tab comes to the front with a banner that shows your instruction and a Done button, and a ring around the target when you give one.",
      "Every browser call waits while the person acts. The step ends on the first of: the URL matches until.url or changes (until.urlChanges), until.selector is visible, the person presses Done, or the timeout (5 minutes by default, 10 at most).",
      "The result says why it ended, the tab's URL and title, what changed in the tabs and how many clicks and changed fields the person made; it never has what they typed. Take a snapshot before your next action.",
      "Write the instruction for a non-technical person, in their language. The browser must have a window, or the person must have the live view open.",
      `A call waits at most waitMs (${DEFAULT_STEP_WAIT_MS / 1000} s by default). If the step is still open then, the result says so and the step goes on, with every other call held: call ${HUMAN_STEP_TOOL} again with { "continue": true } to keep waiting. While a step is open, a call with a new instruction is refused.`,
    ].join(" "),
    inputSchema: z.object({
      instruction: z
        .string()
        .optional()
        .describe(
          'What the person should do, in plain words, as the banner shows it (up to 500 characters), for example "Type your password and press Sign in." Needed unless continue is set.',
        ),
      continue: z
        .union([z.boolean(), z.string()])
        .optional()
        .describe(
          "Keep waiting for the step that is open (true), or for the step with this id, after a result said it is still waiting. The other arguments are ignored.",
        ),
      waitMs: z
        .number()
        .optional()
        .describe(
          `How long this call waits for the step before it returns, in milliseconds (default ${DEFAULT_STEP_WAIT_MS}, from 1000 to ${MAX_STEP_WAIT_MS}); keep it under your client's tool call timeout. The step's own timeout counts from when it began.`,
        ),
      element: z
        .string()
        .optional()
        .describe("Human-readable element description used to obtain permission to interact with the element"),
      target: z
        .string()
        .optional()
        .describe(
          "Exact target element reference from the page snapshot, or a unique element selector: the element the banner points the person to",
        ),
      until: z
        .object({
          url: z
            .string()
            .optional()
            .describe(
              "End when the tab's URL matches: a glob (**/dashboard*), a regular expression written /.../, or text the URL contains",
            ),
          urlChanges: z.boolean().optional().describe("End when the tab's URL changes (not just its #fragment)"),
          selector: z.string().optional().describe("End when an element matching this selector is visible"),
          done: z.boolean().optional().describe("Show a Done button the person presses when finished (default true)"),
          timeoutMs: z
            .number()
            .optional()
            .describe("Give up after this many milliseconds (default 300000, from 1000 to 600000)"),
        })
        .optional()
        .describe("When the step ends: the first of these that happens. Without it, when the person presses Done."),
      requireHumanClick: z
        .boolean()
        .optional()
        .describe("Report whether the person's own click landed on the target (needs target)"),
    }),
    type: "action",
  };
}

/** The tool. The host runs it (`ctx.human`): it needs the pause gate and the session's tab. */
export function requestHumanTool(): TurnoTool {
  let built: ToolSchema | undefined;
  return {
    get schema() {
      built ??= schema();
      return built;
    },
    async handle(ctx, params) {
      if (!ctx.human) throw new Error(`${HUMAN_STEP_TOOL} runs only in a turno-browser-mcp session`);
      return await ctx.human(params);
    },
  };
}

/** What a call asks for: a new step, or more waiting for the open one (`continue`). */
export type StepCall =
  | { kind: "start"; params: StepParams; waitMs: number }
  | { kind: "continue"; step: true | string; waitMs: number };

/** A call's arguments, or why they are not a call of the tool. */
export function parseStepCall(raw: Record<string, unknown>): StepCall | { error: string } {
  const waitMs = parseWaitMs(raw.waitMs);
  if (typeof waitMs !== "number") return waitMs;
  const more = raw.continue;
  if (more === true || (typeof more === "string" && more.trim()))
    return { kind: "continue", step: more === true ? true : (more as string).trim(), waitMs };
  if (more !== undefined && more !== false) return { error: "continue must be true or the id of a step" };
  const params = parseStepParams(raw);
  return "error" in params ? params : { kind: "start", params, waitMs };
}

/** The tool's arguments as the step uses them, or why they do not make a step. */
export function parseStepParams(params: Record<string, unknown>): StepParams | { error: string } {
  const instruction = typeof params.instruction === "string" ? params.instruction.trim() : "";
  if (!instruction) return { error: "instruction must say what the person should do" };
  if (instruction.length > MAX_INSTRUCTION)
    return { error: `instruction is ${instruction.length} characters; keep it to ${MAX_INSTRUCTION}` };
  const until = (params.until ?? {}) as Record<string, unknown>;
  const timeoutMs = until.timeoutMs === undefined ? DEFAULT_STEP_TIMEOUT_MS : Number(until.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_STEP_TIMEOUT_MS || timeoutMs > MAX_STEP_TIMEOUT_MS)
    return {
      error: `until.timeoutMs must be from ${MIN_STEP_TIMEOUT_MS} to ${MAX_STEP_TIMEOUT_MS} (10 minutes); without it the step waits ${formatPause(DEFAULT_STEP_TIMEOUT_MS)}`,
    };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out: StepParams = {
    instruction,
    urlChanges: until.urlChanges === true,
    done: until.done !== false,
    timeoutMs: Math.round(timeoutMs),
    requireHumanClick: params.requireHumanClick === true,
  };
  const element = str(params.element);
  const target = str(params.target);
  const url = str(until.url);
  const selector = str(until.selector);
  if (element) out.element = element;
  if (target) out.target = target;
  if (url) {
    const bad = urlPatternError(url);
    if (bad) return { error: bad };
    out.url = url;
  }
  if (selector) out.selector = selector;
  if (!out.done && !out.url && !out.urlChanges && !out.selector)
    return {
      error: "with until.done false the step needs another way to end: until.url, until.urlChanges or until.selector",
    };
  if (out.requireHumanClick && !out.target) return { error: "requireHumanClick needs a target" };
  return out;
}

const REGEX_FORM = /^\/(.+)\/([dgimsuvy]*)$/;

function urlPatternError(pattern: string): string | undefined {
  const m = REGEX_FORM.exec(pattern);
  if (!m) return undefined;
  try {
    new RegExp(m[1]!, m[2]);
    return undefined;
  } catch (error) {
    return `until.url ${pattern} is not a valid regular expression: ${(error as Error).message}`;
  }
}

/**
 * A URL test from `until.url`: `/.../flags` is a regular expression, a pattern with `*` a glob
 * over the whole URL (`*` stops at a `/`, `**` does not), anything else text the URL contains.
 */
export function urlMatcher(pattern: string): (url: string) => boolean {
  const m = REGEX_FORM.exec(pattern);
  if (m) {
    const re = new RegExp(m[1]!, m[2]?.replace(/[gy]/g, ""));
    return (url) => re.test(url);
  }
  if (pattern.includes("*")) {
    let source = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          source += ".*";
          i++;
        } else source += "[^/]*";
      } else source += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
    const re = new RegExp(`^${source}$`);
    return (url) => re.test(url);
  }
  return (url) => url.includes(pattern);
}

/** A URL without its fragment: a `#` change alone is not a navigation. */
function withoutHash(url: string): string {
  const at = url.indexOf("#");
  return at < 0 ? url : url.slice(0, at);
}

/** Runs the page side in a page or a frame (its utility world); undefined when it does not answer. */
async function overlay(where: Page | Frame, cmd: StepCommand, el?: ElementHandle): Promise<StepReport | undefined> {
  // Playwright passes the handle as the element itself; its types do not follow the union.
  const fn = humanStepOverlay as unknown as (arg: unknown) => StepReport;
  return await where.evaluate(fn, el ? { cmd, el } : { cmd }).catch(() => undefined);
}

/** The banner and the target ring of one step on one tab, drawn again on every new document. */
export class StepBanner {
  private readonly docs = new Map<string, StepReport>();
  private latest: StepReport | undefined;
  private pressed = false;
  private clicked = false;

  constructor(
    private readonly page: Page,
    private readonly view: StepView,
    private readonly target?: { handle: ElementHandle; frame: Frame },
  ) {}

  /** Draws the banner (and the ring) on the page as it is now. */
  async show(): Promise<void> {
    await this.poll(true);
  }

  /** Reads what the person did, drawing the banner again where a new document has none. */
  async poll(first = false): Promise<void> {
    if (this.page.isClosed()) return;
    // The ring first: it is on the page no later than the banner that points to it.
    const t = this.target;
    if (t && !t.frame.isDetached()) {
      const mark = await overlay(t.frame, { op: "target", step: this.view.step }, first ? t.handle : undefined);
      if (mark?.target) {
        this.pressed ||= mark.target.pressed;
        this.clicked ||= mark.target.clicked;
      }
    }
    const report = await overlay(this.page, { op: "banner", view: this.view });
    if (report) {
      if (report.doc) this.docs.set(report.doc, report);
      this.latest = report;
    }
  }

  /** What the person did over every document of the step. */
  totals(): { done: boolean; clicks: number; fields: number; sensitive: boolean; targetClicked: boolean } {
    let clicks = 0;
    let fields = 0;
    let done = false;
    for (const r of this.docs.values()) {
      clicks += r.clicks;
      fields += r.fields;
      done ||= r.done;
    }
    return {
      done,
      clicks,
      fields,
      // Only the document the tab shows now still holds what was typed.
      sensitive: this.latest?.sensitive === true,
      targetClicked: this.pressed || this.clicked,
    };
  }

  /** Removes the banner and the ring. */
  async remove(): Promise<void> {
    if (!this.page.isClosed()) await overlay(this.page, { op: "remove" });
    const t = this.target;
    if (t && !t.frame.isDetached() && t.frame !== this.page.mainFrame()) await overlay(t.frame, { op: "remove" });
    await t?.handle.dispose().catch(() => {});
  }
}

/** Why a step ended. */
export type StepEnd =
  | "done"
  | "url"
  | "url-changed"
  | "selector"
  | "settled"
  | "resumed"
  | "closed"
  | "timeout"
  | "cancelled";

/** An end the step does not see in the page itself: a passkey prompt that settled (`passkey.ts`). */
export interface StepSettle {
  settled(): boolean;
  /** Calls `wake` when it settles; returns what stops that. */
  onSettle(wake: () => void): () => void;
}

/** How a step went, before it becomes a result. */
export interface StepRun {
  ended: StepEnd;
  waitedMs: number;
  url?: string | undefined;
  title?: string | undefined;
  lines: string[];
  clicks: number;
  fields: number;
  liveInputs: number;
  targetClicked: boolean;
}

export interface StepDeps {
  /** The session's current tab: the step happens there. */
  page: Page;
  watch: BrowserWatch;
  guard: VaultGuard;
  /** The client session, for the tab the live view follows (none for a step no call asked for). */
  session?: string;
  /** Who the pause is for, as held calls read it (default: the tool's name). */
  by?: string;
  /** Ends the step when it settles. */
  settle?: StepSettle;
  /** Why the person cannot see this browser now; the step does not start. */
  unseen?: string;
  /** Chrome has a window of its own: bring it back when it is minimized. */
  window: boolean;
  json: boolean;
  signal?: AbortSignal;
  /** Tells a client that asked for progress that the step still waits. */
  progress?: (elapsedMs: number, message: string) => void;
  /** The session's current tab when the step ends. */
  currentPage(): Page | undefined;
  /** The language of the banner (`ui-strings.ts`); English without it. */
  locale?: UiLocale;
  /** The banner's title and hint, in place of the step's own (a page's passkey prompt). */
  banner?: { title: string; hint: string };
  pollMs?: number;
  drainMs?: number;
  now?: () => number;
}

function stepError(message: string, json: boolean): ToolResult {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Brings the tab to the front, and its window back when it is minimized. */
async function toFront(page: Page, window: boolean): Promise<void> {
  if (window) {
    try {
      const cdp = await page.context().newCDPSession(page);
      try {
        const { windowId, bounds } = (await cdp.send("Browser.getWindowForTarget")) as {
          windowId: number;
          bounds: { windowState?: string };
        };
        if (bounds.windowState === "minimized")
          await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      } finally {
        await cdp.detach().catch(() => {});
      }
    } catch {
      /* no window to bring back (an engine without the Browser domain) */
    }
  }
  await page.bringToFront().catch(() => {});
}

/** How a step went (or why it did not start), as a result. */
export function stepRunResult(params: StepParams, run: StepRun | { error: string }, json: boolean): ToolResult {
  if ("error" in run) return stepError(run.error, json);
  const { targetClicked, ...rest } = run;
  return stepResult({ params, ...rest, ...(params.requireHumanClick ? { targetClicked } : {}), json });
}

/** Runs one person step on `deps.page`: what ended it and what changed, or why it did not start. */
export async function runStep(params: StepParams, deps: StepDeps): Promise<StepRun | { error: string }> {
  const { page, watch } = deps;
  const now = deps.now ?? Date.now;
  if (deps.unseen) return { error: deps.unseen };
  if (page.isClosed()) return { error: "the current tab is closed; open a page first" };

  let target: { handle: ElementHandle; frame: Frame } | undefined;
  if (params.target) {
    const locator = (REF.test(params.target) ? page.getByRef(params.target) : page.locator(params.target)).first();
    const handle = await locator.elementHandle({ timeout: 2_000 }).catch(() => null);
    const frame = handle ? await handle.ownerFrame().catch(() => null) : null;
    if (!handle || !frame)
      return {
        error: REF.test(params.target)
          ? `Ref ${params.target} not found in the current page snapshot. Try capturing new snapshot.`
          : `"${params.target}" does not match any elements.`,
      };
    target = { handle, frame };
  }
  if (params.selector) {
    const bad = await page
      .locator(params.selector)
      .count()
      .then(() => undefined)
      .catch((error: Error) => error.message.split("\n")[0]);
    if (bad) {
      await target?.handle.dispose().catch(() => {});
      return { error: `until.selector is not a selector the page can use: ${bad}` };
    }
  }

  const began = now();
  const deadline = began + params.timeoutMs;
  const before = await watch.tabStates();
  const startUrl = page.url();
  if (!(await watch.pause(deps.by ?? HUMAN_STEP_TOOL, false, { step: true, until: deadline }))) {
    await target?.handle.dispose().catch(() => {});
    const by = watch.gate.paused?.by ?? "the user";
    return { error: `the browser is paused (${by}); call again once it is resumed` };
  }
  const mine = watch.gate.paused?.since;
  if (deps.session !== undefined) watch.follow(deps.session, page);

  // Calls that started before the pause finish first: their input is the agent's, not the person's.
  const drainEnd = now() + (deps.drainMs ?? DRAIN_MS);
  while (watch.inFlight > 0 && now() < drainEnd) await sleep(25);

  const strings = uiStrings(deps.locale).step;
  const view: StepView = {
    step: `${began.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    lang: deps.locale ?? "en",
    title: deps.banner?.title ?? strings.title,
    instruction: params.instruction,
    hint: deps.banner?.hint ?? (params.done ? strings.hintDone : strings.hintAuto),
    done: params.done ? strings.done : null,
  };
  const banner = new StepBanner(page, view, target);
  let wake: (() => void) | undefined;
  const kick = () => wake?.();
  // A navigation starts while the old document still answers: read it once more first.
  const onRequest = (request: { isNavigationRequest(): boolean; frame(): Frame }) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) kick();
  };
  page.on("request", onRequest);
  page.on("domcontentloaded", kick);
  page.on("close", kick);
  deps.signal?.addEventListener("abort", kick);
  const unsettle = deps.settle?.onSettle(kick);
  const matches = params.url ? urlMatcher(params.url) : undefined;
  let ended: StepEnd | undefined;
  const ours = () => watch.gate.paused?.since === mine;
  try {
    await toFront(page, deps.window);
    await banner.show();
    let told = began;
    const pollMs = deps.pollMs ?? POLL_MS;
    for (;;) {
      await banner.poll();
      const paused = watch.gate.paused;
      if (page.isClosed()) ended = "closed";
      else if (deps.signal?.aborted) ended = "cancelled";
      else if (!paused || paused.since !== mine) ended = "resumed";
      else if (deps.settle?.settled()) ended = "settled";
      else if (banner.totals().done) ended = "done";
      else if (matches?.(page.url())) ended = "url";
      else if (params.urlChanges && withoutHash(page.url()) !== withoutHash(startUrl)) ended = "url-changed";
      else if (
        params.selector &&
        (await page
          .locator(params.selector)
          .first()
          .isVisible()
          .catch(() => false))
      )
        ended = "selector";
      else if (now() >= deadline) ended = "timeout";
      if (ended) {
        // What ended the step (a click that showed the selector, say) came after the poll above: read it once more.
        if (ended !== "closed") await banner.poll();
        break;
      }
      if (deps.progress && now() - told >= PROGRESS_MS) {
        told = now();
        deps.progress(told - began, `Waiting for the person (${formatPause(told - began)})`);
      }
      await new Promise<void>((r) => {
        const timer = setTimeout(r, Math.max(0, Math.min(pollMs, deadline - now())));
        wake = () => {
          clearTimeout(timer);
          r();
        };
      });
      wake = undefined;
    }
  } catch (error) {
    // Never leave the browser held: the calls waiting for the step go on.
    if (ours()) watch.resume();
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("domcontentloaded", kick);
    page.off("close", kick);
    deps.signal?.removeEventListener("abort", kick);
    unsettle?.();
    await banner.remove();
  }

  const totals = banner.totals();
  // A password or code the person typed stays in the page until it navigates: no script reads it back.
  if (totals.sensitive && !page.isClosed()) deps.guard.mark(page);
  const after = await watch.tabStates();
  const liveInputs = watch.gate.inputsOf(mine);
  if (ours()) watch.resume();
  const current = deps.currentPage() ?? (page.isClosed() ? undefined : page);
  const { lines } = describeChanges(
    before,
    after,
    watch.idOf(page),
    current ? watch.idOf(current) : undefined,
    liveInputs,
  );
  const state = current ? after.find((t) => t.id === watch.idOf(current)) : undefined;
  return {
    ended: ended ?? "timeout",
    waitedMs: now() - began,
    url: state?.url ?? (current?.url() || undefined),
    title: state?.title,
    lines,
    clicks: totals.clicks,
    fields: totals.fields,
    liveInputs,
    targetClicked: totals.targetClicked,
  };
}

/** What the agent reads when a step has not ended within a call's wait: the step goes on. */
export function stillWaiting(
  step: { id: string; info: StepInfo },
  elapsedMs: number,
): { text: string; data: Record<string, unknown> } {
  const left = Math.max(0, step.info.timeoutMs - elapsedMs);
  const next = { continue: true };
  const text = [
    "### Person step still open",
    `Step ${step.id} (${step.info.by}) has waited ${formatPause(elapsedMs)}; it times out in ${formatPause(left)} unless it ends first. The person is asked: ${JSON.stringify(step.info.instruction)}`,
    `The banner is still up and every browser call waits until the step ends. Call ${HUMAN_STEP_TOOL} with ${JSON.stringify(next)} (or { "continue": "${step.id}" }) to keep waiting for it.`,
  ].join("\n");
  const data = {
    waiting: true,
    step: step.id,
    by: step.info.by,
    instruction: step.info.instruction,
    waitedMs: elapsedMs,
    timeoutMs: step.info.timeoutMs,
    next: { tool: HUMAN_STEP_TOOL, arguments: next },
  };
  return { text, data };
}

/** A call's result when the step has not ended within its wait. */
export function stillWaitingResult(step: { id: string; info: StepInfo }, elapsedMs: number, json: boolean): ToolResult {
  const { text, data } = stillWaiting(step, elapsedMs);
  return { content: [{ type: "text", text: json ? JSON.stringify(data, null, 2) : text }] };
}

/** Why a call with a new instruction is refused while `open` runs. */
export function stepBusyMessage(open: { id: string; info: StepInfo }, elapsedMs: number): string {
  return `a person step is open already: step ${open.id} (${open.info.by}, ${formatPause(elapsedMs)} so far) asks ${JSON.stringify(open.info.instruction)}. Call ${HUMAN_STEP_TOOL} with { "continue": true } to wait for it, then ask for the next step once it ended.`;
}

/** Why the step ended, in a sentence. */
function endText(ended: StepEnd, params: StepParams): string {
  switch (ended) {
    case "done":
      return "the person pressed Done";
    case "url":
      return `the tab's URL matched ${params.url}`;
    case "url-changed":
      return "the tab's URL changed";
    case "selector":
      return `${params.selector} is visible`;
    case "settled":
      return "the page's request settled";
    case "resumed":
      return `the person resumed the agent (Resume in the live view, or ${names().browser} resume)`;
    case "closed":
      return "the tab was closed";
    case "timeout":
      return `nothing ended the step within ${formatPause(params.timeoutMs)}`;
    case "cancelled":
      return "the call was cancelled";
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The result of a step: why it ended and what changed, never a value the person typed. */
export function stepResult(o: {
  params: StepParams;
  ended: StepEnd;
  waitedMs: number;
  url?: string | undefined;
  title?: string | undefined;
  lines: readonly string[];
  clicks: number;
  fields: number;
  liveInputs: number;
  targetClicked?: boolean;
  json: boolean;
}): ToolResult {
  const isError = o.ended === "timeout" || o.ended === "cancelled";
  const why = endText(o.ended, o.params);
  if (o.json) {
    const payload = {
      ...(isError ? { isError: true } : {}),
      ended: o.ended,
      reason: why,
      waitedMs: o.waitedMs,
      ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.title !== undefined ? { title: o.title } : {}),
      changes: o.lines,
      clicks: o.clicks,
      fieldsChanged: o.fields,
      liveViewInputs: o.liveInputs,
      ...(o.targetClicked !== undefined ? { targetClicked: o.targetClicked } : {}),
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError } : {}) };
  }
  const out = [isError ? "### Error" : "### Person step"];
  out.push(`The step ended after ${formatPause(o.waitedMs)}: ${why}.`);
  if (o.url !== undefined) out.push(`Current tab: ${o.url}${o.title ? ` (${JSON.stringify(o.title)})` : ""}`);
  out.push("While the person had the browser:");
  const lines = [...o.lines];
  if (o.clicks || o.fields)
    lines.push(
      `In the page, the person clicked ${plural(o.clicks, "time", "times")} and changed ${plural(o.fields, "field", "fields")} (what they typed is never read).`,
    );
  if (!lines.length) lines.push("Nothing changed in the browser's tabs, and the person made no input.");
  out.push(...lines.map((l) => `- ${l}`));
  if (o.targetClicked !== undefined)
    out.push(
      o.targetClicked ? "The person clicked the target themselves." : "The person did not click the target themselves.",
    );
  out.push("Take a snapshot before your next action: the refs of your last snapshot may point elsewhere now.");
  return { content: [{ type: "text", text: out.join("\n") }], ...(isError ? { isError } : {}) };
}
