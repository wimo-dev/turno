import { readFileSync } from "node:fs";
import type { Page } from "patchright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flowPath, listFlows, readFlow } from "../src/flows.js";
import { FlowRecorder, roleFromSelector } from "../src/recorder.js";
import { secretField } from "../src/sensitive.js";
import { Redactor } from "../src/redact.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** The flow recorder with a stand-in page: what a step keeps, and what it never keeps. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

interface FakeElement {
  generated: string;
  info: { tag: string; type: string; autocomplete: string; name: string; id: string; text: string; css: string };
}

/** A page whose refs resolve to the elements given. */
function fakePage(elements: Record<string, FakeElement>, url = "https://example.com/login?next=%2Fhome"): Page {
  return {
    url: () => url,
    locator(selector: string) {
      const el = elements[selector.replace(/^aria-ref=/, "")];
      return {
        normalize: async () => {
          if (!el) throw new Error("no such ref");
          return { _selector: el.generated };
        },
        evaluate: async () => {
          if (!el) throw new Error("no element");
          return el.info;
        },
      };
    },
  } as unknown as Page;
}

const EMAIL: FakeElement = {
  generated: 'internal:role=textbox[name="Email"i]',
  info: {
    tag: "input",
    type: "email",
    autocomplete: "username",
    name: "email",
    id: "",
    text: "",
    css: 'input[name="email"]',
  },
};
const PASSWORD: FakeElement = {
  generated: 'internal:role=textbox[name="Password"i]',
  info: { tag: "input", type: "password", autocomplete: "", name: "pw", id: "pw", text: "", css: "#pw" },
};
const NOTES: FakeElement = {
  generated: 'internal:role=textbox[name="Team PIN"i]',
  info: {
    tag: "input",
    type: "text",
    autocomplete: "",
    name: "team_pin",
    id: "",
    text: "",
    css: 'input[name="team_pin"]',
  },
};
const BUTTON: FakeElement = {
  generated: 'internal:role=button[name="Sign in"i]',
  info: { tag: "button", type: "submit", autocomplete: "", name: "", id: "go", text: "Sign in", css: "#go" },
};

const page = fakePage({ e1: EMAIL, e2: PASSWORD, e3: NOTES, e4: BUTTON });

function recorder(auto = false, redactor = new Redactor()): FlowRecorder {
  return new FlowRecorder({ id: "work", env: sb.env }, redactor, () => auto);
}

async function act(r: FlowRecorder, tool: string, args: Record<string, unknown>): Promise<void> {
  const pending = await r.capture(tool, args, page);
  if (pending) r.commit(pending);
}

describe("telling a secret field", () => {
  it("knows password fields, secret autocomplete values and secret-looking names", () => {
    const f = (o: Partial<{ type: string; autocomplete: string; name: string; id: string }>) =>
      secretField({ type: "text", autocomplete: "", name: "", id: "", ...o });
    expect(f({ type: "password" })).toBe(true);
    expect(f({ autocomplete: "one-time-code" })).toBe(true);
    expect(f({ autocomplete: "cc-number" })).toBe(true);
    expect(f({ name: "otp" })).toBe(true);
    expect(f({ id: "user_pin" })).toBe(true);
    expect(f({ name: "email" })).toBe(false);
    expect(f({ name: "spinner" })).toBe(false);
  });

  it("reads role and name from Playwright's generated role locator, also inside a frame", () => {
    expect(roleFromSelector('internal:role=button[name="Say \\"hi\\""i]')).toEqual({
      role: "button",
      name: 'Say "hi"',
    });
    expect(roleFromSelector('iframe >> internal:control=enter-frame >> internal:role=link[name="Home"s]')).toEqual({
      role: "link",
      name: "Home",
    });
    expect(roleFromSelector("internal:role=main")).toEqual({ role: "main" });
    expect(roleFromSelector("#go")).toBeUndefined();
  });
});

