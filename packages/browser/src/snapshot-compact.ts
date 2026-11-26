/**
 * The compact page snapshot. Upstream's accessibility snapshot (`browser_snapshot` and the one an
 * action adds to its result) is written for completeness: every wrapper element, every link
 * destination, a ref on every node, `[cursor=pointer]` on every link. The model reads it on
 * every step, so turno-browser rewrites it before it leaves the server:
 *
 * - wrappers without a name or role of their own (`generic`, `cell`, `rowgroup`, ...) give way
 *   to their children, and empty ones go;
 * - a link's `/url` goes, unless the link has no name (the URL is then all it says);
 * - refs stay on every element an action can target (an interactive role or
 *   `[cursor=pointer]`), on headings and landmarks (`browser_read` reads a part of the page by
 *   them) and on lists and tables; other refs go;
 * - `[cursor=pointer]` goes where the role already says the element is clickable;
 * - separator text (`|`, `·`) and text that repeats the name of the control next to it go;
 * - runs of identical lines without a ref collapse into one line and a count.
 *
 * Refs are upstream's, so they stay what they were: the same element keeps its ref from one
 * snapshot to the next, and a ref read here works in any tool.
 *
 * A page whose compact snapshot is still larger than `TOC_CHARS` (a long article) is answered
 * with a table of contents instead: its landmarks and headings with their refs and sizes, and
 * its form fields. `browser_read` returns one part by ref (a heading's part runs to the next
 * heading of its level or above), or the whole page as upstream wrote it.
 *
 * Everything here is text in, text out, so it does not touch the page: no snapshot is taken
 * twice, and refs are never renumbered.
 */

/** Roles an action targets. Their refs always stay. */
const INTERACTIVE = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Landmarks: a table of contents lists them, and `browser_read` reads one by ref. */
const LANDMARKS = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);

/** Containers whose refs stay, so a part of the page can be read by ref. */
const CONTAINERS = new Set([
  "alertdialog",
  "article",
  "dialog",
  "grid",
  "iframe",
  "list",
  "menu",
  "menubar",
  "table",
  "tablist",
  "tabpanel",
  "toolbar",
  "tree",
  "treegrid",
]);

/** Wrappers that give way to their children when they have no name and nothing else to say. */
const UNWRAP = new Set(["cell", "generic", "group", "none", "presentation", "rowgroup", "subscript", "superscript"]);

/** Elements that say nothing when they have no name, text or children. */
const DROP_EMPTY = new Set([
  ...UNWRAP,
  "code",
  "emphasis",
  "list",
  "listitem",
  "paragraph",
  "row",
  "separator",
  "strong",
]);

/** Text that only separates other text. */
const SEPARATOR = /^[\s|·•]*$/;

/** A compact snapshot past this many characters becomes a table of contents. */
const TOC_CHARS = 60_000;

/** At least this many identical lines in a row collapse into one. */
const REPEAT_MIN = 3;

const REF_ATTR = /^\[ref=((?:f\d+)?e\d+)\]$/;
const CURSOR_ATTR = "[cursor=pointer]";

/** One line of a snapshot and the lines below it. */
export interface SnapNode {
  /** The line as upstream wrote it, without its indent and `- `; kept for lines that are not elements. */
  raw: string;
  /** False for a line this module does not understand: it is kept as it was. */
  parsed: boolean;
  /** False for a line that is not a list item (a comment): it goes back out exactly as read. */
  item?: false;
  /** `''` or `"` when upstream quoted the key (its text has a colon or a quote). */
  quote?: "'" | '"';
  role: string;
  /** The name as written, with its quotes (`"Sign in"`), so it goes back out unchanged. */
  name?: string;
  attrs: string[];
  /** Text after `: ` (a text node's text, a property's value, an element's own text). */
  value?: string;
  children: SnapNode[];
}

/** A parsed key: `role "name" [attr] [attr]`. */
const KEY = /^(\/?[a-z][a-zA-Z-]*)((?: "(?:[^"\\]|\\.)*")?)((?: \[[^\]]*\])*)$/;

