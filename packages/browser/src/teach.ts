import type { BrowserContext, CDPSession, FileChooser, Page } from "patchright-core";
import type { IdentityRef } from "./engine.js";
import { type Fingerprint, redactFingerprint, seenInPage, urlPattern } from "./fingerprint.js";
import {
  type Flow,
  FlowError,
  type FlowStep,
  type FlowTarget,
  MAX_FLOW_STEPS,
  assertFlowName,
  flowPath,
  setPath,
  writeFlow,
} from "./flows.js";
import { existsSync } from "node:fs";
import { Draft, type ElementInfo, type Slot, elementInfoInPage, locatorsOf, plainUrl } from "./recorder.js";
import type { Redactor } from "./redact.js";
import { secretField } from "./sensitive.js";
import { originAllowed, vaultSite, vaultSummary } from "./vault.js";

/**
 * Teach mode: the person shows a flow once in the agent's Chrome window, and it is saved as a
 * normal flow (`flows.ts`) that `browser_replay` and `turno-browser replay` run again.
 *
 * What is recorded is the person's own input: clicks, typing, a choice in a list, a box checked,
 * the keys Enter, Escape and Tab, a file chosen for an upload, an address typed into the address
 * bar, and a move to another tab. It goes through the recorder's rules (`recorder.ts`): typed text
 * is a parameter, a sensitive field (a password, a one-time code, a card, a field named like one,
 * a vault value) never keeps its value, and a sign-in on a site of the vault is the step
 * `browser_login` with the site's name only.
 *
 * How it listens, without the page seeing it: a script in an isolated world of its own
 * (`Page.createIsolatedWorld`, made again for each new top document when the protocol says it
 * committed), which shares the DOM with the page but none of its JavaScript, so the page's
 * scripts cannot see its listeners, its variables or its calls, and nothing is added to the DOM.
 * It reports through a protocol binding added to that world's context only (`Runtime.addBinding`
 * with its `executionContextId`), which the script takes off its global at once: the page's own
 * world never has such a function. `Runtime.enable` is never sent (a page can tell a session
 * that enabled it). Navigations come from the protocol (`Page.frameNavigated` and the entry's
 * transition type), not from the page. Only the top document of each tab is listened to: input
 * inside a frame is not recorded.
 */

/** The isolated world's name and its binding's. */
const WORLD = "turno-teach";
const BINDING = "__turnoTeach";

/** What the page reports about the element an input went to. */
interface Seen {
  seen: { role: string; name: string; label: string; landmark: string };
  info: ElementInfo;
  /** The CSS path of the form the element is in, empty when none. */
  form: string;
}

/** One report of the teach script. */
type Report = { url: string; at: number } & (
  | { kind: "click"; el: Seen }
  | { kind: "type"; el: Seen; value?: string; sensitive?: boolean; chars: number }
  | { kind: "select"; el: Seen; values: string[] }
  | { kind: "check"; el: Seen; checked: boolean }
  | { kind: "key"; key: string; el?: Seen }
);

/**
 * The teach script, in the isolated world of each top document. Runs in the page: it must stay
 * self-contained (the element readers come in as arguments).
 */
