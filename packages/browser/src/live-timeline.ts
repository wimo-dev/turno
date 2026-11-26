import type { Redactor } from "./redact.js";
import type { ToolResult } from "./upstream.js";

/**
 * The live view's step timeline: one line per agent call (the tool, the element or address it
 * worked on, how it went, when and how long), plus the pauses and hand-backs, so the person can
 * follow the agent outside the page. Everything here goes through the redactor first, and the
 * text an agent typed, the values of a form or a script's source never enter it: a step names its
 * target, never its input. Addresses keep their origin and path only, as the tab list does.
 *
 * It also says when a session looks stuck: the same call on the same target failing again and
 * again (`STUCK_AFTER` times in a row), which the view shows until a call of that session works.
 */

/** How many failures in a row of the same call on the same target count as stuck. */
export const STUCK_AFTER = 3;
/** Steps kept for a view that connects later. */
const KEEP = 200;
const MAX_TARGET = 120;
const MAX_DETAIL = 160;

type StepOutcome =
  /** The call ran and did not fail. */
  | "ok"
  /** The call ran and failed, or was refused. */
  | "error"
  /** The call waited for the person, and was not run because the browser changed meanwhile. */
  | "not-run";

/** One entry of the timeline, as the view shows it. */
export type TimelineEntry =
  | {
      kind: "call";
      id: number;
      /** When the call started (epoch ms). */
      at: number;
      ms: number;
      /** The agent's name ("Claude Code"), or "" when its client sent none. */
      agent: string;
      /** A short tag of the client session, so several sessions can be told apart. */
      session: string;
      tool: string;
      target: string;
      outcome: StepOutcome;
      /** Why it failed or was not run, in a line; "" when it worked. */
      detail: string;
      /** The call waited for the person first (a pause or a person step). */
      waited: boolean;
      /** The n-th failure in a row of this call on this target, from `STUCK_AFTER` on. */
      stuck?: number;
    }
  | {
      kind: "pause";
      id: number;
      at: number;
      /** Who paused, as the gate says it ("the live view", `browser_request_human`). */
      by: string;
      /** A person step the agent asked for, not the person's own pause. */
      step: boolean;
    }
  | {
      kind: "resume";
      id: number;
      at: number;
      /** How long the pause lasted. */
      ms: number;
      by: string;
      step: boolean;
      /** What changed in the tabs while the person had the browser (`describeChanges`). */
      lines: string[];
    };

/** A session that looks stuck: the same call on the same target failed `count` times in a row. */
export interface Stuck {
  session: string;
  agent: string;
  tool: string;
  target: string;
  count: number;
  since: number;
}

/** What the host knows about a finished call. */
export interface CallRecord {
  at: number;
  ms: number;
  session: string;
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  /** The result as it leaves the server (already redacted). */
  result: ToolResult;
  /** The call waited for the person first; `ran` false when it then was not run. */
  held?: { ran: boolean };
  /** The call only reads (a snapshot, the tab list): it neither ends nor breaks a run of failures. */
  readOnly?: boolean;
}

/** `https://a.example/x?token=1#y` as `https://a.example/x`; other schemes by name only. */
export function plainUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : u.protocol;
  } catch {
    return "";
  }
}

/** Every http(s) address in a text without its query and fragment, which may carry a token. */
function withoutQueries(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => plainUrl(url) || url);
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * What a call worked on, in a few words: the element the agent named, the address it opened, the
 * key it pressed. Never what it typed, the values it filled or selected, or a script.
 */
function stepTarget(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "browser_navigate":
      return plainUrl(str(args.url));
    case "browser_press_key":
      return str(args.key);
    case "browser_fill_form": {
      const fields = Array.isArray(args.fields) ? (args.fields as { name?: unknown }[]) : [];
      return fields
        .map((f) => str(f?.name))
        .filter(Boolean)
        .join(", ");
    }
    case "browser_tabs":
      return [str(args.action), typeof args.index === "number" ? String(args.index) : ""].filter(Boolean).join(" ");
    case "browser_request_human":
      return str(args.instruction);
    case "browser_batch":
      return Array.isArray(args.actions) ? `${args.actions.length} steps` : "";
    case "browser_wait_for":
      return typeof args.time === "number" ? `${args.time}s` : "";
    default:
      // `element` is the description every stock tool that acts on an element takes; the text
      // of a type, the values of a select and the code of a script are not read.
      return str(args.element) || str(args.name);
  }
}

