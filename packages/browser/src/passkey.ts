import { randomBytes } from "node:crypto";
import type { Frame, JSHandle, Page } from "patchright-core";
import type { StepRun, StepSettle } from "./human-step.js";
import { formatPause } from "./live.js";

/**
 * Passkeys: when a page starts a WebAuthn ceremony (creating or using a passkey), only the person
 * can finish it, with Touch ID, their phone or a security key, in Chrome's own passkey window.
 * The host sees the ceremony start and hands the browser to the person the way
 * `browser_request_human` does (`human-step.ts`), and the step ends when the ceremony settles.
 *
 * How the ceremony is seen: while the agent acts on a sign-in page (a click, typing, a key: never
 * a snapshot or a navigation), the host wraps `CredentialsContainer.prototype.create` and `.get`
 * in the main world of that page's frames (a `Proxy`, so their name and length stay as they were),
 * and the wrapper notes when a call starts and when its promise settles: the operation, the
 * `mediation` value, whether a `publicKey` member was passed, and on settle the error's name.
 * Never the options themselves (challenge, user, allowed credentials) or the credential. A short
 * while after the action ends, the original methods go back, and a call already made keeps
 * reporting until it settles. A page can call the wrapper too, so a report is only a reason to
 * show the person a banner, never something the host trusts further.
 *
 * Why this mechanism, measured with patchright-core 1.64.3 and Chrome 158:
 *
 * - A wrapper is a trace a page can read: a `Proxy` over a native function prints as
 *   `function () { [native code] }`, without the name a native method has. Installed in every
 *   document from its first line (an init script, as before), every page saw it at load, where
 *   fingerprinting scripts run. Only while the agent acts on a page that shows a sign-in form, a
 *   page reading the methods at load, or at any other time, sees Chrome's own.
 * - No other place sees the call: an isolated world has its own copy of the prototype, which the
 *   page's calls never reach, and the DevTools protocol's WebAuthn domain only adds virtual
 *   authenticators, which would take the place of the person's own Touch ID, phone or key.
 * - Nothing is exposed to the page to report through: the host holds the wrapper's state through a
 *   handle and waits on it (`next`), so no binding or global is added, and no init script either
 *   (patchright adds init scripts to a cross-site iframe only after it starts running, so they were
 *   never in time there anyway).
 *
 * What is not seen: a ceremony a page starts on its own, outside the agent's actions (on load,
 * say), or on a page with no sign-in form, a password field or a sign-in address; the person still
 * sees Chrome's passkey window when they can see the browser.
 *
 * A document that goes away (the page navigates, to an identity provider say, or a policy takes
 * the tab back) drops its pending request without settling it, and the wrapper's state with it. So
 * when the frame of a ceremony navigates, the host asks the wrapper there whether the request is
 * still pending: a navigation within the document keeps it, a new document has none, and the
 * ceremony ends as `left`.
 */

export type PasskeyOp = "create" | "get";

/** What the page reports: no option values, no credential. */
export interface PasskeyReport {
  /** Random per call, from the page. */
  id: string;
  op: PasskeyOp;
  phase: "start" | "settle";
  /** The call passed a `publicKey` member (a WebAuthn request, not a password or federated one). */
  publicKey?: boolean;
  /** The call's `mediation` value, when it is a string. */
  mediation?: string;
  /** On settle: the promise resolved. */
  ok?: boolean;
  /** On settle, when it rejected: the error's name (`NotAllowedError`, `AbortError`, ...). */
  error?: string;
}

/**
 * Whether a credentials call is a passkey ceremony the person must answer now (`modal`), one that
 * waits passively for them (`conditional`), or neither (`none`).
 *
 * Credential Management Level 1, section 2.3.2 (`CredentialMediationRequirement`,
 * https://w3c.github.io/webappsec-credential-management/#enumdef-credentialmediationrequirement):
 * `"optional"` is the default for both `get()` and `create()`, and with `"required"` the user
 * agent always asks the user, so both put up Chrome's passkey window. With `"conditional"`,
 * discovered credentials are offered in a non-modal way (passkey autofill on a field with
 * `autocomplete="webauthn"`, MDN `CredentialsContainer.get()` #conditional), and the promise stays
 * pending until the person picks a passkey there: sign-in pages call it on load, and the agent must
 * not stop for it. WebAuthn Level 3 lets `create()` take `"conditional"` too (a passkey created
 * without a dialog after a password sign-in). `"silent"` suppresses user mediation altogether.
 * A request without `publicKey` asks for a password, a federated or an OTP credential: not a
 * passkey. Any other `mediation` value is not one the enum allows, so the call rejects at once.
 */