function teachPage(binding: string, seenOf: (el: Element) => Seen["seen"], infoOf: (el: Element) => ElementInfo): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const send = g[binding] as ((s: string) => void) | undefined;
  if (typeof send !== "function") return;
  delete g[binding];
  let on = true;
  g.__turnoTeachStop = () => {
    on = false;
  };
  // Broad on purpose, as `sensitive.ts`: such a field's value never leaves the page.
  const SECRET = /pass|pwd|otp|totp|2fa|mfa|pin|cvv|cvc|csc|secret|token|ssn|one.?time/i;
  const secret = (el: HTMLInputElement) =>
    (el.type || "").toLowerCase() === "password" ||
    /password|one-time-code|cc-/i.test(el.getAttribute("autocomplete") || "") ||
    SECRET.test(`${el.getAttribute("name") || ""} ${el.id || ""}`);
  const NOT_TEXT = new Set([
    "checkbox",
    "radio",
    "submit",
    "button",
    "reset",
    "image",
    "file",
    "range",
    "color",
    "hidden",
  ]);
  const textish = (el: Element) =>
    (el.localName === "input" && !NOT_TEXT.has(((el as HTMLInputElement).type || "text").toLowerCase())) ||
    el.localName === "textarea" ||
    (el as HTMLElement).isContentEditable;
  const toggle = (el: Element) =>
    el.localName === "input" && ["checkbox", "radio"].includes(((el as HTMLInputElement).type || "").toLowerCase());
  const describe = (el: Element): Seen => {
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    return { seen: seenOf(el), info: infoOf(el), form: form ? infoOf(form).css : "" };
  };
  const post = (m: Record<string, unknown>) => {
    if (!on) return;
    try {
      send(JSON.stringify({ ...m, url: location.href, at: Date.now() }));
    } catch {
      /* teach mode ended */
    }
  };
  const origin = (e: Event) => (e.composedPath()[0] ?? e.target) as Element;
  let typing: Element | null = null;
  const flush = () => {
    const el = typing;
    if (!el) return;
    typing = null;
    const value = (el as HTMLElement).isContentEditable ? el.textContent || "" : (el as HTMLInputElement).value || "";
    if (el.localName === "input" && secret(el as HTMLInputElement))
      post({ kind: "type", el: describe(el), sensitive: true, chars: value.length });
    else post({ kind: "type", el: describe(el), value, chars: value.length });
  };
  const ACTIONABLE =
    "a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[onclick]";
  let forwarded: { el: Element; at: number } | null = null;
  // Enter in a form clicks its submit button (no pointer, `detail` 0): the key is the step.
  let enterAt = 0;
  const options = { capture: true, passive: true } as const;
  window.addEventListener(
    "input",
    (e) => {
      if (!e.isTrusted) return;
      const el = origin(e);
      if (!textish(el)) return;
      if (typing && typing !== el) flush();
      typing = el;
    },
    options,
  );
  window.addEventListener(
    "change",
    (e) => {
      if (!e.isTrusted) return;
      const el = origin(e);
      if (textish(el)) {
        if (typing === el) flush();
        return;
      }
      flush();
      if (el.localName === "select") {
        const s = el as HTMLSelectElement;
        post({
          kind: "select",
          el: describe(el),
          values: Array.from(s.selectedOptions).map((o) => o.label || o.value),
        });
      } else if (toggle(el)) post({ kind: "check", el: describe(el), checked: (el as HTMLInputElement).checked });
    },
    options,
  );
  window.addEventListener(
    "focusout",
    (e) => {
      if (e.isTrusted && typing === origin(e)) flush();
    },
    options,
  );
  window.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      if (e.detail === 0 && Date.now() - enterAt < 200) return;
      const raw = origin(e);
      const el = (raw.closest?.(ACTIONABLE) as Element | null) ?? raw;
      // A label's click goes on to its control: that second click is the same input.
      if (forwarded && forwarded.el === el && Date.now() - forwarded.at < 300) return;
      const control = el.localName === "label" ? (el as HTMLLabelElement).control : null;
      if (control) forwarded = { el: control, at: Date.now() };
      const acted = control ?? el;
      // Into a field, a list or a box: what they get (typing, a choice, checked) is the step.
      if (textish(acted) || toggle(acted) || acted.localName === "select" || acted.localName === "option") return;
      flush();
      post({ kind: "click", el: describe(acted) });
    },
    options,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted || e.isComposing || !["Enter", "Escape", "Tab"].includes(e.key)) return;
      const el = origin(e);
      // Enter in a text area or an editable element is a new line, part of the typing.
      if (e.key === "Enter" && (el.localName === "textarea" || (el as HTMLElement).isContentEditable)) return;
      flush();
      if (e.key === "Enter") enterAt = Date.now();
      const key = e.key === "Tab" && e.shiftKey ? "Shift+Tab" : e.key;
      post({ kind: "key", key, ...(el && el !== document.body ? { el: describe(el) } : {}) });
    },
    options,
  );
}

/** A step taught so far, with what the review can change. */
export interface TaughtStep {
  id: number;
  step: FlowStep;
  slots: Slot[];
  /** A value that must stay sensitive: the review cannot keep it. */
  locked?: boolean;
  /** The form a typing step's field is in (its CSS path), for a sign-in that replaces it. */
  form?: string;
  /** What the person sees of it: the tool, the element and a count of characters, never a value. */
  view: TaughtView;
}

export interface TaughtView {
  id: number;
  tool: string;
  target?: string;
  /** Characters typed, for a step that types. */
  chars?: number;
  /** The parameter it makes, and whether its value is kept. */
  param?: { name: string; sensitive: boolean; locked: boolean };
  /** For a key, a site or an address: what it is (the address without its query). */
  detail?: string;
}

