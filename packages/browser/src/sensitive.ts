import type { Frame, Page } from "patchright-core";

/**
 * Sensitive fields: the one classifier for the inputs whose value the model must never read
 * or write, shared by the host (snapshots, results, the refusal of `browser_type`), flow
 * recording and natural language actions.
 *
 * - `password` and `one-time code` are the sensitive fields: an input of type password, an
 *   `autocomplete` of `current-password`, `new-password` or `one-time-code`, or a name or id
 *   that reads like one (`password`, `passcode`, `otp`, `totp`, `2fa`, `mfa`, `oneTimeCode`). The
 *   host masks their values in every snapshot, hides them in every result, and refuses an agent
 *   that types into them: the person types those, or `browser_login` fills them from the vault.
 * - `card` and `secret` (a card number, a PIN, a field named like a token or a secret) are
 *   never kept in a flow and never sent to a natural language model, but the agent may fill them.
 *
 * The page is read once per frame (open shadow roots included); the values never leave this
 * process except as the redactor's placeholders.
 */

export type FieldKind = "password" | "one-time code" | "card" | "secret";

/** What the page says about an input, enough to classify it. */
export interface FieldInfo {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
}

/** An input of the page with a value, as `pageFields` reads it. */
export interface PageField extends FieldInfo {
  value: string;
  /** The snapshot ref Playwright gave the element (`e12`, `f1e3`), when it is in a snapshot. */
  ref?: string;
  kind?: FieldKind;
}

/** What a masked value reads in a snapshot. */
export const SENSITIVE_MARK = "[sensitive field]";

const PASSWORD_AUTOCOMPLETE = /(^|\s)(current-password|new-password)(\s|$)/i;
const CODE_AUTOCOMPLETE = /(^|\s)one-time-code(\s|$)/i;
const CARD_AUTOCOMPLETE = /(^|\s)(cc-number|cc-csc|cc-exp(-month|-year)?)(\s|$)/i;
/** Broad on purpose: a flow never keeps what was typed into a field named like this. */
const SECRET_NAME = /pass(word|wd|code)?|pwd|otp|totp|2fa|mfa|(^|[^a-z])pin([^a-z]|$)|cvv|cvc|csc|secret|token|ssn/i;
const PASSWORD_WORD = /^(pass|pwd|passwd|passcode|passphrase)$|password/;
const CODE_WORDS = new Set(["otp", "totp", "hotp", "2fa", "mfa", "tfa", "onetime"]);

/** The words of a name: `newPassword`, `new-password` and `new_password` are `new password`. */
export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function nameKind(name: string): FieldKind | undefined {
  const words = wordsOf(name);
  if (words.some((w) => PASSWORD_WORD.test(w))) return "password";
  if (words.some((w) => CODE_WORDS.has(w))) return "one-time code";
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === "one" && words[i + 1] === "time") return "one-time code";
  return undefined;
}

/** The kind of a field, or undefined when its value is nobody's secret. */
export function fieldKind(info: FieldInfo): FieldKind | undefined {
  if (info.type.toLowerCase() === "password") return "password";
  if (PASSWORD_AUTOCOMPLETE.test(info.autocomplete)) return "password";
  if (CODE_AUTOCOMPLETE.test(info.autocomplete)) return "one-time code";
  if (CARD_AUTOCOMPLETE.test(info.autocomplete)) return "card";
  const named = nameKind(info.name) ?? nameKind(info.id);
  if (named) return named;
  return SECRET_NAME.test(`${info.name} ${info.id}`) ? "secret" : undefined;
}

/** A field whose typed value must never be stored (a flow, a natural language prompt). */
export function secretField(info: FieldInfo): boolean {
  return fieldKind(info) !== undefined;
}

/** A field only the person or the vault fills, whose value no result shows. */
function sensitiveKind(kind: FieldKind | undefined): kind is "password" | "one-time code" {
  return kind === "password" || kind === "one-time code";
}

/** Most fields read in one frame; a page with more is not a form anyone signs in with. */
const MAX_FIELDS = 500;

