import type { Page } from "patchright-core";
import type { StockAccess, TurnoTool } from "./tools.js";
import { type ToolResult, type ToolSchema, upstream } from "./upstream.js";

/**
 * `browser_batch`: several stock actions in one tool call. Each action runs through
 * the same path as a call of its own (the tab governor, the click diagnosis), but without the
 * page snapshot a stock action adds to its result; the batch returns one line per action and,
 * when asked, one snapshot after the last. It stops at the first action that fails, or whose
 * check fails (`expect`: text the page shows or no longer shows, a part of the URL, the value a
 * field holds), and returns a stable error code and the page as it was at the failure.
 *
 * It saves the model a round trip per action and the server an accessibility snapshot per
 * action (`bench/browser-roundtrips.mjs` measures both).
 */

/** Most actions in one batch. */
export const MAX_BATCH = 20;

/** Longest text kept from one action's result section. */
const RESULT_CHARS = 400;

/** How long a step's checks wait for the page by default. */
const CHECK_TIMEOUT_MS = 5_000;

/** The longest a step's checks may wait. */
const MAX_CHECK_TIMEOUT_MS = 30_000;

/** How often a waiting check looks at the page again. */
const CHECK_POLL_MS = 250;

/**
 * Why a step failed, as a stable code a script or an agent can branch on: the first word of the
 * step's error. A diagnosed element failure keeps its own code (`diagnose.ts`: ELEMENT_COVERED,
 * ELEMENT_HIDDEN, ELEMENT_DISABLED, ELEMENT_READONLY, ELEMENT_GONE, ELEMENT_NOT_STABLE); the batch
 * adds the others.
 */
export type StepErrorCode =
  | "ELEMENT_COVERED"
  | "ELEMENT_HIDDEN"
  | "ELEMENT_DISABLED"
  | "ELEMENT_READONLY"
  /** The target is not on the page (a stale ref, a selector that matches nothing). */
  | "ELEMENT_GONE"
  | "ELEMENT_NOT_STABLE"
  /** Nothing ran: a step names no tool of this server or has invalid arguments. */
  | "INVALID_ACTION"
  /** The action or a wait did not finish in time. */
  | "TIMEOUT"
  /** The identity's policy, the engine or the password field guard refused the step. */
  | "REFUSED"
  /** The action ran, and its `expect` did not hold. */
  | "CHECK_FAILED"
  | "ERROR";

const CODED = /^(ELEMENT_[A-Z_]+): /;

/** The code of a failed step's message: its own when it starts with one, else what it says. */
export function errorCode(message: string): StepErrorCode {
  const own = CODED.exec(message)?.[1];
  if (own) return own as StepErrorCode;
  if (/Ref \S+ not found|does not match any element|resolved to 0 elements/.test(message)) return "ELEMENT_GONE";
  if (/Timeout \d+ms exceeded|timed out/i.test(message)) return "TIMEOUT";
  if (/\brefused\b/.test(message)) return "REFUSED";
  return "ERROR";
}

/** A step's error, starting with its code. */
function coded(code: StepErrorCode, message: string): string {
  return CODED.test(message) ? message : `${code}: ${message}`;
}

/** What an action must leave on the page, checked after it runs. */
interface Expect {
  text?: string;
  gone?: string;
  url?: string;
  value?: string;
  timeout?: number;
}

/** A snapshot result's page URL and YAML. */
function pageOf(result: ToolResult): { url: string; yaml: string } {
  const text = textOf(result);
  const url = /^- Page URL: (.*)$/m.exec(text)?.[1] ?? "";
  const yaml = /```yaml\n([\s\S]*?)\n?```/.exec(text)?.[1] ?? "";
  return { url, yaml };
}

/** Whether a snapshot shows this text (names are written as JSON strings). */
function shows(yaml: string, text: string): boolean {
  return yaml.includes(text) || yaml.includes(JSON.stringify(text).slice(1, -1));
}

/**
 * The value the target holds now: "true" or "false" for a checkbox, radio or switch, the
 * selected options' labels for a select, else the field's value or the element's text.
 * Undefined when the target is not on the page.
 */
async function heldValue(page: Page, target: string): Promise<string | undefined> {
  const locator = /^(f\d+)?e\d+$/.test(target) ? page.getByRef(target) : page.locator(target);
  return locator
    .first()
    .evaluate(
      (el) => {
        const role = el.getAttribute("role");
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
          return String(el.checked);
        if (role === "checkbox" || role === "radio" || role === "switch")
          return String(el.getAttribute("aria-checked") === "true");
        if (el instanceof HTMLSelectElement) return [...el.selectedOptions].map((o) => o.label).join(", ");
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
        return el.textContent ?? "";
      },
      undefined,
      { timeout: 1_000 },
    )
    .catch(() => undefined);
}

