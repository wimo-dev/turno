import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BrowserApi, type BrowserDeps, browserCommand } from "../src/cli/commands/browser.js";
import { fakeIo } from "./helpers/cli.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `turno browser set` (and `turno identity set browser:<id>`) with the format 8 flags: natural
 * language actions and captcha solving, keys only as keychain: references.
 * The real turno-browser of the workspace writes identity.json under the sandbox HOME.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const real = async (): Promise<BrowserApi> => (await import("turno-browser")).api;
const deps = (): BrowserDeps => ({ load: real, interactive: () => false, confirm: async () => false });
const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);
const settings = (id: string) => JSON.parse(readFileSync(settingsFile(id), "utf8")) as Record<string, unknown>;

async function browser(args: string[]) {
  const io = fakeIo(sb.env);
  const code = await browserCommand(deps())
    .run(args, io)
    .then(String, (e: Error) => e.message);
  return { code, out: io.lines.join("\n") };
}

describe("turno browser set --act and --captcha-*", () => {
  it("turns natural language actions on with MCP sampling, adds a provider, says what it costs, and turns them off", async () => {
    expect((await browser(["add", "work"])).code).toBe("0");
    const on = await browser(["set", "work", "--act"]);
    expect(on.code).toBe("0");
    expect(settings("work")).toMatchObject({ version: 8, act: {} });
    expect(on.out).toMatch(/act\s+on: MCP sampling when the client offers it, else off/);
    expect(on.out).toMatch(/natural language actions: each call sends the instruction and a snapshot of the page/);

    const provider = await browser([
      "set",
      "work",
      "--act-provider",
      "chat-completions",
      "--act-endpoint",
      "https://models.example.com/v1",
      "--act-model",
      "example-model",
      "--act-key",
      "keychain:act-model",
      "--act-max-steps",
      "5",
    ]);
    expect(provider.code).toBe("0");
    expect(settings("work").act).toEqual({
      provider: "chat-completions",
      endpoint: "https://models.example.com/v1",
      model: "example-model",
      key: "keychain:act-model",
      maxSteps: 5,
    });
    expect(provider.out).toMatch(
      /act\s+on: MCP sampling when the client offers it, else chat-completions example-model at https:\/\/models\.example\.com\/v1/,
    );

    expect((await browser(["set", "work", "--act-max-steps", "99"])).code).toMatch(
      /--act-max-steps must be a whole number from 1 to 30/,
    );
    expect((await browser(["set", "work", "--act-sampling", "maybe"])).code).toMatch(
      /--act-sampling must be true or false/,
    );
    expect((await browser(["set", "work", "--no-act", "--act"])).code).toMatch(/--no-act does not go with/);
    expect((await browser(["set", "work", "--no-act"])).code).toBe("0");
    expect(settings("work").act).toBeUndefined();
  });

  it("refuses a literal key without printing it", async () => {
    await browser(["add", "work"]);
    const literal = "sk-pasted-literal-key-0123456789";
    const r = await browser([
      "set",
      "work",
      "--captcha-provider",
      "task-api",
      "--captcha-endpoint",
      "https://s.example.com",
      "--captcha-key",
      literal,
    ]);
    expect(r.code).toMatch(/--captcha-key must be a keychain:<item> reference/);
    expect(r.code).not.toContain(literal);
    expect(r.out).not.toContain(literal);
  });

  it("turns captcha solving on with a solver and its key reference, warns about terms, and turns it off", async () => {
    await browser(["add", "work"]);
    const on = await browser([
      "set",
      "work",
      "--captcha-provider",
      "task-api",
      "--captcha-endpoint",
      "https://solver.example.com",
      "--captcha-key",
      "keychain:captcha-solver",
    ]);
    expect(on.code).toBe("0");
    expect(settings("work")).toMatchObject({
      version: 8,
      captcha: { provider: "task-api", endpoint: "https://solver.example.com", key: "keychain:captcha-solver" },
    });
    expect(on.out).toMatch(/captcha\s+solver: task-api at solver\.example\.com, key from identity\.json/);
    expect(on.out).toMatch(
      /the solver service sees the page address and the captcha, and solving a site's captchas by machine may break its terms; use it only for your own accounts/,
    );
    expect((await browser(["set", "work", "--engine", "lightpanda"])).code).toMatch(
      /captcha does not go with engine "lightpanda"/,
    );
    expect((await browser(["set", "work", "--no-captcha"])).code).toBe("0");
    expect(settings("work").captcha).toBeUndefined();
  });
});

describe("turno browser reputation with captcha solving", () => {
  it("adds a solved column once a solver answered", async () => {
    const mod = await real();
    mod.addIdentity("shop", sb.env);
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    const log = [
      JSON.stringify({ ts, site: "a.example", kind: "captcha", markers: ["captcha"] }),
      JSON.stringify({ ts, site: "a.example", kind: "solve", widget: "recaptcha", provider: "task-api", ok: true }),
    ].join("\n");
    sb.write(".local/state/turno/browser/identities/shop/reputation.jsonl", `${log}\n`);
    const r = await browser(["reputation", "shop"]);
    expect(r.out).toMatch(/site +total +captcha +verify +block +solved +7d/);
    expect(r.out).toMatch(/a\.example +1 +1 +0 +0 +1 +1 +0 +up/);
  });
});