/** Every input and textarea of one frame with a value, open shadow roots included. */
function readFrame(frame: Frame): Promise<PageField[]> {
  return frame.evaluate((max: number) => {
    const out: {
      type: string;
      autocomplete: string;
      name: string;
      id: string;
      value: string;
      ref?: string;
    }[] = [];
    const skip = new Set(["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"]);
    const walk = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (out.length >= max) return;
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") continue;
        const field = el as HTMLInputElement;
        const type = (field.type || "").toLowerCase();
        if (!field.value || skip.has(type)) continue;
        // The ref Playwright's snapshot gave this element, so the host can mask that line.
        const ref = (el as unknown as { _ariaRef?: { ref?: unknown } })._ariaRef?.ref;
        out.push({
          type,
          autocomplete: field.getAttribute("autocomplete") ?? "",
          name: field.getAttribute("name") ?? "",
          id: field.id,
          value: field.value,
          ...(typeof ref === "string" ? { ref } : {}),
        });
      }
    };
    walk(document);
    return out;
  }, MAX_FIELDS);
}

/**
 * The inputs with a value in every frame of `page` and the kind of each: one evaluate per
 * frame, in parallel. A frame that cannot be read (navigating, detached) is skipped.
 */
export async function pageFields(page: Page): Promise<PageField[]> {
  const frames = await Promise.all(page.frames().map((f) => readFrame(f).catch(() => [] as PageField[])));
  return frames.flat().map((f) => {
    const kind = fieldKind(f);
    return kind ? { ...f, kind } : f;
  });
}

/** The sensitive fields (`sensitiveKind`) of `page` that hold a value. */
export async function sensitiveFields(page: Page): Promise<PageField[]> {
  return (await pageFields(page)).filter((f) => sensitiveKind(f.kind));
}

const REF = /^(f\d+)?e\d+$/;

/**
 * An aria snapshot (`mode: "ai"`) with the value of each element in `refs` replaced by
 * `SENSITIVE_MARK`: `- textbox "Password" [ref=e6]: hunter2` reads
 * `- textbox "Password" [ref=e6]: [sensitive field]`, whatever the length of the value.
 */
export function maskSnapshot(text: string, refs: ReadonlySet<string>): string {
  if (!refs.size || !text) return text;
  return text.replace(
    /^(\s*- [^\n]*?\[ref=((?:f\d+)?e\d+)\](?: \[[^\]\n]*\])*):( .*)?$/gm,
    (line, head: string, ref: string, value: string | undefined) =>
      refs.has(ref) && value !== undefined ? `${head}: ${SENSITIVE_MARK}` : line,
  );
}

/** The same masking on the JSON form of an aria snapshot (`ariaSnapshotJSON`). */
export function maskSnapshotJSON<T>(json: T, refs: ReadonlySet<string>): T {
  if (!refs.size) return json;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const out: Record<string, unknown> = { ...n };
    const masked = typeof n.ref === "string" && refs.has(n.ref);
    if (masked) {
      if ("text" in n) out.text = SENSITIVE_MARK;
      if ("value" in n) out.value = SENSITIVE_MARK;
    }
    if (Array.isArray(n.children))
      out.children = n.children.map((c) => (masked && typeof c === "string" ? SENSITIVE_MARK : walk(c)));
    return out;
  };
  return walk(json) as T;
}

/** The refs of the sensitive fields among `fields`. */
function sensitiveRefs(fields: readonly PageField[]): Set<string> {
  return new Set(fields.filter((f) => sensitiveKind(f.kind) && f.ref && REF.test(f.ref)).map((f) => f.ref!));
}

/**
 * Makes every aria snapshot of `page` mask its sensitive fields: Playwright MCP takes the page
 * snapshot of a tool result with `page.ariaSnapshot` (or `ariaSnapshotJSON` in JSON mode), and
 * writes it to a file or puts it in the result right after. The fields are read after the
 * snapshot, so the refs are the ones it just gave; `onFields` hears them first (the host's
 * redactor learns the values, for the rest of the result). Undone with the returned function.
 */
export function maskSnapshots(page: Page, onFields: (fields: PageField[]) => void): () => void {
  type Snap = (options?: Record<string, unknown>) => Promise<unknown>;
  const target = page as unknown as { ariaSnapshot: Snap; ariaSnapshotJSON?: Snap };
  const text = target.ariaSnapshot;
  const json = target.ariaSnapshotJSON;
  const read = async (): Promise<Set<string>> => {
    const fields = await sensitiveFields(page).catch(() => [] as PageField[]);
    if (fields.length) onFields(fields);
    return sensitiveRefs(fields);
  };
  target.ariaSnapshot = async (options) => {
    const out = (await text.call(page, options)) as string;
    return maskSnapshot(out, await read());
  };
  if (json)
    target.ariaSnapshotJSON = async (options) => {
      const out = await json.call(page, options);
      return maskSnapshotJSON(out, await read());
    };
  return () => {
    target.ariaSnapshot = text;
    if (json) target.ariaSnapshotJSON = json;
  };
}

