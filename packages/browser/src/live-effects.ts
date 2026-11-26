import type { Page } from "patchright-core";

/**
 * The live view's effect events: one small, typed event per thing the agent does, so the view can
 * draw each kind of action in its own way over the picture (`live-page.ts`). They say what kind of
 * action it is, where on the page (the target's box and the click point, in page CSS pixels),
 * and when it started and ended. They never carry what the agent typed, a value it filled or
 * selected, a vault value or a script: a typing step says how many characters, nothing more.
 *
 * Everything comes from what the host already knows: the call's tool and arguments when it
 * starts, the timeline's entry when it ends (`live-timeline.ts`), the boxes the agent cursor
 * measures for its own marks (`agent-cursor.ts`), and the pauses. No page is evaluated for them.
 * Thinking (the model's turn) is not an event: the view infers it from the gap between calls.
 */

/** A rectangle in the page's viewport, in CSS pixels. */
export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StagePoint {
  x: number;
  y: number;
}

/** The kind of an action, which decides how the view draws it. */
export type ActionKind =
  | "navigate"
  | "read"
  | "locate"
  | "click"
  | "hover"
  | "type"
  | "select"
  | "scroll"
  | "drag"
  | "upload"
  | "download"
  | "dialog"
  | "wait"
  | "script"
  | "tabs"
  | "run"
  | "human"
  | "other";

export type ScrollDirection = "up" | "down" | "left" | "right";

/** Who the person's step is for: a step the agent asked for, a last click, a passkey, a captcha. */
export type HumanCueKind = "step" | "last-click" | "passkey" | "captcha";

/** What a person step tells the view and the Chrome window, besides its pause. */
export interface HumanCue {
  kind: HumanCueKind;
  /** The step's instruction, as the agent wrote it (it goes through the redactor). */
  text?: string;
  /** What the click does (a last click), or how to do the step (a passkey), from the banner. */
  detail?: string;
  /** The element the person should act on, in the page's viewport. */
  box?: StageBox;
  /** The page of the step. */
  page?: Page;
}

/** A mark the agent cursor made: the box it ringed, where a click landed, a field typed into. */
export type MarkKind = "box" | "click" | "type" | "drag" | "download";

/** The events the view receives, as `fx` events on its stream. */
export type StageEvent =
  | {
      type: "start";
      /** The step's number, which its marks and its end carry too. */
      step: number;
      at: number;
      session: string;
      /** The agent's name ("Claude Code"), or "" when its client sent none. */
      agent: string;
      kind: ActionKind;
      tool: string;
      /** What it works on, as the timeline names it (redacted, never a typed value). */
      target: string;
      /** A typing step: how many characters, never which. */
      chars?: number;
      /** The value comes from the vault (a sign-in): not even its length is told. */
      vault?: boolean;
      dir?: ScrollDirection;
    }
  | {
      type: "mark";
      /** The step it belongs to, 0 when no step of that session is open. */
      step: number;
      at: number;
      /** The tab it is on (`LiveServer.idOf`): the view draws only marks on the tab it shows. */
      tab: number;
      mark: MarkKind;
      box?: StageBox;
      point?: StagePoint;
      /** The page's scroll when the box was measured, so the view can follow the page as it scrolls. */
      scroll?: StagePoint;
      /** A download's file name. */
      name?: string;
    }
  | {
      type: "end";
      step: number;
      at: number;
      ms: number;
      kind: ActionKind;
      outcome: "ok" | "error" | "not-run" | "handed";
      /** The stable code of a failure (`ELEMENT_COVERED`), when its message starts with one. */
      code?: string;
      /** The n-th failure in a row of the same call on the same target. */
      stuck?: number;
    }
  | {
      type: "human";
      at: number;
      cue: HumanCueKind;
      tab?: number;
      text?: string;
      detail?: string;
      box?: StageBox;
      scroll?: StagePoint;
    }
  | { type: "take-over"; at: number; by: "view" | "window" | "command" }
  | { type: "hand-back"; at: number; ms: number; step: boolean };

type StartEvent = Extract<StageEvent, { type: "start" }>;

