import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, CDPSession, Worker } from "patchright-core";
import { browserPaths, replaceFileSync } from "turno-core/paths";

/**
 * The side panel: what the agent does, shown in Chrome's own side panel of the agent's window,
 * next to the page (on by default for a headed Chrome that turno launches; identity.json
 * `sidePanel`). It is a small extension bundled with this package (`extension/`), loaded at
 * every launch and never kept in the profile's own list of extensions:
 *
 * - Its only permission is `sidePanel`. It has no content scripts, no host permissions and no
 *   web accessible resources, so no page can load one of its files, message it or tell it is
 *   there; the reputation bench's probe checks that (`extension-resources`). Nothing is added to
 *   any page: the panel is a page of the extension, drawn by Chrome beside the site's.
 * - Chrome loads it over the DevTools protocol (`Extensions.loadUnpacked`), which needs
 *   `--enable-unsafe-extension-debugging` and the protocol on a pipe, as Playwright connects. The
 *   files are copied to `<state>/browser/side-panel` first: the standalone executables serve
 *   this package from a virtual file system Chrome cannot read. Its manifest `key` gives it the
 *   same id everywhere (`behcmklpkdiiimpnokegjknjlhonkcig`).
 * - Chrome opens a side panel only in answer to a user gesture. The host opens the extension's
 *   `opener.html` in a hidden tab (`Target.createTarget` with `hidden`: no entry in the tab strip,
 *   so nothing flashes), clicks its button with the protocol's trusted input, and closes it.
 * - The panel reads the live server (`live-server.ts`) on 127.0.0.1. The host puts the server's
 *   address and a code that works once into the extension's service worker over the protocol,
 *   each time a panel page opens; the panel trades it for a token of its own. Neither goes
 *   through a page or into a URL a site can see.
 *
 * The panel takes width from the page, as it does for a person who opens one: a page loaded with
 * it open sees a narrower window (`innerWidth`), and a page open while it opens gets a resize.
 */

/** The switch that lets the protocol load an extension; added only when the panel is on. */
export const SIDE_PANEL_SWITCH = "--enable-unsafe-extension-debugging";

/** What the host offers a panel that opens: the live server's origin and a one-use code. */
export interface PanelOffer {
  server: string;
  code: string;
}

/** Where the package keeps the extension's files. */
function bundledExtensionDir(): string {
  return fileURLToPath(new URL("../extension/", import.meta.url));
}

/**
 * Copies the bundled extension to `<state>/browser/side-panel` (mode 700), rewriting only the
 * files that changed, each through a rename; returns the folder.
 */
