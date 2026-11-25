import { type Server, createServer } from "node:http";
import { join } from "node:path";
import type { BrowserContext } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installPasskeyProbe } from "../src/passkey.js";
import { chromeEnv } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * How turno's init scripts reach pages, on a real Chrome with the patchright-core this package
 * pins. The passkey probe marks the context as routed (`routeInjecting`), so patchright skips its
 * catch-all route and the scripts go in through `Page.addScriptToEvaluateOnNewDocument`. A
 * patchright update that changes that internal shows up here: documents served by the
 * automation (an empty `nextHopProtocol`, which bot detectors read), Chrome's HTTP cache turned
 * off, a cross-site iframe that no longer loads, or an init script that stops reaching a frame.
 * Measured with patchright-core 1.64.3: without the mark, documents come back with an empty
 * `nextHopProtocol` and the cross-site iframe never loads. In a cross-site iframe the script runs
 * after the frame's first inline script, so only the top document checks the order.
 */

const reason = chromeUnavailable();

const REPORT = `<script>
  window.order = (window.order || []).concat("page");
  const nav = performance.getEntriesByType("navigation")[0];
  window.report = { order: window.order, nextHopProtocol: nav ? nav.nextHopProtocol : null };
</script>`;

let sb: Sandbox;
let web: Server;
let port: number;
let ctx: BrowserContext;
let scriptHits = 0;

describe.skipIf(reason)(`turno's init scripts on a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  beforeAll(async () => {
    sb = sandbox();
    web = createServer((req, res) => {
      if (req.url === "/app.js") {
        scriptHits++;
        res.setHeader("content-type", "text/javascript");
        res.setHeader("cache-control", "max-age=3600");
        res.end("window.appLoaded = true;");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/frame") {
        // The cross-site frame sends its report to the top document, once its load is over.
        res.end(
          `<!doctype html><title>Frame</title>${REPORT}<script>addEventListener("load", () => setTimeout(() => parent.postMessage({ ...window.report, order: window.order }, "*"), 500))</script>`,
        );
        return;
      }
      res.end(`<!doctype html><title>Top</title>${REPORT}
<script>
  window.frameReport = new Promise((r) => {
    addEventListener("message", (e) => r(e.data));
    setTimeout(() => r({ order: [], nextHopProtocol: "", loaded: false }), 15000);
  });
</script>
<script src="/app.js"></script>
<iframe src="http://localhost:${port}/frame"></iframe>`);
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    port = (web.address() as { port: number }).port;
    const { chromium } = await import("patchright-core");
    ctx = await chromium.launchPersistentContext(join(sb.home, "profile"), {
      channel: "chrome",
      headless: true,
      env: chromeEnv(sb.env),
    });
    await installPasskeyProbe(ctx, () => {});
    await ctx.addInitScript('window.order = (window.order || []).concat("init");');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close().catch(() => {});
    await new Promise<void>((r) => web?.close(() => r()));
    if (sb) {
      await stopSandboxProcesses(sb.home);
      sb.cleanup();
    }
  });

  it("reaches the main world of every frame, on documents Chrome loaded itself, with its HTTP cache on", async () => {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // The page's own world (false): what its scripts and a detector see.
    const top = (await page.evaluate("window.report", undefined, undefined, false)) as {
      order: string[];
      nextHopProtocol: string;
    };
    const frame = (await page.evaluate("window.frameReport", undefined, undefined, false)) as typeof top & {
      loaded?: false;
    };
    expect(frame.loaded, "the cross-site iframe did not load").toBeUndefined();
    expect(top.order).toEqual(["init", "page"]);
    expect(frame.order).toContain("init");
    for (const r of [top, frame]) expect(r.nextHopProtocol, "a document served by the automation").not.toBe("");
    expect(scriptHits).toBe(1);
    await page.reload();
    expect(await page.evaluate("window.appLoaded", undefined, undefined, false)).toBe(true);
    expect(scriptHits, "the cacheable script was fetched again on reload").toBe(1);
  });
});
