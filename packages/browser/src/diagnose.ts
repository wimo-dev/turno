import type { Locator, Page } from "patchright-core";
import type { ToolResult } from "./upstream.js";

/**
 * Click and type errors that say what is in the way. When an action on an element
 * fails because the element cannot take it, Playwright retries until the action timeout and
 * then reports "Timeout 5000ms exceeded" with a call log, which leaves the agent guessing. The
 * host looks at the target once, after the failure, and replaces the error with one that names
 * the element in the way, or the state of the target, and the next step.
 *
 * One case is checked before the call too (`coveredBeforeCall`): a target in view that another
 * element covers, such as a cookie banner over the page. When the same element still covers it
 * a moment later, the call does not run and the agent hears which element is in the way at
 * once, instead of after the 5 second action timeout. That check costs one look at the target
 * per call; it scrolls only a target out of view, to where Playwright would scroll it.
 *
 * Every message starts with a stable code (`FailureCode`), and the JSON form carries it as `code`.
 */

/** The stock tools whose failures are diagnosed, with the verb for the message. */
const DIAGNOSED_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  browser_click: "click",
  browser_hover: "hover over",
  browser_type: "type into",
  browser_select_option: "select an option in",
  browser_drag: "drag",
});

/** An element as the message names it. */
interface ElementInfo {
  role: string;
  name: string;
  /** A short CSS selector: `#id`, `[data-testid=...]` or `tag.class`. */
  selector: string;
}

export type Diagnosis =
  | { state: "covered"; target: ElementInfo; cover: ElementInfo; buttons: string[] }
  | { state: "hidden"; target: ElementInfo; because?: ElementInfo }
  | { state: "disabled"; target: ElementInfo }
  | { state: "readonly"; target: ElementInfo }
  /** `outside`: the look did not scroll and the target is out of view, so it could not hit-test it. */
  | { state: "ok"; target: ElementInfo; outside?: true };

/** True for the failures a look at the element can explain: actionability timeouts. */
export function isActionabilityFailure(text: string): boolean {
  if (/Ref \S+ not found in the current page snapshot/.test(text)) return false;
  return /Timeout \d+ms exceeded|intercepts pointer events|element is not (visible|enabled|editable|stable)|outside of the viewport/.test(
    text,
  );
}

/**
 * Runs in the page, on the target element: what keeps an action from it. Self-contained, as
 * Playwright serializes it.
 */
function inspect(el: Element, scroll = true): Diagnosis {
  const clean = (s: string | null | undefined, max = 60) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 3)}...` : t;
  };
  const roleOf = (e: Element): string => {
    const explicit = e.getAttribute("role");
    if (explicit) return explicit.split(" ")[0]!;
    const tag = e.tagName.toLowerCase();
    if (tag === "a") return e.hasAttribute("href") ? "link" : "generic";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "dialog") return "dialog";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (e.getAttribute("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      return "textbox";
    }
    const landmarks: Record<string, string> = {
      nav: "navigation",
      header: "banner",
      footer: "contentinfo",
      main: "main",
      aside: "complementary",
      form: "form",
    };
    return landmarks[tag] ?? "generic";
  };
  const nameOf = (e: Element): string => {
    const label = e.getAttribute("aria-label");
    if (label) return clean(label);
    const by = e.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(text)) return clean(text);
    }
    if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement) {
      const labelText = e.labels?.[0]?.textContent;
      if (clean(labelText)) return clean(labelText);
      if (e instanceof HTMLInputElement && ["button", "submit", "reset"].includes(e.type) && e.value)
        return clean(e.value);
      const placeholder = e.getAttribute("placeholder");
      if (placeholder) return clean(placeholder);
    }
    const alt = e.getAttribute("alt") ?? e.getAttribute("title");
    if (alt) return clean(alt);
    return clean(e.textContent);
  };
  const selectorOf = (e: Element): string => {
    const tag = e.tagName.toLowerCase();
    if (e.id && /^[A-Za-z][\w-]*$/.test(e.id) && document.querySelectorAll(`#${e.id}`).length === 1)
      return `${tag}#${e.id}`;
    for (const attr of ["data-testid", "data-test", "data-qa", "name"]) {
      const v = e.getAttribute(attr);
      if (v && v.length <= 40 && !/["\\\]]/.test(v)) return `${tag}[${attr}="${v}"]`;
    }
    const classes = [...e.classList].filter((c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length <= 30).slice(0, 2);
    return classes.length ? `${tag}.${classes.join(".")}` : tag;
  };
  const describe = (e: Element) => ({ role: roleOf(e), name: nameOf(e), selector: selectorOf(e) });
  const target = describe(el);

  const disabled =
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    !!el.closest("fieldset[disabled]");
  if (disabled) return { state: "disabled", target };

  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const visible =
    box.width > 0 &&
    box.height > 0 &&
    style.visibility !== "hidden" &&
    (el.checkVisibility ? el.checkVisibility({ opacityProperty: false }) : true);
  if (!visible) {
    // The ancestor that hides it, when it is not the element itself.
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === "none" || s.visibility === "hidden" || s.contentVisibility === "hidden")
        return { state: "hidden", target, because: describe(a) };
    }
    return { state: "hidden", target };
  }

  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly)
    return { state: "readonly", target };

  if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Without scrolling, a center outside the viewport cannot be hit-tested: nothing to say yet.
  if (!scroll && (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight))
    return { state: "ok", target, outside: true };
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  const inside = (e: Element | null): boolean => {
    for (let n: Node | null = e; n; n = n instanceof ShadowRoot ? n.host : n.parentNode) if (n === el) return true;
    return false;
  };
  if (!hit || inside(hit)) return { state: "ok", target };

  // The covering element: the outermost ancestor of what was hit that does not hold the target
  // (the cookie banner, not the paragraph inside it).
  let cover: Element = hit;
  while (
    cover.parentElement &&
    cover.parentElement !== document.body &&
    cover.parentElement !== document.documentElement &&
    !cover.parentElement.contains(el)
  ) {
    cover = cover.parentElement;
  }
  const buttons = [
    ...cover.querySelectorAll('button, [role="button"], a[href], input[type="button"], input[type="submit"]'),
  ]
    .filter((b) => (b as HTMLElement).offsetParent !== null || getComputedStyle(b).position === "fixed")
    .map(nameOf)
    .filter((n) => n)
    .slice(0, 3);
  return { state: "covered", target, cover: describe(cover), buttons };
}

