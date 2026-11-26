import { type Browser, chromium } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PageActivity } from "../src/page-activity.js";
import { chromeEnv } from "../src/settings.js";
import { chromeUnavailable } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The person's own input in the agent's window, against a real Google Chrome (headless): trusted
 * clicks, keys and scrolls after the agent's call count, a page script's synthetic ones do not,
 * and the page cannot see the listeners.
 */

const reason = chromeUnavailable();

describe.skipIf(reason)(`page activity with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
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

  it("counts the person's input after the agent's call, once, and never a page script's", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `<input id="q"><div style="height:3000px"></div>
       <script>window.fake = () => { document.getElementById("q").dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); };</script>`,
    );
    const activity = new PageActivity();
    // The agent's own click in a call: arming at the end of that call counts from after it.
    await activity.arm(page);
    await page.mouse.click(20, 10);
    await activity.arm(page);
    const after = Date.now();
    expect(await activity.since(page, after)).toBeUndefined();

    // A page script's events are not trusted, so they are not the person's.
    await page.evaluate("window.fake()", undefined, undefined, false);
    expect(await activity.since(page, after)).toBeUndefined();

    await page.mouse.click(20, 10);
    await page.keyboard.press("a");
    await page.mouse.wheel(0, 200);
    // The wheel event may come a moment after the call that sent it returns.
    let count = 0;
    let at = 0;
    for (let i = 0; i < 20 && count < 3; i++) {
      const seen = await activity.since(page, after);
      if (seen) {
        count += seen.count;
        at = seen.at;
      } else await new Promise((r) => setTimeout(r, 50));
    }
    expect(count).toBe(3);
    expect(at).toBeGreaterThanOrEqual(after);
    // Handed out once.
    expect(await activity.since(page, after)).toBeUndefined();

    // Nothing in the page's own world shows the listeners or their state.
    const visible = await page.evaluate(
      "Object.keys(window).filter((k) => /turno/i.test(k))",
      undefined,
      undefined,
      false,
    );
    expect(visible).toEqual([]);
    await page.close();
  });
});
