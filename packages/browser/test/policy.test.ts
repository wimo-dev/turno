import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity } from "../src/identities.js";
import {
  type HostPattern,
  disabledTools,
  hostAllowed,
  navigationVerdict,
  parseHostPattern,
  policyRefusal,
} from "../src/policy.js";
import { identitySettingsPath, writeIdentitySettings } from "../src/settings.js";
import { vaultAdd, vaultSetSubmit } from "../src/vault.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** The policy of identity.json: host patterns, parsing and the refusals it adds. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

function patterns(...raw: string[]): HostPattern[] {
  return raw.map((r) => {
    const p = parseHostPattern(r);
    if ("error" in p) throw new Error(p.error);
    return p;
  });
}

describe("host patterns", () => {
  it("match a host on its default port, subdomains with *., and any port with :*", () => {
    const allowed = patterns("example.com", "*.example.com", "localhost:*", "dev.test:8443", "[::1]:*");
    const ok = (url: string) => hostAllowed(allowed, new URL(url));
    expect(ok("https://example.com/login")).toBe(true);
    expect(ok("http://example.com/")).toBe(true);
    expect(ok("https://example.com:8443/")).toBe(false);
    expect(ok("https://api.example.com/")).toBe(true);
    expect(ok("https://a.b.example.com/")).toBe(true);
    expect(ok("https://notexample.com/")).toBe(false);
    expect(ok("https://example.com.evil.test/")).toBe(false);
    expect(ok("http://localhost:3000/")).toBe(true);
    expect(ok("https://dev.test:8443/")).toBe(true);
    expect(ok("https://dev.test/")).toBe(false);
    expect(ok("http://[::1]:9000/")).toBe(true);
    expect(ok("http://127.0.0.1:3000/")).toBe(false);
  });

  it("are case-insensitive and compared in their ASCII form", () => {
    expect(hostAllowed(patterns("EXAMPLE.com"), new URL("https://example.COM/"))).toBe(true);
    expect(hostAllowed(patterns("bücher.example"), new URL("https://xn--bcher-kva.example/"))).toBe(true);
  });

  it("refuse what is not a host pattern", () => {
    for (const bad of [
      "https://example.com",
      "example.com/path",
      "*",
      "*.com",
      "ex ample.com",
      "a.*.com",
      "host:0",
      "host:99999",
      "",
    ])
      expect(parseHostPattern(bad), bad).toHaveProperty("error");
  });

  it("let a tab show about:blank and an allowed blob:, and refuse other schemes", () => {
    const allowed = patterns("example.com");
    expect(navigationVerdict(allowed, "about:blank")).toEqual({ allowed: true });
    expect(navigationVerdict(allowed, "blob:https://example.com/0f1e")).toEqual({ allowed: true });
    expect(navigationVerdict(allowed, "blob:https://evil.test/0f1e")).toEqual({ allowed: false, target: "evil.test" });
    expect(navigationVerdict(allowed, "data:text/html,hi")).toEqual({ allowed: false, target: "a data: URL" });
    expect(navigationVerdict(allowed, "file:///etc/hosts")).toEqual({ allowed: false, target: "a file: URL" });
    expect(navigationVerdict(allowed, "chrome-error://chromewebdata/")).toEqual({ allowed: "error-page" });
  });
});

