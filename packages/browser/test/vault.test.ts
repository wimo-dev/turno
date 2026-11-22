import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretStore } from "turno-core/secrets";
import { addIdentity, removeIdentity } from "../src/identities.js";
import { totp } from "../src/totp.js";
import {
  VaultError,
  originAllowed,
  readCredential,
  vaultAdd,
  vaultClear,
  vaultHasSites,
  vaultItem,
  vaultList,
  vaultOrigin,
  vaultPath,
  vaultRemove,
  vaultSetSubmit,
  vaultSite,
} from "../src/vault.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

let sb: Sandbox;
let fake: FakeSecretStore;
beforeEach(() => {
  sb = sandbox();
  fake = fakeSecretStore(sb);
  addIdentity("work", sb.env);
});
afterEach(() => sb.cleanup());

const PASSWORD = 'c0rrect horse "battery" staple';
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const opts = () => ({ env: sb.env, store: secretStore(sb.env, "darwin")! });

describe("the credential vault", () => {
  it("keeps the values in the secret store and only names and origins in the index", async () => {
    const site = await vaultAdd(
      "work",
      "github",
      {
        urls: ["https://github.com/login", "https://github.com/session"],
        username: "alice@example.com",
        password: PASSWORD,
        totp: TOTP_SECRET,
      },
      opts(),
    );
    expect(site).toMatchObject({ site: "github", origins: ["https://github.com"], totp: true });
    const index = readFileSync(vaultPath("work", sb.env), "utf8");
    expect(index).not.toContain("alice");
    expect(index).not.toContain("battery");
    expect(index).not.toContain(TOTP_SECRET);
    expectMode(vaultPath("work", sb.env), 0o600);
    expect(fake.services()).toEqual([vaultItem("work", "github")]);
    expect(fake.read(vaultItem("work", "github"))).not.toContain("\n");
    const cred = await readCredential("work", "github", opts());
    expect(cred.username === "alice@example.com" && cred.password === PASSWORD).toBe(true);
    expect(cred.totp).toMatchObject({ algorithm: "SHA1", digits: 6, period: 30 });
    expect(totp(cred.totp!, 0)).toMatch(/^\d{6}$/);
  });

  it("lists sites without reading a value, and says when an item went missing", async () => {
    await vaultAdd(
      "work",
      "github",
      { urls: ["https://github.com/login"], username: "alice", password: PASSWORD },
      opts(),
    );
    await vaultAdd(
      "work",
      "mail",
      { urls: ["https://mail.example.com"], username: "alice", password: PASSWORD },
      opts(),
    );
    let info = await vaultList("work", opts());
    expect(info.submit).toBe("confirm");
    expect(info.sites.map((s) => [s.site, s.stored, s.totp])).toEqual([
      ["github", true, false],
      ["mail", true, false],
    ]);
    fake.remove(vaultItem("work", "mail"));
    info = await vaultList("work", opts());
    expect(info.sites.find((s) => s.site === "mail")?.stored).toBe(false);
    await expect(readCredential("work", "mail", opts())).rejects.toThrow(/missing from the secret store/);
  });

  it("replaces a site's credentials by deleting the item first, keeping its creation date", async () => {
    const first = await vaultAdd(
      "work",
      "github",
      { urls: ["https://github.com"], username: "alice", password: "first-pass" },
      { ...opts(), now: new Date("2026-01-01T00:00:00Z") },
    );
    const second = await vaultAdd(
      "work",
      "github",
      { urls: ["https://github.com"], username: "alice", password: "second-pass" },
      { ...opts(), now: new Date("2026-02-01T00:00:00Z") },
    );
    expect(second.created).toBe(first.created);
    expect(second.updated).toBe("2026-02-01T00:00:00.000Z");
    expect((await readCredential("work", "github", opts())).password === "second-pass").toBe(true);
  });

  it("removes one site, then everything, and refuses to remove an identity that still has credentials", async () => {
    await vaultAdd("work", "github", { urls: ["https://github.com"], username: "alice", password: PASSWORD }, opts());
    await vaultAdd(
      "work",
      "mail",
      { urls: ["https://mail.example.com"], username: "alice", password: PASSWORD },
      opts(),
    );
    expect(await vaultRemove("work", "github", opts())).toBe(true);
    expect(await vaultRemove("work", "github", opts())).toBe(false);
    expect(vaultHasSites("work", sb.env)).toBe(true);
    expect(() => removeIdentity("work", sb.env)).toThrow(/still has vault credentials/);
    expect(await vaultClear("work", opts())).toBe(1);
    expect(fake.services()).toEqual([]);
    removeIdentity("work", sb.env);
  });

  it("binds credentials to https origins (http only on this machine)", async () => {
    expect(vaultOrigin("https://github.com/login?x=1")).toBe("https://github.com");
    expect(vaultOrigin("http://127.0.0.1:8080/login")).toBe("http://127.0.0.1:8080");
    expect(() => vaultOrigin("http://github.com/login")).toThrow(/only https/);
    expect(() => vaultOrigin("javascript:alert(1)")).toThrow(VaultError);
    expect(() => vaultOrigin("not a url")).toThrow(/not a URL/);
    const site = { origins: ["https://github.com"] };
    expect(originAllowed(site, "https://github.com/login")).toBe(true);
    expect(originAllowed(site, "https://github.com.evil.example/login")).toBe(false);
    expect(originAllowed(site, "https://gist.github.com/")).toBe(false);
    expect(originAllowed(site, "about:blank")).toBe(false);
  });

  it("validates input without echoing a value", async () => {
    const add = (over: object) =>
      vaultAdd(
        "work",
        "github",
        { urls: ["https://github.com"], username: "alice", password: PASSWORD, ...over },
        opts(),
      );
    await expect(add({ password: "" })).rejects.toThrow(/password is empty/);
    await expect(add({ urls: [] })).rejects.toThrow(/--url/);
    const err = await add({ totp: "not-a-secret!" }).catch((e: unknown) => e);
    expect(String(err)).not.toContain("not-a-secret");
    await expect(
      vaultAdd("work", "Bad Site", { urls: ["https://x.example"], username: "a", password: "b" }, opts()),
    ).rejects.toThrow(/invalid site key/);
    await expect(
      vaultAdd("nobody", "github", { urls: ["https://github.com"], username: "a", password: "b" }, opts()),
    ).rejects.toThrow(/does not exist/);
    expect(fake.services()).toEqual([]);
  });

  it("records the submit policy per identity", async () => {
    expect(vaultSetSubmit("work", "auto", { env: sb.env })).toBe("auto");
    await vaultAdd("work", "github", { urls: ["https://github.com"], username: "alice", password: PASSWORD }, opts());
    expect(vaultSite("work", "github", sb.env)?.submit).toBe("auto");
    expect(() => vaultSetSubmit("work", "always" as never, { env: sb.env })).toThrow(/confirm/);
  });

  it("refuses an index written by a newer turno-browser", async () => {
    sb.write(
      ".local/share/turno/browser/identities/work.vault.json",
      JSON.stringify({ version: 2, submit: "confirm", sites: {} }),
    );
    await expect(vaultList("work", opts())).rejects.toThrow(/newer turno-browser/);
  });
});
