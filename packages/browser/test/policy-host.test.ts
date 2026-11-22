import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "../src/engine.js";
import { createHost, serve } from "../src/host.js";
import { identitySettingsPath, writeIdentitySettings } from "../src/settings.js";
import { type McpConfig, upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The policy in the host, without a browser: the tools it turns off are not listed and are
 * refused, and no tool call can change identity.json, the file that holds the policy. Every
 * refusal happens before a browser would start (the engine here throws if asked).
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const noBrowser: Engine = {
  id: "chrome",
  async launch() {
    throw new Error("no browser in this test");
  },
};

async function config(caps?: string[]): Promise<McpConfig> {
  return await upstream().tools.resolveCLIConfigForMCP(
    { browser: "chrome", userDataDir: `${sb.home}/profile`, headless: true, ...(caps ? { caps } : {}) },
    {},
  );
}

async function connect(id: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await serve(
    createHost({ config: await config(), cliOptions: {}, engine: noBrowser, identity: { id, env: sb.env } }),
    serverSide,
  );
  const client = new Client({ name: "policy-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

describe("a policy in the host", () => {
  it("lists none of the tools it turns off and refuses each of them", async () => {
    writeIdentitySettings(
      "shop",
      { policy: { allowedDomains: ["example.com"], disabled: ["login", "evaluate"] } },
      sb.env,
    );
    const client = await connect("shop");
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const gone of ["browser_run_code_unsafe", "browser_login", "browser_evaluate"])
      expect(names, gone).not.toContain(gone);
    expect(names).toContain("browser_navigate");
    for (const tool of ["browser_run_code_unsafe", "browser_login", "browser_evaluate"]) {
      const res = await call(client, tool, {});
      expect(res.error, tool).toBe(true);
      expect(res.text, tool).toContain("disabled by the policy");
    }
    const nav = await call(client, "browser_navigate", { url: "https://evil.test/" });
    expect(nav.error).toBe(true);
    expect(nav.text).toContain("evil.test");
    expect(nav.text).toContain("example.com");
  });

  it("leaves identity.json as it was whatever the agent tries", async () => {
    writeIdentitySettings("shop", { policy: { disabled: ["captcha"] } }, sb.env);
    const file = identitySettingsPath("shop", sb.env);
    const before = readFileSync(file, "utf8");
    const client = await connect("shop");
    const rewrite = `async (page) => { require("node:fs").writeFileSync(${JSON.stringify(file)}, "{}"); }`;
    const attempts: [string, Record<string, unknown>][] = [
      ["browser_run_code_unsafe", { code: rewrite }],
      ["browser_batch", { actions: [{ tool: "browser_run_code_unsafe", args: { code: rewrite } }] }],
      ["browser_evaluate", { function: "() => ({})", filename: file }],
      ["browser_snapshot", { filename: file }],
      ["browser_take_screenshot", { filename: file }],
      ["browser_console_messages", { filename: file }],
    ];
    for (const [tool, args] of attempts) {
      const res = await call(client, tool, args);
      expect(res.error, tool).toBe(true);
      expect(res.text, tool).not.toContain("no browser in this test");
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    // No tool the agent can list writes identity settings or the policy.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /policy|setting|identity/.test(n))).toEqual([]);
  });

  it("does not start with a capability whose every tool the policy turns off", async () => {
    writeIdentitySettings("shop", { policy: { allowedDomains: ["example.com"] } }, sb.env);
    const cfg = await config(["network"]);
    expect(() =>
      createHost({ config: cfg, cliOptions: {}, engine: noBrowser, identity: { id: "shop", env: sb.env } }),
    ).toThrow(/--caps network does not go with the policy/);
  });
});
