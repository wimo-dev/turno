import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACT_TOOLS, actTool, checkCall, extractTool, observeTool, parseJsonReply } from "../src/act.js";
import type { ActModel, ModelRequest } from "../src/act-model.js";
import { Redactor, VaultGuard } from "../src/redact.js";
import { writeIdentitySettings } from "../src/settings.js";
import { type StockAccess, type TurnoTool, parseArguments } from "../src/tools.js";
import { type McpConfig, type ToolResult, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * browser_act, browser_extract and browser_observe with fake stock tools and a scripted fake
 * model: the steps they take, what they refuse, their budgets, and that nothing hidden reaches
 * the model. The real Chrome runs are in act-chrome.test.ts.
 */

const VAULT_USER = "alice-vault-user@example.com";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  vi.useRealTimers();
  sb.cleanup();
});

const SNAPSHOT = [
  "### Page",
  "- Page URL: http://127.0.0.1/form",
  "- Page Title: Form",
  "### Snapshot",
  "```yaml",
  `- textbox "Email" [ref=e2]: ${VAULT_USER}`,
  '- button "Go" [ref=e3]',
  "```",
].join("\n");

function fakeStock(snapshot = SNAPSHOT, answers: Record<string, (a: Record<string, unknown>) => ToolResult> = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const schemas = new Map(upstream().tools.browserTools.map((t) => [t.schema.name, t.schema.inputSchema]));
  const stock: StockAccess = {
    schemas,
    formatError: (e) => upstream().utils.z.prettifyError(e),
    async call(name, args) {
      calls.push({ name, args });
      if (answers[name]) return answers[name](args);
      if (name === "browser_snapshot") return { content: [{ type: "text", text: snapshot }] };
      return { content: [{ type: "text", text: "### Result\nDone" }] };
    },
    page: async () => ({ url: "http://127.0.0.1/form", title: "Form" }),
    currentPage: () => undefined,
  };
  return { stock, calls };
}

/** A model that answers from a script, one reply per call, and keeps every request. */
function scripted(
  replies: (string | ((r: ModelRequest) => Promise<string> | string))[],
  usage?: { input: number; output: number },
) {
  const requests: ModelRequest[] = [];
  const model: ActModel = {
    label: "fake model",
    async complete(request) {
      requests.push(request);
      const next = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      const text = typeof next === "function" ? await next(request) : next;
      return { text, ...(usage ? { usage } : {}) };
    },
  };
  return { model, requests };
}

function ctx(stock: StockAccess, model: ActModel, redactor = new Redactor()) {
  return {
    config: {} as McpConfig,
    clientInfo: { cwd: "/", clientName: "t" },
    stock,
    vault: { identity: { id: "work", env: sb.env }, redactor, guard: new VaultGuard() },
    providers: { model },
  };
}

async function run(tool: TurnoTool, c: ReturnType<typeof ctx>, params: Record<string, unknown>) {
  const parsed = parseArguments(tool, params);
  if ("error" in parsed) throw new Error(parsed.error);
  const res = await tool.handle(c, parsed.params);
  return { text: (res.content[0] as { text: string }).text, isError: !!res.isError };
}

const step = (tool: string, args: Record<string, unknown>, why = "next") =>
  JSON.stringify({ tool, arguments: args, why });
const DONE = JSON.stringify({ done: true, success: true, summary: "clicked Go" });

