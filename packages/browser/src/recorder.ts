import type { Locator, Page } from "patchright-core";
import type { IdentityRef } from "./engine.js";
import {
  AUTO_PREFIX,
  type Flow,
  FlowError,
  type FlowParam,
  type FlowStep,
  type FlowLocator,
  type FlowTarget,
  FLOW_FORMAT_VERSION,
  MAX_FLOW_STEPS,
  assertFlowName,
  describeStep,
  flowPath,
  getPath,
  rotateAutoFlows,
  setPath,
  writeFlow,
} from "./flows.js";
import { existsSync } from "node:fs";
import { ActionCache, actionCachePath, differences, fingerprintOf, redactFingerprint, refusal } from "./fingerprint.js";
import type { Redactor } from "./redact.js";
import { secretField } from "./sensitive.js";
import type { TurnoTool } from "./tools.js";
import { type ToolSchema, upstream } from "./upstream.js";

/**
 * Flow recording. While a session records (the agent called `browser_record`, or the
 * identity has `record.flows`), every successful browser action is kept as a flow step, with
 * the element it acted on found again in several ways. The host calls `capture` before a stock
 * tool runs (the snapshot ref still points at the element then) and `commit` after it worked.
 *
 * Secrets never reach a flow file:
 *
 * - Typed text is always a parameter. It keeps what was typed as its default only when the
 *   field is not sensitive: a password field, an `autocomplete` of a password, a one-time code
 *   or a card, a field named like one (`password`, `otp`, `pin`, `cvv`, `token`...), or a value
 *   that is one of this server's vault values. The agent can mark more parameters sensitive
 *   when it stops a named recording, which is held in memory until then.
 * - `browser_login` is recorded as its site name; the values are read from the vault again
 *   at replay.
 * - Nothing else of a page (snapshots, results, values of other fields) is stored.
 */

/** How many flows an identity keeps that it recorded by itself. */
const KEEP_AUTO_FLOWS = 20;

/** The element arguments of each tool a flow records; `browser_fill_form` has one per field. */
const TARGETS: Record<string, readonly string[]> = {
  browser_navigate: [],
  browser_navigate_back: [],
  browser_navigate_forward: [],
  browser_reload: [],
  browser_click: ["target"],
  browser_hover: ["target"],
  browser_type: ["target"],
  browser_select_option: ["target"],
  browser_check: ["target"],
  browser_uncheck: ["target"],
  browser_drag: ["startTarget", "endTarget"],
  browser_press_key: [],
  browser_wait_for: [],
  browser_handle_dialog: [],
  browser_tabs: [],
  browser_file_upload: [],
  browser_fill_form: [],
};

/** True when a flow keeps calls of this tool. */
function recordsTool(name: string, args: Record<string, unknown>): boolean {
  if (!(name in TARGETS)) return false;
  // Listing tabs changes nothing.
  return !(name === "browser_tabs" && (args.action ?? "list") === "list");
}

/** What the page says about an element, for its locators and to tell a secret field. */
export interface ElementInfo {
  tag: string;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  text: string;
  css: string;
}

/** Playwright's attribute value syntax: `"Sign in"s` (exact) for role and text selectors. */
function quoteExact(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"s`;
}

/** A CSS string with its quotes escaped, for `:text-is()`. */
function quoteCss(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Role and accessible name from Playwright's generated locator when it is a role locator
 * (`internal:role=button[name="Sign in"i]`). Asking the element for its aria snapshot instead
 * would renumber the page's refs and break the call the agent is making.
 */
export function roleFromSelector(selector: string): { role: string; name?: string } | undefined {
  const m = /internal:role=([a-z]+)(?:\[name="((?:[^"\\]|\\.)*)"[is]?\])?$/.exec(selector);
  if (!m) return undefined;
  return { role: m[1]!, ...(m[2] ? { name: JSON.parse(`"${m[2]}"`) as string } : {}) };
}

const ROLE_SKIP = new Set(["generic", "text", "none", "presentation", "paragraph"]);

const REF = /^(f\d+)?e\d+$/;

/**
 * What the page says about an element, for its locators and to tell a secret field. Runs in the
 * page (a locator's evaluate, or teach mode's isolated world): it must stay self-contained.
 */
