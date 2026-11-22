import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIdentity, identityDir, removeIdentity } from "../src/identities.js";
import {
  IDENTITY_FORMAT_VERSION,
  acceptLanguages,
  checkIdentitySettings,
  identitySettingsPath,
  launchSettings,
  readIdentitySettings,
  writeIdentitySettings,
} from "../src/settings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * identity.json: the settings that stay fixed for one browser identity (timezone, languages,
 * region, a session health check), stored next to the Chrome profile, never inside it.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const T0 = new Date("2026-11-17T16:00:00.000Z");
const T1 = new Date("2026-11-18T09:30:00.000Z");

describe("identity.json location", () => {
  it("lives next to the profile directory, not inside it", () => {
    const file = identitySettingsPath("school", sb.env);
    expect(file).toBe(join(sb.home, ".local", "share", "turno", "browser", "identities", "school.json"));
    expect(file.startsWith(`${identityDir("school", sb.env)}/`)).toBe(false);
  });

  it("is optional: no file means no settings and Chrome's own defaults", () => {
    // An identity made before identity.json existed: only the profile dir.
    mkdirSync(identityDir("plain", sb.env), { recursive: true });
    expect(readIdentitySettings("plain", sb.env)).toBeUndefined();
    expect(checkIdentitySettings("plain", sb.env)).toEqual({
      path: identitySettingsPath("plain", sb.env),
      problems: [],
    });
    expect(launchSettings(undefined, [], "Europe/Madrid")).toEqual({ args: [] });
  });
});

describe("writeIdentitySettings", () => {
  it("creates the file with the schema version and timestamps, mode 600", () => {
    const s = writeIdentitySettings(
      "school",
      { timezone: "Europe/Madrid", languages: ["es-ES", "es", "en"], region: "es" },
      sb.env,
      T0,
    );
    expect(s).toEqual({
      version: 1,
      timezone: "Europe/Madrid",
      languages: ["es-ES", "es", "en"],
      region: "ES",
      created: T0.toISOString(),
      updated: T0.toISOString(),
    });
    const file = identitySettingsPath("school", sb.env);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(s);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readIdentitySettings("school", sb.env)).toEqual(s);
  });

  it("merges a patch, keeps created, bumps updated and removes keys set to null", () => {
    writeIdentitySettings("school", { timezone: "Europe/Madrid", locale: "es-ES" }, sb.env, T0);
    const s = writeIdentitySettings(
      "school",
      { locale: null, health: { url: "https://mail.example.com/", text: "Inbox" } },
      sb.env,
      T1,
    );
    expect(s).toEqual({
      version: 1,
      timezone: "Europe/Madrid",
      health: { url: "https://mail.example.com/", text: "Inbox" },
      created: T0.toISOString(),
      updated: T1.toISOString(),
    });
  });

  it("canonicalizes locales and refuses bad values without writing", () => {
    expect(writeIdentitySettings("school", { locale: "es-mx" }, sb.env, T0).locale).toBe("es-MX");
    const before = readFileSync(identitySettingsPath("school", sb.env), "utf8");
    expect(() => writeIdentitySettings("school", { timezone: "Mars/Olympus" }, sb.env, T1)).toThrow(
      /timezone "Mars\/Olympus" is not an IANA time zone/,
    );
    expect(() => writeIdentitySettings("school", { locale: "not a locale!" }, sb.env, T1)).toThrow(
      /locale "not a locale!"/,
    );
    expect(() => writeIdentitySettings("school", { languages: [] }, sb.env, T1)).toThrow(
      /languages needs at least one/,
    );
    expect(() => writeIdentitySettings("school", { region: "Mexico" }, sb.env, T1)).toThrow(
      /region "Mexico" must be a two-letter country code/,
    );
    expect(() =>
      writeIdentitySettings("school", { health: { url: "file:///etc/passwd", text: "x" } }, sb.env, T1),
    ).toThrow(/health.url must start with http/);
    expect(() => writeIdentitySettings("school", { health: { url: "https://example.com/" } }, sb.env, T1)).toThrow(
      /health needs text or selector/,
    );
    expect(readFileSync(identitySettingsPath("school", sb.env), "utf8")).toBe(before);
  });

  it("writes humanize as format 4, checks its level and seed, and goes back to the lower format without it", () => {
    const written = writeIdentitySettings("school", { humanize: { level: "light" } }, sb.env, T0);
    expect(written.version).toBe(4);
    expect(written.humanize).toEqual({ level: "light" });
    expect(writeIdentitySettings("school", { humanize: { level: "full", seed: 42 } }, sb.env, T1).humanize).toEqual({
      level: "full",
      seed: 42,
    });
    expect(() => writeIdentitySettings("school", { humanize: { level: "max" as never } }, sb.env, T1)).toThrow(
      /humanize.level must be "off", "light", "full", "adaptive"/,
    );
    expect(() => writeIdentitySettings("school", { humanize: { level: "light", seed: -1 } }, sb.env, T1)).toThrow(
      /humanize.seed must be a whole number/,
    );
    expect(() =>
      writeIdentitySettings("school", { humanize: { level: "light", speed: 2 } as never }, sb.env, T1),
    ).toThrow(/unknown key "humanize.speed"/);
    expect(() => writeIdentitySettings("school", { humanize: "light" as never }, sb.env, T1)).toThrow(
      /humanize must be an object/,
    );
    const removed = writeIdentitySettings("school", { humanize: null, timezone: "UTC" }, sb.env, T1);
    expect(removed.humanize).toBeUndefined();
    expect(removed.version).toBe(1);
  });

  it("rejects an invalid identity id before touching the disk", () => {
    expect(() => writeIdentitySettings("../x", { timezone: "UTC" }, sb.env, T0)).toThrow(/invalid identity/);
  });
});