/** The first line of a failed result that says why, without the "### Error" heading. */
function failureLine(result: ToolResult): string {
  for (const part of result.content) {
    if (part.type !== "text") continue;
    const text = (part as { text: string }).text;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string") return payload.error.split("\n")[0] ?? "";
    } catch {
      /* text */
    }
    const lines = text.split("\n").map((l) => l.trim());
    const at = lines.indexOf("### Error");
    const rest = (at >= 0 ? lines.slice(at + 1) : lines).filter((l) => l && !l.startsWith("#"));
    const first = rest[0]?.replace(/^Error:\s*/, "");
    // "Invalid arguments for tool ...:" says why on the next line.
    if (first) return first.endsWith(":") && rest[1] ? `${first} ${rest[1]}` : first;
  }
  return "";
}

/** The timeline of one live view. */
export class Timeline {
  private readonly entries: TimelineEntry[] = [];
  private nextId = 1;
  /** Per session: the call that failed last and how many times in a row. */
  private readonly failing = new Map<string, { key: string; count: number; since: number }>();
  private current: Stuck | undefined;
  private readonly listeners = new Set<(entry: TimelineEntry) => void>();

  constructor(private readonly redactor: Redactor) {}

  /** Every entry kept, oldest first. */
  list(): TimelineEntry[] {
    return [...this.entries];
  }

  /** The session that looks stuck now, if one does. */
  get stuck(): Stuck | undefined {
    return this.current;
  }

  /** Calls `fn` with each new entry; returns what stops that. */
  onEntry(fn: (entry: TimelineEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Masks what the redactor knows and drops the queries of addresses. */
  clean(text: string, max: number): string {
    return clip(withoutQueries(this.redactor.text(text)), max);
  }

  /** What a call works on, as its line names it: the element or address, never its input. */
  targetOf(tool: string, args: Record<string, unknown>): string {
    return this.clean(stepTarget(tool, args), MAX_TARGET);
  }

  private push(entry: TimelineEntry): TimelineEntry {
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  /** A call ended. */
  call(r: CallRecord): TimelineEntry {
    const target = this.targetOf(r.tool, r.args);
    const outcome: StepOutcome = r.held && !r.held.ran ? "not-run" : r.result.isError ? "error" : "ok";
    const detail = outcome === "ok" ? "" : this.clean(failureLine(r.result), MAX_DETAIL);
    const entry: TimelineEntry = {
      kind: "call",
      id: this.nextId++,
      at: r.at,
      ms: Math.max(0, Math.round(r.ms)),
      agent: this.clean(r.agent, 40),
      session: r.session.slice(0, 8),
      tool: r.tool,
      target,
      outcome,
      detail,
      waited: r.held !== undefined,
    };
    const stuck = r.readOnly && entry.outcome === "ok" ? undefined : this.track(entry);
    if (stuck) entry.stuck = stuck;
    return this.push(entry);
  }

  /** The browser was handed to the person. */
  paused(by: string, step: boolean, at: number = Date.now()): TimelineEntry {
    return this.push({ kind: "pause", id: this.nextId++, at, by: this.clean(by, 60), step });
  }

  /** The person handed the browser back; `lines` say what changed meanwhile. */
  resumed(by: string, step: boolean, ms: number, lines: readonly string[], at: number = Date.now()): TimelineEntry {
    return this.push({
      kind: "resume",
      id: this.nextId++,
      at,
      ms: Math.max(0, Math.round(ms)),
      by: this.clean(by, 60),
      step,
      lines: lines.slice(0, 10).map((l) => this.clean(l, MAX_DETAIL)),
    });
  }

  /** Counts failures in a row per session; returns the count once it reaches `STUCK_AFTER`. */
  private track(entry: Extract<TimelineEntry, { kind: "call" }>): number | undefined {
    const key = `${entry.tool}\u0000${entry.target}`;
    if (entry.outcome !== "error") {
      this.failing.delete(entry.session);
      // A call that was not run says nothing about the target: the person changed the page.
      if (entry.outcome === "ok" && this.current?.session === entry.session) this.current = undefined;
      return undefined;
    }
    const was = this.failing.get(entry.session);
    const now = was && was.key === key ? { ...was, count: was.count + 1 } : { key, count: 1, since: entry.at };
    this.failing.set(entry.session, now);
    if (now.count < STUCK_AFTER) {
      if (this.current?.session === entry.session) this.current = undefined;
      return undefined;
    }
    this.current = {
      session: entry.session,
      agent: entry.agent,
      tool: entry.tool,
      target: entry.target,
      count: now.count,
      since: now.since,
    };
    return now.count;
  }
}