/** Keys that put a character into the focused field (`a`, `Shift+A`), not `Enter` or `Tab`. */
function typesCharacter(key: unknown): boolean {
  if (typeof key !== "string") return false;
  const last = key.split("+").pop() ?? "";
  return last.length === 1 && !/^(Control|Meta|Alt)\+/i.test(key);
}

async function targetInfo(page: Page, target: string): Promise<FieldInfo | undefined> {
  const locator = page.locator(REF.test(target) ? `aria-ref=${target}` : target);
  return await locator
    .evaluate(
      (el: Element) => ({
        type: ((el as HTMLInputElement).type || "").toLowerCase(),
        autocomplete: el.getAttribute("autocomplete") ?? "",
        name: el.getAttribute("name") ?? "",
        id: el.id,
      }),
      undefined,
      { timeout: 2_000 },
    )
    .catch(() => undefined);
}

/** The focused element of a frame, through open shadow roots; undefined when the frame has no focus. */
function focusedInfo(frame: Frame): Promise<FieldInfo | undefined> {
  return frame.evaluate(() => {
    if (!document.hasFocus()) return undefined;
    let el: Element | null = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return undefined;
    return {
      type: ((el as HTMLInputElement).type || "").toLowerCase(),
      autocomplete: el.getAttribute("autocomplete") ?? "",
      name: el.getAttribute("name") ?? "",
      id: el.id,
    };
  });
}

/** The stock tools that type text, and the arguments that say where. */
export const TYPING_TOOLS: ReadonlySet<string> = new Set([
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_press_sequentially",
  "browser_keydown",
]);

/**
 * The kind of sensitive field a typing call would put text into, or undefined. A target the
 * page cannot resolve counts as not sensitive: the call then fails the same way.
 */
export async function typesIntoSensitive(
  page: Page,
  tool: string,
  args: Record<string, unknown>,
): Promise<"password" | "one-time code" | undefined> {
  const targets: string[] = [];
  if (tool === "browser_type") {
    if (typeof args.target === "string" && typeof args.text === "string" && args.text) targets.push(args.target);
  } else if (tool === "browser_fill_form") {
    if (Array.isArray(args.fields))
      for (const f of args.fields as { target?: unknown; value?: unknown; type?: unknown }[])
        if (f.type === "textbox" && typeof f.target === "string" && typeof f.value === "string" && f.value)
          targets.push(f.target);
  } else if (
    tool === "browser_press_sequentially" ? typeof args.text === "string" && args.text : typesCharacter(args.key)
  ) {
    for (const frame of page.frames()) {
      const kind = fieldKind(
        (await focusedInfo(frame).catch(() => undefined)) ?? { type: "", autocomplete: "", name: "", id: "" },
      );
      if (sensitiveKind(kind)) return kind;
    }
    return undefined;
  }
  for (const target of targets) {
    const info = await targetInfo(page, target);
    const kind = info ? fieldKind(info) : undefined;
    if (sensitiveKind(kind)) return kind;
  }
  return undefined;
}

/** The error of a typing call into a sensitive field. */
export function sensitiveRefusal(tool: string, kind: "password" | "one-time code"): string {
  return `${tool} was refused: that field takes a ${kind}, and the agent never types one. Ask the person to type it (with browser_request_human, if this server offers it), or sign in with browser_login and a vault entry for this site; a flow replay can type one passed as keychain:<item>.`;
}

/**
 * The values `browser_type` or `browser_fill_form` would put into secret fields (`secretField`),
 * so a recording can stop its trace first.
 */
export async function secretValues(page: Page, tool: string, args: Record<string, unknown>): Promise<string[]> {
  const pairs: [unknown, unknown][] =
    tool === "browser_type"
      ? [[args.target, args.text]]
      : tool === "browser_fill_form" && Array.isArray(args.fields)
        ? (args.fields as { target?: unknown; value?: unknown; type?: unknown }[])
            .filter((f) => f.type === "textbox")
            .map((f) => [f.target, f.value])
        : [];
  const out: string[] = [];
  for (const [target, value] of pairs) {
    if (typeof target !== "string" || typeof value !== "string" || !value) continue;
    const info = await targetInfo(page, target);
    if (info && secretField(info)) out.push(value);
  }
  return out;
}
