import { type Browser, chromium } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserDrawnCursor } from "../src/agent-cursor-cdp.js";
import { chromeEnv } from "../src/settings.js";
import { chromeUnavailable } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The agent cursor Chrome draws (`cursor: "auto"`), against a real Google Chrome (headless): the
 * highlight is painted (a screenshot shows it), hidden for the model's screenshot, and the page
 * gets no element and sees no mutation.
 */

const reason = chromeUnavailable();

describe.skipIf(reason)(`the browser-drawn cursor with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  let home: Sandbox;
  let browser: Browser;
  beforeAll(async () => {
    home = sandbox();
    browser = await chromium.launch({ channel: "chrome", headless: true, env: chromeEnv(home.env) });
  });
  afterAll(async () => {
    await browser?.close();
    home?.cleanup();
  });

  it("paints the target's highlight above the page, hides it for the screenshot, and adds nothing to the page", async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(
      `<button id="b" style="position:absolute;left:100px;top:100px;width:120px;height:40px">Go</button>
       <script>window.added = 0; new MutationObserver((r) => { for (const m of r) window.added += m.addedNodes.length; }).observe(document.documentElement, { childList: true, subtree: true, attributes: true });</script>`,
    );
    const cursor = new BrowserDrawnCursor({ title: "claude-code" });
    const plain = await page.screenshot();
    await cursor.begin(page, "s1");
    await cursor.ring(page, { x: 100, y: 100, width: 120, height: 40 });
    const ringed = await page.screenshot();
    expect(ringed.equals(plain)).toBe(false);
    const hidden = await cursor.hiddenDuring(page, () => page.screenshot());
    expect(hidden.equals(plain)).toBe(true);
    // Back after the screenshot, and gone when the call ends.
    expect((await page.screenshot()).equals(plain)).toBe(false);
    await cursor.end(page, "s1");
    expect((await page.screenshot()).equals(plain)).toBe(true);
    const seen = await page.evaluate(
      "({ added: window.added, children: [...document.documentElement.children].map((e) => e.tagName) })",
      undefined,
      undefined,
      false,
    );
    expect(seen).toEqual({ added: 0, children: ["HEAD", "BODY"] });
    await page.close();
  });
});
