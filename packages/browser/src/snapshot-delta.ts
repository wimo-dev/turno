import { type SnapNode, YAML_BLOCK, lineOf, parseSnapshot, refOf } from "./snapshot-compact.js";

/**
 * What changed on a page between two compact snapshots, by ref. After an action that stays on
 * the page, the model already holds the snapshot it acted on; sending the elements that changed
 * costs a fraction of the whole page. Playwright had an incremental snapshot mode and removed it
 * (microsoft/playwright#39777, "inefficient ... a lot of complexity for little benefit"), and
 * since then answers an action with a link to the snapshot file only: the model that wants to see
 * the result calls browser_snapshot. Here the changes ride on the action's result, and only when
 * it is safe and smaller (`SnapshotDeltas`): an action that stays on the page (same session, same
 * URL), a base the model was given whole, and changes under half the compact page. Otherwise the
 * result stays as upstream writes it. browser_snapshot always returns the whole page. Applying
 * the changes to the base gives the compact snapshot exactly (the tests check it).
 *
 * Each element with a ref has a signature: its own line and what is inside it down to the next
 * elements with refs, which stand in as their refs. An element is changed when its signature
 * differs, added when its ref is new, removed when its ref is gone. Text without a ref of its
 * own belongs to the nearest element with one, so a changed text shows up as that element.
 */

const ROOT = "(page)";

interface Entry {
  node: SnapNode | undefined;
  signature: string;
  parent: string;
}

/** Signatures of every element with a ref, and of the page around them. */
function entries(nodes: readonly SnapNode[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const own = (children: readonly SnapNode[], depth: number, lines: string[], owner: string) => {
    for (const child of children) {
      const ref = child.parsed ? refOf(child) : undefined;
      if (ref) {
        lines.push(`${"  ".repeat(depth)}@${ref}`);
        visit(child, ref, owner);
        continue;
      }
      lines.push(`${"  ".repeat(depth)}${lineOf(child)}`);
      own(child.children, depth + 1, lines, owner);
    }
  };
  const visit = (node: SnapNode, ref: string, parent: string) => {
    const lines = [lineOf(node)];
    out.set(ref, { node, signature: "", parent });
    own(node.children, 1, lines, ref);
    out.get(ref)!.signature = lines.join("\n");
  };
  const rootLines: string[] = [];
  out.set(ROOT, { node: undefined, signature: "", parent: "" });
  own(nodes, 0, rootLines, ROOT);
  out.get(ROOT)!.signature = rootLines.join("\n");
  return out;
}

/** An element with what is inside it: whole when `whole`, else down to the next refs, which show their line only. */
function render(node: SnapNode, depth: number, out: string[], whole: (ref: string) => boolean): void {
  out.push(`${"  ".repeat(depth)}- ${lineOf(node)}`);
  for (const child of node.children) {
    const ref = child.parsed ? refOf(child) : undefined;
    if (ref && !whole(ref)) {
      out.push(`${"  ".repeat(depth + 1)}- ${lineOf({ ...child, children: [] })}`);
      continue;
    }
    render(child, depth + 1, out, whole);
  }
}

interface Delta {
  text: string;
  changed: number;
  added: number;
  removed: number;
}

/** The changes from `before` to `after` (both compact YAML), or undefined when nothing changed. */
function snapshotDelta(before: string, after: string): Delta | undefined {
  const old = entries(parseSnapshot(before));
  const now = entries(parseSnapshot(after));
  const added = new Set([...now.keys()].filter((r) => !old.has(r)));
  const removed = [...old.keys()].filter((r) => !now.has(r));
  const changed = [...now.keys()].filter((r) => old.has(r) && old.get(r)!.signature !== now.get(r)!.signature);
  if (!added.size && !removed.length && !changed.length) return undefined;
  const lines: string[] = [];
  const whole = (ref: string) => added.has(ref);
  for (const ref of changed) {
    const entry = now.get(ref)!;
    if (!entry.node) {
      // Text outside every element with a ref: the page's top level, refs as their line.
      for (const node of parseSnapshot(after)) {
        const r = node.parsed ? refOf(node) : undefined;
        if (r && !whole(r)) lines.push(`- ${lineOf({ ...node, children: [] })}`);
        else render(node, 0, lines, whole);
      }
      continue;
    }
    render(entry.node, 0, lines, whole);
  }
  // An added element whose parent did not change is rendered here (its parent's signature
  // changes when a child is added, so this is rare: a ref that moved to a new element).
  for (const ref of added) {
    const parent = now.get(ref)!.parent;
    if (changed.includes(parent) || added.has(parent)) continue;
    render(now.get(ref)!.node!, 0, lines, whole);
  }
  const gone = removed.map((r) => {
    const node = old.get(r)!.node!;
    return `- ${lineOf({ ...node, children: [] })}`;
  });
  const text = [
    ...(lines.length
      ? ["# Changed or added (each with what is inside it; refs not listed are unchanged):", ...lines]
      : []),
    ...(gone.length ? ["# Removed:", ...gone] : []),
  ].join("\n");
  return { text, changed: changed.length, added: added.size, removed: removed.length };
}

/** The actions that answer with their changes when the page stays: they act on the page in place. */
const DELTA_TOOLS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_drag",
  "browser_file_upload",
  "browser_mouse_click_xy",
  "browser_mouse_move_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_wheel",
]);

