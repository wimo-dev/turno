import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Flow,
  describeStep,
  fillParams,
  flowPath,
  flowProblems,
  flowsDir,
  listFlows,
  readFlow,
  removeFlow,
  resolveParams,
  rotateAutoFlows,
  writeFlow,
} from "../src/flows.js";
import { addIdentity, removeIdentity } from "../src/identities.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

/** Flow files: format, parameters, storage per identity. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function flow(name: string, over: Partial<Flow> = {}): Flow {
  return {
    version: 1,
    name,
    identity: "work",
    created: "2026-11-18T10:00:00.000Z",
    updated: "2026-11-18T10:00:00.000Z",
    params: [
      { name: "email", sensitive: false, default: "alice@example.com" },
      { name: "password", sensitive: true },
    ],
    steps: [
      { tool: "browser_navigate", args: { url: "https://example.com/login" } },
      {
        tool: "browser_type",
        args: { text: { $param: "email" } },
        targets: {
          target: {
            description: "Email",
            locators: [{ kind: "role", selector: 'internal:role=textbox[name="Email"s]' }],
          },
        },
      },
      {
        tool: "browser_type",
        args: { text: { $param: "password" }, submit: true },
        targets: { target: { locators: [{ kind: "css", selector: "css=#pw" }] } },
      },
    ],
    ...over,
  };
}

describe("flow files", () => {
  it("live per identity under the data folder, mode 600, and read back as written", () => {
    const file = writeFlow("work", flow("sign-in"), sb.env);
    expect(file).toBe(join(sb.home, ".local", "share", "turno", "browser", "flows", "work", "sign-in.json"));
    expectMode(file, 0o600);
    expectMode(flowsDir("work", sb.env), 0o700);
    expect(readFlow("work", "sign-in", sb.env)).toEqual(flow("sign-in"));
  });

  it("refuses a sensitive parameter with a stored value, a parameter no step lists, and bad names", () => {
    const leaky = flow("x", { params: [{ name: "password", sensitive: true, default: "hunter22" }] });
    expect(flowProblems(leaky).join("; ")).toMatch(/sensitive and must not keep a default/);
    expect(() => writeFlow("work", leaky, sb.env)).toThrow(/must not keep a default/);
    expect(existsSync(flowPath("work", "x", sb.env))).toBe(false);
    expect(flowProblems(flow("y", { params: [] })).join("; ")).toMatch(
      /uses parameter "email", which params does not list/,
    );
    expect(() => flowPath("work", "../escape", sb.env)).toThrow(/invalid flow name/);
    expect(flowProblems({ ...flow("z"), version: 9 })).toEqual([
      "is format 9, from a newer turno-browser (this one reads 1); update it",
    ]);
  });

  it("says which flows exist when one is missing, and lists them newest first", () => {
    writeFlow("work", flow("older", { updated: "2026-11-17T00:00:00.000Z" }), sb.env);
    writeFlow("work", flow("newer", { updated: "2026-11-18T12:00:00.000Z", description: "Sign in" }), sb.env);
    writeFileSync(join(flowsDir("work", sb.env), "broken.json"), "{");
    expect(() => readFlow("work", "nope", sb.env)).toThrow(/has no flow "nope" \(saved: newer, older\)/);
    const list = listFlows("work", sb.env);
    expect(list.map((f) => f.name)).toEqual(["newer", "older"]);
    expect(list[0]).toMatchObject({
      description: "Sign in",
      steps: 3,
      start: "https://example.com/login",
      auto: false,
      params: [
        { name: "email", sensitive: false, hasDefault: true },
        { name: "password", sensitive: true, hasDefault: false },
      ],
    });
    expect(removeFlow("work", "older", sb.env)).toBe(true);
    expect(removeFlow("work", "older", sb.env)).toBe(false);
  });

  it("keeps the newest auto flows only, and leaves named ones", () => {
    for (let i = 0; i < 4; i++) {
      const file = writeFlow("work", flow(`auto-2026111${i}`), sb.env);
      utimesSync(file, 1_000 + i, 1_000 + i);
    }
    writeFlow("work", flow("named"), sb.env);
    expect(rotateAutoFlows("work", 2, sb.env)).toBe(2);
    expect(
      listFlows("work", sb.env)
        .map((f) => f.name)
        .sort(),
    ).toEqual(["auto-20261112", "auto-20261113", "named"]);
  });

  it("go with the identity", () => {
    addIdentity("work", sb.env);
    writeFlow("work", flow("sign-in"), sb.env);
    removeIdentity("work", sb.env);
    expect(existsSync(flowsDir("work", sb.env))).toBe(false);
  });
});

describe("parameters", () => {
  it("fills given values over defaults, and names what is missing or unknown", () => {
    const f = flow("p");
    expect(resolveParams(f, { password: "s3cret!", email: "bob@example.com" })).toEqual({
      values: { email: "bob@example.com", password: "s3cret!" },
      missing: [],
      unknown: [],
    });
    const r = resolveParams(f, { colour: "blue" });
    expect(r.missing.map((p) => p.name)).toEqual(["password"]);
    expect(r.unknown).toEqual(["colour"]);
    expect(fillParams(f.steps[1]!.args, { email: "a@b.c" })).toEqual({ text: "a@b.c" });
  });

  it("describes a step without its values", () => {
    expect(describeStep(flow("d").steps[1]!)).toBe("browser_type Email with {email}");
    expect(describeStep({ tool: "browser_login", args: { site: "mail" } })).toBe('browser_login site "mail"');
  });
});
