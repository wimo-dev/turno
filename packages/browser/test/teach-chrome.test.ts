import { readFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Browser, chromium } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flowPath, readFlow } from "../src/flows.js";
import { addIdentity } from "../src/identities.js";
import { Redactor } from "../src/redact.js";
import { chromeEnv } from "../src/settings.js";
import { TeachSession } from "../src/teach.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Teach mode against a real Google Chrome (headless): the person's input, made with the
 * protocol's trusted input as a person's would be, is saved as a flow that the server in dist/
 * (built by the global setup) replays, and a password typed by the person never reaches the flow.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();
const PASSWORD = 'Te4ch pass&<"word">';

const PAGE = `<!doctype html><title>Order</title>
<form id="order" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Ordered ' + this.who.value + (this.gift.checked ? ' as a gift' : '');">
  <label>Name <input name="who"></label>
  <label>Password <input name="pw" type="password"></label>
  <label><input name="gift" type="checkbox"> Gift wrap</label>
  <button>Order</button>
</form>
<p id="out" role="status"></p>`;

describe.skipIf(reason)(`teach mode with a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  let sb: Sandbox;
  let browser: Browser;
  let server: Server;
  let url = "";
  beforeAll(async () => {
    sb = sandbox();
    addIdentity("teach", sb.env);
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/order`;
    browser = await chromium.launch({ channel: "chrome", headless: true, env: chromeEnv(sb.env) });
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server?.close(r));
    if (sb) {
      await stopSandboxProcesses(sb.home);
      sb.cleanup();
    }
  });

  /** A teach session on a fresh context, with the person's steps done by `act`. */
  async function teach(name: string, act: (page: import("patchright-core").Page) => Promise<void>) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = new TeachSession(context, { id: "teach", env: sb.env }, new Redactor(), name, () => {});
    await session.start(url, page);
    await act(page);
    // The last report crosses the protocol after the input: wait for it.
    await expect.poll(() => session.count, { timeout: 5_000 }).toBeGreaterThan(1);
    await new Promise((r) => setTimeout(r, 300));
    await session.stop();
    const views = JSON.stringify(session.views());
    const saved = session.save([]);
    await context.close();
    return { ...saved, views };
  }

  it("saves the person's three steps as a flow that browser_replay runs again", async () => {
    const { flow } = await teach("order", async (page) => {
      await page.getByLabel("Name").click();
      await page.keyboard.type("Ada");
      await page.getByLabel("Gift wrap").click();
      await page.getByRole("button", { name: "Order" }).click();
      await expect.poll(() => page.textContent("#out")).toBe("Ordered Ada as a gift");
    });
    expect(flow.steps.map((s) => s.tool)).toEqual([
      "browser_navigate",
      "browser_type",
      "browser_click",
      "browser_click",
    ]);
    const typed = flow.params.find((p) => !p.sensitive);
    expect(typed).toMatchObject({ default: "Ada" });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--identity", "teach", "--headless"],
      env: sb.env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    const client = new Client({ name: "teach-replay", version: "0.0.0" });
    await client.connect(transport);
    try {
      const text = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: args })) as { content: { text?: string }[] }).content
          .map((c) => c.text ?? "")
          .join("\n");
      const replayed = await text("browser_replay", { flow: "order", params: { [typed!.name]: "Grace" } });
      expect(replayed).not.toMatch(/failed/i);
      expect(await text("browser_snapshot", {})).toContain("Ordered Grace as a gift");
    } finally {
      await transport.close();
    }
  }, 120_000);

  it("never writes a password the person typed: not in the flow, not in what the panel shows", async () => {
    const { file, views } = await teach("sign-in", async (page) => {
      await page.getByLabel("Name").click();
      await page.keyboard.type("ada");
      await page.getByLabel("Password").click();
      await page.keyboard.type(PASSWORD);
      await page.keyboard.press("Enter");
      await expect.poll(() => page.textContent("#out")).toBe("Ordered ada");
    });
    expect(file).toBe(flowPath("teach", "sign-in", sb.env));
    const written = readFileSync(file, "utf8");
    // Counted, never shown.
    expect(
      [written, views].filter((t) => t.includes(PASSWORD) || t.includes(encodeURIComponent(PASSWORD))),
    ).toHaveLength(0);
    const flow = readFlow("teach", "sign-in", sb.env);
    const secret = flow.params.filter((p) => p.sensitive);
    expect(secret).toHaveLength(1);
    expect(secret[0]).not.toHaveProperty("default");
    expect(flow.steps.map((s) => s.tool)).toEqual([
      "browser_navigate",
      "browser_type",
      "browser_type",
      "browser_press_key",
    ]);
  }, 60_000);
});