/** The kind of each tool's calls; a tool missing here is "other". */
export const TOOL_KINDS: Readonly<Record<string, ActionKind>> = Object.freeze({
  browser_navigate: "navigate",
  browser_navigate_back: "navigate",
  browser_navigate_forward: "navigate",
  browser_reload: "navigate",
  browser_snapshot: "read",
  browser_take_screenshot: "read",
  browser_extract: "read",
  browser_read: "read",
  browser_find: "locate",
  browser_observe: "locate",
  browser_generate_locator: "locate",
  browser_verify_element_visible: "locate",
  browser_verify_list_visible: "locate",
  browser_verify_text_visible: "locate",
  browser_verify_value: "locate",
  browser_click: "click",
  browser_mouse_click_xy: "click",
  browser_mouse_down: "click",
  browser_mouse_up: "click",
  browser_hover: "hover",
  browser_mouse_move_xy: "hover",
  browser_type: "type",
  browser_press_sequentially: "type",
  browser_fill_form: "type",
  browser_press_key: "type",
  browser_keydown: "type",
  browser_keyup: "type",
  browser_login: "type",
  browser_select_option: "select",
  browser_check: "select",
  browser_uncheck: "select",
  browser_mouse_wheel: "scroll",
  browser_drag: "drag",
  browser_mouse_drag_xy: "drag",
  browser_file_upload: "upload",
  browser_drop: "upload",
  browser_handle_dialog: "dialog",
  browser_wait_for: "wait",
  browser_evaluate: "script",
  browser_run_code_unsafe: "script",
  browser_tabs: "tabs",
  browser_close: "tabs",
  browser_resize: "tabs",
  browser_batch: "run",
  browser_replay: "run",
  browser_act: "run",
  browser_request_human: "human",
});

/** Keys that scroll the page rather than type, and which way. */
const SCROLL_KEYS: Readonly<Record<string, ScrollDirection>> = Object.freeze({
  PageDown: "down",
  End: "down",
  PageUp: "up",
  Home: "up",
});

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The kind of a call, from its tool and, for a key or the wheel, which way it scrolls. */
function actionKind(tool: string, args: Record<string, unknown>): ActionKind {
  if (tool === "browser_press_key" && typeof args.key === "string" && SCROLL_KEYS[args.key]) return "scroll";
  return TOOL_KINDS[tool] ?? "other";
}

/** Which way a scroll goes: the wheel's larger delta, or the key. */
function scrollDirection(tool: string, args: Record<string, unknown>): ScrollDirection | undefined {
  if (tool === "browser_press_key") return typeof args.key === "string" ? SCROLL_KEYS[args.key] : undefined;
  const dx = num(args.deltaX);
  const dy = num(args.deltaY);
  if (!dx && !dy) return undefined;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "down" : "up";
  return dx > 0 ? "right" : "left";
}

/** How many characters a typing call types: a count read off its arguments, never the text. */
function typedChars(tool: string, args: Record<string, unknown>): number | undefined {
  if (tool === "browser_type" || tool === "browser_press_sequentially")
    return typeof args.text === "string" ? [...args.text].length : undefined;
  if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
    let n = 0;
    for (const f of args.fields as { type?: unknown; value?: unknown }[])
      if (f?.type === "textbox" && typeof f.value === "string") n += [...f.value].length;
    return n;
  }
  return undefined;
}

/** The stable code a failure's message starts with (`ELEMENT_COVERED: ...`), if it has one. */
function failureCode(detail: string): string | undefined {
  return /^([A-Z][A-Z0-9_]{2,39}):/.exec(detail)?.[1];
}

/** What a call of the timeline needs for its end event. */
interface EndedCall {
  session: string;
  tool: string;
  at: number;
  ms: number;
  outcome: "ok" | "error" | "not-run" | "handed";
  detail: string;
  stuck?: number;
}

/** How long a mark may come after its step started and still belong to it (a batch runs long). */
const MARK_WINDOW_MS = 10 * 60_000;

/**
 * The effect feed of one live view: it turns calls, cursor marks and pauses into `StageEvent`s,
 * and keeps the steps that run now so a view that connects later can show them.
 */
export class Stage {
  private seq = 0;
  /** The step each session runs now, by the session's short tag (as the timeline has it). */
  private readonly open = new Map<string, StartEvent>();
  private readonly listeners = new Set<(event: StageEvent) => void>();

  constructor(
    private readonly o: {
      /** What a call works on, as the timeline names it: redacted, never its input. */
      target(tool: string, args: Record<string, unknown>): string;
      /** Redacts and clips a text for the view. */
      clean(text: string, max: number): string;
      now?(): number;
    },
  ) {}