export function passkeyKind(o: { publicKey?: boolean; mediation?: string }): "modal" | "conditional" | "none" {
  if (!o.publicKey) return "none";
  if (o.mediation === undefined || o.mediation === "optional" || o.mediation === "required") return "modal";
  if (o.mediation === "conditional") return "conditional";
  return "none";
}

/** How a ceremony ended, from its op and how its promise settled. */
export interface PasskeyOutcome {
  /** `left`: the document that asked went away (a navigation) before the request settled. */
  kind: "created" | "used" | "cancelled" | "aborted" | "failed" | "left";
  /** The error's name when it rejected. */
  error?: string;
}

export function passkeyOutcome(op: PasskeyOp, ok: boolean, error?: string): PasskeyOutcome {
  if (ok) return { kind: op === "create" ? "created" : "used" };
  const name = error || "Error";
  // WebAuthn rejects both a cancel and a timeout with NotAllowedError, so a page cannot tell them apart.
  if (name === "NotAllowedError") return { kind: "cancelled", error: name };
  if (name === "AbortError") return { kind: "aborted", error: name };
  return { kind: "failed", error: name };
}

/** A report from the page, or undefined when it is not one. */
export function parseReport(raw: unknown): PasskeyReport | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || r.id.length > 64) return undefined;
  if (r.op !== "create" && r.op !== "get") return undefined;
  if (r.phase !== "start" && r.phase !== "settle") return undefined;
  const out: PasskeyReport = { id: r.id, op: r.op, phase: r.phase };
  if (r.publicKey === true) out.publicKey = true;
  if (typeof r.mediation === "string") out.mediation = r.mediation.slice(0, 32);
  if (typeof r.ok === "boolean") out.ok = r.ok;
  if (typeof r.error === "string") out.error = r.error.slice(0, 64);
  return out;
}

/** The wrapper's state in one document, as the host's handle reaches it. */
interface ProbeState {
  pending: Set<string>;
  armed: boolean;
  /** Resolves with the reports not taken yet, once there is one or the wrapper is taken off. */
  next(): Promise<{ events: unknown[]; pending: number; armed: boolean }>;
  arm(): void;
  restore(): void;
}

/**
 * The page side: wraps the two methods and keeps what happens for the host to take (`next`).
 * Runs in the main world through a handle, so it is self-contained (sent as source) and adds no
 * global: the methods themselves lead to the state, under a symbol only the host knows.
 */
