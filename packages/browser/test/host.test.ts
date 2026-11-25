import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { BrowserContext } from "patchright-core";
import {
  type Engine,
  type IdentityRef,
  type LaunchRequest,
  type LaunchedBrowser,
  selectEngine,
  usesChromeEngine,
} from "../src/engine.js";
import { readHealth } from "../src/health.js";
import { writeIdentitySettings } from "../src/settings.js";
import { CallIdleTimer, SERVER_INFO, createHost, mergeTextParts, serve, unseenReason } from "../src/host.js";
import { SESSION_META_KEY } from "../src/session.js";
import { TURNO_TOOLS, type TurnoTool, checkTurnoTools, turnoZod } from "../src/tools.js";
import { type IdleTimerLike, type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The host in process, without a browser: the tool list, the turno tool registry, how calls
 * are routed, and which engine a config selects. A fake engine records launches and fails
 * them, so nothing here starts Chrome (the real Chrome runs are in chrome-lifecycle.test.ts).
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

async function config(options: Record<string, unknown> = {}): Promise<McpConfig> {
  return await upstream().tools.resolveCLIConfigForMCP(
    { browser: "chrome", userDataDir: `${sb.home}/profile`, ...options },
    {},
  );
}

/** A test-only turno tool: echoes its argument without the browser. */
function echoTool(): TurnoTool {
  const z = turnoZod();
  return {
    schema: {
      name: "turno_test_echo",
      title: "Echo (test)",
      description: "Returns its text argument.",
      inputSchema: z.object({ text: z.string().describe("Text to echo") }),
      type: "readOnly",
    },
    browser: false,
    async handle(ctx, params) {
      return {
        content: [
          { type: "text", text: `echo: ${String(params.text)}` },
          { type: "text", text: `client: ${ctx.clientInfo.clientName}` },
        ],
      };
    },
  };
}

function failingEngine(): Engine & { launches: LaunchRequest[] } {
  const launches: LaunchRequest[] = [];
  return {
    id: "chrome",
    launches,
    async launch(request) {
      launches.push(request);
      throw new Error("no browser in this test");
    },
  };
}

async function connect(
  cfg: McpConfig,
  turnoTools: TurnoTool[],
  engine: Engine,
  identity?: IdentityRef,
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(
    createHost({ config: cfg, cliOptions: {}, turnoTools, engine, ...(identity ? { identity } : {}) }),
    serverSide,
  );
  const client = new Client({ name: "host-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("host", () => {
  it("lists the stock tools first, then the turno tools, rendered like stock tools", async () => {
    // No default capabilities, so the list is upstream's core tools (the contract test pins the defaults).
    const client = await connect({ ...(await config()), capabilities: [] }, [echoTool()], failingEngine());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(26);
    expect(names.at(-1)).toBe("turno_test_echo");
    expect(names.slice(0, 2)).toEqual(["browser_close", "browser_resize"]);
    const echo = tools.at(-1)!;
    expect(echo.annotations).toEqual({
      title: "Echo (test)",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(echo.inputSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    });
    expect(client.getServerVersion()).toEqual(SERVER_INFO);
    await client.close();
  });

  it("calls a turno tool without launching the browser, and joins its text parts", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [echoTool()], engine);
    const res = await client.callTool({ name: "turno_test_echo", arguments: { text: "hi" } });
    expect(res).toEqual({ content: [{ type: "text", text: "echo: hi\nclient: host-test" }] });
    expect(engine.launches).toEqual([]);
    await client.close();
  });

  it("hands a turno tool the client session mcpd put in _meta, and nothing when it is missing or malformed", async () => {
    const seen: (string | undefined)[] = [];
    const z = turnoZod();
    const sessionTool: TurnoTool = {
      schema: {
        name: "turno_test_session",
        title: "Session (test)",
        description: "Reports the session.",
        inputSchema: z.object({}),
        type: "readOnly",
      },
      browser: false,
      async handle(ctx) {
        seen.push(ctx.session);
        return { content: [{ type: "text", text: `session: ${ctx.session ?? "none"}` }] };
      },
    };
    const engine = failingEngine();
    const client = await connect(await config(), [sessionTool], engine);
    const call = (meta?: Record<string, unknown>) =>
      client.callTool({ name: "turno_test_session", arguments: {}, ...(meta ? { _meta: meta } : {}) });
    expect(await call({ [SESSION_META_KEY]: "0b6f5c1e-2a43-4d4c-9b0e-5d7a1f3c2e11" })).toEqual({
      content: [{ type: "text", text: "session: 0b6f5c1e-2a43-4d4c-9b0e-5d7a1f3c2e11" }],
    });
    await call();
    await call({ [SESSION_META_KEY]: 42 });
    await call({ [SESSION_META_KEY]: "has space" });
    await call({ [SESSION_META_KEY]: "x".repeat(129) });
    expect(seen).toEqual(["0b6f5c1e-2a43-4d4c-9b0e-5d7a1f3c2e11", undefined, undefined, undefined, undefined]);
    expect(engine.launches).toEqual([]);
    await client.close();
  });

  it("rejects bad arguments of a turno tool with upstream's message", async () => {
    const client = await connect(await config(), [echoTool()], failingEngine());
    const res = await client.callTool({ name: "turno_test_echo", arguments: { text: 5 } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(
      /^### Error\nInvalid arguments for tool "turno_test_echo":\n.*expected string/s,
    );
    await client.close();
  });

  it("sends stock tools to the engine's browser, launched on demand, and reports a failed launch as a tool error", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [], engine);
    expect(engine.launches).toEqual([]);
    const res = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(res).toEqual({
      content: [{ type: "text", text: "### Error\nError: no browser in this test" }],
      isError: true,
    });
    // The next call tries again instead of keeping the failure.
    await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(engine.launches).toHaveLength(2);
    expect(engine.launches[0]).toMatchObject({
      title: "host-test",
      clientInfo: { clientName: "host-test", cwd: process.cwd() },
    });
    expect(engine.launches[1]!.title).toBe("host-test (2)");
    await client.close();
  });
});

/**
 * An engine whose browser is a fake context: one page that "shows" nothing, so a health check
 * on it fails as a signed-out page would.
 */
function signedOutEngine(): Engine & { launches: LaunchRequest[]; closed: number } {
  const engine = {
    id: "chrome" as const,
    launches: [] as LaunchRequest[],
    closed: 0,
    async launch(request: LaunchRequest): Promise<LaunchedBrowser> {
      engine.launches.push(request);
      const timeout = Object.assign(new Error("Timeout 10000ms exceeded"), { name: "TimeoutError" });
      const missing = { first: () => missing, waitFor: async () => Promise.reject(timeout) };
      const page = Object.assign(new EventEmitter(), {
        url: () => "about:blank",
        content: async () => "",
        goto: async () => null,
        getByText: () => missing,
        locator: () => missing,
        close: async () => {},
      });
      const context = Object.assign(new EventEmitter(), { pages: () => [page], newPage: async () => page });
      return {
        engine: "chrome",
        context: context as unknown as BrowserContext,
        isOpen: () => true,
        async close() {
          engine.closed++;
        },
      };
    },
  };
  return engine;
}

describe("identity", () => {
  it("passes the identity to the engine", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [], engine, { id: "school", env: sb.env });
    await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(engine.launches[0]!.identity).toEqual({ id: "school", env: sb.env });
    await client.close();
  });

  it("fails a call with NEEDS_AUTH when the health check finds no signed-in page, and closes that Chrome", async () => {
    writeIdentitySettings("school", { health: { url: "https://mail.example.com/", text: "Inbox" } }, sb.env);
    const engine = signedOutEngine();
    const client = await connect(await config(), [], engine, { id: "school", env: sb.env });
    const res = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(
      /^### Error\nError: NEEDS_AUTH: browser identity "school" is not signed in: the page did not show "Inbox" at https:\/\/mail\.example\.com\//,
    );
    expect(text).toContain("`turno-browser login school`");
    expect(engine.closed).toBe(1);
    expect(readHealth("school", sb.env)).toMatchObject({ status: "needs_auth", url: "https://mail.example.com/" });

    // Right after, calls fail the same way without opening another Chrome.
    const again = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect((again.content as { text: string }[])[0]!.text).toMatch(/NEEDS_AUTH/);
    expect(engine.launches).toHaveLength(1);
    await client.close();
  });

  it("runs no health check for an identity without one", async () => {
    const engine = failingEngine();
    const client = await connect(await config(), [], engine, { id: "plain", env: sb.env });
    const res = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect((res.content as { text: string }[])[0]!.text).toBe("### Error\nError: no browser in this test");
    expect(readHealth("plain", sb.env)).toBeUndefined();
    await client.close();
  });
});

