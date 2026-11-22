import { describe, expect, it } from "vitest";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  type StepParams,
  parseStepParams,
  stepResult,
  urlMatcher,
} from "../src/human-step.js";
import { PauseGate } from "../src/live.js";

/** The person step without a browser: its arguments, URL patterns, result and the gate's hold. */

const params = (raw: Record<string, unknown>): StepParams => {
  const p = parseStepParams(raw);
  if ("error" in p) throw new Error(p.error);
  return p;
};

describe("person step arguments", () => {
  it("refuses what cannot make a step", () => {
    expect(params({ instruction: "  Type your password  " })).toEqual({
      instruction: "Type your password",
      urlChanges: false,
      done: true,
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      requireHumanClick: false,
    });
    const error = (raw: Record<string, unknown>) => (parseStepParams(raw) as { error?: string }).error;
    expect(error({ instruction: " " })).toMatch(/instruction must say/);
    expect(error({ instruction: "x".repeat(501) })).toMatch(/keep it to 500/);
    expect(error({ instruction: "x", until: { timeoutMs: 600_001 } })).toMatch(/from 1000 to 600000/);
    expect(error({ instruction: "x", until: { timeoutMs: 999 } })).toMatch(/from 1000/);
    expect(error({ instruction: "x", until: { done: false } })).toMatch(/needs another way to end/);
    expect(error({ instruction: "x", requireHumanClick: true })).toMatch(/needs a target/);
    expect(error({ instruction: "x", until: { url: "/(/" } })).toMatch(/not a valid regular expression/);
  });
});

describe("until.url", () => {
  it("is a regular expression, a glob or text the URL contains", () => {
    expect(urlMatcher("/welcome$/i")("https://example.com/WELCOME")).toBe(true);
    expect(urlMatcher("/welcome$/")("https://example.com/welcome/x")).toBe(false);
    expect(urlMatcher("**/dashboard*")("https://example.com/app/dashboard?tab=1")).toBe(true);
    expect(urlMatcher("https://example.com/*")("https://example.com/a/b")).toBe(false);
    expect(urlMatcher("https://example.com/**")("https://example.com/a/b")).toBe(true);
    expect(urlMatcher("https://example.com/a.b*")("https://example.com/aXb")).toBe(false);
    expect(urlMatcher("/signed-in")("https://example.com/signed-in?x=1")).toBe(true);
    expect(urlMatcher("/signed-in")("https://example.com/login")).toBe(false);
  });
});

describe("person step result", () => {
  const base = {
    params: params({ instruction: "Type your password", target: "e4", requireHumanClick: true }),
    waitedMs: 42_000,
    url: "https://example.com/welcome",
    title: "Welcome",
    lines: ["Current tab: https://example.com/login -> https://example.com/welcome"],
    clicks: 2,
    fields: 1,
    liveInputs: 0,
    targetClicked: true,
  };

  it("says why the step ended and what changed", () => {
    const json = stepResult({ ...base, ended: "url-changed", targetClicked: false, json: true });
    expect(json.isError).toBeUndefined();
    expect(JSON.parse((json.content[0] as { text: string }).text)).toEqual({
      ended: "url-changed",
      reason: "the tab's URL changed",
      waitedMs: 42_000,
      url: "https://example.com/welcome",
      title: "Welcome",
      changes: base.lines,
      clicks: 2,
      fieldsChanged: 1,
      liveViewInputs: 0,
      targetClicked: false,
    });
  });

  it("is an error when nothing ended the step in time", () => {
    const out = stepResult({ ...base, ended: "timeout", lines: [], clicks: 0, fields: 0, json: false });
    expect(out.isError).toBe(true);
    const text = (out.content[0] as { text: string }).text;
    expect(text).toMatch(/^### Error\nThe step ended after 42s: nothing ended the step within 5m 00s\./);
    expect(text).toContain("- Nothing changed in the browser's tabs, and the person made no input.");
  });
});

describe("the pause gate during a person step", () => {
  it("holds a call until the step ends, past the live wait", async () => {
    let now = 1_000;
    const gate = new PauseGate(() => now);
    expect(gate.start("browser_request_human", Promise.resolve([]), { step: true, until: now + 60_000 })).toBe(true);
    expect(gate.paused).toEqual({ since: 1_000, by: "browser_request_human", step: true });
    let settled = false;
    const held = gate.wait(10).then((o) => {
      settled = true;
      return o;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    now += 5_000;
    gate.resume();
    expect(await held).toMatchObject({ kind: "resumed", step: true, pausedMs: 5_000 });
  });
});