describe("reading and checking", () => {
  it("reports a file that is not JSON or breaks the schema, with the path", () => {
    addIdentity("bad", sb.env);
    const file = identitySettingsPath("bad", sb.env);
    writeFileSync(file, "{ nope");
    expect(() => readIdentitySettings("bad", sb.env)).toThrow(/identity\.json of "bad" .* is not valid JSON/);
    expect(checkIdentitySettings("bad", sb.env).problems).toEqual([expect.stringMatching(/not valid JSON/)]);

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        timezone: 5,
        languages: "es",
        created: "x",
        updated: T0.toISOString(),
        extra: true,
      }),
    );
    const { problems } = checkIdentitySettings("bad", sb.env);
    expect(problems).toEqual([
      "timezone must be a string",
      "languages must be a list of language tags",
      "created must be an ISO date",
      'unknown key "extra"',
    ]);
    expect(() => readIdentitySettings("bad", sb.env)).toThrow(/timezone must be a string/);
  });

  it("refuses a newer schema version instead of guessing", () => {
    addIdentity("newer", sb.env);
    writeFileSync(
      identitySettingsPath("newer", sb.env),
      JSON.stringify({ version: 99, created: T0.toISOString(), updated: T0.toISOString() }),
    );
    expect(checkIdentitySettings("newer", sb.env).problems).toEqual([
      `is format 99, from a newer turno-browser (this one reads up to ${IDENTITY_FORMAT_VERSION}); update turno-browser`,
    ]);
  });

  it("writes format 2 only while a browser key (tabs, backgroundThrottling) is set", () => {
    const s = writeIdentitySettings(
      "tuned",
      { tabs: { max: 4, popups: "keep", park: "2m", close: "0" }, backgroundThrottling: true },
      sb.env,
      T0,
    );
    expect(s).toEqual({
      version: 2,
      tabs: { max: 4, popups: "keep", park: "2m", close: "0" },
      backgroundThrottling: true,
      created: T0.toISOString(),
      updated: T0.toISOString(),
    });
    expect(readIdentitySettings("tuned", sb.env)).toEqual(s);
    expect(writeIdentitySettings("tuned", { tabs: null, backgroundThrottling: null }, sb.env, T1).version).toBe(1);
  });

  it("names every bad browser key and leaves the file as it was", () => {
    expect(() =>
      writeIdentitySettings(
        "tuned",
        {
          tabs: { max: -1, popups: "never" as "keep", park: "soon", close: "5x" },
          backgroundThrottling: "yes" as unknown as boolean,
        },
        sb.env,
      ),
    ).toThrow(
      /tabs\.max must be a whole number from 0 \(no cap\) to 100; tabs\.popups must be "close" or "keep"; tabs\.park must be a duration like "5m" or "0" \(off\); tabs\.close must be a duration.*; backgroundThrottling must be true or false/,
    );
    addIdentity("odd", sb.env);
    writeFileSync(
      identitySettingsPath("odd", sb.env),
      JSON.stringify({ version: 2, tabs: { size: 3 }, created: T0.toISOString(), updated: T0.toISOString() }),
    );
    expect(checkIdentitySettings("odd", sb.env).problems).toEqual(['unknown key "tabs.size"']);
  });

  it("checks settle, block and cache", () => {
    expect(() =>
      writeIdentitySettings(
        "res",
        {
          settle: "11s",
          block: { trackers: "yes" as unknown as boolean, types: ["script" as "image"], patterns: ["has space"] },
          cache: { maxSize: "5GBs" },
        },
        sb.env,
      ),
    ).toThrow(
      /settle must be a duration from "0" to "10s".*; block\.trackers must be true or false; block\.types must be a list of "image", "media", "font"; block\.patterns must be a list of host names.*; cache\.maxSize must be a size from "1MB" to "10GB"/,
    );
    const ok = writeIdentitySettings(
      "res",
      {
        settle: "0",
        block: { trackers: true, types: ["image", "font"], patterns: ["ads.example", "*/promo/*"] },
        cache: { maxSize: "200MB" },
      },
      sb.env,
    );
    expect(ok.version).toBe(2);
    expect(readIdentitySettings("res", sb.env)?.cache).toEqual({ maxSize: "200MB" });
  });

  it("writes format 5 only while sharing is set, and takes only session or tabs", () => {
    const s = writeIdentitySettings("team", { sharing: "tabs", settle: "100ms" }, sb.env, T0);
    expect(s).toEqual({
      version: 5,
      settle: "100ms",
      sharing: "tabs",
      created: T0.toISOString(),
      updated: T0.toISOString(),
    });
    expect(readIdentitySettings("team", sb.env)?.sharing).toBe("tabs");
    expect(() => writeIdentitySettings("team", { sharing: "all" as "tabs" }, sb.env)).toThrow(
      'sharing must be "session" (the default, one agent session at a time) or "tabs"',
    );
    expect(writeIdentitySettings("team", { sharing: null }, sb.env, T1).version).toBe(2);
  });

  it("checks record (format 7), writes format 7 only while it is set, and refuses traces or screenshots with attach or read mode", () => {
    expect(() =>
      writeIdentitySettings(
        "rec",
        { record: { flows: "yes" as unknown as boolean, maxSize: "1MB", video: true } as never },
        sb.env,
      ),
    ).toThrow(
      /record\.flows must be true or false; record\.maxSize must be a size from "10MB" to "10GB".*; unknown key "record\.video"/,
    );
    const on = writeIdentitySettings("rec", { record: { flows: true, traces: true, maxSize: "50MB" } }, sb.env);
    expect(on.version).toBe(7);
    expect(readIdentitySettings("rec", sb.env)?.record).toEqual({ flows: true, traces: true, maxSize: "50MB" });
    expect(() => writeIdentitySettings("rec", { attach: "auto" }, sb.env)).toThrow(
      /record\.traces do not go with attach mode: a trace or screenshot could show your own tabs/,
    );
    expect(() => writeIdentitySettings("rec", { engine: "lightpanda" }, sb.env)).toThrow(
      /record\.traces do not go with engine "lightpanda": read mode renders no page/,
    );
    expect(writeIdentitySettings("rec", { record: { flows: true }, engine: "lightpanda" }, sb.env).version).toBe(7);
    expect(writeIdentitySettings("rec", { record: null, engine: null }, sb.env).version).toBe(1);
  });

  it("checks live (format 10) and writes format 10 only while it is set; it goes with every engine", () => {
    expect(() =>
      writeIdentitySettings("view", { live: { enabled: "yes", wait: "1h", port: 1 } as never }, sb.env),
    ).toThrow(
      /live\.enabled must be true or false; live\.wait must be a duration from "5s" to "30m".*; unknown key "live\.port"/,
    );
    expect(() => writeIdentitySettings("view", { live: { wait: "2s" } }, sb.env)).toThrow(/live\.wait must be/);
    const on = writeIdentitySettings("view", { live: { enabled: true, wait: "90s" } }, sb.env);
    expect(on.version).toBe(10);
    expect(readIdentitySettings("view", sb.env)?.live).toEqual({ enabled: true, wait: "90s" });
    expect(writeIdentitySettings("view", { engine: "lightpanda" }, sb.env).version).toBe(10);
    expect(writeIdentitySettings("view", { engine: null, attach: "auto" }, sb.env).version).toBe(10);
    expect(writeIdentitySettings("view", { live: null, attach: null }, sb.env).version).toBe(1);
  });
});