describe("the policy key of identity.json", () => {
  it("is checked as a whole", () => {
    const policy = {
      allowedDomains: ["example.com", "*.example.com"],
      disabled: ["captcha" as const],
      autoSubmit: false,
    };
    expect(writeIdentitySettings("shop", { policy }, sb.env).policy).toEqual(policy);
    expect(() => writeIdentitySettings("shop", { policy: { allowedDomains: [] } }, sb.env)).toThrow(
      /policy.allowedDomains must be a list/,
    );
    expect(() => writeIdentitySettings("shop", { policy: { disabled: ["request_human" as never] } }, sb.env)).toThrow(
      /unknown feature "request_human"/,
    );
    expect(() => writeIdentitySettings("shop", { policy: { extra: 1 } as never }, sb.env)).toThrow(
      /unknown key "policy.extra"/,
    );
  });

  it("refuses a setting a disabled feature needs, and the domain check with attach mode", () => {
    writeIdentitySettings("shop", { act: {} }, sb.env);
    expect(() => writeIdentitySettings("shop", { policy: { disabled: ["act"] } }, sb.env)).toThrow(
      /act is set while policy.disabled has "act"/,
    );
    // One write that drops the setting and adds the policy goes through.
    expect(writeIdentitySettings("shop", { act: null, policy: { disabled: ["act"] } }, sb.env).policy).toEqual({
      disabled: ["act"],
    });
    expect(() => writeIdentitySettings("shop", { act: {} }, sb.env)).toThrow(/policy.disabled has "act"/);
    expect(() =>
      writeIdentitySettings("shop", { policy: { allowedDomains: ["example.com"] }, attach: "auto" }, sb.env),
    ).toThrow(/allowedDomains does not go with attach mode/);
  });

  it("turns run_code off always and the network tools with allowedDomains", () => {
    expect([...disabledTools({}).keys()]).toEqual(["browser_run_code_unsafe"]);
    const tools = disabledTools({ allowedDomains: ["example.com"], disabled: ["evaluate", "login"] });
    for (const t of ["browser_evaluate", "browser_login", "browser_run_code_unsafe", "browser_route"])
      expect(tools.has(t), t).toBe(true);
    expect(disabledTools(undefined).size).toBe(0);
  });
});

describe("policyRefusal", () => {
  const call = () => ({
    id: "shop",
    policy: { allowedDomains: ["example.com"] },
    cwd: sb.home,
    env: sb.env,
  });

  it("refuses a navigation to another host with the host and the allowed list", () => {
    expect(policyRefusal(call(), "browser_navigate", { url: "https://example.com/a" })).toBeUndefined();
    const refused = policyRefusal(call(), "browser_navigate", { url: "evil.test/x" });
    expect(refused).toContain("evil.test");
    expect(refused).toContain("example.com");
    expect(policyRefusal(call(), "browser_tabs", { action: "new", url: "https://evil.test" })).toContain("evil.test");
    expect(policyRefusal(call(), "browser_tabs", { action: "new", isolatedContext: "other" })).toContain(
      "isolatedContext",
    );
  });

  it("refuses a file argument inside turno's own folders, by any path", () => {
    writeIdentitySettings("shop", { policy: { allowedDomains: ["example.com"] } }, sb.env);
    const file = identitySettingsPath("shop", sb.env);
    expect(policyRefusal(call(), "browser_evaluate", { function: "() => 1", filename: file })).toContain(
      "turno's own folders",
    );
    expect(
      policyRefusal({ ...call(), cwd: `${sb.home}/.local` }, "browser_snapshot", { filename: "share/turno/x.md" }),
    ).toContain("turno's own folders");
    expect(policyRefusal(call(), "browser_snapshot", { filename: "page.md" })).toBeUndefined();
  });
});

describe("the vault under a policy", () => {
  it("refuses what the policy turns off before reading the secret store", async () => {
    addIdentity("shop", sb.env);
    writeIdentitySettings("shop", { policy: { disabled: ["login"], autoSubmit: false } }, sb.env);
    expect(() => vaultSetSubmit("shop", "auto", { env: sb.env })).toThrow(/autoSubmit/);
    expect(vaultSetSubmit("shop", "confirm", { env: sb.env })).toBe("confirm");
    await expect(
      vaultAdd(
        "shop",
        "site",
        { urls: ["https://example.com/login"], username: "alice", password: "x" },
        { env: sb.env },
      ),
    ).rejects.toThrow(/"login" in its policy/);
  });
});