function parseKey(key: string): { role: string; name?: string; attrs: string[] } | undefined {
  const m = KEY.exec(key);
  if (!m) return undefined;
  const name = m[2] ? m[2].slice(1) : undefined;
  const attrs = m[3] ? (m[3].match(/\[[^\]]*\]/g) ?? []) : [];
  return { role: m[1]!, ...(name !== undefined ? { name } : {}), attrs };
}

/** Splits `key: value`, `key:` or `key` where the key may be quoted. */
function splitLine(content: string): { key: string; quote?: "'" | '"'; colon: boolean; value?: string } | undefined {
  let key: string;
  let rest: string;
  let quote: "'" | '"' | undefined;
  if (content.startsWith("'")) {
    let i = 1;
    let out = "";
    for (; i < content.length; i++) {
      if (content[i] === "'") {
        if (content[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += content[i];
    }
    if (i >= content.length) return undefined;
    key = out;
    rest = content.slice(i + 1);
    quote = "'";
  } else if (content.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(content);
    if (!m) return undefined;
    try {
      key = JSON.parse(m[0]) as string;
    } catch {
      return undefined;
    }
    rest = content.slice(m[0].length);
    quote = '"';
  } else {
    // The key ends at the first colon after the name and the attributes.
    const m = /^(\/?[a-z][a-zA-Z-]*(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)(.*)$/.exec(content);
    if (!m) return undefined;
    key = m[1]!;
    rest = m[2]!;
  }
  if (rest === "") return { key, ...(quote ? { quote } : {}), colon: false };
  if (rest === ":") return { key, ...(quote ? { quote } : {}), colon: true };
  if (rest.startsWith(": ")) return { key, ...(quote ? { quote } : {}), colon: true, value: rest.slice(2) };
  return undefined;
}

function parseLine(content: string): SnapNode {
  const split = splitLine(content);
  const key = split ? parseKey(split.key) : undefined;
  if (!split || !key) return { raw: content, parsed: false, role: "", attrs: [], children: [] };
  return {
    raw: content,
    parsed: true,
    ...(split.quote ? { quote: split.quote } : {}),
    role: key.role,
    ...(key.name !== undefined ? { name: key.name } : {}),
    attrs: key.attrs,
    ...(split.value !== undefined ? { value: split.value } : {}),
    children: [],
  };
}

/** The tree of a snapshot's YAML. Lines that are not list items stay attached to the item above. */
export function parseSnapshot(yaml: string): SnapNode[] {
  const roots: SnapNode[] = [];
  const stack: { indent: number; node: SnapNode }[] = [];
  for (const line of yaml.split("\n")) {
    if (line.trim() === "") continue;
    const m = /^( *)- (.*)$/.exec(line);
    if (!m) {
      // Not an item (a comment, a WebMCP header): kept as is, at the top.
      roots.push({ raw: line, parsed: false, item: false, role: "", attrs: [], children: [] });
      stack.length = 0;
      continue;
    }
    const indent = m[1]!.length;
    const node = parseLine(m[2]!);
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

function keyOf(node: SnapNode): string {
  const key = `${node.role}${node.name !== undefined ? ` ${node.name}` : ""}${node.attrs.map((a) => ` ${a}`).join("")}`;
  if (node.quote === "'") return `'${key.replace(/'/g, "''")}'`;
  if (node.quote === '"') return JSON.stringify(key);
  return key;
}

export function lineOf(node: SnapNode): string {
  if (!node.parsed) return node.raw;
  const colon = node.value !== undefined ? `: ${node.value}` : node.children.length ? ":" : "";
  return `${keyOf(node)}${colon}`;
}

/** The YAML of a tree, two spaces per level. */
export function renderSnapshot(nodes: readonly SnapNode[], depth = 0, out: string[] = []): string {
  for (const node of nodes) {
    out.push(node.item === false ? node.raw : `${"  ".repeat(depth)}- ${lineOf(node)}`);
    renderSnapshot(node.children, depth + 1, out);
  }
  return depth === 0 ? out.join("\n") : "";
}

/** The ref of a node, when it has one. */
export function refOf(node: SnapNode): string | undefined {
  for (const a of node.attrs) {
    const m = REF_ATTR.exec(a);
    if (m) return m[1];
  }
  return undefined;
}

/** True for an element an action targets: an interactive role, or the page's pointer cursor. */
function isInteractive(node: { role: string; attrs: readonly string[] }): boolean {
  return INTERACTIVE.has(node.role) || node.attrs.includes(CURSOR_ATTR);
}

function keepsRef(node: SnapNode): boolean {
  return (
    isInteractive(node) ||
    node.role === "heading" ||
    LANDMARKS.has(node.role) ||
    CONTAINERS.has(node.role) ||
    // A named element can be read by ref (`generic "Main menu"`, a named region).
    (node.name !== undefined && node.name !== '""' && !UNWRAP.has(node.role))
  );
}

/** A YAML scalar as plain text: `"|"` is `|`. */
function plain(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function nameText(node: SnapNode): string | undefined {
  return node.name === undefined ? undefined : plain(node.name);
}

function hasRef(node: SnapNode): boolean {
  return refOf(node) !== undefined || node.children.some(hasRef);
}

function compactNodes(nodes: readonly SnapNode[], parent: SnapNode | undefined): SnapNode[] {
  const out: SnapNode[] = [];
  for (const node of nodes) {
    if (!node.parsed) {
      out.push({ ...node, children: compactNodes(node.children, node) });
      continue;
    }
    if (node.role.startsWith("/")) {
      // A link's destination goes; a nameless link keeps it, as it is all the link says.
      if (node.role === "/url" && parent?.role === "link" && parent.name !== undefined && parent.name !== '""')
        continue;
      out.push(node);
      continue;
    }
    if (node.role === "text") {
      if (SEPARATOR.test(plain(node.value) ?? "")) continue;
      out.push(node);
      continue;
    }
    const interactive = isInteractive(node);
    const keepRef = keepsRef(node);
    const attrs = node.attrs.filter(
      (a) => !(a === CURSOR_ATTR && INTERACTIVE.has(node.role)) && (keepRef || !REF_ATTR.test(a)),
    );
    const label = interactive ? normalized(nameText(node)) : undefined;
    const children = compactNodes(node.children, node).filter((c) => !label || !echoes(c, label));
    const named = node.name !== undefined && node.name !== '""';
    const other = attrs.some((a) => !REF_ATTR.test(a));
    if (!interactive && !named && node.value === undefined && !children.length && !other && DROP_EMPTY.has(node.role))
      continue;
    if (!interactive && !named && !other && UNWRAP.has(node.role)) {
      if (node.value !== undefined)
        out.push({ raw: "", parsed: true, role: "text", attrs: [], value: node.value, children: [] });
      else out.push(...children);
      continue;
    }
    out.push({ ...node, attrs, children });
  }
  return collapse(dropEchoes(out));
}

function normalized(text: string | undefined): string | undefined {
  const t = text?.replace(/\s+/g, " ").trim().toLowerCase();
  return t || undefined;
}

/** True when a subtree without refs says nothing its parent's name does not already say. */
function echoes(node: SnapNode, label: string): boolean {
  if (!node.parsed || refOf(node) || node.role.startsWith("/")) return false;
  const pieces = [nameText(node), plain(node.value)].map(normalized).filter((t): t is string => !!t);
  return pieces.every((t) => label.includes(t)) && node.children.every((c) => echoes(c, label));
}

/** Text that repeats the name of the control next to it (`radio "Small"` then `text: Small`). */
function dropEchoes(nodes: SnapNode[]): SnapNode[] {
  return nodes.filter((node, i) => {
    if (node.role !== "text" || !node.parsed) return true;
    const text = plain(node.value)?.trim();
    if (!text) return true;
    const near = [nodes[i - 1], nodes[i + 1]].filter((n): n is SnapNode => !!n && isInteractive(n));
    return !near.some((n) => nameText(n)?.trim() === text);
  });
}

/** Runs of identical lines without refs: the first stays, then a count. */
function collapse(nodes: SnapNode[]): SnapNode[] {
  const out: SnapNode[] = [];
  for (let i = 0; i < nodes.length; ) {
    const first = nodes[i]!;
    const text = hasRef(first) ? undefined : renderSnapshot([first]);
    let j = i + 1;
    if (text !== undefined) while (j < nodes.length && !hasRef(nodes[j]!) && renderSnapshot([nodes[j]!]) === text) j++;
    out.push(first);
    if (j - i >= REPEAT_MIN) {
      out.push({
        raw: "",
        parsed: true,
        role: "text",
        attrs: [],
        value: JSON.stringify(`(${j - i - 1} more like the line above)`),
        children: [],
      });
      i = j;
    } else i++;
  }
  return out;
}

/** The compact YAML of a snapshot. */
export function compactSnapshot(yaml: string): string {
  return renderSnapshot(compactNodes(parseSnapshot(yaml), undefined));
}

/** The ref of every interactive element of a snapshot, in order (the contract of the compact form). */
export function interactiveRefs(yaml: string): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly SnapNode[]) => {
    for (const n of nodes) {
      const ref = n.parsed ? refOf(n) : undefined;
      if (ref && isInteractive(n)) out.push(ref);
      walk(n.children);
    }
  };
  walk(parseSnapshot(yaml));
  return out;
}

/** Rough tokens of a text, the way the evaluation counts them (four bytes a token). */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 4);
}

function headingLevel(node: SnapNode): number | undefined {
  if (node.role !== "heading") return undefined;
  for (const a of node.attrs) {
    const m = /^\[level=(\d)\]$/.exec(a);
    if (m) return Number(m[1]);
  }
  return 6;
}

/** Every node in document order, with its depth. */
function flatten(nodes: readonly SnapNode[], depth = 0, out: { node: SnapNode; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    flatten(node.children, depth + 1, out);
  }
  return out;
}

const FIELDS = new Set(["textbox", "searchbox", "combobox"]);

/**
 * A table of contents of a compact snapshot: its landmarks and headings, each with its ref and
 * the size of its part, and every text field (a search box is often what the model wants).
 */
function tableOfContents(compact: string): string {
  const flat = flatten(parseSnapshot(compact));
  const lines: string[] = [];
  const sizeOf = (start: number, end: number) =>
    estimateTokens(
      flat
        .slice(start, end)
        .map((f) => lineOf(f.node))
        .join("\n"),
    );
  // The landmarks the current line is inside, by the index where each one ends.
  const open: number[] = [];
  for (const [i, { node, depth }] of flat.entries()) {
    while (open.length && open[open.length - 1]! <= i) open.pop();
    if (!node.parsed || !refOf(node)) continue;
    // A region without a name is a section around a heading: the heading stands for it.
    if (LANDMARKS.has(node.role) && !(node.role === "region" && node.name === undefined)) {
      let end = i + 1;
      while (end < flat.length && flat[end]!.depth > depth) end++;
      lines.push(`${"  ".repeat(open.length)}- ${keyOf(node)} (~${sizeOf(i, end).toLocaleString("en-US")} tokens)`);
      open.push(end);
      continue;
    }
    const level = headingLevel(node);
    if (level !== undefined) {
      let end = i + 1;
      while (end < flat.length) {
        const next = headingLevel(flat[end]!.node);
        if (next !== undefined && next <= level) break;
        end++;
      }
      lines.push(
        `${"  ".repeat(open.length + Math.max(0, level - 2))}- ${keyOf(node)} (~${sizeOf(i, end).toLocaleString("en-US")} tokens)`,
      );
      continue;
    }
    if (FIELDS.has(node.role)) lines.push(`${"  ".repeat(open.length)}- ${keyOf(node)}`);
  }
  return lines.join("\n");
}

/**
 * One part of a snapshot by ref: a heading's part runs from it to the next heading of its level
 * or above, in page order; any other element's is the element and what is inside it. Undefined
 * when no line has the ref.
 */
export function readPart(yaml: string, ref: string): string | undefined {
  const flat = flatten(parseSnapshot(yaml));
  const i = flat.findIndex((f) => f.node.parsed && refOf(f.node) === ref);
  if (i < 0) return undefined;
  const { node, depth } = flat[i]!;
  const level = headingLevel(node);
  let end = i + 1;
  if (level !== undefined) {
    while (end < flat.length) {
      const next = headingLevel(flat[end]!.node);
      if (next !== undefined && next <= level) break;
      end++;
    }
  } else {
    while (end < flat.length && flat[end]!.depth > depth) end++;
  }
  const part = flat.slice(i, end);
  const base = Math.min(...part.map((p) => p.depth));
  return part.map((p) => `${"  ".repeat(p.depth - base)}- ${lineOf(p.node)}`).join("\n");
}

/**
 * A part of the page as `browser_read` returns it: whole, unless it is past `TOC_CHARS` and has
 * headings or landmarks of its own; then its text up to its first heading, and a table of
 * contents of the rest (an article's lead, then its sections).
 */
export function shortenPart(compact: string): string {
  if (compact.length <= TOC_CHARS) return compact;
  const toc = tableOfContents(compact).split("\n").slice(1).filter(Boolean);
  if (toc.length < 2) return compact;
  const flat = flatten(parseSnapshot(compact));
  // The small landmarks around an article's title (its tools, its languages) stay in the text.
  const at = flat.findIndex(({ node }, i) => i > 0 && node.parsed && !!refOf(node) && node.role === "heading");
  const lead = flat
    .slice(0, at < 0 ? flat.length : at)
    .map((f) => `${"  ".repeat(f.depth)}- ${lineOf(f.node)}`)
    .join("\n");
  return [lead, "# The rest of this part is long; read its parts by ref:", ...toc].join("\n");
}

/**
 * How snapshots leave the server: "delta" (the default) is compact, and after an action that
 * stays on the page only what changed (`snapshot-delta.ts`); "compact" is always the whole
 * compact page; "full" is the snapshot as upstream writes it.
 */
export type SnapshotForm = "delta" | "compact" | "full";

/** `TURNO_BROWSER_SNAPSHOT`: full, compact, or delta when unset. */
export function snapshotForm(env: NodeJS.ProcessEnv = process.env): SnapshotForm {
  const v = env.TURNO_BROWSER_SNAPSHOT?.trim().toLowerCase();
  return v === "full" || v === "compact" ? v : "delta";
}

export const YAML_BLOCK = /(### Snapshot\n```yaml\n)([\s\S]*?)(\n?```)/;

/** The snapshot YAML of a result text, when it carries one inline. */
export function snapshotYaml(text: string): string | undefined {
  return YAML_BLOCK.exec(text)?.[2];
}

/**
 * A result text with its inline snapshot compacted, or replaced by a table of contents when it
 * is still past `TOC_CHARS`. Text without an inline snapshot (one saved to a file, a JSON
 * result) comes back unchanged.
 */
export function compactResultText(text: string, options: { toc?: boolean } = {}): string {
  const m = YAML_BLOCK.exec(text);
  if (!m) return text;
  const yaml = m[2]!;
  const compact = compactSnapshot(yaml);
  let body: string;
  const toc = options.toc !== false && compact.length > TOC_CHARS ? tableOfContents(compact) : "";
  // A long page without headings or landmarks has no parts to name: it stays whole.
  if (toc.split("\n").length >= 2) {
    body = [
      `# This page is long (about ${estimateTokens(compact).toLocaleString("en-US")} tokens even compacted), so this is its table of contents.`,
      "# Read a part with browser_read and the ref of a heading or landmark; browser_read with full: true returns the whole page.",
      toc,
    ].join("\n");
  } else body = compact;
  return text.slice(0, m.index) + m[1] + body + m[3] + text.slice(m.index + m[0].length);
}
