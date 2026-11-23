import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserFunctions } from "../../src/api.js";
import { identityDir, identityStateDir } from "../../src/ids.js";
import { touchLastUsed } from "../../src/last-used.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";
import { cli, fakeIo, real } from "./helpers.js";

/** `turno-browser status`: every identity at a glance, read only, never a secret or a cookie value. */

let sb: Sandbox;
let api: BrowserFunctions;
beforeEach(async () => {
  sb = sandbox();
  api = await real();
});
afterEach(() => sb.cleanup());

function school(): void {
  api.addIdentity("school", sb.env);
  api.writeIdentitySettings(
    "school",
    { timezone: "America/Monterrey", languages: ["es-MX", "en"], humanize: { level: "light" }, resources: "low" },
    sb.env,
  );
  mkdirSync(identityStateDir("school", sb.env), { recursive: true });
  writeFileSync(
    join(identityStateDir("school", sb.env), "login.json"),
    JSON.stringify({ at: "2026-11-19T15:00:00.000Z", sites: ["canvas.example.edu"] }),
  );
  mkdirSync(join(identityDir("school", sb.env), "Default", "Network"), { recursive: true });
  const db = new DatabaseSync(join(identityDir("school", sb.env), "Default", "Network", "Cookies"));
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT)");
  db.exec("INSERT INTO cookies VALUES ('.canvas.example.edu', 'sid', 'cookie-value-never-shown')");
  db.close();
  touchLastUsed("school", sb.env, new Date("2026-11-20T18:00:00.000Z"));
  sb.write(
    ".claude.json",
    JSON.stringify({
      mcpServers: {
        "browser-school": { command: "turno-browser-mcp", args: ["--identity", "school"] },
        "browser-use": { command: "uvx", args: ["browser-use", "--mcp"] },
      },
    }),
  );
}

describe("turno-browser status", () => {
  it("reports each identity as JSON (settings, sign-ins, cookie hosts, last use, agents), or the one asked for", async () => {
    school();
    api.addIdentity("work", sb.env);
    const io = fakeIo(sb.env);
    expect(await cli(api).run("status", ["--json"], io)).toBe(0);
    const text = io.lines.join("\n");
    expect(text).not.toContain("cookie-value-never-shown");
    const r = JSON.parse(text);
    expect(r.schemaVersion).toBeDefined();
    expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.identities.map((i: { id: string }) => i.id)).toEqual(["school", "work"]);
    expect(r.identities[0]).toMatchObject({
      id: "school",
      profile: join("~", identityDir("school", sb.env).slice(sb.home.length + 1)),
      settings: {
        timezone: "America/Monterrey",
        languages: ["es-MX", "en"],
        humanize: "light",
        sharing: "session",
        resources: "low",
      },
      inUse: false,
      holder: null,
      vault: { sites: [], submit: "confirm" },
      signedIn: { at: "2026-11-19T15:00:00.000Z", sites: ["canvas.example.edu"] },
      cookieHosts: ["canvas.example.edu"],
      lastUsed: "2026-11-20T18:00:00.000Z",
      agents: [{ agent: "claude-code", server: "browser-school", file: join("~", ".claude.json") }],
    });
    expect(r.identities[1].settings.resources).toBe("normal");
    expect(r.identities[1]).toMatchObject({ id: "work", signedIn: null, cookieHosts: [], lastUsed: null, agents: [] });

    const one = fakeIo(sb.env);
    expect(await cli(api).run("status", ["school", "--json"], one)).toBe(0);
    expect(JSON.parse(one.lines.join("\n")).identities.map((i: { id: string }) => i.id)).toEqual(["school"]);
    const human = fakeIo(sb.env);
    expect(await cli(api).run("status", ["school"], human)).toBe(0);
    expect(human.lines.join("\n")).toContain("low-resource preset");
    await expect(cli(api).run("status", ["nobody"], fakeIo(sb.env))).rejects.toThrow(/does not exist/);
  });
});
