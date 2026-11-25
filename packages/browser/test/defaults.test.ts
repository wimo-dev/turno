import { readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DefaultsContext, describeEffective, resolveDefaults } from "../src/defaults.js";
import { effectiveSettings } from "../src/effective.js";
import { writeDetectedHealth } from "../src/health-detect.js";
import { identitySettingsPath, writeIdentitySettings } from "../src/settings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The defaults of an identity (`defaults.ts`): resolved at every launch from the context,
 * never written to identity.json, and always below what identity.json says.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const HEADLESS: DefaultsContext = { identity: true, headless: true, engine: "chrome", pressure: "normal" };

describe("an identity without keys", () => {
  it("gets the new defaults, each with where it came from", () => {
    const e = resolveDefaults(undefined, { ...HEADLESS, systemLocale: "es-MX" }, { live: true });
    expect(e.live.value).toBe(true);
    expect(e.resources).toEqual({ value: "normal", origin: { from: "auto", because: "no memory pressure" } });
    expect(e.humanize.value).toBe("auto");
    expect(e.sharing.value).toBe("tabs");
    expect(e.userAgent.value).toBe("coherent");
    expect(e.locale.value).toBe("es-MX");
    expect(e.keychain.value).toBe("mock");
    expect(e.record.flows.value).toBe(true);
    expect(e.record.screenshots.value).toBe(true);
    expect(e.record.traces.value).toBe("failed");
    expect([e.caps.vision, e.caps.pdf, e.caps.devtools, e.caps.network].map((c) => c.value)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(e.submit.value).toBe("auto");
    // The live view is on, so throttling stays off: the view needs frames.
    expect(e.backgroundThrottling.value).toBe(false);
    expect(
      describeEffective("resources", resolveDefaults(undefined, { ...HEADLESS, pressure: "warn" }).resources),
    ).toBe("resources: low (auto: memory pressure)");
  });

  it("keeps what depends on the launch, the engine or the policy apart", () => {
    const attach = resolveDefaults(undefined, { identity: true, engine: "attach" });
    expect(attach.sharing).toEqual({ value: "session", origin: { from: "auto", because: "attach mode" } });
    expect(attach.record.screenshots.value).toBe(false);
    expect(resolveDefaults(undefined, { identity: true, engine: "lightpanda" }).humanize.value).toBe("off");
    const policed = resolveDefaults(undefined, {
      ...HEADLESS,
      policy: { allowedDomains: ["example.com"], autoSubmit: false },
    });
    expect(policed.caps.network.value).toBe(false);
    expect(policed.submit.value).toBe("confirm");
    // No server yet: the CLI reports the rule, not a guess.
    const cli = resolveDefaults(undefined, { identity: true, engine: "chrome" });
    expect(cli.resources.value).toBeUndefined();
    expect(cli.userAgent.origin.from).toBe("launch");
  });
});

describe("identity.json wins over a default", () => {
  it("with an explicit false, or a value, for every key that has a default", () => {
    const e = resolveDefaults(
      {
        live: { enabled: false },
        userAgent: false,
        locale: false,
        health: false,
        sharing: "session",
        humanize: { level: "off" },
        resources: "normal",
        backgroundThrottling: false,
        record: { flows: false, screenshots: false, traces: false },
      },
      {
        ...HEADLESS,
        pressure: "critical",
        systemLocale: "es-MX",
        detectedHealth: { url: "https://x.test/", selector: "a" },
      },
    );
    expect(e.live).toEqual({ value: false, origin: { from: "file" } });
    expect(e.userAgent.value).toBe("off");
    expect(e.locale.value).toBe(false);
    expect(e.health.value).toBe(false);
    expect(e.sharing.value).toBe("session");
    expect(e.humanize.value).toBe("off");
    expect(e.resources.value).toBe("normal");
    expect(e.backgroundThrottling.value).toBe(false);
    expect([e.record.flows, e.record.screenshots, e.record.traces].map((v) => v.value)).toEqual([false, false, false]);
    for (const v of [e.live, e.userAgent, e.locale, e.health, e.sharing, e.humanize, e.resources])
      expect(v.origin.from).toBe("file");
  });
});

describe("the resolver", () => {
  it("never writes identity.json, with or without one", () => {
    const path = identitySettingsPath("work", sb.env);
    effectiveSettings("fresh", { env: sb.env });
    expect(() => statSync(identitySettingsPath("fresh", sb.env))).toThrow();

    writeIdentitySettings("work", { timezone: "America/Monterrey" }, sb.env);
    writeDetectedHealth("work", sb.env, { url: "https://example.com/account", selector: "a[href*=logout]" });
    const before = readFileSync(path, "utf8");
    const mtime = statSync(path).mtimeMs;
    const e = effectiveSettings("work", { env: sb.env, pressure: "warn" });
    expect(e.health.origin).toEqual({ from: "auto", because: "detected after the last login" });
    expect(e.resources.value).toBe("low");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });
});
