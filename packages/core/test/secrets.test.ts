import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DpapiOp,
  type ExecResult,
  NO_SECRET_STORE,
  SecretError,
  describeSecretStore,
  dpapiArgs,
  dpapiDir,
  dpapiFileName,
  dpapiInput,
  dpapiStore,
  keychainAddLine,
  requireSecretStore,
  secretStore,
  securityQuote,
} from "../src/secrets.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A value with every character the `security -i` quoting has to handle. */
const VALUE = `v4l"ue\\ with spaces 'and' $HOME`;

describe("secret store, against the fake security and secret-tool", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`stores, reads, checks and deletes on ${platform}, value never in argv`, async () => {
      const fake = fakeSecretStore(sb);
      const store = secretStore(sb.env, platform)!;
      expect(store.kind).toBe(platform === "darwin" ? "keychain" : "libsecret");
      expect(await store.get("turno-test/a")).toBeUndefined();
      expect(await store.has("turno-test/a")).toBe(false);
      await store.set("turno-test/a", VALUE);
      expect(fake.read("turno-test/a") === VALUE).toBe(true);
      expect((await store.get("turno-test/a")) === VALUE).toBe(true);
      expect(await store.has("turno-test/a")).toBe(true);
      expect(await store.remove("turno-test/a")).toBe(true);
      expect(await store.remove("turno-test/a")).toBe(false);
      expect(fake.services()).toEqual([]);
    });
  }

  it("reports a failed write without the value", async () => {
    const fake = fakeSecretStore(sb);
    fake.failWrites(true);
    const err = await secretStore(sb.env, "darwin")!
      .set("turno-test/b", VALUE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    expect(String(err)).not.toContain("v4l");
  });

  it("quotes security -i words", () => {
    expect(securityQuote('a b"c\\d')).toBe('"a b\\"c\\\\d"');
    expect(keychainAddLine("svc", "x")).toBe(
      'add-generic-password -U -a "turno" -s "svc" -w "x" -T /usr/bin/security\n',
    );
    expect(() => keychainAddLine("svc", "two\nlines")).toThrow(/line break/);
  });

  it("refuses a service name with a line break", async () => {
    fakeSecretStore(sb);
    await expect(secretStore(sb.env, "darwin")!.get("a\nb")).rejects.toThrow(/invalid secret name/);
  });

  it("says what to install when there is no store", () => {
    const env = { ...sb.env, PATH: join(sb.home, "empty") };
    expect(secretStore(env, "darwin")).toBeUndefined();
    expect(() => requireSecretStore(env, "linux")).toThrow(NO_SECRET_STORE);
  });
});

/** A value the Keychain store cannot take (line breaks) and Credential Manager could not (over 2560 bytes). */
const BIG = `${VALUE}\nsecond line \u00e9\u6f22\n${"x".repeat(5000)}`;

const result = (code: number, bytes = Buffer.alloc(0), stderr = ""): ExecResult => ({
  code,
  stdout: bytes.toString("utf8"),
  stderr,
  bytes,
});

/**
 * A stand-in for the PowerShell DPAPI call with the same input contract: it parses the
 * base64 name line, "encrypts" with XOR behind a tag of the name (so a blob only opens for its
 * own name, like DPAPI's entropy), and exits 3 like the script when that check fails.
 */
function fakeDpapi() {
  const calls: { op: DpapiOp; input: Buffer }[] = [];
  const tag = (name: Buffer) => createHash("sha256").update(name).digest().subarray(0, 4);
  const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
  const run = async (op: DpapiOp, input: Buffer): Promise<ExecResult> => {
    calls.push({ op, input });
    const nl = input.indexOf(10);
    if (nl < 0) return result(2);
    const name = Buffer.from(input.subarray(0, nl).toString("ascii"), "base64");
    const data = input.subarray(nl + 1);
    if (op === "Protect") return result(0, Buffer.concat([tag(name), xor(data)]));
    if (!data.subarray(0, 4).equals(tag(name)))
      return result(3, undefined, "CryptographicException: Key not valid for use in specified state.");
    return result(0, xor(data.subarray(4)));
  };
  return { calls, run };
}

