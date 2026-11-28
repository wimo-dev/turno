import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Locator } from "patchright-core";
import { browserPaths as paths, replaceFileSync } from "turno-core/paths";
import { assertIdentityId } from "./ids.js";
import type { Redactor } from "./redact.js";

/**
 * What an element an action worked on was, so a later action that names it again by a selector
 * (a flow replay, a repeated step from a batch or a shell) can tell whether the selector still
 * finds the same element. A selector that resolves is not enough: a button that moved can leave
 * its CSS path to its neighbour, and a renamed label can sit where the old one was. Before such
 * an action runs, the element the selector finds now must have the recorded role, accessible
 * name, label and landmark on a page of the same URL pattern; otherwise the action is refused and
 * the agent (the model) decides from a fresh snapshot.
 *
 * Only what the page shows about the element is kept, never a value typed into it, and any text
 * the identity's redactor hides (a vault value shown on the page, like a signed-in user name) is
 * replaced by its mark before it is stored.
 */
export interface Fingerprint {
  role: string;
  /** The accessible name, whitespace collapsed, at most 120 characters. */
  name: string;
  /** The text of the field's label, when it has one apart from its name. */
  label?: string;
  /** The nearest landmark or dialog around it, as `navigation "Main"`. */
  landmark?: string;
  /** The page's origin and path, with ids in the path as `*`. */
  url: string;
}

/** The page's URL without query or fragment, with path segments that look like ids as `*`. */
export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname
      .split("/")
      .map((s) =>
        /^\d+$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f-]{32,36}$/i.test(s) || /\d{3,}/.test(s) ? "*" : s,
      );
    return `${u.origin}${segs.join("/")}`;
  } catch {
    return url;
  }
}

/**
 * What the page shows about an element: its role, accessible name, label and landmark. Runs in
 * the page (a locator's evaluate, or teach mode's isolated world): it must stay self-contained.
 */
export function seenInPage(el: Element): { role: string; name: string; label: string; landmark: string } {
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const tag = el.localName;
  const input = el as HTMLInputElement;
  const implicit = (): string => {
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "img";
    if (tag === "option") return "option";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (input.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
      return el.hasAttribute("list") ? "combobox" : "textbox";
    }
    return "generic";
  };
  const role = el.getAttribute("role")?.split(" ")[0] || implicit();
  const byIds = (ids: string | null) =>
    clean(
      (ids ?? "")
        .split(/\s+/)
        .map((id) => (id ? el.ownerDocument.getElementById(id)?.textContent : ""))
        .join(" "),
    );
  const labels = (el as HTMLInputElement).labels;
  const label = labels && labels.length ? clean([...labels].map((l) => l.textContent).join(" ")) : "";
  // A field's text is what was typed into it: never part of its name here.
  const field =
    ["input", "select", "textarea"].includes(tag) ||
    (el as HTMLElement).isContentEditable ||
    ["textbox", "searchbox", "combobox", "spinbutton"].includes(role);
  const name =
    clean(el.getAttribute("aria-label")) ||
    byIds(el.getAttribute("aria-labelledby")) ||
    label ||
    clean(el.getAttribute("alt")) ||
    (field ? "" : clean(el.textContent)) ||
    clean(el.getAttribute("title")) ||
    clean(el.getAttribute("placeholder")) ||
    (tag === "input" && ["submit", "button", "reset"].includes(input.type) ? clean(input.value) : "");
  const LANDMARK: Record<string, string> = {
    nav: "navigation",
    main: "main",
    aside: "complementary",
    dialog: "dialog",
    search: "search",
  };
  const ROLES = new Set([
    "navigation",
    "main",
    "banner",
    "contentinfo",
    "complementary",
    "search",
    "region",
    "form",
    "dialog",
    "alertdialog",
  ]);
  let landmark = "";
  for (let n = el.parentElement; n; n = n.parentElement) {
    let r = n.getAttribute("role") ?? LANDMARK[n.localName];
    const named = clean(n.getAttribute("aria-label")) || byIds(n.getAttribute("aria-labelledby"));
    if (!r && n.localName === "header" && !n.closest("article, aside, main, nav, section")) r = "banner";
    if (!r && n.localName === "footer" && !n.closest("article, aside, main, nav, section")) r = "contentinfo";
    if (!r && (n.localName === "form" || n.localName === "section") && named)
      r = n.localName === "form" ? "form" : "region";
    if (r && ROLES.has(r)) {
      landmark = named ? `${r} "${named}"` : r;
      break;
    }
  }
  return { role, name, label: label && label !== name ? label : "", landmark };
}

/**
 * The element's role, name, label and landmark, read in the page. The locator must match one
 * element (a ref, or a selector replay checked). Undefined when it is gone.
 */
export async function fingerprintOf(locator: Locator, url: string): Promise<Fingerprint | undefined> {
  const seen = await locator.evaluate(seenInPage, undefined, { timeout: 2_000 }).catch(() => undefined);
  if (typeof seen?.role !== "string" || typeof seen.name !== "string") return undefined;
  return {
    role: seen.role,
    name: seen.name,
    ...(seen.label ? { label: seen.label } : {}),
    ...(seen.landmark ? { landmark: seen.landmark } : {}),
    url: urlPattern(url),
  };
}

