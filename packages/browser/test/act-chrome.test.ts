import { readFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { flowsDir, readFlow } from "../src/flows.js";
import { addIdentity } from "../src/identities.js";
import { readSolves, reputationPath } from "../src/reputation.js";
import { writeIdentitySettings } from "../src/settings.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Natural language actions and captcha solving against a real Google Chrome, through the
 * server dist/ the global setup builds, with every provider faked: MCP sampling answered by
 * this test's client, a chat completions API and a solver service on 127.0.0.1, and their keys
 * in a fake `security`/`secret-tool` (never a real Keychain). Secret values are compared, never
 * printed.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const PAGE_SECRET = "Page-Secret-9!x";
const MODEL_KEY = "fake-model-key-0123456789";
const SOLVER_KEY = "fake-solver-key-0123456789";
const TOKEN = "TOKEN-abcdef-0123456789";

let sb: Sandbox;
let store: FakeSecretStore;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

const FORM = `<title>Form</title><h1>Greeter</h1>
  <label>Name <input id="name"></label>
  <label>Password <input id="pw" type="password" value="${PAGE_SECRET}"></label>
  <button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value">Greet</button>
  <p id="out"></p>
  <ul><li>Apple 1 USD</li><li>Pear 2 USD</li></ul>`;

/** A name field that counts trusted key presses, and a button a cookie banner covers. */
const COVERED = `<title>Covered</title><label>Name <input id="name"></label><p id="keys">none</p>
  <button id="save">Save</button>
  <div class="cookie-banner" role="dialog" aria-label="We use cookies" style="position:fixed;left:0;right:0;bottom:0;height:60%;background:#fff">
    <button>Accept all</button></div>
  <script>let n = 0; document.getElementById("name").addEventListener("keydown", (e) => { if (e.isTrusted) document.getElementById("keys").textContent = "keys " + ++n; });
    document.getElementById("save").style.cssText = "position:fixed;bottom:20%;left:40px";</script>`;

const CAPTCHA = `<title>Checkout</title><form id="f">
  <div class="g-recaptcha" data-sitekey="test-site-key-123" data-callback="onToken"></div>
  <textarea name="g-recaptcha-response" id="g-recaptcha-response" style="display:none"></textarea>
  <button>Pay</button></form>
  <script>window.onToken = (t) => { document.title = 'solved ' + t.length; };</script>`;

interface Web {
  url: string;
  llm: { auth: string[]; prompts: string[] };
  solver: { bodies: Record<string, unknown>[] };
  close(): Promise<void>;
}

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

/** The fixture pages, a fake chat completions API and a fake solver, all on 127.0.0.1. */
async function web(llmReply: (prompt: string) => string): Promise<Web> {
  const llm = { auth: [] as string[], prompts: [] as string[] };
  const solver = { bodies: [] as Record<string, unknown>[] };
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/llm/v1/chat/completions") {
      const json = JSON.parse(await body(req)) as { messages: { content: string }[] };
      llm.auth.push(String(req.headers.authorization));
      const prompt = json.messages.map((m) => m.content).join("\n");
      llm.prompts.push(prompt);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: llmReply(prompt) } }],
          usage: { prompt_tokens: 900, completion_tokens: 40 },
        }),
      );
      return;
    }
    if (path.startsWith("/solver/")) {
      solver.bodies.push(JSON.parse(await body(req)) as Record<string, unknown>);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          path.endsWith("/createTask")
            ? { errorId: 0, taskId: 7 }
            : { errorId: 0, status: "ready", solution: { gRecaptchaResponse: TOKEN } },
        ),
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      path === "/form" ? FORM : path === "/captcha" ? CAPTCHA : path === "/covered" ? COVERED : "<title>404</title>",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, llm, solver, close: () => new Promise((r) => server.close(() => r())) };
}

async function start(id: string, sampling?: (prompt: string) => string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client(
    { name: "act-chrome", version: "0.0.0" },
    { capabilities: sampling ? { sampling: {} } : {} },
  );
  if (sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const prompt = [
        request.params.systemPrompt ?? "",
        ...request.params.messages.map((m) => (m.content as { text?: string }).text ?? ""),
      ].join("\n");
      return { role: "assistant", model: "test-client-model", content: { type: "text", text: sampling(prompt) } };
    });
  }
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(prompt: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(prompt);
  if (!m) throw new Error(`no ${role} "${name}" in the prompt`);
  return m[1]!;
}