describe("Windows store: DPAPI files, PowerShell on stdin", () => {
  it("puts neither the value nor the item name in the PowerShell argv", () => {
    for (const op of ["Protect", "Unprotect"] as const) {
      const args = dpapiArgs(op);
      expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      expect(args).toHaveLength(5);
      const script = args[4]!;
      expect(script).toContain(`[Security.Cryptography.ProtectedData]::${op}(`);
      expect(script).toContain("DataProtectionScope]::CurrentUser");
      // Data moves only through the raw stdin and stdout streams, never through a cmdlet.
      expect(script).toContain("[Console]::OpenStandardInput()");
      expect(script).toContain("[Console]::OpenStandardOutput()");
      expect(script).not.toMatch(/Write-(Output|Host)|\$input|\$args|\$env:/);
      expect(args.join(" ")).not.toContain("turno-test");
    }
  });

  it("sends the name in base64 on the first stdin line and the bytes after it", () => {
    const input = dpapiInput("turno-test/a b", Buffer.from(VALUE));
    const nl = input.indexOf(10);
    expect(Buffer.from(input.subarray(0, nl).toString("ascii"), "base64").toString()).toBe("turno-test/a b");
    expect(input.subarray(nl + 1).toString()).toBe(VALUE);
  });

  it("stores, reads, checks and deletes; only the encrypted blob reaches the disk", async () => {
    const dir = join(sb.home, "secrets");
    const fake = fakeDpapi();
    const store = dpapiStore(dir, fake.run);
    expect(store.kind).toBe("dpapi");
    expect(describeSecretStore(store)).toBe(`Windows DPAPI, current user (files in ${dir})`);
    expect(await store.get("turno-test/a")).toBeUndefined();
    expect(await store.has("turno-test/a")).toBe(false);
    expect(fake.calls).toEqual([]); // a missing item costs no PowerShell start
    await store.set("turno-test/a", BIG);
    expect(readdirSync(dir)).toEqual([dpapiFileName("turno-test/a")]);
    const text = readFileSync(join(dir, dpapiFileName("turno-test/a")), "utf8");
    expect(text).not.toContain("v4l");
    expect(JSON.parse(text)).toMatchObject({ v: 1, name: "turno-test/a" });
    expect((await store.get("turno-test/a")) === BIG).toBe(true);
    expect(await store.has("turno-test/a")).toBe(true);
    expect(fake.calls.map((c) => c.op)).toEqual(["Protect", "Unprotect"]);
    expect(await store.remove("turno-test/a")).toBe(true);
    expect(await store.remove("turno-test/a")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("file names are case-safe hashes, so names that differ only in case stay apart", () => {
    expect(dpapiFileName("Token")).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(dpapiFileName("Token")).not.toBe(dpapiFileName("token"));
  });

  it("tells a file it cannot decrypt, a damaged file and a missing PowerShell apart, never with the value", async () => {
    const dir = join(sb.home, "secrets");
    const fake = fakeDpapi();
    const store = dpapiStore(dir, fake.run);
    await store.set("turno-test/a", VALUE);
    // Another item's file copied over this one: DPAPI's entropy (the name) does not match.
    copyFileSync(join(dir, dpapiFileName("turno-test/a")), join(dir, dpapiFileName("turno-test/b")));
    const body = JSON.parse(readFileSync(join(dir, dpapiFileName("turno-test/a")), "utf8"));
    writeFileSync(join(dir, dpapiFileName("turno-test/b")), JSON.stringify({ ...body, name: "turno-test/b" }));
    const denied = await store.get("turno-test/b").catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(SecretError);
    expect(String(denied)).toMatch(/keychain:turno-test\/b: Windows could not decrypt it \(DPAPI\)/);
    writeFileSync(join(dir, dpapiFileName("turno-test/b")), "not json");
    await expect(store.get("turno-test/b")).rejects.toThrow(/its file is damaged/);
    const gone = dpapiStore(dir, async () => result(127, undefined, "spawn powershell.exe ENOENT"));
    const err = await gone.get("turno-test/a").catch((e: unknown) => e);
    expect(String(err)).toMatch(/Windows PowerShell is not available/);
    expect(String(err)).not.toContain("v4l");
  });

  it("writes nothing when DPAPI refuses to encrypt, and leaves no temporary file", async () => {
    const dir = join(sb.home, "secrets");
    const store = dpapiStore(dir, async () => result(1, undefined, "PlatformNotSupportedException: no"));
    const err = await store.set("turno-test/a", VALUE).catch((e: unknown) => e);
    expect(String(err)).toMatch(/DPAPI did not encrypt it: PlatformNotSupportedException/);
    expect(String(err)).not.toContain("v4l");
    expect(() => readdirSync(dir)).toThrow(); // the folder is created only for a write that has a blob
  });

  it("keeps the items in %LOCALAPPDATA%\\turno\\secrets, and has no store without Windows PowerShell", () => {
    expect(dpapiDir({ LOCALAPPDATA: join(sb.home, "Local") })).toBe(join(sb.home, "Local", "turno", "secrets"));
    expect(dpapiDir({ USERPROFILE: sb.home })).toBe(join(sb.home, "AppData", "Local", "turno", "secrets"));
    const env = { ...sb.env, SystemRoot: join(sb.home, "no-windows") };
    expect(secretStore(env, "win32")).toBeUndefined();
    expect(() => requireSecretStore(env, "win32")).toThrow(NO_SECRET_STORE);
  });
});

// The real store, on Windows only (CI's windows-latest). Items go to a temporary folder, never
// to the user's own %LOCALAPPDATA%, and the folder is removed at the end.
describe.runIf(process.platform === "win32")("Windows store: a real DPAPI round trip", () => {
  it("sets, gets, lists and deletes through Windows PowerShell", async () => {
    const local = mkdtempSync(join(tmpdir(), "turno-dpapi-"));
    const name = `turno-test/ci-${randomBytes(6).toString("hex")}`;
    const other = `${name}-other`;
    try {
      const store = secretStore({ ...process.env, LOCALAPPDATA: local }, "win32")!;
      expect(store.kind).toBe("dpapi");
      expect(store.location).toBe(join(local, "turno", "secrets"));
      let t = performance.now();
      await store.set(name, BIG);
      const setMs = performance.now() - t;
      t = performance.now();
      const back = await store.get(name);
      const getMs = performance.now() - t;
      expect(back === BIG).toBe(true);
      expect(await store.has(name)).toBe(true);
      const dir = join(local, "turno", "secrets");
      expect(readdirSync(dir)).toEqual([dpapiFileName(name)]);
      expect(readFileSync(join(dir, dpapiFileName(name)), "utf8")).not.toContain("second line");
      // The blob is bound to its name: under another name DPAPI refuses it.
      const body = JSON.parse(readFileSync(join(dir, dpapiFileName(name)), "utf8"));
      writeFileSync(join(dir, dpapiFileName(other)), JSON.stringify({ ...body, name: other }));
      await expect(store.get(other)).rejects.toThrow(/Windows could not decrypt it \(DPAPI\)/);
      expect(await store.remove(other)).toBe(true);
      expect(await store.remove(name)).toBe(true);
      expect(await store.get(name)).toBeUndefined();
      expect(readdirSync(dir)).toEqual([]);
      console.log(
        `DPAPI round trip of ${Buffer.byteLength(BIG)} bytes: set ${setMs.toFixed(0)} ms, get ${getMs.toFixed(0)} ms`,
      );
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});