export function elementInfoInPage(el: Element): ElementInfo {
  const input = el as HTMLInputElement;
  const esc = (v: string) => CSS.escape(v);
  const unique = (sel: string) => {
    try {
      return el.ownerDocument.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  let css = "";
  const name = el.getAttribute("name");
  if (el.id && unique(`#${esc(el.id)}`)) css = `#${esc(el.id)}`;
  else if (name && unique(`${el.localName}[name="${esc(name)}"]`)) css = `${el.localName}[name="${esc(name)}"]`;
  else {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.localName !== "html") {
      if (node.id && unique(`#${esc(node.id)}`)) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      const tag: string = node.localName;
      const parent: Element | null = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === tag) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      node = parent;
    }
    css = parts.join(" > ");
  }
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  return {
    tag: el.localName,
    type: (input.type || "").toLowerCase(),
    autocomplete: el.getAttribute("autocomplete") ?? "",
    name: name ?? "",
    id: el.id,
    text: text.length <= 80 ? text : "",
    css,
  };
}

/**
 * The element a target names, found again four ways: Playwright's own locator for it, its role
 * and accessible name, its visible text and a CSS path. Elements in a frame keep the frame hop
 * Playwright's locator starts with. Undefined when the element is not on the page.
 */
async function captureTarget(
  page: Page,
  target: string,
  element: string | undefined,
): Promise<{ target: FlowTarget; info?: ElementInfo; label?: string } | undefined> {
  const isRef = REF.test(target);
  const description = element?.trim() || undefined;
  const out: FlowTarget = {
    ...(description ? { description } : {}),
    locators: [],
    ...(isRef ? { ref: target } : {}),
  };
  let locator: Locator;
  let generated: string | undefined;
  if (isRef) {
    locator = page.locator(`aria-ref=${target}`);
    try {
      generated = ((await locator.normalize()) as unknown as { _selector?: string })._selector;
    } catch {
      return undefined; // the ref is not in the current snapshot: upstream fails the call the same way
    }
  } else {
    // A selector or locator the agent wrote: upstream takes it again as is on replay.
    generated = target;
    try {
      locator = page.locator(target);
    } catch {
      return { target: { ...out, locators: [{ kind: "generated", selector: target }] } };
    }
  }
  let frame = "";
  if (generated) {
    out.locators.push({ kind: "generated", selector: generated });
    const hop = generated.lastIndexOf("internal:control=enter-frame >> ");
    if (hop >= 0) frame = generated.slice(0, hop + "internal:control=enter-frame >> ".length);
  }
  const aria = generated ? roleFromSelector(generated) : undefined;
  if (aria?.name && !ROLE_SKIP.has(aria.role))
    out.locators.push({ kind: "role", selector: `${frame}internal:role=${aria.role}[name=${quoteExact(aria.name)}]` });
  const info = await locator.evaluate(elementInfoInPage, undefined, { timeout: 2_000 }).catch(() => undefined);
  if (info) out.locators.push(...pageLocators(info, frame));
  out.locators = out.locators.filter((l, i) => out.locators.findIndex((m) => m.selector === l.selector) === i);
  const fingerprint = await fingerprintOf(locator, page.url());
  if (fingerprint) out.fingerprint = fingerprint;
  const label = aria?.name ?? info?.name ?? description;
  return { target: out, ...(info ? { info } : {}), ...(label ? { label } : {}) };
}

/** The text and CSS path locators of an element, after a frame hop when it is in a frame. */
function pageLocators(info: ElementInfo, frame = ""): FlowLocator[] {
  const out: FlowLocator[] = [];
  const field = ["input", "textarea", "select"].includes(info.tag);
  // The tag keeps the text from matching another element (a heading that reads like the button).
  if (info.text && !field)
    out.push({ kind: "text", selector: `${frame}css=${info.tag}:text-is(${quoteCss(info.text)})` });
  if (info.css) out.push({ kind: "css", selector: `${frame}css=${info.css}` });
  return out;
}

/**
 * The locators of an element read in the page (teach mode, with no snapshot ref): its role and
 * accessible name, its text and its CSS path, in replay's order.
 */
export function locatorsOf(role: string, name: string, info: ElementInfo): FlowLocator[] {
  return [
    ...(name && !ROLE_SKIP.has(role)
      ? [{ kind: "role" as const, selector: `internal:role=${role}[name=${quoteExact(name)}]` }]
      : []),
    ...pageLocators(info),
  ];
}

/** A typed value of a step, before each draft gives it a parameter name. */
export interface Slot {
  path: string;
  value: string;
  sensitive: boolean;
  /** No default either (a file to upload, given at replay). */
  noDefault?: boolean;
  label?: string;
  description?: string;
}

/** A step captured before its tool ran; committed only when the tool worked. */
export interface PendingStep {
  step: FlowStep;
  slots: Slot[];
  /** Why the action must not run: a selector the cache knows finds another element now. */
  refused?: string;
}