function armProbe(mark: string): ProbeState | undefined {
  const proto = (globalThis as unknown as { CredentialsContainer?: { prototype: Record<string, unknown> } })
    .CredentialsContainer?.prototype;
  if (!proto) return undefined;
  const key = Symbol.for(mark);
  const existing = (proto.get as Record<symbol, ProbeState> | undefined)?.[key];
  if (existing) {
    existing.arm();
    return existing;
  }
  const ops = ["create", "get"] as const;
  const originals: Record<string, unknown> = {};
  const wrapped: Record<string, unknown> = {};
  const events: unknown[] = [];
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const state: ProbeState = {
    pending: new Set<string>(),
    armed: false,
    next: () =>
      new Promise((resolve) => {
        const done = () => resolve({ events: events.splice(0), pending: state.pending.size, armed: state.armed });
        if (events.length) done();
        else wake = done;
      }),
    arm() {
      for (const op of ops) if (wrapped[op] && proto[op] === originals[op]) proto[op] = wrapped[op];
      state.armed = true;
    },
    restore() {
      for (const op of ops) if (wrapped[op] && proto[op] === wrapped[op]) proto[op] = originals[op];
      state.armed = false;
      signal();
    },
  };
  const report = (r: unknown): void => {
    events.push(r);
    if (events.length > 50) events.shift();
    signal();
  };
  let seq = 0;
  for (const op of ops) {
    const original = proto[op];
    if (typeof original !== "function") continue;
    originals[op] = original;
    wrapped[op] = new Proxy(original, {
      get(target, k, receiver) {
        return k === key ? state : Reflect.get(target, k, receiver);
      },
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args) as Promise<unknown>;
        const options = args[0] as { publicKey?: unknown; mediation?: unknown } | null | undefined;
        if (!options || typeof options !== "object" || !result || typeof result.then !== "function") return result;
        const id = `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const mediation = typeof options.mediation === "string" ? options.mediation : undefined;
        state.pending.add(id);
        report({ id, op, phase: "start", publicKey: !!options.publicKey, ...(mediation ? { mediation } : {}) });
        // The page gets the promise this returns, so a rejection it leaves unhandled stays unhandled.
        return result.then(
          (value) => {
            state.pending.delete(id);
            report({ id, op, phase: "settle", ok: true });
            return value;
          },
          (error: unknown) => {
            const name = error && typeof (error as Error).name === "string" ? (error as Error).name : "Error";
            state.pending.delete(id);
            report({ id, op, phase: "settle", ok: false, error: name });
            throw error;
          },
        );
      },
    });
  }
  state.arm();
  return state;
}

/**
 * Whether a frame shows a sign-in page: a password field, a field passkey autofill serves
 * (`autocomplete` with `webauthn`), or an address that names sign-in, sign-up or passkeys. Runs
 * in the isolated world, where the page cannot see it.
 */
function signInSignal(): boolean {
  if (
    /log[-_]?[io]n|sign[-_]?(in|up|on)|auth|passkey|webauthn|account|register|verify|mfa|2fa|sso/i.test(location.href)
  )
    return true;
  return !!document.querySelector('input[type="password" i], input[autocomplete*="webauthn" i]');
}

/** Whether the request `id` is still pending in the document `frame` shows now. */
type PasskeyPending = (frame: Frame, id: string) => Promise<boolean>;

/** The host's side of the wrapper, for one browser. */
export interface PasskeyProbe {
  /**
   * Wraps the methods in the frames of `page` that show a sign-in page, for an action the agent
   * is about to run. Returns what to call when the action is over: the originals go back after
   * `graceMs`, unless another action armed the page again.
   */
  arm(page: Page): Promise<() => void>;
  /** Whether a request is still pending in what a frame shows now. */
  pending: PasskeyPending;
}

/** How long the wrapper stays after an action: a page asks for a passkey once its click handler has fetched a challenge. */
const PASSKEY_GRACE_MS = 3000;

interface ArmedFrame {
  handle: JSHandle<ProbeState | undefined>;
  page: Page;
}

export function createPasskeyProbe(
  onReport: (report: PasskeyReport, page: Page, frame: Frame) => void,
  graceMs = PASSKEY_GRACE_MS,
): PasskeyProbe {
  // A name no page can guess.
  const mark = `f${randomBytes(16).toString("hex")}`;
  const frames = new Map<Frame, ArmedFrame>();
  const pages = new Map<Page, { actions: number; timer?: ReturnType<typeof setTimeout> }>();

  // Takes the reports of one frame until its document goes away, or the wrapper is off with
  // nothing pending.
  const listen = async (frame: Frame, armed: ArmedFrame): Promise<void> => {
    try {
      for (;;) {
        const r = await armed.handle.evaluate((s) => s?.next());
        if (!r) return;
        for (const raw of r.events) {
          const report = parseReport(raw);
          if (report) onReport(report, armed.page, frame);
        }
        if (!r.armed && r.pending === 0) return;
      }
    } catch {
      // The document went away, with its requests.
    } finally {
      if (frames.get(frame) === armed) frames.delete(frame);
      await armed.handle.dispose().catch(() => {});
    }
  };

  const armFrame = async (page: Page, frame: Frame): Promise<void> => {
    const known = frames.get(frame);
    if (known) {
      const again = await known.handle
        .evaluate((s) => {
          s?.arm();
          return true;
        })
        .catch(() => false);
      if (again) return;
      // The frame shows another document now.
      frames.delete(frame);
    }
    if (!(await frame.evaluate(signInSignal, undefined, undefined, true).catch(() => false))) return;
    // The main world (false): the page's own methods.
    const handle = (await frame.evaluateHandle(armProbe, mark, undefined, false).catch(() => undefined)) as
      | JSHandle<ProbeState | undefined>
      | undefined;
    if (!handle) return;
    if (!(await handle.evaluate((s) => !!s).catch(() => false))) {
      await handle.dispose().catch(() => {});
      return;
    }
    const armed = { handle, page };
    frames.set(frame, armed);
    void listen(frame, armed);
  };

  const disarm = async (page: Page): Promise<void> => {
    for (const [, armed] of frames)
      if (armed.page === page) await armed.handle.evaluate((s) => s?.restore()).catch(() => {});
  };

  return {
    async arm(page) {
      if (page.isClosed()) return () => {};
      let entry = pages.get(page);
      if (!entry) {
        entry = { actions: 0 };
        pages.set(page, entry);
        page.once("close", () => pages.delete(page));
      }
      const own = entry;
      if (own.timer) clearTimeout(own.timer);
      own.timer = undefined;
      own.actions++;
      await Promise.all(page.frames().map((f) => armFrame(page, f)));
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (--own.actions > 0) return;
        own.timer = setTimeout(() => {
          own.timer = undefined;
          if (own.actions === 0) void disarm(page);
        }, graceMs);
        own.timer.unref?.();
      };
    },
    async pending(frame, id) {
      const armed = frames.get(frame);
      if (!armed) return false;
      // A frame that is gone, or shows another document, has nothing pending.
      return (await armed.handle.evaluate((s, i) => s?.pending.has(i) ?? false, id).catch(() => false)) === true;
    },
  };
}

interface Ceremony {
  id: string;
  op: PasskeyOp;
  page: Page;
  /** The frame that asked: when it navigates, the request may be gone with its document. */
  frame: Frame;
  origin: string;
  outcome?: PasskeyOutcome;
  wakes: Set<() => void>;
  /** How the agent hears about it: through a step, a note when it settles, or not at all. */
  mode: "step" | "settle" | "none";
}

/** What the agent reads about a passkey prompt (under `turno.passkey` in JSON). */
export interface PasskeyNote {
  text: string;
  data: {
    op: PasskeyOp;
    origin: string;
    /** How the person's step ended (`human-step.ts`), when there was one. */
    ended?: StepRun["ended"];
    outcome?: PasskeyOutcome["kind"];
    error?: string;
    waitedMs?: number;
    /** The person could not see Chrome's passkey window, so no step started. */
    unseen?: true;
  };
}

export interface PasskeyDeps {
  /** Why the person cannot answer Chrome's passkey window now, or undefined. */
  unseen(): string | undefined;
  /** The browser is held already (the user's pause, a person step): the person has it. */
  paused(): boolean;
  /** Hands the browser to the person on `page` until `settle` settles; how it went. */
  handoff(page: Page, settle: StepSettle): Promise<StepRun | { error: string }>;
  /** Whether the request is still pending in what `frame` shows now (`createPasskeyProbe`). */
  pending: PasskeyPending;
  /** A step started; `done` resolves once it ended and its note is kept. */
  opened?(done: Promise<void>): void;
}

/**
 * The passkey prompts of one browser: starts a person step on a modal ceremony, ends it when the
 * ceremony settles, and keeps what the agent should read until a call takes it.
 */
export class PasskeyWatch {
  private readonly ceremonies = new Map<string, Ceremony & { forget(): void }>();
  private notes: PasskeyNote[] = [];
  private step: Promise<void> | undefined;

  constructor(private readonly deps: PasskeyDeps) {}

  /** The person step running now for a passkey prompt, if any. */
  get running(): Promise<void> | undefined {
    return this.step;
  }

  /** The notes not yet given to a call; each is given once. */
  takeNotes(): PasskeyNote[] {
    const out = this.notes;
    this.notes = [];
    return out;
  }

  report(r: PasskeyReport, page: Page, frame: Frame): void {
    if (r.phase === "settle") {
      const c = this.ceremonies.get(r.id);
      if (c && c.page === page) this.finish(c, passkeyOutcome(c.op, r.ok === true, r.error));
      return;
    }
    if (passkeyKind(r) !== "modal" || this.ceremonies.has(r.id)) return;
    const base: Ceremony = { id: r.id, op: r.op, page, frame, origin: originOf(page), wakes: new Set(), mode: "none" };
    const unseen = this.deps.unseen();
    if (unseen) {
      this.notes.push(unseenNote(base, unseen));
      return;
    }
    // A navigation of its frame may take the request with the document; a removed frame does.
    const navigated = (f: Frame) => {
      if (f === frame)
        void this.deps.pending(frame, r.id).then((still) => {
          if (!still) this.finish(c, { kind: "left" });
        });
    };
    const detached = (f: Frame) => {
      if (f === frame) this.finish(c, { kind: "left" });
    };
    const closed = () => this.drop(c);
    page.on("framenavigated", navigated);
    page.on("framedetached", detached);
    page.on("close", closed);
    const c = Object.assign(base, {
      forget: () => {
        page.off("framenavigated", navigated);
        page.off("framedetached", detached);
        page.off("close", closed);
      },
    });
    this.ceremonies.set(r.id, c);
    if (this.step || this.deps.paused()) {
      // The person has the browser already: say how it ended once it does.
      c.mode = "settle";
      return;
    }
    c.mode = "step";
    const settle: StepSettle = {
      settled: () => c.outcome !== undefined,
      onSettle: (wake) => {
        c.wakes.add(wake);
        return () => c.wakes.delete(wake);
      },
    };
    const step = this.deps
      .handoff(page, settle)
      .then(
        (run) => {
          this.notes.push(stepNote(c, "error" in run ? undefined : run));
        },
        () => {
          this.notes.push(stepNote(c, undefined));
        },
      )
      .finally(() => {
        if (this.step === step) this.step = undefined;
        if (c.outcome) this.drop(c);
      });
    this.step = step;
    this.deps.opened?.(step);
  }

  private finish(c: Ceremony & { forget(): void }, outcome: PasskeyOutcome): void {
    if (c.outcome || this.ceremonies.get(c.id) !== c) return;
    c.outcome = outcome;
    for (const wake of c.wakes) wake();
    if (c.mode === "settle") {
      this.notes.push(stepNote(c, undefined));
      this.drop(c);
    } else if (!this.step) this.drop(c);
  }

  private drop(c: Ceremony & { forget(): void }): void {
    if (this.ceremonies.get(c.id) !== c) return;
    this.ceremonies.delete(c.id);
    c.forget();
  }
}

function originOf(page: Page): string {
  try {
    return new URL(page.url()).origin;
  } catch {
    return page.url();
  }
}

const what = (op: PasskeyOp) => (op === "create" ? "to create a passkey" : "for a passkey to sign in");

function outcomeText(o: PasskeyOutcome): string {
  switch (o.kind) {
    case "created":
      return "A passkey was created.";
    case "used":
      return "The passkey was used.";
    case "cancelled":
      return "The person cancelled it, or it timed out (NotAllowedError: the page cannot tell which).";
    case "aborted":
      return "The page withdrew the request (AbortError).";
    case "failed":
      return `It failed (${o.error}).`;
    case "left":
      return "The page navigated away before it finished, so the request went with it.";
  }
}

function unsettledText(ended: StepRun["ended"] | undefined): string {
  switch (ended) {
    case "done":
      return "The person pressed Done before Chrome's passkey window finished; the page may still be waiting for it.";
    case "closed":
      return "The tab was closed.";
    case "resumed":
      return "The person gave the browser back to the agent before the passkey prompt finished.";
    case "timeout":
      return "It had not finished when the step timed out; the page may still be waiting for it.";
    default:
      return "It had not finished when the step ended; the page may still be waiting for it.";
  }
}

/** The note of a modal ceremony the person had (in a step, or while they already held the browser). */
function stepNote(c: Pick<Ceremony, "op" | "origin" | "outcome">, run: StepRun | undefined): PasskeyNote {
  const lines = [
    `The page ${c.origin} asked ${what(c.op)}: only the person can answer that, in Chrome's passkey window.`,
  ];
  if (run) lines.push(`The browser was handed to them, and the step ended after ${formatPause(run.waitedMs)}.`);
  lines.push(c.outcome ? outcomeText(c.outcome) : unsettledText(run?.ended));
  if (run?.lines.length) lines.push(...run.lines.map((l) => `- ${l}`));
  lines.push("Take a snapshot before your next action.");
  return {
    text: lines.join("\n"),
    data: {
      op: c.op,
      origin: c.origin,
      ...(run ? { ended: run.ended, waitedMs: run.waitedMs } : {}),
      ...(c.outcome ? { outcome: c.outcome.kind, ...(c.outcome.error ? { error: c.outcome.error } : {}) } : {}),
    },
  };
}

/** The note of a modal ceremony nobody can see. */
function unseenNote(c: Pick<Ceremony, "op" | "origin">, why: string): PasskeyNote {
  return {
    text: `The page ${c.origin} asked ${what(c.op)}. Only the person can answer that, in Chrome's passkey window, but ${why} The page keeps waiting for it until it gives up.`,
    data: { op: c.op, origin: c.origin, unseen: true },
  };
}
