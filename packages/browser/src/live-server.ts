import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import type { BrowserContext, CDPSession, Page } from "patchright-core";
import type { IdentityRef } from "./engine.js";
import {
  DEFAULT_IDLE_MS,
  type LiveFile,
  type LivePolicy,
  PauseGate,
  type PauseHold,
  type TabState,
  describeChanges,
  handBackWhenIdle,
  liveFilePath,
} from "./live.js";
import { type HumanCue, Stage, type StagePoint } from "./live-effects.js";
import { deniedPage, livePage } from "./live-page.js";
import { type Stuck, Timeline, type TimelineEntry, plainUrl } from "./live-timeline.js";
import type { CursorMark } from "./agent-cursor.js";
import type { Redactor, VaultGuard } from "./redact.js";
import { names } from "./names.js";
import { type UiLocale, fill, uiStrings } from "./ui-strings.js";
import { type BrowserWatch, titleOf } from "./watch.js";

/**
 * The live view server of one turno-browser-mcp process, when identity.json `live.enabled` or
 * `--live` turns it on (off by default).
 *
 * - The view is served on 127.0.0.1 only, on a random port, and only to a browser that holds
 *   this process's cookie: a random token made at start, never written to disk or logged. A
 *   browser gets the cookie from a link `turno browser live <id>` opens, whose code works once
 *   and for two minutes. Every request must name the server by its loopback Host (DNS
 *   rebinding), and every POST must come from the view's own origin with its header.
 * - `turno browser live|pause|resume` talk to the server over a Unix socket in a private
 *   folder (mode 700, socket 600): the file system is the access check there. On Windows it is
 *   a named pipe with a random name, which by default only its creator, administrators and the
 *   system can write to. Where to find both is in `<state>/browser/identities/<id>/live.json`,
 *   without any secret.
 * - The picture is a CDP screencast of one tab (the one the agent used last, or the one the
 *   user picked), taken only while a view is open. A frame of a page that holds a vault or
 *   sensitive value (the vault guard: a `browser_login` fill, a password typed) is never sent;
 *   the view says the page is hidden until it navigates.
 * - The user's clicks, keys and scrolls on the picture go to that tab through Playwright's mouse
 *   and keyboard, never to a hidden page. Input while the agent works first pauses it by itself
 *   (an automatic pause, `live.ts`) and waits for the call that runs to end; the browser goes back
 *   to the agent once the input stops, or with Hand back. Input is not logged anywhere.
 * - Next to the picture, the step timeline (`live-timeline.ts`): each call of the agent, the
 *   pauses and what changed in them, redacted like every result, and a session that looks stuck.
 * - Over the picture, the effects of each action (`live-effects.ts`): what kind of action runs,
 *   the box and click point the agent cursor measured, and the person's turns, sent as `fx`
 *   events with no typed or vault value. Each frame says the page's scroll and size, so the view
 *   can place a box on the picture as the page scrolls (`live-map.ts`).
 */

/** The running browser, as the host gives it to the live server. */
export interface LiveBrowser {
  context: BrowserContext;
  engine: string;
  /** Attach mode: only the agent's own tabs are listed, and nothing is brought to the front. */
  userBrowser: boolean;
  /** The session that holds a page (`"sharing": "tabs"`), for the tab list. */
  owner?(page: Page): string | undefined;
  /** The URL a page shows, or will load again when the tab governor parked it. */
  urlOf?(page: Page): string;
  /** The user takes over: hold the idle limit and the tab governor, save the trace. `cue`: a person step's. */
  onPause?(cue?: HumanCue): Promise<void>;
  /** The user gave the browser back. */
  onResume?(): void;
}

