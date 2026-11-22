/**
 * Waiting for a person step in pieces. A step (`human-step.ts`, or a page's passkey prompt,
 * `passkey.ts`) runs on its own once it starts: the banner stays up and every other call stays
 * held until it ends or times out (its timeout counts from when it began). A call waits for it
 * at most `waitMs` (50 s by default, up to 4 minutes) and then returns a "still waiting" result,
 * and the agent calls `browser_request_human` with `continue` to wait another piece.
 *
 * Why pieces: MCP clients give a tool call a limit of their own. The TypeScript SDK fails a
 * request after 60 s unless the client opts in to progress resetting it, and Codex stops a call
 * after its `tool_timeout_sec` whatever progress it hears. A person typing a code from an email
 * takes longer than that, and a call cut off by its client used to end the step with it.
 *
 * The table holds one step at a time, like the pause gate it holds: a step that ended before any
 * call read its result stays until one does (or the next step starts).
 */

export const DEFAULT_STEP_WAIT_MS = 50_000;
export const MAX_STEP_WAIT_MS = 240_000;
const MIN_STEP_WAIT_MS = 1_000;

/** `waitMs` as a call gives it, or why it is not one. */
export function parseWaitMs(value: unknown): number | { error: string } {
  if (value === undefined) return DEFAULT_STEP_WAIT_MS;
  const ms = Number(value);
  if (typeof value !== "number" || !Number.isFinite(ms) || ms < MIN_STEP_WAIT_MS || ms > MAX_STEP_WAIT_MS)
    return {
      error: `waitMs must be from ${MIN_STEP_WAIT_MS} to ${MAX_STEP_WAIT_MS} (4 minutes); without it a call waits ${DEFAULT_STEP_WAIT_MS / 1000} s`,
    };
  return Math.round(ms);
}

/** What a "still waiting" result says about a step. */
export interface StepInfo {
  /** Who asked: the tool, or "a passkey prompt". */
  by: string;
  instruction: string;
  timeoutMs: number;
}

export class OpenStep<R> {
  ended = false;
  /** A call has read the result: the step leaves the table. */
  claimed = false;
  constructor(
    readonly id: string,
    readonly info: StepInfo,
    readonly began: number,
    readonly done: Promise<R>,
    /** Ends the step (`cancelled`): the call that asked for it was cancelled. */
    readonly cancel: (() => void) | undefined,
  ) {}
}

/** How a call's wait went. */
export type StepWait<R> = { kind: "ended"; result: R } | { kind: "waiting"; elapsedMs: number };

export class StepTable<R> {
  private step: OpenStep<R> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** The step running now, if any. */
  get running(): OpenStep<R> | undefined {
    return this.step && !this.step.ended ? this.step : undefined;
  }

  /**
   * Registers a step that has started; refused (with the step that is running) while another
   * runs. A result no call read is dropped.
   */
  open(info: StepInfo, done: Promise<R>, cancel?: () => void): OpenStep<R> | { busy: OpenStep<R> } {
    const busy = this.running;
    if (busy) return { busy };
    const id = `s${Math.random().toString(36).slice(2, 8)}`;
    const step = new OpenStep(id, info, this.now(), done, cancel);
    this.step = step;
    void done.then(
      () => {
        step.ended = true;
      },
      () => {
        step.ended = true;
      },
    );
    return step;
  }

  /** The step `ref` names (`true`: the one in the table), running or ended and not read yet. */
  find(ref: true | string): OpenStep<R> | undefined {
    const s = this.step;
    if (!s || s.claimed) return undefined;
    return ref === true || ref === s.id ? s : undefined;
  }

  /**
   * Waits for `step` at most `waitMs`. A cancelled call cancels the step when `cancelOnAbort`
   * (a `browser_request_human` call), and otherwise only stops waiting (a click that started a
   * page's passkey prompt: the prompt is the page's).
   */
  async wait(
    step: OpenStep<R>,
    waitMs: number,
    o: {
      signal?: AbortSignal;
      cancelOnAbort?: boolean;
      progress?: (elapsedMs: number) => void;
      progressMs?: number;
    } = {},
  ): Promise<StepWait<R>> {
    let timer: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const outcome = await Promise.race([
      step.done.then((result) => ({ kind: "ended" as const, result })),
      new Promise<"waiting">((r) => {
        timer = setTimeout(() => r("waiting"), waitMs);
        if (o.progress) ticker = setInterval(() => o.progress?.(this.now() - step.began), o.progressMs ?? 15_000);
      }),
      new Promise<"aborted">((r) => {
        if (!o.signal) return;
        onAbort = () => r("aborted");
        if (o.signal.aborted) onAbort();
        else o.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      clearInterval(ticker);
      if (onAbort) o.signal?.removeEventListener("abort", onAbort);
    });
    if (outcome === "aborted" && o.cancelOnAbort && step.cancel) {
      step.cancel();
      return this.claim(step, await step.done);
    }
    if (typeof outcome === "object") return this.claim(step, outcome.result);
    return { kind: "waiting", elapsedMs: this.now() - step.began };
  }

  private claim(step: OpenStep<R>, result: R): StepWait<R> {
    step.claimed = true;
    if (this.step === step) this.step = undefined;
    return { kind: "ended", result };
  }
}
