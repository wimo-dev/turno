import { randomBytes } from "node:crypto";
import type { BrowserContext, Frame, Page } from "patchright-core";
import type { StepRun, StepSettle } from "./human-step.js";
import { formatPause } from "./live.js";

/**
 * Passkeys: when a page starts a WebAuthn ceremony (creating or using a passkey), only the person
 * can finish it, with Touch ID, their phone or a security key, in Chrome's own passkey window.
 * The host sees the ceremony start and hands the browser to the person the way
 * `browser_request_human` does (`human-step.ts`), and the step ends when the ceremony settles.
 *
 * How the ceremony is seen: an init script in the main world of every frame wraps
 * `CredentialsContainer.prototype.create` and `.get` (a `Proxy`, so their name and length stay as
 * they were) and reports through a binding when a call starts and when its promise settles: the
 * operation, the `mediation` value, whether a `publicKey` member was passed, and on settle the
 * error's name. Never the options themselves (challenge, user, allowed credentials) or the
 * credential. A page can call the binding too, so a report is only a reason to show the person a
 * banner, never something the host trusts further.
 *
 * Why this mechanism, measured with patchright-core 1.64.3 and Chrome:
 *
 * - patchright's client `addInitScript` and `exposeBinding` first install a catch-all route
 *   (`installInjectRoute`) to put scripts into HTML responses. Its server never fills that list in
 *   this version, so the route only costs: with it, a cacheable script was fetched again on
 *   reload (Playwright turns Chrome's HTTP cache off while it intercepts) and a cross-site iframe
 *   failed to load. Marking the context as already routed (`routeInjecting`) skips it, and the
 *   scripts still go in through `Page.addScriptToEvaluateOnNewDocument`, in every frame,
 *   cross-site iframes included.
 * - patchright does not enable the Runtime domain, so a binding reaches a new document only once
 *   patchright looks up that frame's main world, 50 to 200 ms after the document starts. The
 *   wrapper therefore looks the binding up when it reports, and holds reports until it is there.
 * - A raw CDP `Runtime.addBinding` (in the main world or a named isolated world) never reached a
 *   new document without `Runtime.enable`, which patchright leaves off on purpose.
 *
 * A document that goes away (the page navigates, to an identity provider say, or a policy takes
 * the tab back) drops its pending request without settling it. So when the frame of a ceremony
 * navigates, the host asks the wrapper there whether the request is still pending: a navigation
 * within the document keeps it, a new document has none, and the ceremony ends as `left`.
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

/**
 * The page side: wraps the two methods and reports through `binding`. Runs in the main world as
 * an init script, so it is self-contained (sent as source) and runs once per realm even when
 * Chrome runs it twice in a cross-site iframe.
 */
function passkeyProbe(binding: string): void {
  const proto = (globalThis as unknown as { CredentialsContainer?: { prototype: Record<string, unknown> } })
    .CredentialsContainer?.prototype;
  if (!proto) return;
  const mark = Symbol.for(binding);
  // The ids of this document's requests not settled yet: the host reads them after a navigation.
  const pending = new Set<string>();
  const queue: unknown[] = [];
  let waiting = 0;
  const flush = (): void => {
    const send = (globalThis as Record<string, unknown>)[binding];
    if (typeof send !== "function") {
      // The binding reaches a new document a moment after it starts: try again shortly, for a while.
      if (waiting++ < 200) setTimeout(flush, 50);
      return;
    }
    waiting = 0;
    while (queue.length) {
      try {
        const result = (send as (r: unknown) => unknown)(queue.shift());
        if (result && typeof (result as Promise<unknown>).catch === "function")
          (result as Promise<unknown>).catch(() => {});
      } catch {
        /* the page replaced the binding: nothing to report to */
      }
    }
  };
  const report = (r: unknown): void => {
    queue.push(r);
    if (queue.length > 50) queue.shift();
    if (waiting === 0) flush();
  };
  let seq = 0;
  for (const op of ["create", "get"] as const) {
    const original = proto[op];
    if (typeof original !== "function" || (original as unknown as Record<symbol, unknown>)[mark]) continue;
    proto[op] = new Proxy(original, {
      get(target, key, receiver) {
        return key === mark ? pending : Reflect.get(target, key, receiver);
      },
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args) as Promise<unknown>;
        const options = args[0] as { publicKey?: unknown; mediation?: unknown } | null | undefined;
        if (!options || typeof options !== "object" || !result || typeof result.then !== "function") return result;
        const id = `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const mediation = typeof options.mediation === "string" ? options.mediation : undefined;
        pending.add(id);
        report({ id, op, phase: "start", publicKey: !!options.publicKey, ...(mediation ? { mediation } : {}) });
        // The page gets the promise this returns, so a rejection it leaves unhandled stays unhandled.
        return result.then(
          (value) => {
            pending.delete(id);
            report({ id, op, phase: "settle", ok: true });
            return value;
          },
          (error: unknown) => {
            const name = error && typeof (error as Error).name === "string" ? (error as Error).name : "Error";
            pending.delete(id);
            report({ id, op, phase: "settle", ok: false, error: name });
            throw error;
          },
        );
      },
    });
  }
}

/** Whether the request `id` is still pending in the document `frame` shows now. */
export type PasskeyPending = (frame: Frame, id: string) => Promise<boolean>;

/**
 * Puts the probe in every frame of `context`, now and on every new document. Returns how to ask
 * a frame whether a request is still pending there.
 */
export async function installPasskeyProbe(
  context: BrowserContext,
  onReport: (report: PasskeyReport, page: Page, frame: Frame) => void,
  existing: (page: Page) => boolean = () => true,
): Promise<PasskeyPending> {
  // A name no page can guess, in patchright's own form for callback names.
  const binding = `f${randomBytes(16).toString("hex")}`;
  // patchright's client installs a catch-all route before its first init script or binding;
  // marking the context as routed skips it (see the module comment for what it costs).
  (context as unknown as { routeInjecting?: boolean }).routeInjecting = true;
  await context.exposeBinding(binding, (source: { page?: Page; frame?: Frame }, raw: unknown) => {
    const report = parseReport(raw);
    if (report && source.page && source.frame) onReport(report, source.page, source.frame);
  });
  const script = `(${passkeyProbe.toString()})(${JSON.stringify(binding)});`;
  await context.addInitScript(script);
  // Documents open now (the first blank tab) started before the init script.
  for (const page of context.pages().filter(existing))
    for (const frame of page.frames()) await frame.evaluate(script, undefined, undefined, false).catch(() => {});
  const ask = `([mark, id]) => {
    const set = globalThis.CredentialsContainer?.prototype.get?.[Symbol.for(mark)];
    return set instanceof Set && set.has(id);
  }`;
  // The main world, where the wrapper is; a frame that is gone has nothing pending.
  return async (frame, id) => (await frame.evaluate(ask, [binding, id], undefined, false).catch(() => false)) === true;
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
  /** Whether the request is still pending in what `frame` shows now (`installPasskeyProbe`). */
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