describe("browser_act", () => {
  beforeEach(() => {
    writeIdentitySettings("work", { act: {} }, sb.env);
  });

  it("runs the model's stock calls one by one until it is done, and lists every step", async () => {
    const { stock, calls } = fakeStock();
    const { model } = scripted([step("browser_click", { target: "e3", element: "Go" }, "submit the form"), DONE]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "press Go" });
    expect(r.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["browser_snapshot", "browser_click", "browser_snapshot"]);
    expect(r.text).toContain(
      "### Act\nModel: fake model\n1. browser_click e3 (Go): ok (submit the form)\nDone: clicked Go",
    );
    expect(r.text).toMatch(/### Budget\n1 of 10 steps, about [\d,]+ of 50,000 tokens, [\d.]+ s of 120 s/);
    expect(r.text).toContain("- Page URL: http://127.0.0.1/form");
  });

  it("never shows the model a vault value, and refuses an instruction that holds one", async () => {
    const redactor = new Redactor();
    redactor.add(VAULT_USER, "username of mail");
    const { stock } = fakeStock();
    const { model, requests } = scripted([DONE]);
    await run(actTool(), ctx(stock, model, redactor), { instruction: "press Go" });
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain(VAULT_USER);
    expect(sent).toContain("[vault: username of mail]");

    const refused = await run(actTool(), ctx(stock, model, redactor), { instruction: `type ${VAULT_USER} in Email` });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/holds a value this server hides/);
    expect(requests).toHaveLength(1);
  });

  it("refuses tools outside its set and stops after three refusals in a row", async () => {
    const { stock, calls } = fakeStock();
    const { model } = scripted([
      step("browser_navigate", { url: "https://elsewhere.example/?q=data" }),
      step("browser_evaluate", { function: "() => document.cookie" }),
      step("browser_click", { nope: true }),
    ]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "do it" });
    expect(r.isError).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["browser_snapshot", "browser_snapshot", "browser_snapshot"]);
    expect(r.text).toContain("1. browser_navigate: refused, browser_navigate is not one of the tools");
    expect(r.text).toContain("2. browser_evaluate: refused");
    expect(r.text).toMatch(/3\. browser_click: refused, invalid arguments for browser_click/);
    expect(r.text).toContain("Stopped: 3 steps in a row failed or were refused.");
  });

  it("tells the model about a failed step and lets it recover", async () => {
    const { stock } = fakeStock(SNAPSHOT, {
      browser_click: (a) =>
        a.target === "e9"
          ? { content: [{ type: "text", text: "### Error\nRef e9 not found" }], isError: true }
          : { content: [{ type: "text", text: "### Result\nok" }] },
    });
    const { model, requests } = scripted([
      step("browser_click", { target: "e9" }),
      step("browser_click", { target: "e3" }),
      DONE,
    ]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "press Go" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("1. browser_click e9: failed (next)\n   Ref e9 not found");
    expect(r.text).toContain("2. browser_click e3: ok");
    expect(requests[1]!.messages[0]!.text).toContain("1. browser_click e9: failed: Ref e9 not found");
  });

  it("asks again after a reply that is not JSON", async () => {
    const { stock } = fakeStock();
    const { model } = scripted(["I would click Go.", DONE]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "press Go" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("- the model's reply was not a JSON object; asked again");
  });

  it("stops at the step limit, the identity's or the call's, whichever is lower", async () => {
    writeIdentitySettings("work", { act: { maxSteps: 3 } }, sb.env);
    const { stock } = fakeStock();
    const { model } = scripted([step("browser_press_key", { key: "Tab" })]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "tab around" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Stopped: the step limit (3) was reached before the model was done.");
    const lower = await run(actTool(), ctx(fakeStock().stock, model), { instruction: "tab", maxSteps: 1 });
    expect(lower.text).toContain("the step limit (1)");
    const higher = await run(actTool(), ctx(fakeStock().stock, model), { instruction: "tab", maxSteps: 50 });
    expect(higher.text).toContain("the step limit (3)");
  });

  it("stops before a model call would pass the token budget", async () => {
    writeIdentitySettings("work", { act: { maxTokens: 2_000 } }, sb.env);
    const { stock } = fakeStock();
    const { model, requests } = scripted([step("browser_press_key", { key: "Tab" })], { input: 1_800, output: 100 });
    const r = await run(actTool(), ctx(stock, model), { instruction: "tab" });
    expect(r.isError).toBe(true);
    expect(requests).toHaveLength(1);
    expect(r.text).toMatch(/Stopped: the token budget \(2,000\) would be passed/);
  });

  it("stops at the time limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    writeIdentitySettings("work", { act: { timeout: "10s" } }, sb.env);
    const { stock } = fakeStock();
    const model: ActModel = {
      label: "slow",
      complete: (request) =>
        new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const pending = run(actTool(), ctx(stock, model), { instruction: "wait" });
    await vi.advanceTimersByTimeAsync(10_001);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Stopped: the time limit (10 s) was reached.");
  });

  it("stops at its next step once the user pauses the agent in the live view", async () => {
    const { stock, calls } = fakeStock();
    let paused = false;
    stock.held = () => (paused ? "The user paused the browser" : undefined);
    const { model } = scripted([
      () => {
        paused = true; // the user pauses while the model thinks about the second step
        return step("browser_click", { target: "e3", element: "Go" });
      },
      DONE,
    ]);
    const r = await run(actTool(), ctx(stock, model), { instruction: "press Go" });
    expect(r.isError).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["browser_snapshot"]);
    expect(r.text).toContain("1. browser_click e3 (Go): not run");
    expect(r.text).toContain("Stopped: The user paused the browser; this step and the ones after it were not run.");

    const held = fakeStock();
    held.stock.held = () => "The user paused the browser";
    const first = await run(actTool(), ctx(held.stock, scripted([DONE]).model), { instruction: "press Go" });
    expect(held.calls).toEqual([]);
    expect(first.text).toContain("Stopped: The user paused the browser; no further step was run.");
  });
});