/** A parameter name from a field's label: "E-mail address" is `e_mail_address`. */
function paramBase(label: string | undefined): string {
  const slug = (label ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "text";
}

/** One flow being recorded (or taught, `teach.ts`). */
export class Draft {
  readonly params: FlowParam[] = [];
  readonly steps: FlowStep[] = [];
  readonly created = new Date().toISOString();
  full = false;
  constructor(
    readonly name: string,
    readonly description?: string,
  ) {}

  private param(slot: Slot): string {
    const base = paramBase(slot.label);
    let name = base;
    for (let n = 2; this.params.some((p) => p.name === name); n++) name = `${base}_${n}`;
    this.params.push({
      name,
      sensitive: slot.sensitive,
      ...(slot.sensitive || slot.noDefault ? {} : { default: slot.value }),
      ...(slot.description ? { description: slot.description } : {}),
    });
    return name;
  }

  /** Adds a step; false once the flow is full. */
  add(pending: PendingStep): boolean {
    if (this.steps.length >= MAX_FLOW_STEPS) {
      this.full = true;
      return false;
    }
    const step = structuredClone(pending.step);
    for (const slot of pending.slots) setPath(step.args, slot.path, { $param: this.param(slot) });
    this.steps.push(step);
    return true;
  }

  flow(identity: string): Flow {
    return {
      version: FLOW_FORMAT_VERSION,
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      identity,
      created: this.created,
      updated: new Date().toISOString(),
      params: this.params.map((p) => ({ ...p })),
      steps: this.steps.map((s) => structuredClone(s)),
    };
  }
}

/** The URL of a page without its query and fragment (they can carry tokens). */
export function plainUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return undefined;
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

/** The recorder of one MCP session. */
export class FlowRecorder {
  private named: Draft | undefined;
  private overwrite = false;
  private auto: Draft | undefined;
  private suspended = 0;

  /** The fingerprints of what the identity's actions worked on (`fingerprint.ts`). */
  readonly cache: ActionCache;

  constructor(
    private readonly identity: IdentityRef,
    private readonly redactor: Redactor,
    /** identity.json `record.flows`: record every session as `auto-<time>`. */
    private readonly autoFlows: () => boolean,
  ) {
    this.cache = ActionCache.for(actionCachePath(identity.id, identity.env), redactor);
  }

  /** True when a step would be kept now. */
  get active(): boolean {
    return this.suspended === 0 && (this.named !== undefined || this.autoFlows());
  }

  get recording(): { name: string; steps: number; params: number; full: boolean } | undefined {
    const d = this.named;
    return d && { name: d.name, steps: d.steps.length, params: d.params.length, full: d.full };
  }

  start(name: string, description: string | undefined, overwrite: boolean): void {
    assertFlowName(name);
    if (name.startsWith(AUTO_PREFIX))
      throw new FlowError(`flow names starting with "${AUTO_PREFIX}" are kept for the identity's own recordings`);
    if (this.named) throw new FlowError(`already recording flow "${this.named.name}"; stop or cancel it first`);
    if (!overwrite && existsSync(flowPath(this.identity.id, name, this.identity.env)))
      throw new FlowError(`flow "${name}" exists; pass overwrite: true to replace it, or pick another name`);
    this.named = new Draft(name, description);
    this.overwrite = overwrite;
  }

  /** Saves the named flow, with `sensitive` parameters' values dropped. */
  stop(sensitive: readonly string[] = [], description?: string): { flow: Flow; file: string } {
    const draft = this.named;
    if (!draft) throw new FlowError("no flow is being recorded; start one with action start");
    const unknown = sensitive.filter((s) => !draft.params.some((p) => p.name === s));
    if (unknown.length)
      throw new FlowError(
        `no parameter ${unknown.map((u) => `"${u}"`).join(", ")} in this flow (its parameters: ${draft.params.map((p) => p.name).join(", ") || "none"})`,
      );
    if (!draft.steps.length)
      throw new FlowError("the flow has no steps yet; nothing was saved (cancel it, or act first)");
    const flow = draft.flow(this.identity.id);
    if (description) flow.description = description;
    for (const p of flow.params)
      if (sensitive.includes(p.name)) {
        p.sensitive = true;
        delete p.default;
      }
    if (!this.overwrite && existsSync(flowPath(this.identity.id, flow.name, this.identity.env)))
      throw new FlowError(`flow "${flow.name}" was saved by someone else meanwhile; stop with another name`);
    const file = writeFlow(this.identity.id, flow, this.identity.env);
    this.named = undefined;
    return { flow, file };
  }

  cancel(): boolean {
    const had = this.named !== undefined;
    this.named = undefined;
    return had;
  }

  /** Runs `fn` without recording its steps (a replay is recorded as one step). */
  async suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.suspended++;
    try {
      return await fn();
    } finally {
      this.suspended--;
    }
  }

  /** A stock tool call about to run, as a step; undefined when it is not one a flow keeps. */
  async capture(tool: string, args: Record<string, unknown>, page: Page | undefined): Promise<PendingStep | undefined> {
    if (!this.active || !recordsTool(tool, args)) return undefined;
    const { element: _element, startElement: _start, endElement: _end, ...rest } = args;
    const step: FlowStep = { tool, args: structuredClone(rest) };
    const slots: Slot[] = [];
    const paths =
      tool === "browser_fill_form" && Array.isArray(args.fields)
        ? (args.fields as unknown[]).map((_, i) => `fields.${i}.target`)
        : (TARGETS[tool] ?? []);
    const describedBy: Record<string, string | undefined> = {
      target: args.element as string | undefined,
      startTarget: args.startElement as string | undefined,
      endTarget: args.endElement as string | undefined,
    };
    const infos: Record<string, { info?: ElementInfo; label?: string }> = {};
    let refused: string | undefined;
    for (const path of paths) {
      const value = getPath(args, path);
      if (typeof value !== "string" || !page) return undefined;
      const fieldName = path.startsWith("fields.")
        ? (getPath(args, path.replace(/target$/, "name")) as string)
        : undefined;
      const captured = await captureTarget(page, value, describedBy[path] ?? fieldName);
      if (!captured) return undefined;
      const fp = captured.target.fingerprint;
      if (fp) captured.target.fingerprint = redactFingerprint(fp, this.redactor);
      // A locator that names the element by a vault value (a signed-in user's name on a button)
      // is not kept: the flow and the action cache never hold one.
      captured.target.locators = captured.target.locators.filter((l) => !this.redactor.covers(l.selector));
      // A selector the agent wrote (a repeated step from a batch or a shell): the element it
      // finds now must be the one the cache saw an action work on under that selector.
      const known = REF.test(value) ? undefined : this.cache.get(page.url(), value);
      if (known && captured.target.fingerprint) {
        const diffs = differences(known, captured.target.fingerprint);
        this.cache.count(page.url(), value, diffs.length === 0);
        if (diffs.length) refused = refusal(value, diffs);
      }
      step.targets ??= {};
      step.targets[path] = captured.target;
      infos[path] = { ...(captured.info ? { info: captured.info } : {}), label: fieldName ?? captured.label };
    }
    // Drop the emptied target keys so the step's args are only what replay passes again.
    for (const path of paths) {
      const keys = path.split(".");
      const holder = keys.length > 1 ? getPath(step.args, keys.slice(0, -1).join(".")) : step.args;
      if (holder && typeof holder === "object") delete (holder as Record<string, unknown>)[keys[keys.length - 1]!];
    }
    const typed = (path: string, value: unknown, at: string) => {
      if (typeof value !== "string") return;
      const meta = infos[at];
      const sensitive = (meta?.info ? secretField(meta.info) : false) || this.redactor.covers(value);
      slots.push({
        path,
        value,
        sensitive,
        ...(meta?.label ? { label: meta.label } : {}),
        ...(step.targets?.[at]?.description ? { description: step.targets[at]!.description } : {}),
      });
    };
    if (tool === "browser_type") typed("text", args.text, "target");
    if (tool === "browser_handle_dialog" && typeof args.promptText === "string") {
      slots.push({
        path: "promptText",
        value: args.promptText,
        sensitive: this.redactor.covers(args.promptText),
        label: "prompt",
      });
    }
    if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
      (args.fields as { type?: string; value?: unknown }[]).forEach((f, i) => {
        // A checkbox or radio value is "true" or "false": part of the flow, not a parameter.
        if (f.type === "checkbox" || f.type === "radio") return;
        typed(`fields.${i}.value`, f.value, `fields.${i}.target`);
      });
    }
    const url = page ? plainUrl(page.url()) : undefined;
    if (url) step.url = url;
    return { step, slots, ...(refused ? { refused } : {}) };
  }

  /** Keeps a captured step after its tool worked, and what each of its targets was. */
  commit(pending: PendingStep): void {
    if (!this.active) return;
    for (const target of Object.values(pending.step.targets ?? {}))
      if (target.fingerprint)
        // A CSS path also under its plain form: the selector an agent or a shell writes again.
        this.cache.remember(
          target.fingerprint,
          target.locators.flatMap((l) =>
            l.kind === "css" && l.selector.startsWith("css=") ? [l.selector, l.selector.slice(4)] : [l.selector],
          ),
        );
    this.named?.add(pending);
    if (this.autoFlows()) this.commitAuto(pending);
  }

  /** A turno tool as a step: `browser_login` (site only) or `browser_replay` (its flow and parameters). */
  record(tool: "browser_login" | "browser_replay", args: Record<string, unknown>, slots: Slot[] = []): void {
    this.commit({ step: { tool, args: structuredClone(args) }, slots });
  }

  private commitAuto(pending: PendingStep): void {
    if (!this.auto) {
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      this.auto = new Draft(`${AUTO_PREFIX}${stamp}`, "recorded by the identity (record.flows)");
    }
    if (!this.auto.add(pending)) return;
    try {
      writeFlow(this.identity.id, this.auto.flow(this.identity.id), this.identity.env);
      if (this.auto.steps.length === 1) rotateAutoFlows(this.identity.id, KEEP_AUTO_FLOWS, this.identity.env);
    } catch {
      /* best effort: a full disk must not break a tool call */
    }
  }
}

function recordSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_record",
    title: "Record browser actions as a flow",
    description: [
      "Record the browser actions of this session as a named flow that browser_replay can run again later without working the page out.",
      "action start begins recording (name required); every browser action that works from then on is kept: navigate, click, type, fill_form, select_option, press_key, hover, drag, tabs, wait_for, browser_login (the site only) and browser_replay.",
      "action stop saves the flow; list in sensitive the parameters whose values must not be kept (password fields, one-time codes and vault sign-ins are never kept anyway). action cancel drops it; action status says what is recording.",
      "Typed text becomes a parameter of the flow, with what you typed as its default unless it is sensitive.",
    ].join(" "),
    inputSchema: z.object({
      action: z.string().describe('"start", "stop", "cancel" or "status"'),
      name: z
        .string()
        .optional()
        .describe("The flow name for start: lowercase letters, digits, - and _ (for example submit-timesheet)"),
      description: z.string().optional().describe("What the flow does, for start or stop"),
      sensitive: z.array(z.string()).optional().describe("For stop: parameter names whose values must not be saved"),
      overwrite: z.boolean().optional().describe("For start: replace a saved flow of the same name"),
    }),
    type: "action",
  };
}

/** `browser_record`. */
export function recordTool(): TurnoTool {
  let built: ToolSchema | undefined;
  return {
    get schema() {
      built ??= recordSchema();
      return built;
    },
    browser: false,
    async handle(ctx, params) {
      const recorder = ctx.recorder;
      if (!recorder)
        throw new FlowError("browser_record needs a browser identity: this server runs without --identity");
      const action = String(params.action);
      const text = (lines: string[]) => ({
        content: [{ type: "text" as const, text: ["### Result", ...lines].join("\n") }],
      });
      if (action === "start") {
        if (typeof params.name !== "string")
          throw new FlowError('action start needs a name, for example "submit-timesheet"');
        recorder.start(params.name, params.description as string | undefined, params.overwrite === true);
        return text([
          `Recording flow "${params.name}". Browser actions that work are kept from now on; call browser_record with action "stop" to save it.`,
        ]);
      }
      if (action === "stop") {
        const { flow, file } = recorder.stop(
          (params.sensitive as string[] | undefined) ?? [],
          params.description as string | undefined,
        );
        const params_ = flow.params.map(
          (p) => `- ${p.name}${p.sensitive ? " (sensitive: not saved, give it at replay)" : ` (default kept)`}`,
        );
        return text([
          `Saved flow "${flow.name}" with ${flow.steps.length} step${flow.steps.length === 1 ? "" : "s"} to ${file}.`,
          ...flow.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
          ...(params_.length ? ["Parameters:", ...params_] : []),
          `Run it again with browser_replay {"flow": "${flow.name}"}.`,
        ]);
      }
      if (action === "cancel")
        return text([
          recorder.cancel() ? "Dropped the flow being recorded; nothing was saved." : "No flow was being recorded.",
        ]);
      if (action === "status") {
        const r = recorder.recording;
        return text([
          r
            ? `Recording flow "${r.name}": ${r.steps} step${r.steps === 1 ? "" : "s"}, ${r.params} parameter${r.params === 1 ? "" : "s"}${r.full ? " (full: later steps are not kept)" : ""}.`
            : "No named flow is being recorded.",
        ]);
      }
      throw new FlowError(`unknown action "${action}": use start, stop, cancel or status`);
    },
  };
}
