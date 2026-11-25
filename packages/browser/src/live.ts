import { join } from "node:path";
import { identityStateDir } from "./ids.js";
import type { LiveSettings } from "./settings.js";
import { parseDuration } from "./units.js";
import { names } from "./names.js";

/**
 * The live view and take-over, the part that needs no browser: the policy (identity.json `live`
 * and the server flags), the pause gate that holds the agent's calls while the user acts, and
 * the note that tells the agent what changed. The HTTP side and the screencast are in
 * `live-server.ts`; the host wires both into every call (`host.ts`).
 *
 * How a pause works:
 *
 * - The user pauses (the live view's Pause button, or `turno browser pause <id>`). A call that is
 *   running finishes; the next call of any session waits, up to `live.wait` (2 minutes by
 *   default), for the user to resume. A batch or replay in progress stops at its next step.
 * - On resume the held call gets a note first: how long the pause lasted and what changed in the
 *   browser's tabs (the current tab's URL and title, tabs opened and closed, input from the live
 *   view). When nothing changed, the call runs. When something changed, a call that only reads
 *   (a snapshot, the tab list) runs; any other call does not, because the refs of the agent's last
 *   snapshot may now point elsewhere, and a fresh snapshot comes back instead.
 * - When the wait runs out the call fails with a message that says the user still has the
 *   browser; the next call waits again.
 */

/** How long a paused call waits for the user when identity.json and the flags say nothing. */
export const DEFAULT_LIVE_WAIT_MS = 2 * 60_000;

/** `turno-browser-mcp --live` and `--live-wait`: each wins over identity.json `live`. */
export interface LiveFlags {
  live?: boolean;
  waitMs?: number;
}

export interface LivePolicy {
  enabled: boolean;
  waitMs: number;
}

/**
 * The live policy of a server with an identity: flags, then identity.json, then on. The view
 * listens on 127.0.0.1 behind a per-process cookie and opens only when the person asks for a
 * one-time link (`turno-browser live <id>`), so being on costs a socket, not exposure.
 */
export function resolveLive(settings: LiveSettings | undefined, flags: LiveFlags = {}): LivePolicy {
  const wait = settings?.wait === undefined ? undefined : parseDuration(settings.wait);
  const enabled = settings?.enabled;
  return {
    enabled: flags.live ?? (typeof enabled === "boolean" ? enabled : true),
    waitMs: flags.waitMs ?? wait ?? DEFAULT_LIVE_WAIT_MS,
  };
}

/**
 * Where a running server says how to reach its live view: its pid, the control socket and the
 * port, never a token (`live-server.ts` writes it, `live-client.ts` reads it).
 */
export function liveFilePath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "live.json");
}

export interface LiveFile {
  version: 1;
  pid: number;
  socket: string;
  port: number;
  started: string;
}

/**
 * Why the live view shows no pixels with this engine (read mode, attach mode, Camoufox);
 * undefined when it can. Pause and resume
 * work with every engine.
 */
export function viewRefusal(engine: string | undefined): string | undefined {
  if (engine === "lightpanda")
    return "Read mode (Lightpanda) renders no pixels, so there is nothing to show. Pause and resume still work.";
  if (engine === "attach")
    return "Attach mode drives your own Chrome, which you already see; a view would stream your own tabs, so it is off. Pause and resume still work.";
  if (engine === "camoufox")
    return "The view is a Chrome DevTools Protocol screencast, and Camoufox is a Firefox build that has none, so there is nothing to show; Camoufox's own window shows the page when it runs headed. Pause and resume still work.";
  return undefined;
}

/** One tab as the note compares it before and after a pause. */
export interface TabState {
  id: number;
  url: string;
  title: string;
}

/** What a held call learns when the gate lets it go. */
export type GateOutcome =
  | { kind: "open" }
  | {
      kind: "resumed";
      pausedMs: number;
      by: string;
      /** The pause was a step an agent asked the person to do (`browser_request_human`). */
      step: boolean;
      /** The tabs when the pause started (empty when no browser ran). */
      before: TabState[];
      /** Clicks, keys and scrolls the user sent through the live view during the pause. */
      inputs: number;
    }
  | { kind: "timeout"; pausedMs: number; by: string; step: boolean }
  | { kind: "aborted" };