function installSidePanelExtension(env: NodeJS.ProcessEnv = process.env, from = bundledExtensionDir()): string {
  const dir = join(browserPaths(env).state, "browser", "side-panel");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    const data = readFileSync(join(from, name));
    const to = join(dir, name);
    if (existsSync(to) && readFileSync(to).equals(data)) continue;
    const tmp = `${to}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    replaceFileSync(tmp, to);
  }
  return dir;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Commands to a target through the browser session (`Target.sendMessageToTarget`). */
function targetSession(cdp: CDPSession, sessionId: string): { send: Send; detach(): void } {
  const browser = cdp.send.bind(cdp) as unknown as Send;
  let id = 0;
  const pending = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
  const onMessage = (e: { sessionId: string; message: string }) => {
    if (e.sessionId !== sessionId) return;
    const m = JSON.parse(e.message) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    if (m.id === undefined) return;
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  const events = cdp as unknown as {
    on(event: string, fn: (e: { sessionId: string; message: string }) => void): void;
    off(event: string, fn: (e: { sessionId: string; message: string }) => void): void;
  };
  events.on("Target.receivedMessageFromTarget", onMessage);
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {})));
        browser("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: n, method, params }) }).catch(
          reject,
        );
      }),
    detach() {
      events.off("Target.receivedMessageFromTarget", onMessage);
      void browser("Target.detachFromTarget", { sessionId }).catch(() => {});
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SidePanelOptions {
  /** A fresh offer for a panel that opens; undefined when the live server is not up. */
  offer(origin: string): Promise<PanelOffer | undefined>;
  log?(line: string): void;
  env?: NodeJS.ProcessEnv;
}

/** The side panel of one launched Chrome. */
export class SidePanel {
  private closed = false;

  private constructor(
    private readonly context: BrowserContext,
    private readonly cdp: CDPSession,
    /** `chrome-extension://<id>`: the origin the live server lets the panel in from. */
    readonly origin: string,
    private readonly options: SidePanelOptions,
  ) {}

  /**
   * Loads the extension into the Chrome of `context` and opens the panel in its windows.
   * Undefined when Chrome refuses (an engine or a Chrome without the protocol's extension
   * domain, or no `--enable-unsafe-extension-debugging`): the browser runs on without it.
   */
  static async open(context: BrowserContext, options: SidePanelOptions): Promise<SidePanel | undefined> {
    let cdp: CDPSession | undefined;
    try {
      const browser = context.browser();
      if (!browser) return undefined;
      const dir = installSidePanelExtension(options.env);
      cdp = await browser.newBrowserCDPSession();
      const send = cdp.send.bind(cdp) as unknown as Send;
      const { id } = (await send("Extensions.loadUnpacked", { path: dir })) as { id: string };
      const panel = new SidePanel(context, cdp, `chrome-extension://${id}`, options);
      // Each panel page that opens (the person may close it and open it again from the toolbar)
      // gets a fresh code in the service worker. Its target comes without a URL and gets it in
      // a change that follows.
      const offered = new Set<string>();
      const seen = ({ targetInfo }: { targetInfo: { targetId: string; url: string } }) => {
        if (!targetInfo.url.startsWith(`${panel.origin}/panel.html`) || offered.has(targetInfo.targetId)) return;
        offered.add(targetInfo.targetId);
        void panel.offer().catch((e: unknown) => options.log?.(`side panel: ${(e as Error).message}`));
      };
      const events = cdp as unknown as { on<T>(e: string, f: (x: T) => void): void };
      events.on("Target.targetCreated", seen);
      events.on("Target.targetInfoChanged", seen);
      events.on("Target.targetDestroyed", ({ targetId }: { targetId: string }) => offered.delete(targetId));
      await send("Target.setDiscoverTargets", { discover: true });
      await panel.openInWindows();
      return panel;
    } catch (error) {
      options.log?.(`the side panel did not open: ${(error as Error).message.split("\n")[0]}`);
      await cdp?.detach().catch(() => {});
      return undefined;
    }
  }

  /** The extension's service worker, started by Chrome when the panel asks for it. */
  private async worker(): Promise<Worker | undefined> {
    const url = `${this.origin}/sw.js`;
    const found = this.context.serviceWorkers().find((w) => w.url() === url);
    if (found) return found;
    return await new Promise<Worker | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.context.off("serviceworker", on);
        resolve(undefined);
      }, 10_000);
      const on = (w: Worker) => {
        if (w.url() !== url) return;
        clearTimeout(timer);
        this.context.off("serviceworker", on);
        resolve(w);
      };
      this.context.on("serviceworker", on);
    });
  }

  /** Puts a fresh offer into the service worker, for the panel that just opened. */
  private async offer(): Promise<void> {
    if (this.closed) return;
    const offer = await this.options.offer(this.origin);
    const worker = offer && (await this.worker());
    if (!offer || !worker || this.closed) return;
    await worker.evaluate(
      (o) => (globalThis as unknown as { turnoOffer(o: PanelOffer): boolean }).turnoOffer(o),
      offer,
    );
  }

  /** Opens the panel in every window: a hidden tab of `opener.html`, one trusted click. */
  private async openInWindows(): Promise<void> {
    const send = this.cdp.send.bind(this.cdp) as unknown as Send;
    const { targetId } = (await send("Target.createTarget", {
      url: `${this.origin}/opener.html`,
      hidden: true,
      background: true,
    })) as { targetId: string };
    const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: false })) as {
      sessionId: string;
    };
    const tab = targetSession(this.cdp, sessionId);
    try {
      const value = async (expression: string) =>
        ((await tab.send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } })
          .result?.value;
      const until = Date.now() + 5_000;
      while ((await value("document.readyState")) !== "complete") {
        if (Date.now() > until) throw new Error("the opener page did not load");
        await sleep(20);
      }
      // A hidden tab has no size of its own: give it one, so the click lands on the button.
      await tab.send("Emulation.setDeviceMetricsOverride", {
        width: 64,
        height: 64,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const type of ["mousePressed", "mouseReleased"])
        await tab.send("Input.dispatchMouseEvent", { type, x: 32, y: 32, button: "left", clickCount: 1 });
      let title = "";
      while (!/^(opened|failed)/.test(title)) {
        if (Date.now() > until) throw new Error("the opener did not answer");
        await sleep(20);
        title = String((await value("document.title")) ?? "");
      }
      if (title.startsWith("failed")) throw new Error(title);
    } finally {
      tab.detach();
      await send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.cdp.detach().catch(() => {});
  }
}