/** The checks of `expect` that do not hold on this page, in words; empty when all hold. */
function unmet(
  check: Expect,
  target: string | undefined,
  page: { url: string; yaml: string },
  value: string | undefined,
): string[] {
  const out: string[] = [];
  if (check.text !== undefined && !shows(page.yaml, check.text)) out.push(`the page does not show "${check.text}"`);
  if (check.gone !== undefined && shows(page.yaml, check.gone)) out.push(`the page still shows "${check.gone}"`);
  if (check.url !== undefined && !page.url.includes(check.url))
    out.push(`the page URL is ${page.url || "unknown"}, without "${check.url}"`);
  if (check.value !== undefined && target !== undefined) {
    if (value === undefined) out.push(`${target} is no longer on the page`);
    else if (value !== check.value)
      out.push(`${target} holds ${JSON.stringify(value)}, not ${JSON.stringify(check.value)}`);
  }
  return out;
}

/** The sections of an upstream result text (`### Title` then the body). */
export function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(/^### /m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    out.set(part.slice(0, nl), part.slice(nl + 1).trim());
  }
  return out;
}

export function clip(text: string, max = RESULT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** What an action acted on, for its line: `browser_click e5`, `browser_navigate https://...`. */
function label(tool: string, args: Record<string, unknown>): string {
  const what = args.target ?? args.startTarget ?? args.url ?? args.key ?? args.action ?? args.text;
  return what === undefined ? tool : `${tool} ${clip(String(what), 80)}`;
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
}

function batchSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_batch",
    title: "Run several browser actions",
    description: [
      "Run several browser actions in order in one call, stopping at the first one that fails.",
      "Each action names a browser tool (browser_navigate, browser_click, browser_type, browser_select_option, browser_press_key, browser_hover, browser_wait_for, ...) and its arguments, exactly as that tool takes them.",
      "Returns one short line per action instead of a snapshot after each, and one page snapshot after the last action when snapshot is true.",
      "An action can carry expect: text the page must show after it, text it must no longer show (gone), a part of the URL, or the value its target field must hold; the checks wait up to timeout ms (default 5000).",
      "A failed action or check stops the batch; its error starts with a stable code (ELEMENT_GONE, ELEMENT_COVERED, ELEMENT_HIDDEN, ELEMENT_DISABLED, ELEMENT_READONLY, ELEMENT_NOT_STABLE, TIMEOUT, REFUSED, CHECK_FAILED, INVALID_ACTION, ERROR), and the result carries a snapshot of the page at the failure.",
      "Refs come from the snapshot taken before the batch: when an action changes the page, later refs may no longer exist, so batch actions on one page (filling a form) and take a snapshot after.",
    ].join(" "),
    inputSchema: z.object({
      actions: z
        .array(
          z.object({
            tool: z.string().describe("A browser tool name, for example browser_click"),
            arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, as it takes them"),
            expect: z
              .object({
                text: z.string().optional().describe("Text the page must show after the action"),
                gone: z.string().optional().describe("Text the page must no longer show after the action"),
                url: z.string().optional().describe("A part the page URL must contain after the action"),
                value: z
                  .string()
                  .optional()
                  .describe('The value the target must hold after the action ("true" or "false" for a checkbox)'),
                timeout: z
                  .number()
                  .optional()
                  .describe(
                    `How long the checks wait for the page, in ms (default ${CHECK_TIMEOUT_MS}, at most ${MAX_CHECK_TIMEOUT_MS})`,
                  ),
              })
              .optional()
              .describe("Checks after the action; a check that does not hold stops the batch"),
          }),
        )
        .min(1)
        .max(MAX_BATCH)
        .describe(`The actions, in order (at most ${MAX_BATCH})`),
      snapshot: z.boolean().optional().describe("Return a snapshot of the page after the last action (default false)"),
    }),
    type: "action",
  };
}

/** Waits up to the check's timeout for every check to hold; the ones that still do not, in words. */
async function check(stock: StockAccess, expect: Expect, target: string | undefined): Promise<string[]> {
  const end = Date.now() + Math.min(Math.max(expect.timeout ?? CHECK_TIMEOUT_MS, 0), MAX_CHECK_TIMEOUT_MS);
  for (;;) {
    const snap = await stock.call("browser_snapshot", {}, { snapshot: true });
    const page = stock.currentPage();
    const value =
      expect.value !== undefined && target !== undefined && page ? await heldValue(page, target) : undefined;
    const missed = snap.isError ? ["the page could not be read"] : unmet(expect, target, pageOf(snap), value);
    if (!missed.length || Date.now() >= end) return missed;
    await new Promise((r) => setTimeout(r, CHECK_POLL_MS));
  }
}

