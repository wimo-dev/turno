import type { Frame, Page } from "patchright-core";
import { describe, expect, it } from "vitest";
import type { StepRun, StepSettle } from "../src/human-step.js";
import { PasskeyWatch, parseReport, passkeyKind, passkeyOutcome } from "../src/passkey.js";

describe("passkeyKind", () => {
  it("is modal only for a WebAuthn request the person must answer now", () => {
    expect(passkeyKind({ publicKey: true })).toBe("modal");
    expect(passkeyKind({ publicKey: true, mediation: "optional" })).toBe("modal");
    expect(passkeyKind({ publicKey: true, mediation: "required" })).toBe("modal");
    expect(passkeyKind({ publicKey: true, mediation: "conditional" })).toBe("conditional");
    expect(passkeyKind({ publicKey: true, mediation: "silent" })).toBe("none");
    expect(passkeyKind({ publicKey: true, mediation: "bogus" })).toBe("none");
    expect(passkeyKind({ mediation: "required" })).toBe("none");
  });
});

describe("passkeyOutcome", () => {
  it("names how a ceremony settled, by its op and error name", () => {
    expect(passkeyOutcome("create", true)).toEqual({ kind: "created" });
    expect(passkeyOutcome("get", true)).toEqual({ kind: "used" });
    expect(passkeyOutcome("get", false, "NotAllowedError")).toEqual({ kind: "cancelled", error: "NotAllowedError" });
    expect(passkeyOutcome("get", false, "AbortError")).toEqual({ kind: "aborted", error: "AbortError" });
    expect(passkeyOutcome("create", false, "InvalidStateError")).toEqual({
      kind: "failed",
      error: "InvalidStateError",
    });
  });
});

describe("parseReport", () => {
  it("keeps only the fields a report has, and drops what is not one", () => {
    expect(parseReport({ id: "a1", op: "get", phase: "start", publicKey: true, challenge: "x" })).toEqual({
      id: "a1",
      op: "get",
      phase: "start",
      publicKey: true,
    });
    expect(parseReport({ id: "a1", op: "store", phase: "start" })).toBeUndefined();
    expect(parseReport("a1")).toBeUndefined();
  });
});

/** A page with a main frame, whose frame events a test emits. */
function fakePage(url = "https://example.com/login"): Page & { frame: Frame; emit(event: string, f: Frame): void } {
  const frame = {} as Frame;
  const on = new Map<string, Set<(f: Frame) => void>>();
  return {
    url: () => url,
    frame,
    on: (event: string, fn: (f: Frame) => void) => on.set(event, (on.get(event) ?? new Set()).add(fn)),
    off: (event: string, fn: (f: Frame) => void) => on.get(event)?.delete(fn),
    emit: (event: string, f: Frame) => {
      for (const fn of on.get(event) ?? []) fn(f);
    },
  } as unknown as Page & { frame: Frame; emit(event: string, f: Frame): void };
}

const run = (ended: StepRun["ended"]): StepRun => ({
  ended,
  waitedMs: 1200,
  lines: [],
  clicks: 0,
  fields: 0,
  liveInputs: 0,
  targetClicked: false,
});

describe("PasskeyWatch", () => {
  it("starts a step on a modal ceremony, ends it when the ceremony settles, and notes how it went once", async () => {
    const steps: StepSettle[] = [];
    const watch = new PasskeyWatch({
      unseen: () => undefined,
      paused: () => false,
      pending: async () => true,
      handoff: (_page, settle) => {
        steps.push(settle);
        return new Promise((resolve) => settle.onSettle(() => resolve(run("settled"))));
      },
    });
    const page = fakePage();
    watch.report({ id: "c1", op: "get", phase: "start", publicKey: true, mediation: "conditional" }, page, page.frame);
    expect(steps).toHaveLength(0);
    watch.report({ id: "m1", op: "create", phase: "start", publicKey: true }, page, page.frame);
    expect(steps).toHaveLength(1);
    expect(watch.running).toBeDefined();
    watch.report({ id: "m1", op: "create", phase: "settle", ok: true }, page, page.frame);
    await watch.running;
    const notes = watch.takeNotes();
    expect(notes.map((n) => n.data)).toEqual([
      { op: "create", origin: "https://example.com", ended: "settled", waitedMs: 1200, outcome: "created" },
    ]);
    expect(watch.takeNotes()).toEqual([]);
  });

  it("starts no step when the person cannot see Chrome's window, or already has the browser", () => {
    let handoffs = 0;
    const handoff = () => {
      handoffs++;
      return new Promise<StepRun>(() => {});
    };
    const pending = async () => true;
    const page0 = fakePage();
    const unseen = new PasskeyWatch({ unseen: () => "it has no window.", paused: () => false, pending, handoff });
    unseen.report({ id: "m1", op: "get", phase: "start", publicKey: true }, page0, page0.frame);
    expect(unseen.takeNotes().map((n) => n.data)).toEqual([{ op: "get", origin: "https://example.com", unseen: true }]);

    const held = new PasskeyWatch({ unseen: () => undefined, paused: () => true, pending, handoff });
    const page = fakePage();
    held.report({ id: "m2", op: "get", phase: "start", publicKey: true }, page, page.frame);
    expect(held.takeNotes()).toEqual([]);
    held.report({ id: "m2", op: "get", phase: "settle", ok: false, error: "NotAllowedError" }, page, page.frame);
    expect(held.takeNotes().map((n) => n.data)).toEqual([
      { op: "get", origin: "https://example.com", outcome: "cancelled", error: "NotAllowedError" },
    ]);
    expect(handoffs).toBe(0);
  });

  it("ends the step when the page navigates away from the request, not on a navigation within the document", async () => {
    let still = true;
    const watch = new PasskeyWatch({
      unseen: () => undefined,
      paused: () => false,
      pending: async () => still,
      handoff: (_page, settle) => new Promise((resolve) => settle.onSettle(() => resolve(run("settled")))),
    });
    const page = fakePage();
    watch.report({ id: "m1", op: "get", phase: "start", publicKey: true }, page, page.frame);
    page.emit("framenavigated", page.frame);
    await new Promise((r) => setTimeout(r, 0));
    expect(watch.running).toBeDefined();
    still = false;
    page.emit("framenavigated", page.frame);
    await watch.running;
    expect(watch.takeNotes().map((n) => n.data)).toEqual([
      { op: "get", origin: "https://example.com", ended: "settled", waitedMs: 1200, outcome: "left" },
    ]);
  });
});
