import { describe, expect, it } from "vitest";
import type { Page } from "patchright-core";
import { MAX_BATCH, batchTool, errorCode } from "../src/batch.js";
import { type Diagnosis, failureMessage } from "../src/diagnose.js";
import { configForSession } from "../src/host.js";
import { sensitiveRefusal } from "../src/sensitive.js";
import { type StockAccess, parseArguments } from "../src/tools.js";
import { resolveTuning } from "../src/tuning.js";
import { type McpConfig, type ToolResult, upstream } from "../src/upstream.js";

/** Stock tools that answer like upstream, recording each call. */
function fakeStock(answers: Record<string, (args: Record<string, unknown>) => ToolResult> = {}) {
  const calls: { name: string; args: Record<string, unknown>; snapshot: boolean }[] = [];
  const schemas = new Map(upstream().tools.browserTools.map((t) => [t.schema.name, t.schema.inputSchema]));
  const stock: StockAccess = {
    schemas,
    formatError: (e) => upstream().utils.z.prettifyError(e),
    async call(name, args, { snapshot }) {
      calls.push({ name, args, snapshot });
      const answer = answers[name];
      if (answer) return answer(args);
      return {
        content: [
          {
            type: "text",
            text: `### Ran Playwright code\n\`\`\`js\nawait page.x();\n\`\`\`${snapshot ? "\n### Snapshot\n- big tree" : ""}`,
          },
        ],
      };
    },
    page: async () => ({ url: "http://127.0.0.1/form", title: "Sign up" }),
    currentPage: () => undefined,
  };
  return { stock, calls };
}

async function run(stock: StockAccess, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = batchTool();
  const parsed = parseArguments(tool, params);
  if ("error" in parsed) return { text: parsed.error, isError: true };
  const res = await tool.handle(
    { config: {} as McpConfig, clientInfo: { cwd: "/", clientName: "t" }, stock },
    parsed.params,
  );
  return { text: res.content.map((c) => (c as { text?: string }).text ?? "").join("\n"), isError: !!res.isError };
}