/** The tool. Its schema is built on first use, so importing the registry does not load the bundle. */
export function batchTool(): TurnoTool {
  let schema: ToolSchema | undefined;
  return {
    get schema() {
      schema ??= batchSchema();
      return schema;
    },
    async handle(ctx, params) {
      const actions = params.actions as { tool: string; arguments?: Record<string, unknown>; expect?: Expect }[];
      const stock = ctx.stock;
      if (!stock) throw new Error("browser_batch needs the browser host");
      // Check every action before running any, so a typo in the last one runs nothing.
      const problems: string[] = [];
      actions.forEach((a, i) => {
        const schema = stock.schemas.get(a.tool);
        if (!schema) {
          problems.push(
            `action ${i + 1}: "${a.tool}" is not a browser tool of this server${a.tool === "browser_batch" ? " (a batch cannot hold a batch)" : ""}`,
          );
          return;
        }
        const parsed = schema.safeParse(a.arguments ?? {});
        if (!parsed.success)
          problems.push(`action ${i + 1} (${a.tool}): invalid arguments: ${stock.formatError(parsed.error)}`);
        if (a.expect?.value !== undefined && typeof a.arguments?.target !== "string")
          problems.push(`action ${i + 1} (${a.tool}): expect.value needs the action's target`);
      });
      if (problems.length) {
        return {
          content: [{ type: "text", text: `### Error\nINVALID_ACTION: nothing ran.\n${problems.join("\n")}` }],
          isError: true,
        };
      }

      const lines: string[] = [];
      const attachments: ToolResult["content"] = [];
      const notes: string[] = [];
      let failure: string | undefined;
      for (const [i, a] of actions.entries()) {
        const args = a.arguments ?? {};
        const result = await stock.call(a.tool, args, { snapshot: false });
        const parts = sections(textOf(result));
        const governor = parts.get("Tab governor");
        if (governor) notes.push(governor);
        attachments.push(...result.content.filter((c) => c.type !== "text"));
        const left = actions.length - i - 1;
        const notRun = left ? `; the ${left === 1 ? "last action" : `last ${left} actions`} did not run` : "";
        if (result.isError) {
          const error = parts.get("Error") ?? textOf(result);
          const code = errorCode(error);
          lines.push(`${i + 1}. ${label(a.tool, args)}: failed (${code})`);
          failure = `Action ${i + 1} of ${actions.length} (${label(a.tool, args)}) failed${notRun}.\n${coded(code, error)}`;
          break;
        }
        if (a.expect) {
          const target = typeof args.target === "string" ? args.target : undefined;
          const missed = await check(stock, a.expect, target);
          if (missed.length) {
            lines.push(`${i + 1}. ${label(a.tool, args)}: ran, check failed (CHECK_FAILED)`);
            failure = `Action ${i + 1} of ${actions.length} (${label(a.tool, args)}) ran, but its check failed${notRun}.\nCHECK_FAILED: after ${a.expect.timeout ?? CHECK_TIMEOUT_MS} ms ${missed.join("; ")}.`;
            break;
          }
        }
        const res = parts.get("Result");
        lines.push(`${i + 1}. ${label(a.tool, args)}: ok${res ? `\n   ${clip(res).replace(/\n/g, "\n   ")}` : ""}`);
        const modal = parts.get("Modal state");
        if (modal) lines.push(`   ${clip(modal).replace(/\n/g, "\n   ")}`);
      }

      const out: string[] = [];
      if (failure) out.push("### Error", failure);
      out.push("### Batch", ...lines);
      // The page at the failure comes back with it, so the next step needs no snapshot call.
      if (params.snapshot === true || failure) {
        const snap = await stock.call("browser_snapshot", {}, { snapshot: true });
        const parts = sections(textOf(snap));
        const governor = parts.get("Tab governor");
        if (governor) notes.push(governor);
        for (const title of ["Open tabs", "Page", "Modal state", "Snapshot", "Events"]) {
          const body = parts.get(title);
          if (body) out.push(`### ${title}`, body);
        }
      } else {
        const page = await stock.page();
        if (page)
          out.push("### Page", `- Page URL: ${page.url}`, ...(page.title ? [`- Page Title: ${page.title}`] : []));
      }
      if (notes.length) out.push("### Tab governor", ...notes);
      return {
        content: [{ type: "text", text: out.join("\n") }, ...attachments],
        ...(failure ? { isError: true } : {}),
      };
    },
  };
}