/** How a pause holds calls beyond the live wait: a step the agent asked the person to do. */
export interface PauseHold {
  /** The pause is a person step (`browser_request_human`), not the user's own pause. */
  step?: boolean;
  /** When the step ends at the latest (epoch ms): a held call waits at least until then. */
  until?: number;
}

/** How long a held call waits past the end of a person step, for the step to clean up. */
const STEP_SLACK_MS = 10_000;

interface Pause {
  since: number;
  by: string;
  step: boolean;
  until: number | undefined;
  before: Promise<TabState[]>;
  inputs: number;
  done: Promise<void>;
  release: () => void;
}

/** Holds calls while the user has the browser. One per server: a pause holds every session. */
export class PauseGate {
  private pause: Pause | undefined;
  /** The pause that ended last, for a step the person resumed before it read its input count. */
  private ended: { since: number; inputs: number } | undefined;
  private waiting = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get paused(): { since: number; by: string; step: boolean } | undefined {
    return this.pause && { since: this.pause.since, by: this.pause.by, step: this.pause.step };
  }

  /** The live view input of the pause that started at `since`, on now or ended last (else 0). */
  inputsOf(since: number | undefined): number {
    if (since === undefined) return 0;
    if (this.pause?.since === since) return this.pause.inputs;
    return this.ended?.since === since ? this.ended.inputs : 0;
  }

  /** Calls waiting for the user now. */
  get held(): number {
    return this.waiting;
  }

  /** Starts a pause; false when one is already on. `before` is the tabs as the agent left them. */
  start(by: string, before: Promise<TabState[]> = Promise.resolve([]), hold: PauseHold = {}): boolean {
    if (this.pause) return false;
    let release!: () => void;
    const done = new Promise<void>((r) => {
      release = r;
    });
    before.catch(() => {});
    this.pause = {
      since: this.now(),
      by,
      step: hold.step === true,
      until: hold.until,
      before,
      inputs: 0,
      done,
      release,
    };
    return true;
  }

  /** Ends the pause and lets every held call go; false when there was none. */
  resume(): boolean {
    const p = this.pause;
    if (!p) return false;
    this.pause = undefined;
    this.ended = { since: p.since, inputs: p.inputs };
    p.release();
    return true;
  }

  /** The user clicked, typed or scrolled through the live view. */
  noteInput(): void {
    if (this.pause) this.pause.inputs++;
  }