/** A fingerprint with every text the redactor hides replaced by its mark. */
export function redactFingerprint(fp: Fingerprint, redactor: Redactor): Fingerprint {
  const r = (t: string) => redactor.text(t);
  return {
    role: fp.role,
    name: r(fp.name),
    ...(fp.label !== undefined ? { label: r(fp.label) } : {}),
    ...(fp.landmark !== undefined ? { landmark: r(fp.landmark) } : {}),
    url: r(fp.url),
  };
}

const norm = (t: string | undefined) => (t ?? "").toLowerCase();

/**
 * How the element found now differs from the recorded one, in words; empty when it is the same.
 * Names compare without case; a field missing from either side is not compared, except the name.
 */
export function differences(recorded: Fingerprint, now: Fingerprint): string[] {
  const out: string[] = [];
  if (recorded.url !== now.url) out.push(`the page is ${now.url}, not ${recorded.url}`);
  if (recorded.role !== now.role) out.push(`it is a ${now.role}, not a ${recorded.role}`);
  if (norm(recorded.name) !== norm(now.name))
    out.push(`its name is ${JSON.stringify(now.name)}, not ${JSON.stringify(recorded.name)}`);
  if (recorded.label !== undefined && now.label !== undefined && norm(recorded.label) !== norm(now.label))
    out.push(`its label is ${JSON.stringify(now.label)}, not ${JSON.stringify(recorded.label)}`);
  if (recorded.landmark !== undefined && norm(recorded.landmark) !== norm(now.landmark))
    out.push(`it is in ${now.landmark ?? "no landmark"}, not in ${recorded.landmark}`);
  return out;
}

/** The words of a refusal: what the selector found, and what to do. */
export function refusal(selector: string, diffs: string[]): string {
  return [
    `The element ${selector} finds now is not the one this action was recorded on: ${diffs.join("; ")}.`,
    "The action did not run. Next: take a snapshot (browser_snapshot) and act on the element by its ref.",
  ].join("\n");
}

interface CacheEntry {
  fingerprint: Fingerprint;
  hits: number;
  refused: number;
  seen: string;
}

interface CacheFile {
  version: 1;
  /** By URL pattern, then by selector. */
  pages: Record<string, Record<string, CacheEntry>>;
}

/** Most entries one identity keeps; the least recently seen go first. */
const MAX_ENTRIES = 2_000;

/** Where an identity's action cache lives: `<data>/browser/action-cache/<id>.json`. */
export function actionCachePath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  assertIdentityId(id);
  return join(paths(env).browserDir, "action-cache", `${id}.json`);
}

/**
 * The fingerprints of the elements an identity's actions worked on, by page and selector, on
 * disk (mode 600) so they outlive the session. Every write is redacted first.
 */
export class ActionCache {
  private static readonly open = new Map<string, ActionCache>();
  private data: CacheFile | undefined;

  /** The cache of this file; every session of the identity shares one. */
  static for(file: string, redactor: Redactor): ActionCache {
    const open = ActionCache.open.get(file);
    if (open) return open;
    const cache = new ActionCache(file, redactor);
    ActionCache.open.set(file, cache);
    return cache;
  }

  private constructor(
    private readonly file: string,
    private readonly redactor: Redactor,
  ) {}

  private load(): CacheFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as CacheFile;
      this.data = parsed?.version === 1 && parsed.pages ? parsed : { version: 1, pages: {} };
    } catch {
      this.data = { version: 1, pages: {} };
    }
    return this.data;
  }

  private save(): void {
    const data = this.load();
    const all = Object.entries(data.pages).flatMap(([page, sel]) =>
      Object.entries(sel).map(([s, e]) => ({ page, s, seen: e.seen })),
    );
    if (all.length > MAX_ENTRIES)
      for (const old of all.sort((a, b) => a.seen.localeCompare(b.seen)).slice(0, all.length - MAX_ENTRIES)) {
        delete data.pages[old.page]![old.s];
        if (!Object.keys(data.pages[old.page]!).length) delete data.pages[old.page];
      }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      replaceFileSync(tmp, this.file);
    } catch {
      /* best effort: a full disk must not break a tool call */
    }
  }

  /** The fingerprint recorded for this selector on a page of this URL pattern. */
  get(url: string, selector: string): Fingerprint | undefined {
    return this.load().pages[urlPattern(url)]?.[selector]?.fingerprint;
  }

  /** Keeps what an action worked on, under every selector that names it. */
  remember(fingerprint: Fingerprint, selectors: readonly string[]): void {
    const fp = redactFingerprint(fingerprint, this.redactor);
    const pages = this.load().pages;
    pages[fp.url] ??= {};
    const page = pages[fp.url]!;
    const seen = new Date().toISOString();
    for (const s of selectors) {
      if (this.redactor.covers(s)) continue;
      const old = page[s];
      page[s] = { fingerprint: fp, hits: old?.hits ?? 0, refused: old?.refused ?? 0, seen };
    }
    this.save();
  }

  /** Counts a check of a cached selector: the same element (a hit) or another one (refused). */
  count(url: string, selector: string, hit: boolean): void {
    const entry = this.load().pages[urlPattern(url)]?.[selector];
    if (!entry) return;
    if (hit) entry.hits++;
    else entry.refused++;
    entry.seen = new Date().toISOString();
    this.save();
  }
}