/** An idle timer that records what the session does with it, instead of counting. */
function recordingTimer(): IdleTimerLike & { events: string[]; armed: boolean } {
  const timer = {
    events: [] as string[],
    armed: false,
    poke() {
      timer.events.push("poke");
      timer.armed = true;
    },
    dispose() {
      timer.events.push("dispose");
      timer.armed = false;
    },
  };
  return timer;
}

/** An engine whose fake browser has one blank page and the given idle timer. */
function idleEngine(idleTimer: IdleTimerLike): Engine {
  return {
    id: "chrome",
    async launch(): Promise<LaunchedBrowser> {
      const page = Object.assign(new EventEmitter(), {
        url: () => "about:blank",
        isClosed: () => false,
        close: async () => {},
      });
      const context = Object.assign(new EventEmitter(), {
        pages: () => [page],
        newPage: async () => page,
        browser: () => null,
      });
      return {
        engine: "chrome",
        context: context as unknown as BrowserContext,
        isOpen: () => true,
        idleTimer,
        async close() {},
      };
    },
  };
}

describe("a person step on a headless Chrome", () => {
  it("starts only while the live view has a viewer, and otherwise says how to open one", () => {
    expect(unseenReason({ viewerCount: 1 }, "work")).toBeUndefined();
    expect(unseenReason({ viewerCount: 0 }, "work")).toContain("`turno-browser live work`");
    expect(unseenReason(undefined, "work")).toContain("`turno-browser set work --live true`");
    expect(unseenReason(undefined, undefined)).toContain("without --headless");
  });
});

