import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WIDGETS, resolveCaptchaSource, solveCaptchaTool, taskApiSolver } from "../src/captcha.js";
import { Redactor, VaultGuard } from "../src/redact.js";
import { readChallenges, readSolves, recordChallenge, recordSolve, reputationReport } from "../src/reputation.js";
import { addIdentity } from "../src/identities.js";
import { writeIdentitySettings } from "../src/settings.js";
import type { StockAccess } from "../src/tools.js";
import type { McpConfig } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Captcha solving without a browser or a network: the task protocol against a fake fetch, the
 * reputation log lines, and the tool's refusals. The widget and token on a real page are in
 * act-chrome.test.ts.
 */

const KEY = "solver-account-key-0123456789";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function fakeSolverFetch(results: Record<string, unknown>[]) {
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  let poll = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push({ path, body });
    if (path.endsWith("/createTask")) return json({ errorId: 0, taskId: 42 });
    return json(results[Math.min(poll++, results.length - 1)]);
  }) as typeof fetch;
  return { fetch: f, bodies };
}

describe("taskApiSolver", () => {
  it("creates a task for the widget and polls until the token is ready", async () => {
    const { fetch, bodies } = fakeSolverFetch([
      { errorId: 0, status: "processing" },
      { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "TOKEN-1" } },
    ]);
    const solver = taskApiSolver({ endpoint: "https://solver.example.com/", key: KEY, fetch, polls: [1] });
    expect(solver.label).toBe("task-api at solver.example.com");
    const out = await solver.solve({
      widget: { kind: "recaptcha", siteKey: "site-key-1", invisible: true },
      pageUrl: "https://shop.example.com/checkout",
    });
    expect(out).toEqual({ token: "TOKEN-1" });
    expect(bodies.map((b) => b.path)).toEqual(["/createTask", "/getTaskResult", "/getTaskResult"]);
    expect(bodies[0]!.body).toEqual({
      clientKey: KEY,
      task: {
        type: WIDGETS.recaptcha.task,
        websiteURL: "https://shop.example.com/checkout",
        websiteKey: "site-key-1",
        isInvisible: true,
      },
    });
    expect(bodies[1]!.body).toEqual({ clientKey: KEY, taskId: 42 });
  });

  it("reads a token solution (Turnstile) and reports a refused task by its code", async () => {
    const turnstile = fakeSolverFetch([{ errorId: 0, status: "ready", solution: { token: "T-2" } }]);
    expect(
      await taskApiSolver({ endpoint: "https://s.example.com", key: KEY, fetch: turnstile.fetch, polls: [1] }).solve({
        widget: { kind: "turnstile", siteKey: "0x4AAAAAAAA" },
        pageUrl: "https://a.example.com/",
      }),
    ).toEqual({ token: "T-2" });
    expect((turnstile.bodies[0]!.body.task as { type: string }).type).toBe("TurnstileTaskProxyless");
    const refused = fakeSolverFetch([{ errorId: 1, errorCode: "ERROR_CAPTCHA_UNSOLVABLE", errorDescription: "no" }]);
    await expect(
      taskApiSolver({ endpoint: "https://s.example.com", key: KEY, fetch: refused.fetch, polls: [1] }).solve({
        widget: { kind: "hcaptcha", siteKey: "k" },
        pageUrl: "https://a.example.com/",
      }),
    ).rejects.toThrow("s.example.com refused the task (ERROR_CAPTCHA_UNSOLVABLE: no)");
  });

  it("stops polling when the time is up", async () => {
    const { fetch } = fakeSolverFetch([{ errorId: 0, status: "processing" }]);
    const controller = new AbortController();
    const pending = taskApiSolver({ endpoint: "https://s.example.com", key: KEY, fetch, polls: [5] }).solve({
      widget: { kind: "recaptcha", siteKey: "k" },
      pageUrl: "https://a.example.com/",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toThrow("the solver did not answer in time");
  });
});

describe("the reputation log", () => {
  it("keeps solve attempts apart from challenges, and counts the ones that worked per site", () => {
    addIdentity("shop", sb.env);
    const now = new Date("2026-11-19T12:00:00Z");
    recordChallenge("shop", sb.env, { site: "a.example.com", kind: "captcha", markers: ["captcha"] }, now);
    recordSolve("shop", sb.env, { site: "a.example.com", widget: "recaptcha", provider: "task-api", ok: true }, now);
    recordSolve("shop", sb.env, { site: "a.example.com", widget: "recaptcha", provider: "task-api", ok: false }, now);
    recordSolve("shop", sb.env, { site: "b.example.com", widget: "turnstile", provider: "task-api", ok: true }, now);
    expect(readChallenges("shop", sb.env)).toHaveLength(1);
    expect(readSolves("shop", sb.env).map((s) => [s.site, s.ok])).toEqual([
      ["a.example.com", true],
      ["a.example.com", false],
      ["b.example.com", true],
    ]);
    const [report] = reputationReport(sb.env, ["shop"], now).identities;
    expect(report!.total).toBe(1);
    expect(report!.sites.map((s) => [s.site, s.total, s.captcha, s.solved])).toEqual([
      ["a.example.com", 1, 1, 1],
      ["b.example.com", 0, 0, 1],
    ]);
  });
});

describe("browser_solve_captcha", () => {
  const stock = { currentPage: () => undefined } as unknown as StockAccess;
  const ctx = () => ({
    config: {} as McpConfig,
    clientInfo: { cwd: "/", clientName: "t" },
    stock,
    vault: { identity: { id: "shop", env: sb.env }, redactor: new Redactor(), guard: new VaultGuard() },
  });

  it("is refused without a solver key, and hands the captcha to the person", async () => {
    writeIdentitySettings("shop", { region: "MX" }, sb.env);
    const res = await solveCaptchaTool().handle(ctx(), {});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(
      /captcha solving is off for identity "shop" \(no solver key: .*\); only the person can configure a solver .*browser_request_human/,
    );
  });

  it("takes its key from identity.json first, else from the environment's endpoint and key together", () => {
    const own = { provider: "task-api" as const, endpoint: "https://own.example.com", key: "keychain:s" };
    const env = { TURNO_BROWSER_CAPTCHA_ENDPOINT: "https://env.example.com", TURNO_BROWSER_CAPTCHA_KEY: KEY };
    expect(resolveCaptchaSource(own, env)).toEqual({ kind: "identity", settings: own });
    expect(resolveCaptchaSource(undefined, env)).toMatchObject({ kind: "env", key: KEY });
    expect(resolveCaptchaSource(false, env).kind).toBe("none");
    expect(resolveCaptchaSource(undefined, { TURNO_BROWSER_CAPTCHA_KEY: KEY }).kind).toBe("none");
    expect(
      resolveCaptchaSource(undefined, { ...env, TURNO_BROWSER_CAPTCHA_ENDPOINT: "http://env.example.com" }).kind,
    ).toBe("none");
  });

  it("needs a page", async () => {
    writeIdentitySettings(
      "shop",
      { captcha: { provider: "task-api", endpoint: "https://s.example.com", key: "keychain:s" } },
      sb.env,
    );
    const res = await solveCaptchaTool().handle(ctx(), {});
    expect((res.content[0] as { text: string }).text).toContain("there is no page open");
  });
});
