import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type IdentityRef } from "../src/engine.js";
import type { ActFallback } from "../src/act-chain.js";
import { createHost, serve } from "../src/host.js";
import { writeIdentitySettings } from "../src/settings.js";
import { TURNO_TOOLS, type TurnoTool, allOptInTools, checkTurnoTools, turnoZod } from "../src/tools.js";
import { type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { TOOL_NAMES } from "./helpers/upstream-tools.js";

/**
 * The opt-in tools in the host, without a browser: listed only when identity.json turns them
 * on, refused in read mode before anything starts, and MCP sampling handed to them only when the
 * client offers it, routed back through the call that asked.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const NONE: ActFallback = { kind: "none", reason: "nothing in this test" };
const CLI: ActFallback = { kind: "cli", clis: [{ cli: "claude", command: "/usr/local/bin/claude" }] };

const SOLVER = { provider: "task-api" as const, endpoint: "https://solver.example.com", key: "keychain:solver" };

async function config(): Promise<McpConfig> {
  return await upstream().tools.resolveCLIConfigForMCP(
    { browser: "chrome", userDataDir: `${sb.home}/profile`, headless: true },
    {},
  );
}

const noBrowser: Engine = {
  id: "chrome",
  async launch() {
    throw new Error("no browser in this test");
  },
};

async function connect(options: {
  identity?: IdentityRef;
  turnoTools?: TurnoTool[];
  engine?: Engine;
  sampling?: (text: string, meta: unknown) => string;
  actFallback?: ActFallback;
}): Promise<Client> {
  // No default capabilities: these tests count upstream's core tools and the opt-in ones.
  const cfg = { ...(await config()), capabilities: [] };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(
    createHost({
      config: cfg,
      cliOptions: {},
      engine: options.engine ?? noBrowser,
      ...(options.turnoTools ? { turnoTools: options.turnoTools } : {}),
      ...(options.identity ? { identity: options.identity } : {}),
      providers: { actFallback: options.actFallback ?? NONE },
    }),
    serverSide,
  );
  const client = new Client(
    { name: "opt-in-test", version: "0.0.0" },
    { capabilities: options.sampling ? { sampling: {} } : {} },
  );
  if (options.sampling) {
    const answer = options.sampling;
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const first = request.params.messages[0]?.content as { text?: string };
      return {
        role: "assistant",
        model: "client-model",
        content: { type: "text", text: answer(first.text ?? "", request.params._meta) },
      };
    });
  }
  await client.connect(clientSide);
  return client;
}

/** The stock tools and the turno tools: what every identity lists before its opt-in tools. */
const LISTED = TOOL_NAMES.length + TURNO_TOOLS.length;

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe("opt-in tools in the host", () => {
  it("list natural language actions per connection: with the client's sampling, or with a model in the environment", async () => {
    writeIdentitySettings("work", { region: "MX" }, sb.env);
    const identity = { id: "work", env: sb.env };
    const act = ["browser_act", "browser_extract", "browser_observe"];
    expect((await names(await connect({ identity }))).slice(LISTED)).toEqual([]);
    expect((await names(await connect({ identity, sampling: () => "{}" }))).slice(LISTED)).toEqual(act);
    expect((await names(await connect({ identity, actFallback: CLI }))).slice(LISTED)).toEqual(act);
    expect((await names(await connect({ actFallback: CLI }))).slice(LISTED)).toEqual([]);
  });

  it("list captcha solving only with a solver key, from identity.json or the environment", async () => {
    writeIdentitySettings("shop", { region: "MX" }, sb.env);
    const env = { ...sb.env, TURNO_BROWSER_CAPTCHA_ENDPOINT: "https://solver.example.com" };
    expect(await names(await connect({ identity: { id: "shop", env } }))).not.toContain("browser_solve_captcha");
    const withKey = { ...env, TURNO_BROWSER_CAPTCHA_KEY: "solver-key-0123456789" };
    expect((await names(await connect({ identity: { id: "shop", env: withKey } }))).slice(LISTED)).toEqual([
      "browser_solve_captcha",
    ]);
  });

  it("are not listed by default, nor for an identity that does not turn them on", async () => {
    const plain = await connect({});
    expect(await names(plain)).toHaveLength(LISTED);
    writeIdentitySettings("work", { region: "MX" }, sb.env);
    const identity = await connect({ identity: { id: "work", env: sb.env } });
    const listed = await names(identity);
    expect(listed).toHaveLength(LISTED);
    for (const t of ["browser_act", "browser_extract", "browser_observe", "browser_solve_captcha"])
      expect(listed).not.toContain(t);
  });

  it("are listed after the turno tools when identity.json names a provider and a solver", async () => {
    const act = { provider: "chat-completions" as const, endpoint: "https://models.example.com/v1", model: "m" };
    writeIdentitySettings("work", { act }, sb.env);
    expect((await names(await connect({ identity: { id: "work", env: sb.env } }))).slice(LISTED)).toEqual([
      "browser_act",
      "browser_extract",
      "browser_observe",
    ]);
    writeIdentitySettings("work", { captcha: SOLVER }, sb.env);
    expect((await names(await connect({ identity: { id: "work", env: sb.env } }))).slice(LISTED)).toEqual([
      "browser_act",
      "browser_extract",
      "browser_observe",
      "browser_solve_captcha",
    ]);
  });

  it("never take a stock tool's name", () => {
    expect(() => checkTurnoTools([...TURNO_TOOLS, ...allOptInTools()], upstream().tools.browserTools)).not.toThrow();
    for (const t of allOptInTools())
      expect(upstream().tools.browserTools.map((s) => s.schema.name)).not.toContain(t.schema.name);
  });

  it("refuse captcha solving in read mode before the browser starts, and let natural language actions through", async () => {
    writeIdentitySettings("reader", { act: {} }, sb.env);
    const cfg = await config();
    const lightpanda = createEngine(cfg, { engine: "lightpanda" });
    expect(lightpanda.refuse?.("browser_solve_captcha")).toMatch(
      /browser_solve_captcha is not available in read mode \(the Lightpanda engine\): read mode runs no captcha widget/,
    );
    for (const t of ["browser_act", "browser_extract", "browser_observe"])
      expect(lightpanda.refuse?.(t)).toBeUndefined();
  });

  it("hand a tool MCP sampling only when the client offers it, routed with the call's request id", async () => {
    const z = turnoZod();
    const probe: TurnoTool = {
      schema: {
        name: "turno_test_sample",
        title: "Sample (test)",
        description: "Asks the client's model.",
        inputSchema: z.object({}),
        type: "readOnly",
      },
      browser: false,
      async handle(ctx) {
        if (!ctx.sample) return { content: [{ type: "text", text: "no sampling" }] };
        const reply = await ctx.sample({
          systemPrompt: "sys",
          messages: [{ role: "user", content: { type: "text", text: "ping" } }],
          maxTokens: 10,
        });
        return { content: [{ type: "text", text: `${reply.text} from ${reply.model}` }] };
      },
    };
    const without = await connect({ turnoTools: [probe] });
    expect(await without.callTool({ name: "turno_test_sample", arguments: {} })).toMatchObject({
      content: [{ text: "no sampling" }],
    });
    const metas: unknown[] = [];
    const withSampling = await connect({
      turnoTools: [probe],
      sampling: (text, meta) => {
        metas.push(meta);
        return `pong to ${text}`;
      },
    });
    expect(await withSampling.callTool({ name: "turno_test_sample", arguments: {} })).toMatchObject({
      content: [{ text: "pong to ping from client-model" }],
    });
    expect(metas).toEqual([{ relatedRequestId: expect.anything() }]);
  });
});