describe("a named recording", () => {
  it("keeps locators and parameters, never a password, and saves only on stop", async () => {
    const r = recorder();
    r.start("sign-in", "Sign in to example", false);
    await act(r, "browser_navigate", { url: "https://example.com/login" });
    await act(r, "browser_type", { element: "Email field", target: "e1", text: "alice@example.com" });
    await act(r, "browser_type", { element: "Password field", target: "e2", text: "Hunter2-secret!" });
    await act(r, "browser_snapshot", {});
    await act(r, "browser_click", { element: "Sign in button", target: "e4" });
    expect(listFlows("work", sb.env)).toEqual([]);
    const { flow, file } = r.stop();
    expect(file).toBe(flowPath("work", "sign-in", sb.env));
    expect(readFileSync(file, "utf8")).not.toContain("Hunter2-secret!");
    expect(flow.steps.map((s) => s.tool)).toEqual([
      "browser_navigate",
      "browser_type",
      "browser_type",
      "browser_click",
    ]);
    expect(flow.params).toEqual([
      { name: "email", sensitive: false, default: "alice@example.com", description: "Email field" },
      { name: "password", sensitive: true, description: "Password field" },
    ]);
    const click = flow.steps[3]!;
    expect(click.args).toEqual({});
    expect(click.url).toBe("https://example.com/login");
    expect(click.targets?.target).toEqual({
      description: "Sign in button",
      ref: "e4",
      locators: [
        { kind: "generated", selector: 'internal:role=button[name="Sign in"i]' },
        { kind: "role", selector: 'internal:role=button[name="Sign in"s]' },
        { kind: "text", selector: 'css=button:text-is("Sign in")' },
        { kind: "css", selector: "css=#go" },
      ],
    });
    expect(flow.steps[1]!.args).toEqual({ text: { $param: "email" } });
  });

  it("drops the values the agent marks sensitive, and a vault value typed by hand", async () => {
    const redactor = new Redactor();
    redactor.add("vault-username-1", "mail username");
    const r = recorder(false, redactor);
    r.start("form", undefined, false);
    await act(r, "browser_fill_form", {
      fields: [
        { name: "Team PIN", type: "textbox", target: "e3", value: "4321-team" },
        { name: "Email", type: "textbox", target: "e1", value: "vault-username-1" },
        { name: "Remember", type: "checkbox", target: "e4", value: "true" },
      ],
    });
    await act(r, "browser_type", { target: "e1", text: "public text" });
    expect(() => r.stop(["nope"])).toThrow(/no parameter "nope" in this flow/);
    const { flow } = r.stop(["email_2"]);
    const text = JSON.stringify(flow);
    for (const v of ["4321-team", "vault-username-1"]) expect(text).not.toContain(v);
    expect(flow.params.map((p) => [p.name, p.sensitive])).toEqual([
      ["team_pin", true],
      ["email", true],
      ["email_2", true],
    ]);
    expect(flow.steps[0]!.args).toEqual({
      fields: [
        { name: "Team PIN", type: "textbox", value: { $param: "team_pin" } },
        { name: "Email", type: "textbox", value: { $param: "email" } },
        { name: "Remember", type: "checkbox", value: "true" },
      ],
    });
  });

  it("refuses to replace a saved flow unless asked, and keeps auto- names for the identity", async () => {
    const r = recorder();
    r.start("once", undefined, false);
    await act(r, "browser_navigate", { url: "https://example.com/" });
    r.stop();
    expect(() => r.start("once", undefined, false)).toThrow(/exists; pass overwrite: true/);
    expect(() => r.start("auto-mine", undefined, false)).toThrow(/kept for the identity's own recordings/);
    r.start("once", undefined, true);
    expect(() => r.stop()).toThrow(/no steps yet/);
    expect(r.cancel()).toBe(true);
  });

  it("does not keep steps while suspended (a replay is one step) or when the tool failed", async () => {
    const r = recorder();
    r.start("outer", undefined, false);
    await r.suspend(async () => act(r, "browser_navigate", { url: "https://example.com/inner" }));
    await r.capture("browser_click", { target: "e4" }, page); // captured, never committed: the click failed
    r.record("browser_replay", { flow: "inner", params: { email: "" } }, [
      { path: "params.email", value: "keychain:mail-email", sensitive: false, label: "email" },
    ]);
    r.record("browser_login", { site: "mail" });
    const { flow } = r.stop();
    expect(flow.steps).toEqual([
      { tool: "browser_replay", args: { flow: "inner", params: { email: { $param: "email" } } } },
      { tool: "browser_login", args: { site: "mail" } },
    ]);
    expect(flow.params).toEqual([{ name: "email", sensitive: false, default: "keychain:mail-email" }]);
  });
});

describe("identity recording (record.flows)", () => {
  it("writes an auto flow after each step, without passwords", async () => {
    const r = recorder(true);
    await act(r, "browser_type", { target: "e2", text: "Hunter2-secret!" });
    const [auto] = listFlows("work", sb.env);
    expect(auto?.name).toMatch(/^auto-\d{8}-\d{6}$/);
    expect(auto?.auto).toBe(true);
    const flow = readFlow("work", auto!.name, sb.env);
    expect(flow.steps).toHaveLength(1);
    expect(JSON.stringify(flow)).not.toContain("Hunter2-secret!");
  });
});