/** What the review says about one step. */
export interface TaughtEdit {
  id: number;
  /** Drop the step. */
  remove?: boolean;
  /** A new name for the step's element (its description in the flow). */
  name?: string;
  /** For a step that types: a parameter (the default), a fixed value, or sensitive (no value kept). */
  value?: "param" | "fixed" | "sensitive";
}

/** Sign-in on a site of the vault: the form it was typed into, and whether its submit is dropped. */
interface SignIn {
  page: Page;
  form: string;
  /** `auto`: browser_login submits, so the person's own submit is not a step. */
  submits: boolean;
  /** The steps of the form, replaced by the one `browser_login`. */
  login: number;
}

/** Transition types of a navigation the person made in the address bar (not a link or a form). */
const TYPED = new Set(["typed", "address_bar", "auto_bookmark", "generated", "keyword", "keyword_generated"]);

/** One teach session on a launched Chrome. */
export class TeachSession {
  private readonly steps: TaughtStep[] = [];
  private readonly sessions = new Map<Page, { cdp: CDPSession; world?: number }>();
  private nextId = 1;
  private lastPage: Page | undefined;
  private signIn: SignIn | undefined;
  private stopped = false;
  private readonly onPage = (page: Page) => void this.watchPage(page, true);
  private readonly unwatch: (() => void)[] = [];

  constructor(
    private readonly context: BrowserContext,
    private readonly identity: IdentityRef,
    private readonly redactor: Redactor,
    readonly name: string,
    /** A step was added, changed or dropped. */
    private readonly changed: () => void,
  ) {}

  /** Starts listening on every tab; with `url`, opens it in the current tab as the first step. */
  async start(url: string | undefined, page: Page | undefined): Promise<void> {
    const pages = this.context.pages().filter((p) => !p.isClosed());
    const first = page ?? pages[pages.length - 1] ?? (await this.context.newPage());
    if (url) {
      await first.goto(url, { waitUntil: "domcontentloaded" });
      this.add({ tool: "browser_navigate", args: { url: first.url() } }, [], { detail: shortUrl(first.url()) });
    }
    this.lastPage = first;
    await first.bringToFront().catch(() => {});
    this.context.on("page", this.onPage);
    for (const p of this.context.pages()) await this.watchPage(p, false);
  }

  get count(): number {
    return this.steps.length;
  }

  views(): TaughtView[] {
    return this.steps.map((s) => s.view);
  }

  /** Stops listening; the steps stay for the review. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.context.off("page", this.onPage);
    for (const off of this.unwatch.splice(0)) off();
    await Promise.all(
      [...this.sessions.values()].map(async (s) => {
        if (s.world !== undefined)
          await s.cdp
            .send("Runtime.evaluate", { contextId: s.world, expression: "globalThis.__turnoTeachStop?.()" })
            .catch(() => {});
        await s.cdp.send("Runtime.removeBinding", { name: BINDING }).catch(() => {});
        await s.cdp.detach().catch(() => {});
      }),
    );
    this.sessions.clear();
  }

  /** Saves the reviewed flow; `overwrite` replaces a flow of the same name. */
  save(
    edits: readonly TaughtEdit[],
    options: { description?: string; overwrite?: boolean } = {},
  ): { flow: Flow; file: string } {
    assertFlowName(this.name);
    if (!options.overwrite && existsSync(flowPath(this.identity.id, this.name, this.identity.env)))
      throw new FlowError(`flow "${this.name}" exists; pick another name`);
    const byId = new Map(edits.map((e) => [e.id, e]));
    const draft = new Draft(this.name, options.description);
    for (const taught of this.steps) {
      const edit = byId.get(taught.id);
      if (edit?.remove) continue;
      const step = structuredClone(taught.step);
      const name = edit?.name?.trim().slice(0, 120);
      const target = step.targets?.target;
      if (name && target) target.description = name;
      const slots: Slot[] = [];
      for (const slot of taught.slots) {
        // A value never kept (a sensitive field, a file) stays a parameter without one.
        const mode = slot.sensitive || slot.noDefault ? "param" : (edit?.value ?? "param");
        if (mode === "fixed") {
          setPath(step.args, slot.path, slot.value);
          continue;
        }
        slots.push({
          ...slot,
          sensitive: slot.sensitive || mode === "sensitive",
          ...(name ? { label: name, description: name } : {}),
        });
      }
      draft.add({ step, slots });
    }
    if (!draft.steps.length) throw new FlowError("the flow has no steps; nothing was saved");
    const flow = draft.flow(this.identity.id);
    const file = writeFlow(this.identity.id, flow, this.identity.env);
    return { flow, file };
  }