describe("idle limit", () => {
  it("does not count while a call runs, and counts again from the end of the last call", async () => {
    const timer = recordingTimer();
    let release!: () => void;
    const seen: boolean[] = [];
    const z = turnoZod();
    const slow: TurnoTool = {
      schema: {
        name: "turno_test_slow",
        title: "Slow (test)",
        description: "Waits until the test releases it.",
        inputSchema: z.object({}),
        type: "readOnly",
      },
      async handle() {
        seen.push(timer.armed);
        await new Promise<void>((r) => {
          release = r;
        });
        seen.push(timer.armed);
        return { content: [{ type: "text", text: "done" }] };
      },
    };
    const client = await connect(await config(), [slow], idleEngine(timer));
    const call = client.callTool({ name: "turno_test_slow", arguments: {} });
    await vi.waitFor(() => expect(release).toBeDefined());
    // A call longer than the idle limit must not have Chrome closed under it.
    expect(timer.armed).toBe(false);
    release();
    expect(await call).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(seen).toEqual([false, false]);
    expect(timer.armed).toBe(true);
    expect(timer.events.at(-1)).toBe("poke");
    await client.close();
  });

  it("keeps counting stopped until the last of two overlapping calls ends", () => {
    const inner = recordingTimer();
    const timer = new CallIdleTimer(inner, () => true);
    const a = timer.begin();
    const b = timer.begin();
    timer.poke(); // upstream pokes at the start of each call
    expect(inner.armed).toBe(false);
    a();
    expect(inner.armed).toBe(false);
    b();
    expect(inner.armed).toBe(true);
    b(); // ending twice changes nothing
    inner.dispose();
    timer.poke();
    expect(inner.armed).toBe(true);
  });

  it("does not start counting again for a browser that already closed", () => {
    const inner = recordingTimer();
    let open = true;
    const timer = new CallIdleTimer(inner, () => open);
    const end = timer.begin();
    open = false;
    end();
    expect(inner.armed).toBe(false);
    timer.poke();
    expect(inner.armed).toBe(false);
  });
});

