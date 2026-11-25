import type { Page } from "patchright-core";
import type { ToolResult } from "./upstream.js";

/**
 * Keeps vault values out of everything the model reads. Once `browser_login` fills a
 * username, a password or a one-time code into a page, the host passes every tool result and
 * error of this server through `redact`, so the value never comes back: not in the page
 * snapshot (a filled textbox shows its value there), not in a network request body, a console
 * message or an evaluate result.
 *
 * Each value is matched as typed and in the encodings a page or a tool turns it into: URL and
 * form encoding, a JSON string, HTML entities. What it cannot catch is a value the page or a
 * script transforms some other way (base64, hashed, reversed), or a screenshot; the host also
 * refuses the tools that run arbitrary script on a page that holds vault values (`guard`).
 */

/** Values shorter than this are not redacted: replacing "ab" everywhere would wreck the snapshot. */
const MIN_LENGTH = 4;

interface Entry {
  label: string;
  /** What the value reads in a result: `[vault: <label>]` unless set. */
  mark?: string;
  variants: string[];
  /** When the value stops being redacted (one-time codes); undefined: for the life of the server. */
  until?: number;
}

function htmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The forms a value takes in page text, request bodies and JSON. */
export function variantsOf(value: string): string[] {
  const out = new Set([value]);
  const uri = encodeURIComponent(value);
  out.add(uri);
  out.add(uri.replace(/%20/g, "+"));
  // URLSearchParams also escapes these, which encodeURIComponent leaves.
  out.add(new URLSearchParams({ v: value }).toString().slice(2));
  out.add(JSON.stringify(value).slice(1, -1));
  out.add(htmlEscape(value));
  return [...out].filter((v) => v.length >= MIN_LENGTH);
}

/** Most values read from sensitive fields kept at once; the oldest go first. */
const MAX_FIELD_VALUES = 256;
/** Most cookie and storage values masked at once (`storage-mask.ts`); the oldest go first. */
const MAX_MASKED_VALUES = 4096;

export class Redactor {
  private readonly entries = new Map<string, Entry>();
  private readonly fields = new Set<string>();
  private readonly masked = new Set<string>();

  /** Redact `value` from now on, shown as `[vault: <label>]`; `ttlMs` for a one-time code. */
  add(value: string, label: string, ttlMs?: number, now: number = Date.now()): void {
    if (value.length < MIN_LENGTH) return;
    this.fields.delete(value);
    this.masked.delete(value);
    this.entries.set(value, {
      label,
      variants: variantsOf(value),
      ...(ttlMs !== undefined ? { until: now + ttlMs } : {}),
    });
  }

  /**
   * Redact a value read from a sensitive field of a page, whoever typed it (the person, a page
   * script), shown as `mark`; `ttlMs` for a one-time code. A value the vault already hides
   * keeps its vault label.
   */
  addField(value: string, mark: string, ttlMs?: number, now: number = Date.now()): void {
    if (value.length < MIN_LENGTH) return;
    const known = this.entries.get(value);
    if (known && !this.fields.has(value) && !this.masked.has(value)) return;
    this.masked.delete(value);
    this.fields.delete(value);
    this.fields.add(value);
    this.entries.set(value, {
      label: "sensitive field",
      mark,
      variants: variantsOf(value),
      ...(ttlMs !== undefined ? { until: now + ttlMs } : {}),
    });
    for (const old of this.fields) {
      if (this.fields.size <= MAX_FIELD_VALUES) break;
      this.fields.delete(old);
      this.entries.delete(old);
    }
  }

  /**
   * Mask a cookie or web storage value from now on, shown as `mark` (`storage-mask.ts`): a
   * session cookie read by any tool, `document.cookie` included. A value the vault or a
   * sensitive field already hides keeps its label.
   */
  addMasked(value: string, mark: string): void {
    if (value.length < MIN_LENGTH) return;
    if (this.masked.has(value)) {
      // Seen again: it moves to the end, so the values still in the browser are the last to go.
      this.masked.delete(value);
      this.masked.add(value);
      return;
    }
    if (this.entries.has(value)) return;
    this.masked.add(value);
    this.entries.set(value, { label: "masked value", mark, variants: variantsOf(value) });
    for (const old of this.masked) {
      if (this.masked.size <= MAX_MASKED_VALUES) break;
      this.masked.delete(old);
      this.entries.delete(old);
    }
  }

  /** True when there is something to redact. */
  get active(): boolean {
    return this.entries.size > 0;
  }

  /** True when `text` holds a value this redactor hides, in any of its forms. */
  covers(text: string, now: number = Date.now()): boolean {
    return this.labelsIn(text, () => true, now).length > 0;
  }

  /**
   * The labels of the values found in `text` whose label passes `which` (a recorder looks for
   * passwords and one-time codes in a trace before it keeps it).
   */
  labelsIn(text: string, which: (label: string) => boolean, now: number = Date.now()): string[] {
    const found = new Set<string>();
    for (const e of this.entries.values()) {
      if ((e.until !== undefined && now > e.until) || !which(e.label)) continue;
      if (e.variants.some((v) => text.includes(v))) found.add(e.label);
    }
    return [...found];
  }

  text(text: string, now: number = Date.now()): string {
    if (!this.entries.size || !text) return text;
    const pairs: [string, string][] = [];
    for (const [value, e] of this.entries) {
      if (e.until !== undefined && now > e.until) {
        this.entries.delete(value);
        this.fields.delete(value);
        this.masked.delete(value);
        continue;
      }
      for (const v of e.variants) pairs.push([v, e.mark ?? `[vault: ${e.label}]`]);
    }
    // Longest first, so a value inside another value's encoding is handled by the longer one.
    pairs.sort((a, b) => b[0].length - a[0].length);
    let out = text;
    for (const [v, mark] of pairs) if (out.includes(v)) out = out.split(v).join(mark);
    return out;
  }

  /** A tool result with every text part (and any string in structured content) redacted. */
  result(result: ToolResult, now: number = Date.now()): ToolResult {
    if (!this.entries.size) return result;
    const content = result.content.map((part) =>
      part.type === "text" ? { ...part, text: this.text((part as { text: string }).text, now) } : part,
    );
    const out: ToolResult = { ...result, content };
    if (result.structuredContent !== undefined) {
      try {
        out.structuredContent = JSON.parse(this.text(JSON.stringify(result.structuredContent), now)) as unknown;
      } catch {
        delete out.structuredContent; // redaction broke the JSON: drop it rather than leak
      }
    }
    return out;
  }
}

/** Stock tools that run arbitrary script in a page, refused on a page that holds vault values. */
export const SCRIPT_TOOLS: ReadonlySet<string> = new Set(["browser_evaluate", "browser_run_code_unsafe"]);

/**
 * The pages `browser_login` filled, until their main frame navigates (a submitted form, a new
 * URL) or they close. While a page is held, the host refuses `SCRIPT_TOOLS` on it: reading a
 * password field's value back through a script is one line, and a script can encode it past
 * any redaction.
 */
export class VaultGuard {
  private readonly pages = new WeakSet<Page>();

  mark(page: Page): void {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    const release = () => {
      this.pages.delete(page);
      page.off("framenavigated", onNavigated);
    };
    const onNavigated = (frame: unknown) => {
      if (frame === page.mainFrame()) release();
    };
    page.on("framenavigated", onNavigated);
    page.once("close", release);
  }

  holds(page: Page | undefined): boolean {
    return !!page && this.pages.has(page);
  }
}
