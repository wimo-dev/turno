import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserFunctions as BrowserApi } from "../../src/api.js";
import type { CliDeps, VaultInput } from "../../src/cli/context.js";
import * as session from "../../src/cli/session.js";
import { parseExpiry } from "../../src/cli/session.js";
import { type Sandbox, sandbox, expectMode } from "../helpers/sandbox.js";
import { ctx, fakeIo } from "./helpers.js";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const PASS = "a long enough passphrase";
const SUMMARY = {
  identity: "work",
  createdAt: "2026-11-18T00:00:00.000Z",
  expiresAt: "2026-11-25T00:00:00.000Z",
  cookies: 3,
  origins: 2,
};

interface Calls {
  exported: { id: string; options: { passphrase: string; expiresInMs?: number } }[];
  imported: { options: { passphrase: string; as?: string } }[];
}

function fakeModule(calls: Calls, existing: string[] = ["work"]): BrowserApi {
  const fake = {
    assertIdentityId: (id: string) => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id))
        throw Object.assign(new Error(`invalid identity id "${id}"`), { name: "IdentityError" });
    },
    identityExists: (id: string) => existing.includes(id),
    exportSession: async (id: string, options: Calls["exported"][number]["options"]) => {
      calls.exported.push({ id, options });
      return { sealed: '{"format":"turno-browser-session"}\n', summary: SUMMARY };
    },
    readSessionExport: async (_text: string, passphrase: string) => {
      if (passphrase !== PASS)
        throw Object.assign(new Error("wrong passphrase, or the file was changed"), { name: "SealError" });
      return { payload: {}, summary: SUMMARY };
    },
    importSession: async (_text: string, options: Calls["imported"][number]["options"]) => {
      calls.imported.push({ options });
      const id = options.as ?? "work";
      return { ...SUMMARY, identity: id, created: !existing.includes(id) };
    },
  };
  return fake as unknown as BrowserApi;
}

function input(over: Partial<VaultInput> = {}): VaultInput {
  return {
    isTty: () => false,
    hidden: async () => PASS,
    visible: async () => "",
    stdin: async () => `${PASS}\n`,
    ...over,
  };
}

type Asks = Pick<CliDeps, "interactive" | "confirm">;
const deps = (answer: boolean, interactive = true): Asks => ({
  interactive: () => interactive,
  confirm: async () => answer,
});
type IoOf = Parameters<typeof session.exportSession>[2];
const exportSession = (m: BrowserApi, args: string[], io: IoOf, inp: VaultInput) =>
  session.exportSession(ctx(m, { input: inp }), args, io);
const importSession = (m: BrowserApi, args: string[], io: IoOf, d: Asks, inp: VaultInput) =>
  session.importSession(ctx(m, { ...d, input: inp }), args, io);
const run = (p: Promise<number>) => p.then(String, (e: Error) => e.message);

describe("export", () => {
  it("writes the sealed file with mode 600, refuses to overwrite without --force, never prints the passphrase", async () => {
    const calls: Calls = { exported: [], imported: [] };
    const out = join(sb.home, "work.session");
    const io = fakeIo(sb.env);
    expect(await exportSession(fakeModule(calls), ["work", "--out", out, "--expires", "2d"], io, input())).toBe(0);
    expect(calls.exported[0]!.options.passphrase === PASS).toBe(true);
    expect(calls.exported[0]!.options.expiresInMs).toBe(2 * 24 * 3600_000);
    expectMode(out, 0o600);
    expect(readFileSync(out, "utf8")).toContain("turno-browser-session");
    const text = [...io.lines, ...io.errors].join("\n");
    expect(text).toMatch(/3 cookies, storage of 2 sites/);
    expect(text).toMatch(/holds no vault credentials/);
    expect(text).not.toContain(PASS);
    expect(await run(exportSession(fakeModule(calls), ["work", "--out", out], fakeIo(sb.env), input()))).toMatch(
      /exists; pass --force/,
    );
    expect(await exportSession(fakeModule(calls), ["work", "--out", out, "--force"], fakeIo(sb.env), input())).toBe(0);
  });

  it("asks for the passphrase twice on a terminal and stops when they differ", async () => {
    const calls: Calls = { exported: [], imported: [] };
    let n = 0;
    const tty = input({ isTty: () => true, hidden: async () => (n++ === 0 ? PASS : "something else entirely") });
    const out = join(sb.home, "x.session");
    expect(
      await run(
        exportSession(fakeModule(calls), ["work", "--out", out], fakeIo({ ...sb.env, TURNO_NO_INPUT: "0" }), tty),
      ),
    ).toMatch(/passphrases differ/);
    expect(existsSync(out)).toBe(false);
    expect(calls.exported).toEqual([]);
  });

  it("checks its arguments", async () => {
    const m = fakeModule({ exported: [], imported: [] });
    expect(await run(exportSession(m, ["work"], fakeIo(sb.env), input()))).toMatch(/--out/);
    expect(await run(exportSession(m, ["nobody", "--out", "x"], fakeIo(sb.env), input()))).toMatch(/does not exist/);
    expect(await run(exportSession(m, [], fakeIo(sb.env), input()))).toMatch(/usage: turno-browser export/);
    expect(() => parseExpiry("91d")).toThrow(/up to 90d/);
    expect(() => parseExpiry("5m")).toThrow(/like 7d or 12h/);
    expect(parseExpiry("12h")).toBe(12 * 3600_000);
  });
});

describe("import", () => {
  const file = () => {
    const f = join(sb.home, "in.session");
    writeFileSync(f, '{"format":"turno-browser-session"}');
    return f;
  };

  it("creates a new identity without asking", async () => {
    const calls: Calls = { exported: [], imported: [] };
    const io = fakeIo(sb.env);
    expect(await importSession(fakeModule(calls), [file(), "--as", "laptop"], io, deps(false, false), input())).toBe(0);
    expect(calls.imported[0]!.options.as).toBe("laptop");
    expect(io.lines.join("\n")).toMatch(/created browser identity "laptop" with 3 cookies/);
  });

  it("asks before replacing an existing identity's session, and needs --yes without a terminal", async () => {
    const calls: Calls = { exported: [], imported: [] };
    const no = fakeIo(sb.env);
    expect(await importSession(fakeModule(calls), [file()], no, deps(false), input())).toBe(1);
    expect(no.lines.join("\n")).toMatch(/nothing imported/);
    expect(await run(importSession(fakeModule(calls), [file()], fakeIo(sb.env), deps(false, false), input()))).toMatch(
      /--yes/,
    );
    expect(calls.imported).toEqual([]);
    expect(await importSession(fakeModule(calls), [file(), "--yes"], fakeIo(sb.env), deps(false, false), input())).toBe(
      0,
    );
    expect(calls.imported).toHaveLength(1);
  });

  it("shows what it would do with --dry-run, and reports a wrong passphrase in one line", async () => {
    const calls: Calls = { exported: [], imported: [] };
    const io = fakeIo(sb.env);
    expect(await importSession(fakeModule(calls), [file(), "--dry-run"], io, deps(false), input())).toBe(0);
    expect(io.lines.join("\n")).toMatch(/\(dry run\) would replace the session of browser identity "work"/);
    expect(calls.imported).toEqual([]);
    const wrong = input({ stdin: async () => "not the passphrase\n" });
    const err = await importSession(fakeModule(calls), [file()], fakeIo(sb.env), deps(true), wrong).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toBe("wrong passphrase, or the file was changed");
  });
});
