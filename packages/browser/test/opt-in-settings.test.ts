import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actBudget, allowedEndpoint, captchaTimeoutMs } from "../src/opt-in-settings.js";
import { IDENTITY_FORMAT_VERSION, readIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** identity.json format 8: `act` and `captcha`, both off unless the file names them. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const PROVIDER = {
  provider: "chat-completions" as const,
  endpoint: "https://models.example.com/v1",
  model: "example-model",
  key: "keychain:act-model",
};
const SOLVER = { provider: "task-api" as const, endpoint: "https://solver.example.com", key: "keychain:solver" };

describe("the act and captcha keys", () => {
  it("are format 8, written only while one of them is set", () => {
    expect(IDENTITY_FORMAT_VERSION).toBeGreaterThanOrEqual(8);
    expect(writeIdentitySettings("a", { act: {} }, sb.env).version).toBe(8);
    expect(readIdentitySettings("a", sb.env)?.act).toEqual({});
    expect(writeIdentitySettings("a", { act: null, captcha: SOLVER }, sb.env).version).toBe(8);
    expect(writeIdentitySettings("a", { captcha: null }, sb.env).version).toBe(1);
  });

  it("accept sampling alone, a provider, or both, with budgets", () => {
    const s = writeIdentitySettings(
      "a",
      { act: { ...PROVIDER, maxSteps: 5, maxTokens: 20_000, timeout: "90s" } },
      sb.env,
    );
    expect(s.act).toMatchObject({ provider: "chat-completions", maxSteps: 5 });
    expect(actBudget(s.act || {})).toEqual({ maxSteps: 5, maxTokens: 20_000, timeoutMs: 90_000 });
    expect(actBudget({})).toEqual({ maxSteps: 10, maxTokens: 50_000, timeoutMs: 120_000 });
    expect(
      (writeIdentitySettings("a", { act: { sampling: false, ...PROVIDER } }, sb.env).act || undefined)?.sampling,
    ).toBe(false);
    // A local model server: plain http, but only on a loopback address.
    expect(
      (
        writeIdentitySettings(
          "a",
          { act: { ...PROVIDER, endpoint: "http://127.0.0.1:11434/v1", key: undefined } },
          sb.env,
        ).act || undefined
      )?.endpoint,
    ).toBe("http://127.0.0.1:11434/v1");
  });

  it("refuse a key that is not a keychain: reference, without repeating it", () => {
    const literal = "sk-literal-key-value-1234567890";
    let message = "";
    try {
      writeIdentitySettings("a", { act: { ...PROVIDER, key: literal } }, sb.env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/act\.key must be a keychain:<item> reference/);
    expect(message).not.toContain(literal);
    expect(() => writeIdentitySettings("a", { captcha: { ...SOLVER, key: literal } }, sb.env)).toThrow(
      /captcha\.key must be a keychain:<item> reference/,
    );
  });

  it("explain every other mistake", () => {
    expect(() =>
      writeIdentitySettings(
        "a",
        { act: { provider: "other" as never, endpoint: "http://models.example.com", maxSteps: 99, timeout: "1s" } },
        sb.env,
      ),
    ).toThrow(
      /act\.provider must be "chat-completions"; act\.endpoint must be an https:\/\/ URL.*; act\.model must be the model name.*; act\.maxSteps must be a whole number from 1 to 30; act\.timeout must be a duration from "10s" to "10m"/,
    );
    expect(() => writeIdentitySettings("a", { act: { sampling: false } }, sb.env)).toThrow(
      /act needs act\.provider when act\.sampling is false/,
    );
    expect(() => writeIdentitySettings("a", { act: { model: "m" } }, sb.env)).toThrow(/act\.model needs act\.provider/);
    expect(() => writeIdentitySettings("a", { captcha: { provider: "task-api" } as never }, sb.env)).toThrow(
      /captcha\.endpoint must be an https:\/\/ URL.*; captcha\.key is required/,
    );
    expect(() => writeIdentitySettings("a", { act: { extra: 1 } as never }, sb.env)).toThrow(
      /unknown key "act\.extra"/,
    );
  });

  it("refuse captcha solving in read mode, where no widget runs", () => {
    expect(() => writeIdentitySettings("a", { engine: "lightpanda", captcha: SOLVER }, sb.env)).toThrow(
      /captcha does not go with engine "lightpanda"/,
    );
    // Natural language actions read a snapshot and use read mode's own tools, so they go with it.
    expect(writeIdentitySettings("a", { engine: "lightpanda", act: {} }, sb.env).act).toEqual({});
    // Attach mode and tab sharing: both features work on the agent's own tab.
    expect(writeIdentitySettings("b", { attach: "auto", act: {}, captcha: SOLVER }, sb.env).captcha).toEqual(SOLVER);
    expect(writeIdentitySettings("c", { sharing: "tabs", act: {}, captcha: SOLVER }, sb.env).act).toEqual({});
  });

  it("allow https endpoints and loopback http only", () => {
    expect(allowedEndpoint("https://solver.example.com/api")).toBe(true);
    expect(allowedEndpoint("http://localhost:8080")).toBe(true);
    expect(allowedEndpoint("http://[::1]:8080")).toBe(true);
    expect(allowedEndpoint("http://solver.example.com")).toBe(false);
    expect(allowedEndpoint("https://user:pass@solver.example.com")).toBe(false);
    expect(allowedEndpoint("not a url")).toBe(false);
    expect(captchaTimeoutMs(SOLVER)).toBe(180_000);
    expect(captchaTimeoutMs({ ...SOLVER, timeout: "30s" })).toBe(30_000);
  });
});