  /** Listens on a tab's top documents, this one and each later one. */
  private async watchPage(page: Page, opened: boolean): Promise<void> {
    if (this.stopped || this.sessions.has(page) || page.isClosed()) return;
    // A tab the person opened (not a popup of the page): the flow opens one too.
    if (opened && !(await page.opener().catch(() => null)))
      this.add({ tool: "browser_tabs", args: { action: "new" } }, [], {});
    try {
      const cdp = await this.context.newCDPSession(page);
      const entry: { cdp: CDPSession; world?: number } = { cdp };
      this.sessions.set(page, entry);
      cdp.on("Runtime.bindingCalled", (e: { name: string; payload: string; executionContextId: number }) => {
        if (e.name !== BINDING || e.executionContextId !== entry.world) return;
        try {
          this.report(page, JSON.parse(e.payload) as Report);
        } catch {
          /* not a report */
        }
      });
      cdp.on("Page.frameNavigated", (e: { frame: { id: string; parentId?: string; url: string } }) => {
        if (e.frame.parentId) return;
        void this.listen(entry, e.frame.id);
        void this.navigated(page, cdp, e.frame.url);
      });
      // The agent's Chrome takes a page's file chooser for the agent (Playwright's interception), so
      // the person's click that opens one shows no dialog: the step is an upload whose file is a
      // parameter, given at replay.
      const chooser = (c: FileChooser) => {
        if (this.stopped) return;
        setTimeout(() => {
          this.toTab(page);
          this.add(
            {
              tool: "browser_file_upload",
              args: { paths: [""] },
              ...(plainUrl(page.url()) ? { url: plainUrl(page.url()) } : {}),
            },
            [
              {
                path: "paths.0",
                value: "",
                sensitive: false,
                noDefault: true,
                label: c.isMultiple() ? "files" : "file",
              },
            ],
            {},
            true,
          );
        }, 150);
      };
      page.on("filechooser", chooser);
      this.unwatch.push(() => page.off("filechooser", chooser));
      page.once("close", () => {
        this.sessions.delete(page);
        void cdp.detach().catch(() => {});
      });
      await cdp.send("Page.enable");
      const { frameTree } = await cdp.send("Page.getFrameTree");
      await this.listen(entry, frameTree.frame.id);
    } catch {
      /* a tab that closed meanwhile */
    }
  }