describe("resources and policy (format 13)", () => {
  it("takes normal or low, writes format 13 only while it is set, and keeps an older format otherwise", () => {
    expect(writeIdentitySettings("school", { resources: "low" }, sb.env).version).toBe(13);
    expect(readIdentitySettings("school", sb.env)?.resources).toBe("low");
    expect(() => writeIdentitySettings("school", { resources: "tiny" as "low" }, sb.env)).toThrow(
      'resources must be "normal" (the default) or "low" (the low-resource preset)',
    );
    expect(writeIdentitySettings("school", { resources: null, tabs: { max: 2 } }, sb.env).version).toBe(2);
    expect(writeIdentitySettings("fox", { engine: "camoufox" }, sb.env).version).toBe(11);
  });

  it("writes format 13 while a policy is set, alone or with resources", () => {
    expect(writeIdentitySettings("shop", { policy: { disabled: ["captcha"] } }, sb.env).version).toBe(13);
    expect(writeIdentitySettings("shop", { resources: "low" }, sb.env).version).toBe(13);
    expect(writeIdentitySettings("shop", { policy: null }, sb.env).version).toBe(13);
    expect(writeIdentitySettings("shop", { resources: null }, sb.env).version).toBe(1);
  });
});

describe("tabLocks (format 9)", () => {
  it("checks the wait and the release, writes format 9 only while it is set", () => {
    expect(() =>
      writeIdentitySettings("locks", { tabLocks: { wait: "11m", release: "soon", hold: "1s" } as never }, sb.env),
    ).toThrow(
      /tabLocks\.wait must be a duration from "0" \(fail at once\) to "10m".*; tabLocks\.release must be a duration from "0" \(free between calls\) to "24h".*; unknown key "tabLocks\.hold"/,
    );
    const on = writeIdentitySettings("locks", { sharing: "tabs", tabLocks: { wait: "30s", release: "0" } }, sb.env);
    expect(on.version).toBe(9);
    expect(readIdentitySettings("locks", sb.env)?.tabLocks).toEqual({ wait: "30s", release: "0" });
    expect(writeIdentitySettings("locks", { tabLocks: null }, sb.env).version).toBe(5);
  });
});