/** What `/state` returns: the view, the pause and the tabs, as the CLI and the page show them. */
export interface LiveStatus {
  identity: string;
  pid: number;
  port: number;
  started: string;
  /** `idleMs`: an automatic pause, which ends once the person's input stops that long. */
  paused: { since: string; by: string; idleMs?: number } | null;
  /** Agent calls waiting for the user. */
  waiting: number;
  /** Agent calls running now. */
  busy: number;
  /** How long one call waits for the user, in milliseconds. */
  wait: number;
  /** True when a browser runs. */
  browser: boolean;
  engine: string | null;
  view: { available: boolean; reason?: string; headless: boolean };
  /** The tab the view shows, by id; null when none. */
  showing: number | null;
  /** True when the user picked the tab, false when the view follows the agent. */
  pinned: boolean;
  /** True when the shown tab holds a vault or sensitive value, so no frame of it is sent. */
  hidden: boolean;
  /** Viewers connected now. */
  viewers: number;
  tabs: { id: number; url: string; title: string; session?: string }[];
  /** A session whose same call on the same target failed again and again; null when none. */
  stuck: Stuck | null;
}

export interface LiveServerOptions {
  identity: IdentityRef;
  policy: LivePolicy;
  guard: VaultGuard;
  redactor: Redactor;
  headless: boolean;
  /** Why the engine shows no pixels; `engine` is the running one, undefined before a launch. */
  viewRefusal(engine: string | undefined): string | undefined;
  /** A line for stderr (the server's log); never a token or a code. */
  log?(line: string): void;
  /** The language of the page and of its answers to the page (`ui-strings.ts`); English without it. */
  uiLocale?(): UiLocale;
  /** How long the person's input must stop before an automatic pause ends (default 5 s). */
  idleMs?: number;
}

/** How long input from the view waits for a call that runs to end, after it paused the agent. */
const DRAIN_MS = 10_000;
/** How long a link's code works. */
const CODE_MS = 2 * 60_000;
/** Largest request body accepted. */
const MAX_BODY = 16 * 1024;
/** Keys the view may press besides plain characters. */
const KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new HttpError(400, "the body must be a JSON object");
}