/** A model that greets Ada: types the name, tries the password field (refused), clicks, done. */
function greeter(): { reply: (prompt: string) => string; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    reply(prompt) {
      prompts.push(prompt);
      const steps = (prompt.match(/^\d+\. /gm) ?? []).length;
      const at = (tool: string, args: Record<string, unknown>) =>
        JSON.stringify({ tool, arguments: args, why: "test" });
      if (steps === 0)
        return at("browser_type", { target: ref(prompt, "textbox", "Name"), element: "Name", text: "Ada" });
      if (steps === 1)
        return at("browser_type", { target: ref(prompt, "textbox", "Password"), element: "Password", text: "guess" });
      if (steps === 2) return at("browser_click", { target: ref(prompt, "button", "Greet"), element: "Greet" });
      return JSON.stringify({ done: true, success: true, summary: "greeted Ada" });
    },
  };
}

describe.skipIf(reason !== undefined)(
  reason
    ? `natural language actions and captcha solving on real Chrome (skipped: ${reason})`
    : "natural language actions and captcha solving on real Chrome",
  () => {
    it("acts through MCP sampling, hides the page's password from the model, and records only the stock steps", async () => {
      const site = await web(() => "");
      onTestFinished(() => site.close());
      addIdentity("work", sb.env);
      writeIdentitySettings("work", { act: {} }, sb.env);
      const model = greeter();
      const client = await start("work", model.reply);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("browser_act");

      await call(client, "browser_navigate", { url: `${site.url}/form` });
      expect((await call(client, "browser_record", { action: "start", name: "greet" })).error).toBe(false);
      const instruction = "Greet Ada with the form";
      const acted = await call(client, "browser_act", { instruction });
      expect(acted.error, acted.text).toBe(false);
      expect(acted.text).toContain("Model: MCP sampling (your client's model)");
      expect(acted.text).toMatch(/1\. browser_type e\d+ \(Name\) "Ada": ok \(test\)/);
      expect(acted.text).toMatch(/2\. browser_type: refused, that field takes a password/);
      expect(acted.text).toMatch(/3\. browser_click e\d+ \(Greet\): ok/);
      expect(acted.text).toContain("Done: greeted Ada");
      const stopped = await call(client, "browser_record", { action: "stop" });
      expect(stopped.error, stopped.text).toBe(false);

      // The page did what the model chose.
      const page = await call(client, "browser_snapshot");
      expect(page.text).toContain("Hello Ada");
      // The model never saw the password the page holds.
      expect(model.prompts.length).toBe(4);
      expect(model.prompts.filter((p) => p.includes(PAGE_SECRET)).length, "page secret in a prompt").toBe(0);
      // The flow holds the stock steps, never the instruction or the page the model read.
      const file = readFileSync(join(flowsDir("work", sb.env), "greet.json"), "utf8");
      expect(readFlow("work", "greet", sb.env).steps.map((s) => s.tool)).toEqual(["browser_type", "browser_click"]);
      expect(file).not.toContain(instruction);
      expect(file).not.toContain("Current page");
      expect(file.includes(PAGE_SECRET), "page secret in the flow").toBe(false);
    }, 90_000);

    it("types its steps with humanize and hears at once which element covers a button", async () => {
      const site = await web(() => "");
      onTestFinished(() => site.close());
      addIdentity("human", sb.env);
      writeIdentitySettings("human", { act: {}, humanize: { level: "light", seed: 3 } }, sb.env);
      const prompts: string[] = [];
      // A 60 s action timeout: only the check before the call answers within the time below.
      const client = await start(
        "human",
        (prompt) => {
          prompts.push(prompt);
          const steps = (prompt.match(/^\d+\. /gm) ?? []).length;
          const at = (tool: string, args: Record<string, unknown>) =>
            JSON.stringify({ tool, arguments: args, why: "test" });
          if (steps === 0)
            return at("browser_type", { target: ref(prompt, "textbox", "Name"), element: "Name", text: "Ada" });
          if (steps === 1) return at("browser_click", { target: ref(prompt, "button", "Save"), element: "Save" });
          return JSON.stringify({ done: true, success: false, summary: "a cookie banner is in the way" });
        },
        ["--timeout-action", "60000"],
      );
      await call(client, "browser_navigate", { url: `${site.url}/covered` });
      const t0 = Date.now();
      const acted = await call(client, "browser_act", { instruction: "Save the name Ada" });
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(acted.text).toMatch(/1\. browser_type e\d+ \(Name\) "Ada": ok/);
      expect(acted.text).toMatch(/2\. browser_click e\d+ \(Save\): failed/);
      expect(acted.text).toContain('dialog "We use cookies" (div.cookie-banner) covers it');
      // The model heard which element is in the way, and the name was typed key by key.
      expect(prompts[2]).toContain('dialog "We use cookies" (div.cookie-banner) covers it');
      expect((await call(client, "browser_snapshot")).text).toContain("keys 3");
    }, 90_000);

    it("extracts data through a configured provider, its key read from the secret store and never shown", async () => {
      const site = await web(() =>
        JSON.stringify({
          data: [
            { name: "Apple", price: "1 USD" },
            { name: "Pear", price: "2 USD" },
          ],
        }),
      );
      onTestFinished(() => site.close());
      store.write("act-model", MODEL_KEY);
      addIdentity("reader", sb.env);
      writeIdentitySettings(
        "reader",
        {
          act: {
            sampling: false,
            provider: "chat-completions",
            endpoint: `${site.url}/llm/v1`,
            model: "fake-model",
            key: "keychain:act-model",
          },
        },
        sb.env,
      );
      const client = await start("reader");
      await call(client, "browser_navigate", { url: `${site.url}/form` });
      const out = await call(client, "browser_extract", { instruction: "each fruit and its price" });
      expect(out.error, out.text).toBe(false);
      expect(out.text).toMatch(/Model: chat-completions fake-model at 127\.0\.0\.1:\d+/);
      expect(out.text).toContain('"name": "Pear"');
      expect(out.text).toMatch(/### Budget\nabout 940 of 50,000 tokens/);
      expect(site.llm.auth.length).toBe(1);
      expect(site.llm.auth[0] === `Bearer ${MODEL_KEY}`, "the provider got the stored key").toBe(true);
      expect(out.text.includes(MODEL_KEY), "key in the result").toBe(false);
      expect(site.llm.prompts[0]!.includes(PAGE_SECRET), "page secret in the prompt").toBe(false);
      expect(site.llm.prompts[0]).toContain("Apple 1 USD");
    }, 90_000);

    it("solves a captcha widget through the configured solver, puts the token in the page and logs it", async () => {
      const site = await web(() => "");
      onTestFinished(() => site.close());
      store.write("captcha-solver", SOLVER_KEY);
      addIdentity("shop", sb.env);
      writeIdentitySettings(
        "shop",
        { captcha: { provider: "task-api", endpoint: `${site.url}/solver`, key: "keychain:captcha-solver" } },
        sb.env,
      );
      const client = await start("shop");
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("browser_solve_captcha");
      await call(client, "browser_navigate", { url: `${site.url}/captcha` });
      const solved = await call(client, "browser_solve_captcha");
      expect(solved.error, solved.text).toBe(false);
      expect(solved.text).toContain("Widget: reCAPTCHA v2");
      expect(solved.text).toContain("Token put into the page (1 response field); the widget's callback onToken ran.");
      expect(solved.text.includes(SOLVER_KEY), "key in the result").toBe(false);

      const value = await call(client, "browser_evaluate", {
        function: "() => document.getElementById('g-recaptcha-response').value === '" + TOKEN + "' && document.title",
      });
      expect(value.text).toContain(`solved ${TOKEN.length}`);
      const task = site.solver.bodies[0] as { clientKey: string; task: Record<string, unknown> };
      expect(task.clientKey === SOLVER_KEY, "the solver got the stored key").toBe(true);
      expect(task.task).toEqual({
        type: "RecaptchaV2TaskProxyless",
        websiteURL: `${site.url}/captcha`,
        websiteKey: "test-site-key-123",
      });

      expect(readSolves("shop", sb.env)).toEqual([
        {
          ts: expect.any(String),
          site: "127.0.0.1",
          kind: "solve",
          widget: "recaptcha",
          provider: "task-api",
          ok: true,
        },
      ]);
      const log = readFileSync(reputationPath("shop", sb.env), "utf8");
      expect(log.includes(TOKEN) || log.includes(SOLVER_KEY), "token or key in the log").toBe(false);
    }, 90_000);
  },
);
