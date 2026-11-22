import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookieHosts } from "../src/cookie-hosts.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** The host names of a profile's cookies, for `status`: never a name or a value. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A cookie store shaped like Chrome's, with a value that must never come out. */
function store(profile: string, rel: string, hosts: string[]): void {
  mkdirSync(join(profile, rel, ".."), { recursive: true });
  const db = new DatabaseSync(join(profile, rel));
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)");
  const insert = db.prepare("INSERT INTO cookies VALUES (?, 'session', 'secret-value', x'00')");
  for (const h of hosts) insert.run(h);
  db.close();
}

describe("cookie hosts", () => {
  it("lists each host once, without its leading dot, sorted, from either location", async () => {
    expect(await cookieHosts(join(sb.home, "none"), false)).toEqual({ hosts: [] });
    const older = join(sb.home, "older");
    store(older, "Default/Cookies", ["school.example.edu"]);
    expect(await cookieHosts(older, false)).toEqual({ hosts: ["school.example.edu"] });
    const profile = join(sb.home, "profile");
    store(profile, "Default/Network/Cookies", [".github.com", "github.com", "accounts.google.com", ".example.org"]);
    const r = await cookieHosts(profile, false);
    expect(r).toEqual({ hosts: ["accounts.google.com", "example.org", "github.com"] });
    expect(JSON.stringify(r)).not.toContain("secret-value");
  });

  it("does not open the store while Chrome has the profile, and names a broken one", async () => {
    const profile = join(sb.home, "busy");
    store(profile, "Default/Network/Cookies", ["github.com"]);
    expect(await cookieHosts(profile, true)).toHaveProperty("note");
    const broken = join(sb.home, "broken");
    sb.write("broken/Default/Network/Cookies", "not a database");
    expect(await cookieHosts(broken, false)).toHaveProperty("note");
  });
});