describe("addIdentity and removeIdentity", () => {
  it("pins a new identity to the system time zone and the settings given", () => {
    addIdentity("fresh", sb.env, { languages: ["en-GB", "en"] });
    const s = readIdentitySettings("fresh", sb.env)!;
    expect(s.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(s.languages).toEqual(["en-GB", "en"]);
  });

  it("leaves an existing identity as it is unless settings are given", () => {
    // An identity made before identity.json existed: only the profile dir.
    mkdirSync(identityDir("old", sb.env), { recursive: true });
    addIdentity("old", sb.env);
    expect(existsSync(identitySettingsPath("old", sb.env))).toBe(false);

    addIdentity("pinned", sb.env, { timezone: "UTC" }, T0);
    const file = identitySettingsPath("pinned", sb.env);
    const before = readFileSync(file, "utf8");
    addIdentity("pinned", sb.env);
    expect(readFileSync(file, "utf8")).toBe(before);
    addIdentity("pinned", sb.env, { region: "MX" }, T1);
    expect(readIdentitySettings("pinned", sb.env)).toMatchObject({
      timezone: "UTC",
      region: "MX",
      created: T0.toISOString(),
      updated: T1.toISOString(),
    });
  });

  it("deletes identity.json and the identity's state with the profile", () => {
    addIdentity("gone", sb.env, { timezone: "UTC" });
    const state = join(sb.home, ".local", "state", "turno", "browser", "identities", "gone");
    sb.write(".local/state/turno/browser/identities/gone/reputation.jsonl", "{}\n");
    removeIdentity("gone", sb.env);
    expect(existsSync(identitySettingsPath("gone", sb.env))).toBe(false);
    expect(existsSync(state)).toBe(false);
  });
});

describe("launch settings", () => {
  const base = { version: 1, created: T0.toISOString(), updated: T0.toISOString() };

  it("passes languages as Chrome's own --accept-lang, so the header keeps its q-values", () => {
    expect(launchSettings({ ...base, languages: ["es-MX", "es", "en"] }, [], "UTC")).toEqual({
      args: ["--accept-lang=es-MX,es,en"],
    });
  });

  it("derives the languages from the locale, and adds --lang for Chrome's UI and Intl", () => {
    expect(acceptLanguages({ ...base, locale: "es-MX" })).toEqual(["es-MX", "es"]);
    expect(acceptLanguages({ ...base, locale: "en" })).toEqual(["en"]);
    expect(launchSettings({ ...base, locale: "es-MX" }, [], "UTC")).toEqual({
      args: ["--lang=es-MX", "--accept-lang=es-MX,es"],
    });
  });

  it("emulates the time zone only when it differs from the system's", () => {
    expect(launchSettings({ ...base, timezone: "Asia/Tokyo" }, [], "Europe/Madrid")).toEqual({
      args: [],
      timezoneId: "Asia/Tokyo",
    });
    expect(launchSettings({ ...base, timezone: "Europe/Madrid" }, [], "Europe/Madrid")).toEqual({ args: [] });
  });

  it("never overrides flags or context options the user set", () => {
    const user = ["--lang=fr", "--accept-lang=fr-FR"];
    expect(
      launchSettings({ ...base, locale: "es-MX", timezone: "Asia/Tokyo" }, user, "UTC", { timezoneId: "Europe/Paris" }),
    ).toEqual({ args: [] });
  });
});