/** The target of a stock call as a locator: a snapshot ref (`e5`, `f1e5`) or a selector. */
function locatorOf(page: Page, target: string): Locator {
  return /^(f\d+)?e\d+$/.test(target) ? page.getByRef(target) : page.locator(target);
}

/** Looks at the target of a failed call. Undefined when it cannot be found (it is gone). */
async function diagnoseTarget(page: Page, target: string): Promise<Diagnosis | undefined> {
  try {
    return await locatorOf(page, target).first().evaluate(inspect, undefined, { timeout: 1_000 });
  } catch {
    return undefined;
  }
}

/**
 * The stable code of a diagnosed failure, the first word of its message and the `code` of its JSON
 * form: an agent or a script can branch on it without reading the prose, which may change.
 */
type FailureCode =
  | "ELEMENT_COVERED"
  | "ELEMENT_HIDDEN"
  | "ELEMENT_DISABLED"
  | "ELEMENT_READONLY"
  | "ELEMENT_GONE"
  | "ELEMENT_NOT_STABLE";

function failureCode(d: Diagnosis | undefined): FailureCode {
  if (!d) return "ELEMENT_GONE";
  switch (d.state) {
    case "covered":
      return "ELEMENT_COVERED";
    case "hidden":
      return "ELEMENT_HIDDEN";
    case "disabled":
      return "ELEMENT_DISABLED";
    case "readonly":
      return "ELEMENT_READONLY";
    case "ok":
      return "ELEMENT_NOT_STABLE";
  }
}

function named(e: ElementInfo): string {
  return `${e.role}${e.name ? ` "${e.name}"` : ""} (${e.selector})`;
}

/** The agent-facing message for a diagnosed failure: its code, what is wrong, and the next step. */
export function failureMessage(tool: string, target: string, d: Diagnosis | undefined, original: string): string {
  return `${failureCode(d)}: ${explanation(tool, target, d, original)}`;
}