describe("turno tool registry", () => {
  const stock = () => upstream().tools.browserTools;

  it("ships browser_batch, browser_login, the flow tools and browser_request_human, after the stock tools", () => {
    const names = [
      "browser_batch",
      "browser_login",
      "browser_record",
      "browser_replay",
      "browser_flows",
      "browser_request_human",
    ];
    expect(TURNO_TOOLS.map((t) => t.schema.name)).toEqual(names);
    const host = createHost({
      config: { server: {}, browser: { browserName: "chromium", launchOptions: {} } } as McpConfig,
      cliOptions: {},
    });
    expect(
      host
        .listTools()
        .slice(-names.length)
        .map((t) => t.name),
    ).toEqual(names);
  });

  it("refuses a turno tool with the name of any upstream tool, a duplicate or a bad name", () => {
    const named = (name: string): TurnoTool => ({ ...echoTool(), schema: { ...echoTool().schema, name } });
    expect(() => checkTurnoTools([named("browser_snapshot")], stock())).toThrow(/name of a Playwright MCP tool/);
    // Capability-gated tools count too, enabled or not.
    expect(() => checkTurnoTools([named("browser_pdf_save")], stock())).toThrow(/name of a Playwright MCP tool/);
    expect(() => checkTurnoTools([named("turno_x"), named("turno_x")], stock())).toThrow(/twice/);
    expect(() => checkTurnoTools([named("Turno-X")], stock())).toThrow(/must match/);
    expect(() => checkTurnoTools([echoTool()], stock())).not.toThrow();
  });

  it("is checked when the host starts", async () => {
    const clash: TurnoTool = { ...echoTool(), schema: { ...echoTool().schema, name: "browser_navigate" } };
    expect(() => createHost({ config: { server: {} } as McpConfig, cliOptions: {}, turnoTools: [clash] })).toThrow(
      /name of a Playwright MCP tool/,
    );
  });
});

describe("engine selection", () => {
  it("launches the default persistent Chrome itself and hands every other mode to upstream", async () => {
    const fallback = failingEngine();
    fallback.id = "upstream";
    expect(usesChromeEngine(await config())).toBe(true);
    expect(selectEngine(await config(), fallback).id).toBe("chrome");
    for (const options of [
      { isolated: true, userDataDir: undefined },
      { cdpEndpoint: "http://127.0.0.1:9222" },
      { extension: true },
      { sharedBrowserContext: true },
      { browser: "firefox" },
      { userDataDir: undefined },
    ]) {
      const cfg = await config(options);
      expect(selectEngine(cfg, fallback).id, JSON.stringify(options)).toBe("upstream");
    }
  });
});

describe("mergeTextParts", () => {
  it("joins runs of text parts and keeps other parts in place, like upstream", () => {
    const image = { type: "image", data: "AA", mimeType: "image/png" };
    expect(
      mergeTextParts({
        content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, image, { type: "text", text: "c" }],
        isError: false,
      }),
    ).toEqual({ content: [{ type: "text", text: "a\nb" }, image, { type: "text", text: "c" }], isError: false });
  });
});