/** Tools that change nothing on the page the model holds: the base stays after them. */
const READS = new Set([
  "browser_snapshot",
  "browser_read",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_take_screenshot",
  "browser_find",
  "browser_flows",
  "browser_wait_for",
]);

const HEADER =
  "# Changes since the last snapshot of this page: refs not listed are unchanged, and a ref shown without what is inside it keeps its content. browser_snapshot returns the whole page.";

const LINK = /^- \[Snapshot\]\(([^)]+)\)$/m;
const PAGE_URL = /^- Page URL: (.*)$/m;

/**
 * What each session's model holds of its page: the last whole compact snapshot it was given,
 * plus the changes sent since. Upstream answers an action with a link to the snapshot file, not
 * the snapshot: without changes inline, a model that wants to see what its click did calls
 * browser_snapshot and reads the whole page again.
 */
export class SnapshotDeltas {
  private readonly held = new Map<string, { url: string; yaml: string }>();

  /**
   * A tool's result went to the session: keep the page it showed when `whole` (browser_snapshot,
   * browser_read of the whole compact page), or drop what may be stale after anything but a read
   * or an action that stays on the page.
   */
  saw(session: string, tool: string, text: string, whole: boolean): void {
    const yaml = YAML_BLOCK.exec(text)?.[2];
    const url = PAGE_URL.exec(text)?.[1];
    // A table of contents starts with a comment line: not the page.
    if (whole && yaml !== undefined && url && !yaml.startsWith("# ")) this.held.set(session, { url, yaml });
    else if (!READS.has(tool) && !DELTA_TOOLS.has(tool)) this.held.delete(session);
  }

  /**
   * An action's result text with the page's changes since the model's copy, when the action
   * stayed on the page and the changes are under half the compact page. `compactNow` is the
   * compact snapshot after the action (the snapshot file the result links to, compacted).
   */
  afterAction(session: string, tool: string, text: string, compactNow: (path: string) => string | undefined): string {
    const held = this.held.get(session);
    if (!DELTA_TOOLS.has(tool)) return text;
    const link = LINK.exec(text);
    const url = PAGE_URL.exec(text)?.[1];
    if (!held || !link || !url || url !== held.url) {
      // Another page: what the model holds is stale.
      if (url && held && url !== held.url) this.held.delete(session);
      return text;
    }
    const now = compactNow(link[1]!);
    if (now === undefined) return text;
    const delta = snapshotDelta(held.yaml, now);
    if (delta && delta.text.length > now.length / 2) return text;
    this.held.set(session, { url, yaml: now });
    const body = delta ? `${HEADER}\n${delta.text}` : "# The page did not change since the last snapshot.";
    return text.replace(LINK, (line) => `\`\`\`yaml\n${body}\n\`\`\`\n${line}`);
  }

  /** The session ended. */
  forget(session: string): void {
    this.held.delete(session);
  }
}