  /** Calls `fn` with each event; returns what stops that. */
  onEvent(fn: (event: StageEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The steps running now, for a view that connects while they run. */
  running(): StageEvent[] {
    return [...this.open.values()];
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private emit(event: StageEvent): StageEvent {
    for (const fn of this.listeners) fn(event);
    return event;
  }

  /** A call of the agent starts (after any pause let it go). */
  start(call: { tool: string; args: Record<string, unknown>; session: string; agent?: string }): StageEvent {
    const { tool, args } = call;
    const kind = actionKind(tool, args);
    const chars = kind === "type" ? typedChars(tool, args) : undefined;
    const dir = kind === "scroll" ? scrollDirection(tool, args) : undefined;
    const event: StartEvent = {
      type: "start",
      step: ++this.seq,
      at: this.now(),
      session: call.session.slice(0, 8),
      agent: this.o.clean(call.agent ?? "", 40),
      kind,
      tool,
      target: this.o.target(tool, args),
      ...(chars !== undefined ? { chars } : {}),
      ...(tool === "browser_login" ? { vault: true } : {}),
      ...(dir ? { dir } : {}),
    };
    this.open.set(event.session, event);
    return this.emit(event);
  }

  /** A call ended, as the timeline recorded it. */
  end(call: EndedCall): StageEvent {
    const session = call.session.slice(0, 8);
    const open = this.open.get(session);
    const mine = open && open.tool === call.tool ? open : undefined;
    if (mine) this.open.delete(session);
    const code = call.outcome === "error" ? failureCode(call.detail) : undefined;
    return this.emit({
      type: "end",
      step: mine?.step ?? 0,
      at: call.at,
      ms: call.ms,
      kind: mine?.kind ?? TOOL_KINDS[call.tool] ?? "other",
      outcome: call.outcome,
      ...(code ? { code } : {}),
      ...(call.stuck ? { stuck: call.stuck } : {}),
    });
  }

  /** The agent cursor marked something on a tab. */
  mark(m: {
    session: string;
    tab: number;
    mark: MarkKind;
    box?: StageBox;
    point?: StagePoint;
    scroll?: StagePoint;
    name?: string;
  }): StageEvent {
    const now = this.now();
    const open = this.open.get(m.session.slice(0, 8));
    const step = open && now - open.at < MARK_WINDOW_MS ? open.step : 0;
    return this.emit({
      type: "mark",
      step,
      at: now,
      tab: m.tab,
      mark: m.mark,
      ...(m.box ? { box: roundBox(m.box) } : {}),
      ...(m.point ? { point: roundPoint(m.point) } : {}),
      ...(m.scroll ? { scroll: roundPoint(m.scroll) } : {}),
      ...(m.name ? { name: this.o.clean(m.name, 80) } : {}),
    });
  }

  /** The browser was handed to the person: their own pause, or a step the agent asked for. */
  paused(p: { by: string; step: boolean; cue?: HumanCue; tab?: number; scroll?: StagePoint }): StageEvent {
    const at = this.now();
    if (!p.step)
      return this.emit({
        type: "take-over",
        at,
        by:
          p.by === "the live view"
            ? "view"
            : p.by === "the person's input in the browser window"
              ? "window"
              : "command",
      });
    const cue = p.cue;
    return this.emit({
      type: "human",
      at,
      cue: cue?.kind ?? (p.by === "a passkey prompt" ? "passkey" : "step"),
      ...(p.tab !== undefined ? { tab: p.tab } : {}),
      ...(cue?.text ? { text: this.o.clean(cue.text, 200) } : {}),
      ...(cue?.detail ? { detail: this.o.clean(cue.detail, 300) } : {}),
      ...(cue?.box ? { box: roundBox(cue.box) } : {}),
      ...(cue?.box && p.scroll ? { scroll: roundPoint(p.scroll) } : {}),
    });
  }

  /** The person handed the browser back after `ms`. */
  resumed(ms: number, step: boolean): StageEvent {
    return this.emit({ type: "hand-back", at: this.now(), ms: Math.max(0, Math.round(ms)), step });
  }
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

function roundBox(b: StageBox): StageBox {
  return { x: r1(b.x), y: r1(b.y), width: r1(b.width), height: r1(b.height) };
}

function roundPoint(p: StagePoint): StagePoint {
  return { x: r1(p.x), y: r1(p.y) };
}
