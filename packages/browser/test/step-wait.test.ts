import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStepCall } from "../src/human-step.js";
import { DEFAULT_STEP_WAIT_MS, StepTable } from "../src/step-wait.js";

/** Waiting for a person step in pieces: the table a step runs in, and what a call asks for. */

const info = { by: "browser_request_human", instruction: "Type the code.", timeoutMs: 300_000 };

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("StepTable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns after waitMs while the step goes on, counts from the step's start, and gives its result once", async () => {
    const table = new StepTable<string>();
    const run = deferred<string>();
    const step = table.open(info, run.promise);
    if ("busy" in step) throw new Error("busy");

    const first = table.wait(step, 50_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await first).toEqual({ kind: "waiting", elapsedMs: 50_000 });
    expect(table.running).toBe(step);
    // A new step is refused while this one runs, and named.
    expect(table.open(info, new Promise<string>(() => {}))).toEqual({ busy: step });

    expect(table.find("nope")).toBeUndefined();
    const second = table.wait(table.find(step.id)!, 50_000);
    await vi.advanceTimersByTimeAsync(20_000);
    run.resolve("ended");
    expect(await second).toEqual({ kind: "ended", result: "ended" });
    expect(table.running).toBeUndefined();
    expect(table.find(true)).toBeUndefined();
  });

  it("keeps a result no call waited for until one continues, and drops it for a new step", async () => {
    const table = new StepTable<string>();
    const early = table.open(info, Promise.resolve("done early"));
    if ("busy" in early) throw new Error("busy");
    await vi.advanceTimersByTimeAsync(0);
    expect(table.running).toBeUndefined();
    expect(await table.wait(table.find(true)!, 50_000)).toEqual({ kind: "ended", result: "done early" });

    const unread = table.open(info, Promise.resolve("unread"));
    await vi.advanceTimersByTimeAsync(0);
    const next = table.open(info, new Promise<string>(() => {}));
    expect("busy" in next).toBe(false);
    expect(table.find(true)).toBe(next);
    expect(table.find((unread as { id: string }).id)).toBeUndefined();
  });

  it("ends the step when the call that waits for it is cancelled, or only stops waiting", async () => {
    const table = new StepTable<string>();
    const run = deferred<string>();
    const cancel = vi.fn(() => run.resolve("cancelled"));
    const step = table.open(info, run.promise, cancel);
    if ("busy" in step) throw new Error("busy");

    const passive = new AbortController();
    const looking = table.wait(step, 50_000, { signal: passive.signal });
    passive.abort();
    expect(await looking).toMatchObject({ kind: "waiting" });
    expect(cancel).not.toHaveBeenCalled();

    const asked = new AbortController();
    const waiting = table.wait(step, 50_000, { signal: asked.signal, cancelOnAbort: true });
    asked.abort();
    expect(await waiting).toEqual({ kind: "ended", result: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("a browser_request_human call", () => {
  it("starts a step or continues the open one, and waits 50 s by default, 4 minutes at most", () => {
    expect(parseStepCall({ instruction: "Type the code." })).toMatchObject({
      kind: "start",
      params: { instruction: "Type the code." },
      waitMs: DEFAULT_STEP_WAIT_MS,
    });
    expect(parseStepCall({ continue: true, waitMs: 240_000 })).toEqual({
      kind: "continue",
      step: true,
      waitMs: 240_000,
    });
    expect(parseStepCall({ continue: " s1a2b3 ", instruction: "ignored" })).toMatchObject({ step: "s1a2b3" });
    const error = (raw: Record<string, unknown>) => (parseStepCall(raw) as { error?: string }).error;
    expect(error({ continue: true, waitMs: 240_001 })).toMatch(/waitMs must be from 1000 to 240000/);
    expect(error({ continue: true, waitMs: "50000" })).toMatch(/waitMs/);
    expect(error({ continue: 1 })).toMatch(/continue must be true or the id/);
    expect(error({})).toMatch(/instruction must say/);
  });
});