function explanation(tool: string, target: string, d: Diagnosis | undefined, original: string): string {
  const verb = DIAGNOSED_TOOLS[tool] ?? "act on";
  const first = original.split("\n").find((l) => l.trim()) ?? original;
  const detail = original.startsWith("the call did not run") ? `turno: ${first.trim()}` : `Playwright: ${first.trim()}`;
  if (!d) {
    return [
      `Could not ${verb} ${target}: the element is no longer on the page.`,
      `Next: take a new snapshot (browser_snapshot) and use the ref it shows now.`,
      detail,
    ].join("\n");
  }
  const what = `${named(d.target)}, ${target}`;
  switch (d.state) {
    case "covered":
      return [
        `Could not ${verb} ${what}: ${named(d.cover)} covers it and would get the click instead.`,
        d.buttons.length
          ? `Next: close or answer that element first (it has ${d.buttons.map((b) => `"${b}"`).join(", ")}), then try again; take a new snapshot if the page changed.`
          : "Next: close or scroll past that element first, then try again; take a new snapshot if the page changed.",
        detail,
      ].join("\n");
    case "hidden":
      return [
        `Could not ${verb} ${what}: it is not visible${d.because ? ` (${named(d.because)} hides it)` : ""}.`,
        "Next: open the menu, tab or section that holds it (or wait for it with browser_wait_for), then take a new snapshot and try again.",
        detail,
      ].join("\n");
    case "disabled":
      return [
        `Could not ${verb} ${what}: it is disabled.`,
        "Next: do what enables it first (fill in the required fields, accept the terms), or wait for it with browser_wait_for, then try again.",
        detail,
      ].join("\n");
    case "readonly":
      return [
        `Could not ${verb} ${what}: it is read-only.`,
        "Next: look for the control that sets this value (a picker, a select, an edit button).",
        detail,
      ].join("\n");
    case "ok":
      return [
        `Could not ${verb} ${what} in time, although it is visible, enabled and not covered now: it was probably moving or covered for a moment.`,
        "Next: try again once; if it fails again, take a new snapshot.",
        detail,
      ].join("\n");
  }
}

/** How long a cover must stay before the call is refused: an overlay fading out is let through. */
const COVER_STABLE_MS = 300;

/**
 * The error text of a diagnosed call, in the shape the call asked for. The JSON form carries the
 * code and, for a covered target, the element in the way.
 */
function errorText(message: string, d: Diagnosis | undefined, json: boolean): string {
  if (!json) return `### Error\n${message}`;
  const cover = d?.state === "covered" ? { cover: d.cover } : {};
  return JSON.stringify({ isError: true, code: failureCode(d), error: message, ...cover }, null, 2);
}

/** The target of a diagnosed call, as its arguments name it. */
function targetOf(args: Record<string, unknown>): string {
  return String(args.target ?? args.startTarget ?? "");
}

/** One look at a target; undefined when it is not exactly one element or the look fails. */
async function lookAt(page: Page, target: string, scroll = false): Promise<Diagnosis | undefined> {
  try {
    const locator = locatorOf(page, target);
    if ((await locator.count()) !== 1) return undefined;
    return await locator.evaluate(inspect, scroll, { timeout: 500 });
  } catch {
    return undefined;
  }
}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function coveredError(tool: string, target: string, d: Diagnosis, why: string, json: boolean): ToolResult {
  const message = failureMessage(tool, target, d, why);
  return { isError: true, content: [{ type: "text", text: errorText(message, d, json) }] };
}

/**
 * Before a diagnosed call: when another element covers its target, now and `COVER_STABLE_MS`
 * later, the error that names that element; undefined (run the call) otherwise. A target out of
 * view is scrolled to the middle of the viewport first, as Playwright's action would do, so a
 * full-page banner over a button below the fold is named too. Anything this check cannot tell (a
 * target not found yet, in a frame) is left to Playwright and the diagnosis after it.
 */
export async function coveredBeforeCall(
  page: Page | undefined,
  tool: string,
  args: Record<string, unknown>,
  json: boolean,
  wait: (ms: number) => Promise<void> = defaultWait,
): Promise<ToolResult | undefined> {
  if (!page || !(tool in DIAGNOSED_TOOLS)) return undefined;
  const target = targetOf(args);
  if (!target) return undefined;
  let first = await lookAt(page, target);
  if (first?.state === "ok" && first.outside) first = await lookAt(page, target, true);
  if (first?.state !== "covered") return undefined;
  await wait(COVER_STABLE_MS);
  const again = await lookAt(page, target);
  if (again?.state !== "covered" || again.cover.selector !== first.cover.selector) return undefined;
  return coveredError(tool, target, again, "the call did not run: the target is covered", json);
}

/**
 * Rewrites the error of a failed stock call when it is an actionability failure of a diagnosed
 * tool; returns the result as it was otherwise.
 */
export async function explainFailure(
  page: Page | undefined,
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
  json: boolean,
): Promise<ToolResult> {
  if (!result.isError || !page || !(tool in DIAGNOSED_TOOLS)) return result;
  const first = result.content[0];
  if (!first || first.type !== "text") return result;
  const text = (first as { text: string }).text;
  let original = text.replace(/^### Error\n/, "");
  if (json) {
    try {
      original = String((JSON.parse(text) as { error?: unknown }).error ?? text);
    } catch {
      /* keep the raw text */
    }
  }
  if (!isActionabilityFailure(original)) return result;
  const target = targetOf(args);
  if (!target) return result;
  const d = await diagnoseTarget(page, target);
  const message = failureMessage(tool, target, d, original);
  return { ...result, content: [{ type: "text", text: errorText(message, d, json) }, ...result.content.slice(1)] };
}