describe("browser_batch", () => {
  it("runs each action without its snapshot and returns one line per action and the page", async () => {
    const { stock, calls } = fakeStock();
    const res = await run(stock, {
      actions: [
        { tool: "browser_type", arguments: { target: "e3", text: "Alice" } },
        { tool: "browser_click", arguments: { target: "e7" } },
      ],
    });
    expect(res.isError).toBe(false);
    expect(calls.map((c) => [c.name, c.snapshot])).toEqual([
      ["browser_type", false],
      ["browser_click", false],
    ]);
    expect(res.text).toContain("### Batch\n1. browser_type e3: ok\n2. browser_click e7: ok");
    expect(res.text).toContain("### Page\n- Page URL: http://127.0.0.1/form\n- Page Title: Sign up");
    expect(res.text).not.toContain("big tree");
  });

  it("takes one snapshot after the last action when asked", async () => {
    const { stock, calls } = fakeStock({
      browser_snapshot: () => ({
        content: [
          { type: "text", text: '### Page\n- Page URL: u\n### Snapshot\n```yaml\n- button "Save" [ref=e2]\n```' },
        ],
      }),
    });
    const res = await run(stock, { actions: [{ tool: "browser_click", arguments: { target: "e7" } }], snapshot: true });
    expect(calls.map((c) => c.name)).toEqual(["browser_click", "browser_snapshot"]);
    expect(calls[1]!.snapshot).toBe(true);
    expect(res.text).toContain('### Snapshot\n```yaml\n- button "Save" [ref=e2]');
  });

  it("stops at the first failure with its code, says which actions did not run, and returns the page", async () => {
    const save = { role: "button", name: "Save", selector: "#save" };
    const covered = failureMessage(
      "browser_click",
      "e7",
      {
        state: "covered",
        target: save,
        cover: { role: "dialog", name: "Cookies", selector: "#cookies" },
        buttons: ["Accept"],
      },
      "Timeout 5000ms exceeded.",
    );
    const { stock, calls } = fakeStock({
      browser_click: () => ({ content: [{ type: "text", text: `### Error\n${covered}` }], isError: true }),
      browser_snapshot: () => ({
        content: [
          { type: "text", text: '### Page\n- Page URL: u\n### Snapshot\n```yaml\n- dialog "Cookies" [ref=e9]\n```' },
        ],
      }),
    });
    const res = await run(stock, {
      actions: [
        { tool: "browser_type", arguments: { target: "e3", text: "Alice" } },
        { tool: "browser_click", arguments: { target: "e7" } },
        { tool: "browser_press_key", arguments: { key: "Enter" } },
        { tool: "browser_press_key", arguments: { key: "Tab" } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["browser_type", "browser_click", "browser_snapshot"]);
    expect(res.text).toMatch(
      /^### Error\nAction 2 of 4 \(browser_click e7\) failed; the last 2 actions did not run\.\nELEMENT_COVERED: Could not click button "Save"/,
    );
    expect(res.text).toContain("1. browser_type e3: ok\n2. browser_click e7: failed (ELEMENT_COVERED)");
    expect(res.text).toContain('### Snapshot\n```yaml\n- dialog "Cookies" [ref=e9]');
  });

  it("gives each failure a stable code", () => {
    const target = { role: "button", name: "Save", selector: "#save" };
    const diagnosed = (d: Diagnosis | undefined) =>
      failureMessage("browser_click", "e7", d, "Timeout 5000ms exceeded.");
    expect(errorCode(diagnosed(undefined))).toBe("ELEMENT_GONE");
    expect(errorCode(diagnosed({ state: "covered", target, cover: target, buttons: [] }))).toBe("ELEMENT_COVERED");
    expect(errorCode(diagnosed({ state: "ok", target }))).toBe("ELEMENT_NOT_STABLE");
    expect(errorCode("Ref e7 not found in the current page snapshot. Try capturing new snapshot.")).toBe(
      "ELEMENT_GONE",
    );
    expect(errorCode('Error: "#nope" does not match any elements.')).toBe("ELEMENT_GONE");
    expect(errorCode("TimeoutError: Timeout 5000ms exceeded.")).toBe("TIMEOUT");
    expect(errorCode(sensitiveRefusal("browser_type", "password"))).toBe("REFUSED");
    expect(errorCode("net::ERR_NAME_NOT_RESOLVED")).toBe("ERROR");
  });

  it("checks what an action must leave on the page, waiting for it, and stops at a check that fails", async () => {
    let looks = 0;
    const page = (yaml: string) => ({
      content: [
        {
          type: "text" as const,
          text: `### Page\n- Page URL: http://127.0.0.1/done\n### Snapshot\n\`\`\`yaml\n${yaml}\n\`\`\``,
        },
      ],
    });
    const { stock, calls } = fakeStock({
      // The confirmation shows on the fourth look: the last check waits for it.
      browser_snapshot: () =>
        page(['- textbox "Name" [ref=e3]: Alic', ...(++looks >= 4 ? ['- status: "Saved: Alice"'] : [])].join("\n")),
    });
    // What the fields hold, as the page reads them.
    const held: Record<string, string> = { e3: "Alic", e4: "Pro", e5: "true" };
    const field = (target: string) => ({
      first: () => ({
        evaluate: async () => {
          if (!(target in held)) throw new Error("no element");
          return held[target];
        },
      }),
    });
    stock.currentPage = () => ({ getByRef: field, locator: field }) as unknown as Page;
    const ok = await run(stock, {
      actions: [
        { tool: "browser_select_option", arguments: { target: "e4", values: ["Pro"] }, expect: { value: "Pro" } },
        { tool: "browser_click", arguments: { target: "e5" }, expect: { value: "true", url: "/done" } },
        { tool: "browser_click", arguments: { target: "e6" }, expect: { text: "Saved: Alice", gone: "Error" } },
      ],
    });
    expect(ok.isError).toBe(false);
    expect(looks).toBe(4);

    calls.length = 0;
    const res = await run(stock, {
      actions: [
        { tool: "browser_type", arguments: { target: "e3", text: "Alice" }, expect: { value: "Alice", timeout: 0 } },
        { tool: "browser_click", arguments: { target: "e6" } },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["browser_type", "browser_snapshot", "browser_snapshot"]);
    expect(res.text).toMatch(
      /^### Error\nAction 1 of 2 \(browser_type e3\) ran, but its check failed; the last action did not run\.\nCHECK_FAILED: after 0 ms e3 holds "Alic", not "Alice"\./,
    );
    expect(res.text).toContain("1. browser_type e3: ran, check failed (CHECK_FAILED)");
    expect(res.text).toContain('### Snapshot\n```yaml\n- textbox "Name" [ref=e3]: Alic');
  });

  it("checks every action before running any", async () => {
    const { stock, calls } = fakeStock();
    const res = await run(stock, {
      actions: [
        { tool: "browser_click", arguments: { target: "e7" } },
        { tool: "browser_clik", arguments: {} },
        { tool: "browser_type", arguments: { target: "e3" } },
        { tool: "browser_batch", arguments: {} },
      ],
    });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(res.text).toContain("INVALID_ACTION: nothing ran.");
    expect(res.text).toContain('action 2: "browser_clik" is not a browser tool of this server');
    expect(res.text).toMatch(/action 3 \(browser_type\): invalid arguments: .*text/s);
    expect(res.text).toContain("(a batch cannot hold a batch)");
  });

  it("keeps the tab governor's notes and a dialog the page opened", async () => {
    const { stock } = fakeStock({
      browser_click: () => ({
        content: [
          {
            type: "text",
            text: '### Modal state\n- ["alert" dialog with message "Saved"]: can be handled by browser_handle_dialog\n### Tab governor\n- closed a popup',
          },
        ],
      }),
    });
    const res = await run(stock, { actions: [{ tool: "browser_click", arguments: { target: "e7" } }] });
    expect(res.text).toContain('1. browser_click e7: ok\n   - ["alert" dialog with message "Saved"]');
    expect(res.text).toMatch(/### Tab governor\n- closed a popup$/);
  });

  it(`takes 1 to ${MAX_BATCH} actions`, async () => {
    const { stock } = fakeStock();
    expect((await run(stock, { actions: [] })).text).toMatch(/Invalid arguments for tool "browser_batch"/);
    const many = Array.from({ length: MAX_BATCH + 1 }, () => ({
      tool: "browser_press_key",
      arguments: { key: "Tab" },
    }));
    expect((await run(stock, { actions: many })).text).toMatch(/Invalid arguments for tool "browser_batch"/);
  });
});

describe("configForSession", () => {
  const base = () =>
    ({
      server: {},
      browser: { browserName: "chromium", launchOptions: {} },
      timeouts: { idle: 1000, settle: 500 },
      snapshot: { mode: "full" },
    }) as unknown as McpConfig;

  it("is a copy, with the identity's settle", () => {
    const config = base();
    const session = configForSession(config, {}, resolveTuning({ settle: "100ms" } as never));
    expect(session.timeouts).toEqual({ idle: 1000, settle: 100 });
    session.snapshot!.mode = "none";
    expect(config.snapshot!.mode).toBe("full");
    expect(config.timeouts!.settle).toBe(500);
  });

  it("leaves Playwright's settle when identity.json has none or the user set --timeout-settle", () => {
    expect(configForSession(base(), {}, resolveTuning(undefined)).timeouts!.settle).toBe(500);
    expect(
      configForSession(base(), { timeoutSettle: 900 }, resolveTuning({ settle: "100ms" } as never)).timeouts!.settle,
    ).toBe(500);
  });
});
