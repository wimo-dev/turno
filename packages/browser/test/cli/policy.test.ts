import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserFunctions } from "../../src/api.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";
import { init } from "../../src/cli/init.js";
import { cli, ctx, fakeIo, real } from "./helpers.js";

/** The policy on the command line: init and set write it, show and status report it. */

let sb: Sandbox;
let api: BrowserFunctions;
beforeEach(async () => {
  sb = sandbox();
  api = await real();
});
afterEach(() => sb.cleanup());

const POLICY = { allowedDomains: ["example.com", "*.example.com"], disabled: ["captcha"], autoSubmit: false };

async function json(cmd: string, args: string[]) {
  const io = fakeIo(sb.env);
  expect(await cli(api).run(cmd, [...args, "--json"], io)).toBe(0);
  return JSON.parse(io.lines.join("\n"));
}

describe("the policy on the command line", () => {
  it("init applies a policy file without a terminal, and checks it before creating anything", async () => {
    const bad = sb.write("bad.json", JSON.stringify({ disabled: ["nothing"] }));
    const args = (file: string) => ["--identity", "shop", "--agent", "none", "--policy-file", file, "--json"];
    const nothing = async () => 0;
    await expect(init(ctx(api), args(bad), fakeIo(sb.env), nothing)).rejects.toThrow(/unknown feature "nothing"/);
    expect(api.identityExists("shop", sb.env)).toBe(false);

    const io = fakeIo(sb.env);
    expect(await init(ctx(api), args(sb.write("policy.json", JSON.stringify(POLICY))), io, nothing)).toBe(0);
    expect(JSON.parse(io.lines.join("\n")).identity.policy).toEqual(POLICY);
    expect((await json("show", ["shop"])).settings.policy).toEqual(POLICY);
    expect((await json("status", ["shop"])).identities[0].settings.policy).toEqual(POLICY);
  });

  it("set changes parts of it, refuses settings it turns off, and removes it", async () => {
    api.addIdentity("shop", sb.env);
    await json("set", ["shop", "--allowed-domains", "example.com", "--disable", "act,captcha"]);
    await json("set", ["shop", "--auto-submit", "false"]);
    expect((await json("show", ["shop"])).settings.policy).toEqual({
      allowedDomains: ["example.com"],
      disabled: ["act", "captcha"],
      autoSubmit: false,
    });
    await expect(cli(api).run("set", ["shop", "--act"], fakeIo(sb.env))).rejects.toThrow(/policy.disabled has "act"/);
    await expect(
      cli(api).run("set", ["shop", "--policy-file", "x.json", "--disable", "act"], fakeIo(sb.env)),
    ).rejects.toThrow(/does not go with/);
    await json("set", ["shop", "--no-policy"]);
    expect((await json("show", ["shop"])).settings.policy).toBeUndefined();
  });
});