  /** Waits while paused, at most `waitMs`; resolves at once when there is no pause. */
  async wait(waitMs: number, signal?: AbortSignal): Promise<GateOutcome> {
    const p = this.pause;
    if (!p) return { kind: "open" };
    if (signal?.aborted) return { kind: "aborted" };
    this.waiting++;
    // A person step holds every call until it ends, however long the live wait is.
    const holdMs = p.until === undefined ? waitMs : Math.max(waitMs, p.until - this.now() + STEP_SLACK_MS);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        p.done.then(() => "resumed" as const),
        new Promise<"timeout">((r) => {
          // Each call waits the whole time: a call that arrives late in a pause is held as long.
          timer = setTimeout(() => r("timeout"), holdMs);
        }),
        new Promise<"aborted">((r) => {
          onAbort = () => r("aborted");
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (outcome === "aborted") return { kind: "aborted" };
      const pausedMs = this.now() - p.since;
      if (outcome === "timeout") return { kind: "timeout", pausedMs, by: p.by, step: p.step };
      return {
        kind: "resumed",
        pausedMs,
        by: p.by,
        step: p.step,
        before: await p.before.catch(() => []),
        inputs: p.inputs,
      };
    } finally {
      this.waiting--;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** `65000` as "1m 05s", `9000` as "9s". */
export function formatPause(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * What changed in the tabs between the pause and now, one line each, from the point of view
 * of the session whose current tab was `currentBefore` and is `currentAfter` now.
 */
export function describeChanges(
  before: readonly TabState[],
  after: readonly TabState[],
  currentBefore: number | undefined,
  currentAfter: number | undefined,
  inputs: number,
): { changed: boolean; lines: string[] } {
  const lines: string[] = [];
  const was = new Map(before.map((t) => [t.id, t]));
  const now = new Map(after.map((t) => [t.id, t]));
  const cb = currentBefore === undefined ? undefined : was.get(currentBefore);
  const ca = currentAfter === undefined ? undefined : now.get(currentAfter);
  if (cb && ca && cb.id === ca.id) {
    if (cb.url !== ca.url) lines.push(`Current tab: ${cb.url} -> ${ca.url}`);
    if (cb.title !== ca.title) lines.push(`Title: ${JSON.stringify(cb.title)} -> ${JSON.stringify(ca.title)}`);
  } else if (ca && currentBefore !== undefined) {
    lines.push(`Current tab is now another tab: ${ca.url} (${JSON.stringify(ca.title)})`);
  }
  for (const t of after) if (!was.has(t.id)) lines.push(`New tab: ${t.url}`);
  for (const t of before) if (!now.has(t.id)) lines.push(`Closed tab: ${t.url}`);
  for (const t of after) {
    const old = was.get(t.id);
    if (!old || t.id === ca?.id || t.id === cb?.id) continue;
    if (old.url !== t.url) lines.push(`Another tab: ${old.url} -> ${t.url}`);
  }
  if (inputs > 0)
    lines.push(`The user clicked, typed or scrolled ${inputs} time${inputs === 1 ? "" : "s"} through the live view.`);
  return { changed: lines.length > 0, lines };
}

/** The section a held call's result starts with. */
export function resumeNote(o: {
  pausedMs: number;
  by: string;
  lines: readonly string[];
  tool: string;
  ran: boolean;
  /** The pause was a person step (`browser_request_human`, or a page's passkey prompt). */
  step?: boolean;
  /** A flow is being recorded: what the user did is not in it. */
  recordingFlow?: boolean;
  /** The browser is not running, so there is no snapshot. */
  noBrowser?: boolean;
}): string {
  const out = o.step
    ? [
        "### Waited for the person",
        `The browser was handed to the person for a step (${o.by}); it took ${formatPause(o.pausedMs)} and has ended.`,
      ]
    : [
        "### Paused by the user",
        `The user paused this browser (${o.by}) for ${formatPause(o.pausedMs)} and has resumed it.`,
      ];
  if (o.lines.length) out.push("While you waited:", ...o.lines.map((l) => `- ${l}`));
  else out.push("Nothing changed in the browser's tabs (same tabs, URLs and titles).");
  if (o.ran) out.push(`Your ${o.tool} call ran after the resume; its result follows.`);
  else if (o.noBrowser)
    out.push(`Your ${o.tool} call was not run. The browser is not running now; start again from a navigation.`);
  else
    out.push(
      `Your ${o.tool} call was not run: the browser changed while you waited, so the refs of your last snapshot may point elsewhere. A fresh snapshot follows; decide the next step from it.`,
    );
  if (o.recordingFlow) out.push("The flow you are recording does not have what the user did.");
  return out.join("\n");
}

/** The note of a call that was running when a pause started. */
export function pausedWhileRunningNote(step: boolean): string {
  return step
    ? "### Waited for the person\nThe browser was handed to the person for a step while this call ran. Your next call waits until the step ends."
    : "### Paused by the user\nThe user paused this browser while this call ran. Your next call waits until they resume.";
}

/** The error of a call whose wait ran out. */
export function timeoutMessage(identity: string, tool: string, pausedMs: number, by: string, waitMs: number): string {
  return (
    `The user paused browser identity "${identity}" ${formatPause(pausedMs)} ago (${by}) and has not resumed it ` +
    `within ${formatPause(waitMs)}, so ${tool} was not run. The user is probably acting in the browser: wait, or ask ` +
    `them to resume (Resume in the live view, or ${names().browser} resume ${identity}), then call again.`
  );
}