  /** The teach script in a new isolated world of the tab's top document. */
  private async listen(entry: { cdp: CDPSession; world?: number }, frameId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const { executionContextId } = await entry.cdp.send("Page.createIsolatedWorld", { frameId, worldName: WORLD });
      await entry.cdp.send("Runtime.addBinding", { name: BINDING, executionContextId });
      entry.world = executionContextId;
      await entry.cdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: `(${teachPage.toString()})(${JSON.stringify(BINDING)}, ${seenInPage.toString()}, ${elementInfoInPage.toString()})`,
      });
    } catch {
      /* the document went away meanwhile; its successor gets its own */
    }
  }

  /** A navigation of a tab's top document: a step when the person typed the address. */
  private async navigated(page: Page, cdp: CDPSession, url: string): Promise<void> {
    if (this.stopped) return;
    const history = await cdp.send("Page.getNavigationHistory").catch(() => undefined);
    const entry = history?.entries[history.currentIndex];
    if (!entry || !TYPED.has(entry.transitionType) || !/^https?:/.test(url)) return;
    this.toTab(page);
    this.add({ tool: "browser_navigate", args: { url: entry.url || url } }, [], { detail: shortUrl(url) });
  }

  /** A move to another tab before an input there: a step that selects it. */
  private toTab(page: Page): void {
    if (page === this.lastPage) return;
    this.lastPage = page;
    const index = this.context.pages().indexOf(page);
    if (index >= 0)
      this.add({ tool: "browser_tabs", args: { action: "select", index } }, [], { detail: `${index + 1}` });
  }

  private report(page: Page, r: Report): void {
    if (this.stopped) return;
    this.toTab(page);
    const url = page.url();
    if (r.kind === "key") {
      if (r.key === "Enter" && this.submitsSignIn(page, r.el?.form)) return;
      this.add({ tool: "browser_press_key", args: { key: r.key } }, [], { detail: r.key });
      return;
    }
    const target = this.targetOf(r.el, url);
    const label = target.description;
    const plain = plainUrl(url);
    const at = plain ? { url: plain } : {};
    if (r.kind === "click") {
      if (this.submitsSignIn(page, r.el.form, r.el.info)) return;
      this.add({ tool: "browser_click", args: {}, targets: { target }, ...at }, [], { target: label });
      return;
    }
    if (r.kind === "check") {
      // A click, as the person did: browser_check is a capability an agent's server has off.
      this.add(
        { tool: "browser_click", args: {}, targets: { target }, ...at },
        [],
        { target: label },
        false,
        undefined,
        r.checked ? "browser_check" : "browser_uncheck",
      );
      return;
    }
    if (r.kind === "select") {
      this.add({ tool: "browser_select_option", args: { values: r.values }, targets: { target }, ...at }, [], {
        target: label,
      });
      return;
    }
    // Typing.
    const value = r.value ?? "";
    const sensitive = r.sensitive === true || secretField(r.el.info) || (value !== "" && this.redactor.covers(value));
    if (sensitive && this.signInAt(page, url, r.el.form)) return;
    const slot: Slot = {
      path: "text",
      value: sensitive ? "" : value,
      sensitive,
      ...(label ? { label, description: label } : {}),
    };
    this.add(
      { tool: "browser_type", args: { text: "" }, targets: { target }, ...at },
      [slot],
      { target: label, chars: r.chars },
      sensitive,
      r.el.form,
    );
  }

  /**
   * A password typed on a page of a vault site: the form's steps become `browser_login` with the
   * site's name. True when it did.
   */
  private signInAt(page: Page, url: string, form: string): boolean {
    const summary = vaultSummary(this.identity.id, this.identity.env);
    const site = summary?.sites
      .map((s) => vaultSite(this.identity.id, s, this.identity.env)?.site)
      .find((s) => s && originAllowed(s, url));
    if (!site || !summary) return false;
    if (this.signIn?.page === page && this.signIn.form === form) return true;
    // The fields of the same form typed into before (the user name) go into the sign-in.
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i]!;
      if (s.step.tool !== "browser_type" || s.form !== form) break;
      this.steps.splice(i, 1);
    }
    const login = this.add({ tool: "browser_login", args: { site: site.site } }, [], { detail: site.site });
    this.signIn = { page, form, submits: summary.submit === "auto", login };
    return true;
  }

  /** The person's submit of a vault sign-in that `browser_login` submits itself: not a step. */
  private submitsSignIn(page: Page, form: string | undefined, info?: ElementInfo): boolean {
    const s = this.signIn;
    if (!s || s.page !== page || !s.submits || form === undefined || form !== s.form) return false;
    if (info && !(info.tag === "button" || (info.tag === "input" && ["submit", "image"].includes(info.type))))
      return false;
    this.signIn = undefined;
    return true;
  }

  /** The element as a flow target: role and name, text and CSS path, and its fingerprint. */
  private targetOf(el: Seen, url: string): FlowTarget {
    const fp: Fingerprint = {
      role: el.seen.role,
      name: el.seen.name,
      ...(el.seen.label ? { label: el.seen.label } : {}),
      ...(el.seen.landmark ? { landmark: el.seen.landmark } : {}),
      url: urlPattern(url),
    };
    const fingerprint = redactFingerprint(fp, this.redactor);
    const locators = locatorsOf(el.seen.role, el.seen.name, el.info).filter((l) => !this.redactor.covers(l.selector));
    const description = fingerprint.name || fingerprint.label || el.info.name || undefined;
    return { ...(description ? { description } : {}), locators, fingerprint };
  }

  private add(
    step: FlowStep,
    slots: Slot[],
    view: Omit<TaughtView, "id" | "tool">,
    locked = false,
    form?: string,
    /** What the panel calls the step, when not its tool (a box checked is a click). */
    shown?: string,
  ): number {
    if (this.steps.length >= MAX_FLOW_STEPS) return 0;
    const id = this.nextId++;
    const slot = slots[0];
    this.steps.push({
      id,
      step,
      slots,
      ...(locked ? { locked } : {}),
      ...(form !== undefined ? { form } : {}),
      view: {
        id,
        tool: shown ?? step.tool,
        ...view,
        ...(slot ? { param: { name: slot.label ?? "text", sensitive: slot.sensitive, locked } } : {}),
      },
    });
    this.changed();
    return id;
  }
}

/** An address as the panel shows it: origin and path, never the query. */
function shortUrl(url: string): string {
  return plainUrl(url) ?? url;
}