describe("browser_extract", () => {
  beforeEach(() => {
    writeIdentitySettings("work", { act: {} }, sb.env);
  });

  it("takes one snapshot, asks once, and returns the data as JSON", async () => {
    const { stock, calls } = fakeStock();
    const { model, requests } = scripted(['```json\n{"data": {"button": "Go"}}\n```']);
    const r = await run(extractTool(), ctx(stock, model), {
      instruction: "the button's label",
      schema: { type: "object", properties: { button: { type: "string" } } },
    });
    expect(r.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["browser_snapshot"]);
    expect(r.text).toMatch(
      /1\. browser_snapshot: ok \([\d,]+ characters sent to the model, sensitive values hidden\)\n2\. model: ok/,
    );
    expect(r.text).toContain('### Data\n{\n  "button": "Go"\n}');
    expect(requests[0]!.messages[0]!.text).toContain('Shape the data to this JSON schema:\n{"type":"object"');
  });

  it("says so when the data is not on the page", async () => {
    const { model } = scripted(['{"data": null, "reason": "no price shown"}']);
    const r = await run(extractTool(), ctx(fakeStock().stock, model), { instruction: "the price" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Nothing extracted: the model did not find it on the page: no price shown.");
  });
});

describe("browser_observe", () => {
  beforeEach(() => {
    writeIdentitySettings("work", { act: {} }, sb.env);
  });

  it("proposes checked calls without running any", async () => {
    const { stock, calls } = fakeStock();
    const { model } = scripted([
      JSON.stringify({
        actions: [
          { tool: "browser_click", arguments: { target: "e3", element: "Go" }, description: "Press Go" },
          { tool: "browser_run_code_unsafe", arguments: { code: "x" }, description: "bad" },
        ],
      }),
    ]);
    const r = await run(observeTool(), ctx(stock, model), { instruction: "submit" });
    expect(r.isError).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["browser_snapshot"]);
    expect(r.text).toContain('1. Press Go\n   {"tool":"browser_click","arguments":{"target":"e3","element":"Go"}}');
    expect(r.text).toMatch(/Left out:\n- browser_run_code_unsafe is not one of the tools/);
    expect(r.text).toContain("Nothing ran");
  });
});

describe("the reply and call checks", () => {
  it("reads the first JSON object of a reply", () => {
    expect(parseJsonReply('Sure.\n```json\n{"done": true}\n```')).toEqual({ done: true });
    expect(parseJsonReply("[1,2]")).toBeUndefined();
    expect(parseJsonReply("no json")).toBeUndefined();
  });

  it("allows only input on the current tab, with the tool's own schema", () => {
    const { stock } = fakeStock();
    expect(ACT_TOOLS).not.toContain("browser_navigate");
    expect(ACT_TOOLS).not.toContain("browser_evaluate");
    expect(ACT_TOOLS).not.toContain("browser_tabs");
    expect(checkCall(stock, "browser_type", { target: "e2", text: "hi" })).toEqual({
      tool: "browser_type",
      arguments: { target: "e2", text: "hi" },
    });
    expect(checkCall(stock, "browser_tabs", { action: "new" })).toMatchObject({
      error: expect.stringMatching(/not one of/),
    });
    expect(checkCall(stock, 7, {})).toEqual({ error: "the reply names no tool" });
  });
});
