import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "patchright-core";
import type { IdentityRef } from "./engine.js";
import { type LiveFile, type LivePolicy, PauseGate, type PauseHold, type TabState, liveFilePath } from "./live.js";
import { deniedPage, livePage } from "./live-page.js";
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
 *   folder (mode 700, socket 600): the file system is the access check there. Where to find
 *   both is in `<state>/browser/identities/<id>/live.json`, without any secret.
 * - The picture is a CDP screencast of one tab (the one the agent used last, or the one the
 *   user picked), taken only while a view is open. A frame of a page that holds a vault or
 *   sensitive value (the vault guard: a `browser_login` fill, a password typed) is never sent;
 *   the view says the page is hidden until it navigates.
 * - While the agent is paused, the user's clicks, keys and scrolls on the picture go to that
 *   tab through Playwright's mouse and keyboard. Never while an agent call runs, and never to a
 *   hidden page. Input is not logged anywhere.
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
  /** The user takes over: hold the idle limit and the tab governor, save the trace. */
  onPause?(): Promise<void>;
  /** The user gave the browser back. */
  onResume?(): void;
}

/** What `/state` returns: the view, the pause and the tabs, as the CLI and the page show them. */
export interface LiveStatus {
  identity: string;
  pid: number;
  port: number;
  started: string;
  paused: { since: string; by: string } | null;
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
}

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

function plainUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}${u.pathname}` : u.protocol;
  } catch {
    return "";
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
  private cast: { page: Page; cdp: CDPSession } | undefined;
  private casting: Promise<void> = Promise.resolve();
  private hidden = false;
  private readonly token = randomBytes(32).toString("base64url");
  private readonly codes = new Map<string, number>();
  private tcp: Server | undefined;
  private unix: Server | undefined;
  private port = 0;
  private socketDir: string | undefined;
  private started = "";
  private queued = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly onExit = () => this.cleanupFiles();

  constructor(private readonly o: LiveServerOptions) {}

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
    return this.socketDir && join(this.socketDir, "control.sock");
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
    this.socketDir = mkdtempSync(join(tmpdir(), "turno-live-"));
    chmodSync(this.socketDir, 0o700);
    const socket = this.socket!;
    this.unix = createServer((req, res) => void this.handle(req, res, true));
    await listen(this.unix, socket);
    chmodSync(socket, 0o600);
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
    renameSync(tmp, file);
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

  /** An agent call starts; returns what to call when it ends. */
  begin(): () => void {
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
    this.o.log?.(
      hold.step
        ? `"${this.o.identity.id}" waits for the person (${by}); every call waits until the step ends`
        : `"${this.o.identity.id}" paused (${by}); the agent's next call waits up to ${this.o.policy.waitMs / 1000}s`,
    );
    const b = this.browser;
    if (b) {
      this.heldBrowser = b;
      await b.onPause?.().catch(() => {});
      const target = this.target();
      if (front && !this.o.headless && !b.userBrowser && target) await target.bringToFront().catch(() => {});
    }
    this.pushState();
    return true;
  }

  resume(): boolean {
    if (!this.gate.resume()) return false;
    this.o.log?.(`"${this.o.identity.id}" resumed`);
    const b = this.heldBrowser;
    this.heldBrowser = undefined;
    b?.onResume?.();
    this.pushState();
    return true;
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
      paused: paused ? { since: new Date(paused.since).toISOString(), by: paused.by } : null,
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
    if (old) {
      await old.cdp.send("Page.stopScreencast").catch(() => {});
      await old.cdp.detach().catch(() => {});
    }
    if (!want || !b) return;
    const cdp = await b.context.newCDPSession(want);
    const cast = { page: want, cdp };
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
      this.broadcast(
        "frame",
        JSON.stringify({
          tab: this.idOf(want),
          w: f.metadata.deviceWidth ?? 0,
          h: f.metadata.deviceHeight ?? 0,
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
        await this.pause(trusted ? (by ?? `${names().browser} pause`) : "the live view", trusted);
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
    this.viewers.add(res);
    req.on("close", () => {
      this.viewers.delete(res);
      void this.retarget();
    });
    void this.retarget();
    this.pushState();
  }

  /** Why input from the view cannot go to the page now. */
  private inputRefusal(page: Page | undefined): string | undefined {
    const t = uiStrings(this.locale()).live;
    const reason = this.refusal();
    if (reason) return fill(t.noView, { reason });
    if (!this.paused) return t.pauseFirst;
    if (this.busy) return t.busy;
    if (!page) return t.noTab;
    if (this.o.guard.holds(page)) return t.hiddenInput;
    return undefined;
  }

  /** The language of the page and of its answers to it. */
  private locale(): UiLocale {
    return this.o.uiLocale?.() ?? "en";
  }

  private async input(body: Record<string, unknown>): Promise<void> {
    const page = this.browser ? this.target() : undefined;
    const why = this.inputRefusal(page);
    if (why) throw new HttpError(409, why);
    const p = page!;
    const xy = () => [num(body.x, 0, 20_000), num(body.y, 0, 20_000)] as const;
    switch (body.type) {
      case "click": {
        const [x, y] = xy();
        await p.mouse.click(x, y);
        break;
      }
      case "dblclick": {
        const [x, y] = xy();
        await p.mouse.dblclick(x, y);
        break;
      }
      case "wheel": {
        const [x, y] = xy();
        await p.mouse.move(x, y);
        await p.mouse.wheel(num(body.dx, -20_000, 20_000), num(body.dy, -20_000, 20_000));
        break;
      }
      case "text": {
        if (typeof body.text !== "string" || !body.text || body.text.length > 1_000)
          throw new HttpError(400, "text must be 1 to 1000 characters");
        await p.keyboard.insertText(body.text);
        break;
      }
      case "key": {
        if (typeof body.key !== "string" || !KEYS.has(body.key)) throw new HttpError(400, "unknown key");
        await p.keyboard.press(body.key);
        break;
      }
      default:
        throw new HttpError(400, "type must be click, dblclick, wheel, text or key");
    }
    this.gate.noteInput();
  }
}