function listen(server: Server, ...args: [string] | [number, string]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...(args as [number, string]), () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const num = (v: unknown, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new HttpError(400, `expected a number from ${min} to ${max}`);
  return v;
};

export class LiveServer implements BrowserWatch {
  readonly gate = new PauseGate();
  /** The steps of the agent, as the view shows them next to the picture. */
  readonly timeline: Timeline;
  /** The effects of each action, as the view draws them over the picture. */
  readonly stage: Stage;
  private browser: LiveBrowser | undefined;
  /** The browser `onPause` was called for, so `onResume` goes to the same one. */
  private heldBrowser: LiveBrowser | undefined;
  private readonly lastBySession = new Map<string, Page>();
  private last: Page | undefined;
  private pinned: Page | undefined;
  private busy = 0;
  private readonly ids = new WeakMap<Page, number>();
  private nextId = 1;
  private readonly viewers = new Set<ServerResponse>();
  private cast: { page: Page; cdp: CDPSession; download: (d: { suggestedFilename(): string }) => void } | undefined;
  private casting: Promise<void> = Promise.resolve();
  private hidden = false;
  /** The scroll of the shown tab in its latest frame: a mark that came without one is placed by it. */
  private frameScroll: StagePoint | undefined;
  private readonly token = randomBytes(32).toString("base64url");
  private readonly codes = new Map<string, number>();
  private tcp: Server | undefined;
  private unix: Server | undefined;
  private port = 0;
  private socketDir: string | undefined;
  private pipe: string | undefined;
  private started = "";
  private queued = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly onExit = () => this.cleanupFiles();

  constructor(private readonly o: LiveServerOptions) {
    this.timeline = new Timeline(o.redactor);
    this.stage = new Stage({
      target: (tool, args) => this.timeline.targetOf(tool, args),
      clean: (text, max) => this.timeline.clean(text, max),
    });
    this.timeline.onEntry((entry) => this.onStep(entry));
    this.stage.onEvent((event) => {
      if (this.viewers.size) this.broadcast("fx", JSON.stringify(event));
    });
  }

  private onStep(entry: TimelineEntry): void {
    if (entry.kind === "call") this.stage.end(entry);
    if (!this.viewers.size) return;
    this.broadcast("step", JSON.stringify(entry));
    // A call can make a session stuck or clear it, which the state says.
    if (entry.kind === "call") this.pushState();
  }

  get paused(): boolean {
    return this.gate.paused !== undefined;
  }

  get waitMs(): number {
    return this.o.policy.waitMs;
  }

  get inFlight(): number {
    return this.busy;
  }

  /** Views open now. */
  get viewerCount(): number {
    return this.viewers.size;
  }

  /** The control socket path (tests). */
  get socket(): string | undefined {
    return this.pipe ?? (this.socketDir && join(this.socketDir, "control.sock"));
  }

  private get cookieName(): string {
    return `turno-live-${this.port}`;
  }

  private starting: Promise<void> | undefined;

  /** Listens on the socket and on 127.0.0.1, and writes live.json (once). */
  start(): Promise<void> {
    this.starting ??= this.listenAll();
    return this.starting;
  }

  private async listenAll(): Promise<void> {
    if (process.platform === "win32") this.pipe = `\\\\.\\pipe\\turno-live-${randomBytes(12).toString("hex")}`;
    else {
      this.socketDir = mkdtempSync(join(tmpdir(), "turno-live-"));
      chmodSync(this.socketDir, 0o700);
    }
    const socket = this.socket!;
    this.unix = createServer((req, res) => void this.handle(req, res, true));
    await listen(this.unix, socket);
    if (!this.pipe) chmodSync(socket, 0o600);
    this.tcp = createServer((req, res) => void this.handle(req, res, false));
    await listen(this.tcp, 0, "127.0.0.1");
    this.port = (this.tcp.address() as AddressInfo).port;
    // The live view never keeps the server process alive on its own.
    this.unix.unref();
    this.tcp.unref();
    this.started = new Date().toISOString();
    const file = liveFilePath(this.o.identity.id, this.o.identity.env);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const data: LiveFile = { version: 1, pid: process.pid, socket, port: this.port, started: this.started };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    replaceFileSync(tmp, file);
    process.once("exit", this.onExit);
    this.heartbeat = setInterval(() => {
      for (const v of this.viewers) v.write(": ping\n\n");
    }, 15_000);
    this.heartbeat.unref();
    this.o.log?.(
      `live view on http://127.0.0.1:${this.port} for "${this.o.identity.id}"; open it with: ${names().browser} live ${this.o.identity.id}`,
    );
  }

  private cleanupFiles(): void {
    const file = liveFilePath(this.o.identity.id, this.o.identity.env);
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveFile>;
      if (data.pid === process.pid && data.socket === this.socket) rmSync(file, { force: true });
    } catch {
      /* gone or not ours */
    }
    if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gate.resume();
    clearInterval(this.heartbeat);
    for (const v of this.viewers) v.end();
    this.viewers.clear();
    await this.retarget();
    await Promise.all(
      [this.tcp, this.unix].map(
        (s) =>
          new Promise<void>((r) => {
            if (!s) return r();
            s.closeAllConnections?.();
            s.close(() => r());
          }),
      ),
    );
    process.off("exit", this.onExit);
    this.cleanupFiles();
  }

  // The host's side.

  /** A browser launched; returns what to call when it goes away. */
  bind(browser: LiveBrowser): () => void {
    this.browser = browser;
    this.last = undefined;
    this.pinned = undefined;
    this.lastBySession.clear();
    if (this.paused && this.heldBrowser !== browser) {
      this.heldBrowser = browser;
      void browser.onPause?.().catch(() => {});
    }
    void this.retarget();
    this.pushState();
    return () => {
      if (this.browser !== browser) return;
      this.browser = undefined;
      if (this.heldBrowser === browser) this.heldBrowser = undefined;
      void this.retarget();
      this.pushState();
    };
  }

  /** The page a call of `session` worked on; the view follows the latest one. */
  follow(session: string, page: Page | undefined): void {
    if (!page || page.isClosed()) return;
    this.lastBySession.set(session, page);
    if (this.last === page) return;
    this.last = page;
    void this.retarget();
    this.pushState();
  }

  /** The page the last call of `session` worked on (it may have closed since). */
  lastPage(session: string): Page | undefined {
    return this.lastBySession.get(session);
  }

  /**
   * An agent call starts; returns what to call when it ends. `call` says which, for the view's
   * effects (its end comes from the timeline).
   */
  begin(call?: { tool: string; args: Record<string, unknown>; session: string; agent?: string }): () => void {
    if (call) this.stage.start(call);
    this.busy++;
    this.pushState();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.busy--;
      this.pushState();
    };
  }

  /** A mark of the agent cursor on `page` (a box, a click, a field typed into), for the view's effects. */
  mark(page: Page, session: string, m: CursorMark): void {
    // A page that holds a vault value is not shown, and neither is where the agent acts on it.
    if (!this.viewers.size || page.isClosed() || this.o.guard.holds(page)) return;
    const scroll = m.scroll ?? (page === this.cast?.page ? this.frameScroll : undefined);
    this.stage.mark({
      session,
      tab: this.idOf(page),
      mark: m.mark,
      ...(m.box ? { box: m.box } : {}),
      ...(m.point ? { point: m.point } : {}),
      ...(scroll ? { scroll } : {}),
    });
  }

  /** A vault or sensitive value is about to go into `page`: the view stops showing it now. */
  hide(page: Page | undefined): void {
    if (page && page === this.cast?.page) {
      this.hidden = true;
      this.pushState();
    }
  }

  /** The id the view and the note give a tab. */
  idOf(page: Page): number {
    let id = this.ids.get(page);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(page, id);
    }
    return id;
  }

  /** The agent's pages: every page, or in attach mode only those the agent worked on. */
  private pages(): Page[] {
    const b = this.browser;
    if (!b) return [];
    if (b.userBrowser) return [...new Set(this.lastBySession.values())].filter((p) => !p.isClosed());
    try {
      return b.context.pages().filter((p) => !p.isClosed());
    } catch {
      return [];
    }
  }

  private urlOf(page: Page): string {
    return this.browser?.urlOf?.(page) ?? page.url();
  }

  /** The tabs now, as the note compares them. */
  async tabStates(): Promise<TabState[]> {
    return await Promise.all(
      this.pages().map(async (p) => ({ id: this.idOf(p), url: this.urlOf(p), title: await titleOf(p) })),
    );
  }

  /** Pauses the agent. `front`: bring the shown tab to the front of a headed window. */
  async pause(by: string, front = false, hold: PauseHold = {}): Promise<boolean> {
    if (!this.gate.start(by, this.tabStates(), hold)) return false;
    this.timeline.paused(by, hold.step === true);
    const cue = hold.cue;
    this.stage.paused({
      by,
      step: hold.step === true,
      ...(cue ? { cue } : {}),
      ...(cue?.page ? { tab: this.idOf(cue.page) } : {}),
      ...(cue?.page && cue.page === this.cast?.page && this.frameScroll ? { scroll: this.frameScroll } : {}),
    });
    this.o.log?.(
      hold.step
        ? `"${this.o.identity.id}" waits for the person (${by}); every call waits until the step ends`
        : hold.idleMs !== undefined
          ? `"${this.o.identity.id}" held while the person uses it (${by}); it goes back to the agent ${hold.idleMs / 1000}s after their last input`
          : `"${this.o.identity.id}" paused (${by}); the agent's next call waits up to ${this.o.policy.waitMs / 1000}s`,
    );
    const b = this.browser;
    if (b) {
      this.heldBrowser = b;
      await b.onPause?.(cue).catch(() => {});
      const target = this.target();
      if (front && !this.o.headless && !b.userBrowser && target) await target.bringToFront().catch(() => {});
    }
    this.pushState();
    return true;
  }

  resume(): boolean {
    const was = this.gate.current();
    if (!this.gate.resume()) return false;
    this.o.log?.(`"${this.o.identity.id}" resumed`);
    if (was) {
      this.stage.resumed(Date.now() - was.since, was.step);
      void this.noteHandBack(was);
    }
    const b = this.heldBrowser;
    this.heldBrowser = undefined;
    b?.onResume?.();
    this.pushState();
    return true;
  }

  /** The timeline's hand-back line: what changed in the tabs while the person had the browser. */
  private async noteHandBack(was: NonNullable<ReturnType<PauseGate["current"]>>): Promise<void> {
    const before = await was.before.catch(() => [] as TabState[]);
    const after = await this.tabStates().catch(() => [] as TabState[]);
    const { lines } = describeChanges(before, after, undefined, undefined, this.gate.inputsOf(was.since));
    this.timeline.resumed(was.by, was.step, Date.now() - was.since, lines);
  }

  /** The tab the view shows: the one picked, else the agent's latest, else the first. */
  private target(): Page | undefined {
    if (this.pinned && !this.pinned.isClosed()) return this.pinned;
    this.pinned = undefined;
    if (this.last && !this.last.isClosed()) return this.last;
    return this.browser?.userBrowser ? undefined : this.pages()[0];
  }

  private refusal(): string | undefined {
    return this.o.viewRefusal(this.browser?.engine);
  }

  status(): LiveStatus {
    const reason = this.refusal();
    const paused = this.gate.paused;
    const target = this.browser ? this.target() : undefined;
    const tabs = this.pages().map((p) => {
      const session = this.browser?.owner?.(p);
      return {
        id: this.idOf(p),
        url: this.o.redactor.text(plainUrl(this.urlOf(p))),
        title: "",
        ...(session ? { session: session.slice(0, 8) } : {}),
      };
    });
    return {
      identity: this.o.identity.id,
      pid: process.pid,
      port: this.port,
      started: this.started,
      paused: paused
        ? {
            since: new Date(paused.since).toISOString(),
            by: paused.by,
            ...(paused.idleMs === undefined ? {} : { idleMs: paused.idleMs }),
          }
        : null,
      waiting: this.gate.held,
      busy: this.busy,
      wait: this.o.policy.waitMs,
      browser: this.browser !== undefined,
      engine: this.browser?.engine ?? null,
      view: { available: reason === undefined, ...(reason ? { reason } : {}), headless: this.o.headless },
      showing: target && reason === undefined ? this.idOf(target) : null,
      pinned: this.pinned !== undefined,
      hidden: target ? this.o.guard.holds(target) || (this.hidden && this.cast?.page === target) : false,
      viewers: this.viewers.size,
      tabs,
      stuck: this.timeline.stuck ?? null,
    };
  }

  /** The status with tab titles (they need a round trip to each page). */
  private async fullStatus(): Promise<LiveStatus> {
    const s = this.status();
    const titles = new Map((await this.tabStates()).map((t) => [t.id, t.title]));
    for (const t of s.tabs) t.title = this.o.redactor.text(titles.get(t.id) ?? "");
    return s;
  }

  private pushState(): void {
    if (this.queued || !this.viewers.size) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      void this.fullStatus()
        .then((s) => this.broadcast("state", JSON.stringify(s)))
        .catch(() => {});
    });
  }

  private broadcast(event: string, data: string): void {
    for (const v of this.viewers) v.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  /** Starts or moves the screencast to the tab the view should show, or stops it. */
  private retarget(): Promise<void> {
    this.casting = this.casting.then(() => this.doRetarget()).catch(() => {});
    return this.casting;
  }

  private async doRetarget(): Promise<void> {
    const b = this.browser;
    const want = this.viewers.size && b && !this.closed && !this.refusal() ? this.target() : undefined;
    if (this.cast?.page === want && (!want || !want.isClosed())) return;
    const old = this.cast;
    this.cast = undefined;
    this.hidden = false;
    this.frameScroll = undefined;
    if (old) {
      old.page.off("download", old.download);
      await old.cdp.send("Page.stopScreencast").catch(() => {});
      await old.cdp.detach().catch(() => {});
    }
    if (!want || !b) return;
    const cdp = await b.context.newCDPSession(want);
    // A download from the shown tab: its file name, for the view's effect (Playwright's event).
    const download = (d: { suggestedFilename(): string }) => {
      if (this.viewers.size)
        this.stage.mark({ session: "", tab: this.idOf(want), mark: "download", name: d.suggestedFilename() });
    };
    want.on("download", download);
    const cast = { page: want, cdp, download };
    this.cast = cast;
    cdp.on("Page.screencastFrame", (f) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      if (this.cast !== cast) return;
      // Checked as each frame arrives: once the guard holds the page, no frame of it leaves.
      if (this.o.guard.holds(want)) {
        if (!this.hidden) {
          this.hidden = true;
          this.pushState();
        }
        return;
      }
      if (this.hidden) {
        this.hidden = false;
        this.pushState();
      }
      const m = f.metadata;
      this.frameScroll = { x: m.scrollOffsetX ?? 0, y: m.scrollOffsetY ?? 0 };
      this.broadcast(
        "frame",
        JSON.stringify({
          tab: this.idOf(want),
          w: m.deviceWidth ?? 0,
          h: m.deviceHeight ?? 0,
          // Where the page was, so the view places the effects' boxes on the picture (`live-map.ts`).
          sx: m.scrollOffsetX ?? 0,
          sy: m.scrollOffsetY ?? 0,
          scale: m.pageScaleFactor ?? 1,
          top: m.offsetTop ?? 0,
          data: f.data,
        }),
      );
    });
    want.once("close", () => {
      void this.retarget();
      this.pushState();
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280 });
  }

  // HTTP.

  private hostOk(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return (
      req.headers["x-turno-live"] === "1" &&
      (origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`)
    );
  }

  private cookieOk(req: IncomingMessage): boolean {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === this.cookieName && sameSecret(part.slice(eq + 1).trim(), this.token))
        return true;
    }
    return false;
  }

  /** A one-time code for a link (socket only). */
  private issueCode(): string {
    const now = Date.now();
    for (const [c, until] of this.codes) if (until < now) this.codes.delete(c);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, now + CODE_MS);
    return code;
  }

  private takeCode(code: string): boolean {
    for (const [c, until] of this.codes) {
      if (sameSecret(c, code)) {
        this.codes.delete(c);
        return until >= Date.now();
      }
    }
    return false;
  }

  private send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}) {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      ...headers,
    });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    this.send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, trusted: boolean): Promise<void> {
    try {
      if (!trusted && !this.hostOk(req)) return this.send(res, 403, "text/plain", "forbidden");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      if (!trusted && method === "GET" && url.pathname === "/" && url.searchParams.has("code")) {
        if (!this.takeCode(url.searchParams.get("code") ?? ""))
          return this.send(res, 403, "text/html; charset=utf-8", deniedPage(this.o.identity.id, this.locale()));
        return this.send(res, 303, "text/plain", "", {
          Location: "/",
          "Set-Cookie": `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
        });
      }
      if (!trusted && !this.cookieOk(req)) {
        if (method === "GET" && url.pathname === "/")
          return this.send(res, 401, "text/html; charset=utf-8", deniedPage(this.o.identity.id, this.locale()));
        return this.json(res, 401, { error: "not signed in to this live view" });
      }
      if (method === "POST" && !trusted && !this.originOk(req))
        return this.json(res, 403, { error: "a request from another origin" });
      const route = `${method} ${url.pathname}`;
      if (route === "GET /" && !trusted) {
        const nonce = randomBytes(16).toString("base64");
        return this.send(res, 200, "text/html; charset=utf-8", livePage(nonce, this.locale()), {
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }
      if (route === "GET /state") return this.json(res, 200, await this.fullStatus());
      if (route === "GET /events" && !trusted) return this.events(req, res);
      if (route === "POST /pause") {
        const body = await readJson(req);
        // The command that paused, as the local client names it; only a short command name is taken.
        const by = typeof body.by === "string" && /^[a-z][a-z -]{0,38} pause$/.test(body.by) ? body.by : undefined;
        // Pause during an automatic pause: the person keeps the controls until they hand back.
        if (this.gate.keep()) this.pushState();
        else await this.pause(trusted ? (by ?? `${names().browser} pause`) : "the live view", trusted);
        return this.json(res, 200, await this.fullStatus());
      }
      if (route === "POST /resume") {
        await readJson(req);
        this.resume();
        return this.json(res, 200, await this.fullStatus());
      }
      if (route === "POST /follow") {
        const body = await readJson(req);
        if (body.tab === null || body.tab === undefined) this.pinned = undefined;
        else {
          const page = this.pages().find((p) => this.idOf(p) === body.tab);
          if (!page) throw new HttpError(404, uiStrings(this.locale()).live.noSuchTab);
          this.pinned = page;
        }
        await this.retarget();
        this.pushState();
        return this.json(res, 200, await this.fullStatus());
      }
      if (route === "POST /input" && !trusted) {
        await this.input(await readJson(req));
        return this.json(res, 200, { ok: true });
      }
      if (route === "POST /link" && trusted) {
        await readJson(req);
        const reason = this.refusal();
        if (reason) throw new HttpError(409, reason);
        return this.json(res, 200, { url: `http://127.0.0.1:${this.port}/?code=${this.issueCode()}` });
      }
      return this.json(res, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) this.json(res, status, { error: this.o.redactor.text(String((error as Error).message)) });
      else res.end();
    }
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: steps\ndata: ${JSON.stringify(this.timeline.list())}\n\n`);
    // The steps that run now, so a view that opens mid-call shows them.
    for (const e of this.stage.running()) res.write(`event: fx\ndata: ${JSON.stringify(e)}\n\n`);
    this.viewers.add(res);
    req.on("close", () => {
      this.viewers.delete(res);
      void this.retarget();
    });
    void this.retarget();
    this.pushState();
  }

  /** Why input from the view cannot go to the page now (a pause comes first when there is none). */
  private inputRefusal(page: Page | undefined): string | undefined {
    const t = uiStrings(this.locale()).live;
    const reason = this.refusal();
    if (reason) return fill(t.noView, { reason });
    if (!page) return t.noTab;
    if (this.o.guard.holds(page)) return t.hiddenInput;
    return undefined;
  }

  /** The language of the page and of its answers to it. */
  private locale(): UiLocale {
    return this.o.uiLocale?.() ?? "en";
  }

  /**
   * The person used the view while the agent works: an automatic pause, which ends once their
   * input stops. The input waits for the call that runs to end, so it never lands in the middle
   * of the agent's own.
   */
  private async takeOver(): Promise<void> {
    if (!this.paused) {
      const idleMs = this.o.idleMs ?? DEFAULT_IDLE_MS;
      if (await this.pause("the live view", false, { idleMs })) {
        const since = this.gate.paused?.since;
        if (since !== undefined) void handBackWhenIdle(this, since);
      }
    }
    const end = Date.now() + DRAIN_MS;
    while (this.busy > 0 && this.paused && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    if (this.busy > 0) throw new HttpError(409, uiStrings(this.locale()).live.busy);
  }

  private async input(body: Record<string, unknown>): Promise<void> {
    const page = this.browser ? this.target() : undefined;
    const why = this.inputRefusal(page);
    if (why) throw new HttpError(409, why);
    const p = page!;
    const xy = () => [num(body.x, 0, 20_000), num(body.y, 0, 20_000)] as const;
    let act: () => Promise<void>;
    switch (body.type) {
      case "click": {
        const [x, y] = xy();
        act = () => p.mouse.click(x, y);
        break;
      }
      case "dblclick": {
        const [x, y] = xy();
        act = () => p.mouse.dblclick(x, y);
        break;
      }
      case "wheel": {
        const [x, y] = xy();
        const dx = num(body.dx, -20_000, 20_000);
        const dy = num(body.dy, -20_000, 20_000);
        act = async () => {
          await p.mouse.move(x, y);
          await p.mouse.wheel(dx, dy);
        };
        break;
      }
      case "text": {
        if (typeof body.text !== "string" || !body.text || body.text.length > 1_000)
          throw new HttpError(400, "text must be 1 to 1000 characters");
        const text = body.text;
        act = () => p.keyboard.insertText(text);
        break;
      }
      case "key": {
        if (typeof body.key !== "string" || !KEYS.has(body.key)) throw new HttpError(400, "unknown key");
        const key = body.key;
        act = () => p.keyboard.press(key);
        break;
      }
      default:
        throw new HttpError(400, "type must be click, dblclick, wheel, text or key");
    }
    await this.takeOver();
    // Before it lands too, so an automatic pause does not end while it runs.
    this.gate.touch();
    await act();
    this.gate.noteInput();
  }
}
