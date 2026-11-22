import { type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { addIdentity, identityExists } from "../src/identities.js";
import { seal } from "../src/sealed.js";
import { exportSession, importSession, profileOrigins, readSessionExport } from "../src/session-export.js";
import { chromeEnv, keychainArgs, readIdentitySettings, writeIdentitySettings } from "../src/settings.js";
import { vaultAdd } from "../src/vault.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const PASS = "a long enough passphrase";
const reason = chromeUnavailable();

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

const state = (cookies = 1) => ({
  cookies: Array.from({ length: cookies }, (_, i) => ({
    name: `c${i}`,
    value: "v",
    domain: "127.0.0.1",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  })),
  origins: [],
});

describe("reading a session export", () => {
  it("enforces the expiry inside the encrypted payload", async () => {
    const payload = {
      kind: "turno-browser-session",
      identity: "work",
      createdAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-11-08T00:00:00.000Z",
      storageState: state(2),
    };
    const text = await seal(payload, PASS);
    const { summary } = await readSessionExport(text, PASS, new Date("2026-11-07T23:59:00Z"));
    expect(summary).toEqual({
      identity: "work",
      createdAt: payload.createdAt,
      expiresAt: payload.expiresAt,
      cookies: 2,
      origins: 0,
    });
    await expect(readSessionExport(text, PASS, new Date("2026-11-08T00:00:01Z"))).rejects.toThrow(
      /expired on 2026-11-08T00:00:00.000Z/,
    );
  }, 30_000);

  it("refuses a sealed file that is not a session", async () => {
    await expect(readSessionExport(await seal({ hello: 1 }, PASS), PASS)).rejects.toThrow(/not a session/);
  }, 30_000);

  it("refuses an expiry past 90 days before opening Chrome", async () => {
    addIdentity("work", sb.env);
    await expect(
      exportSession("work", { passphrase: PASS, expiresInMs: 91 * 24 * 3600_000, env: sb.env }),
    ).rejects.toThrow(/at most 90 days/);
    await expect(exportSession("nobody", { passphrase: PASS, env: sb.env })).rejects.toThrow(/does not exist/);
  });
});

describe("the origins an export opens", () => {
  it("come from IndexedDB folders, Local Storage keys and cookie hosts, deduplicated", () => {
    sb.write("p/Default/IndexedDB/https_app.example.com_0.indexeddb.leveldb/CURRENT", "x");
    sb.write("p/Default/IndexedDB/http_127.0.0.1_51798.indexeddb.leveldb/CURRENT", "x");
    sb.write("p/Default/IndexedDB/not-an-origin/CURRENT", "x");
    sb.write(
      "p/Default/Local Storage/leveldb/000003.log",
      "\u0000META:https://mail.example.com\u0000_https://app.example.com\u0000\u0001pref",
    );
    const origins = profileOrigins(`${sb.home}/p`, [
      { domain: ".example.org", secure: true },
      { domain: "127.0.0.1", secure: false },
    ]);
    expect(origins.sort()).toEqual(
      [
        "http://127.0.0.1",
        "http://127.0.0.1:51798",
        "https://127.0.0.1",
        "https://app.example.com",
        "https://example.org",
        "https://mail.example.com",
      ].sort(),
    );
    expect(profileOrigins(`${sb.home}/missing`, [])).toEqual([]);
  });
});

describe("the keychain setting (identity.json format 3)", () => {
  it("drops the mock keychain switches only for system, and is format 3", () => {
    expect(keychainArgs(undefined)).toEqual({});
    expect(keychainArgs({ keychain: "mock" })).toEqual({});
    expect(keychainArgs({ keychain: "system" })).toEqual({
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    });
    addIdentity("work", sb.env);
    const written = writeIdentitySettings("work", { keychain: "system" }, sb.env);
    expect(written.version).toBe(3);
    expect(readIdentitySettings("work", sb.env)?.keychain).toBe("system");
    expect(() => writeIdentitySettings("work", { keychain: "os" as never }, sb.env)).toThrow(/keychain must be "mock"/);
    expect(writeIdentitySettings("work", { keychain: null }, sb.env).version).toBe(1);
  });
});

/** A page on 127.0.0.1 that sets a cookie, a localStorage item and an IndexedDB record. */
async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/set") {
      res.setHeader("set-cookie", "sid=cookie-value-42; Max-Age=86400; Path=/; HttpOnly");
      res.end(`<title>set</title><script>
        localStorage.setItem("pref", "local-value-7");
        const open = indexedDB.open("app", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("kv");
        open.onsuccess = () => { const tx = open.result.transaction("kv", "readwrite"); tx.objectStore("kv").put("idb-value-9", "k"); tx.oncomplete = () => { document.title = "stored"; }; };
      </script>`);
      return;
    }
    res.end(`<title>read</title><script>
      const open = indexedDB.open("app", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onsuccess = () => { const r = open.result.transaction("kv").objectStore("kv").get("k"); r.onsuccess = () => { document.title = [localStorage.getItem("pref"), r.result].join("|"); }; };
    </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe.skipIf(reason !== undefined)(
  reason ? `session export and import on real Chrome (skipped: ${reason})` : "session export and import on real Chrome",
  () => {
    it("moves cookies, localStorage and IndexedDB to another identity, and never the vault", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      fakeSecretStore(sb);
      addIdentity("source", sb.env);
      await vaultAdd(
        "source",
        "local",
        { urls: [web.url], username: "vault-user-name", password: "vault-password-value" },
        { env: sb.env },
      );
      const { chromium } = await import("patchright-core");
      const { identityDir } = await import("../src/ids.js");
      const ctx = await chromium.launchPersistentContext(identityDir("source", sb.env), {
        channel: "chrome",
        headless: true,
        env: chromeEnv(sb.env),
      });
      const page = await ctx.newPage();
      await page.goto(`${web.url}/set`);
      await page.waitForFunction(() => document.title === "stored");
      await ctx.close();

      const { sealed, summary } = await exportSession("source", { passphrase: PASS, env: sb.env });
      expect(summary.cookies).toBeGreaterThanOrEqual(1);
      expect(summary.origins).toBe(1);
      for (const v of ["cookie-value-42", "local-value-7", "idb-value-9", "vault-user-name", "vault-password-value"])
        expect(sealed.includes(v), "plain value in the file").toBe(false);
      const { payload } = await readSessionExport(sealed, PASS);
      const inside = JSON.stringify(payload);
      expect(inside).toContain("cookie-value-42");
      expect(inside).toContain("local-value-7");
      expect(inside).toContain("idb-value-9");
      expect(
        inside.includes("vault-password-value") || inside.includes("vault-user-name"),
        "vault values in the export",
      ).toBe(false);

      const done = await importSession(sealed, { passphrase: PASS, as: "copy", env: sb.env });
      expect(done).toMatchObject({ identity: "copy", created: true });
      expect(identityExists("copy", sb.env)).toBe(true);
      const ctx2 = await chromium.launchPersistentContext(identityDir("copy", sb.env), {
        channel: "chrome",
        headless: true,
        env: chromeEnv(sb.env),
      });
      const cookies = await ctx2.cookies(web.url);
      expect(cookies.find((c) => c.name === "sid")?.value === "cookie-value-42").toBe(true);
      const page2 = await ctx2.newPage();
      await page2.goto(`${web.url}/read`);
      await page2.waitForFunction(() => document.title.includes("|"));
      expect(await page2.title()).toBe("local-value-7|idb-value-9");
      await ctx2.close();
    }, 120_000);
  },
);
