import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserFunctions as BrowserApi } from "../../src/api.js";
import type { VaultInput } from "../../src/cli/context.js";
import * as flowCmd from "../../src/cli/flows.js";
import { type Sandbox, sandbox } from "../helpers/sandbox.js";
import { cli, ctx, fakeIo, real } from "./helpers.js";
import { slashes } from "../helpers/programs.js";

/**
 * `record|flows|replay|traces`. The real turno-browser from the workspace runs
 * against the sandbox HOME for identity.json and flow files; replay and the trace viewer come
 * from a fake, so no browser starts.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

type IoOf = Parameters<typeof flowCmd.replay>[2];
const replay = (m: BrowserApi, args: string[], io: IoOf, input?: VaultInput) =>
  flowCmd.replay(ctx(m, input ? { input } : {}), args, io);
const traces = (m: BrowserApi, args: string[], io: IoOf) => flowCmd.traces(ctx(m), args, io);
const run = (p: Promise<number>) => p.then(String, (e: Error) => e.message);
const settingsFile = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "identities", `${id}.json`);
const flowsFolder = (id: string) => join(sb.home, ".local", "share", "turno", "browser", "flows", id);

async function browser(args: string[]) {
  const io = fakeIo(sb.env);
  const code = await run(cli(await real()).command.run(args, io));
  return { code, out: io.lines.join("\n"), err: io.errors.join("\n") };
}

const FLOW = {
  version: 1,
  name: "sign-in",
  description: "Sign in to the example site",
  identity: "school",
  created: "2026-11-18T10:00:00.000Z",
  updated: "2026-11-18T10:00:00.000Z",
  params: [
    { name: "email", sensitive: false, default: "alice@example.com" },
    { name: "password", sensitive: true },
  ],
  steps: [
    { tool: "browser_navigate", args: { url: "https://example.com/login" } },
    {
      tool: "browser_type",
      args: { text: { $param: "email" } },
      targets: { target: { description: "Email", locators: [{ kind: "css", selector: "css=#email" }] } },
    },
    {
      tool: "browser_type",
      args: { text: { $param: "password" } },
      targets: { target: { description: "Password", locators: [{ kind: "css", selector: "css=#pw" }] } },
    },
    { tool: "browser_login", args: { site: "mail" } },
  ],
};

function saveFlow(id: string, flow: Record<string, unknown> = FLOW): void {
  mkdirSync(flowsFolder(id), { recursive: true });
  writeFileSync(join(flowsFolder(id), `${flow.name}.json`), JSON.stringify(flow));
}

describe("turno-browser record and set --record-*", () => {
  it("shows what an identity records, turns parts on, refuses bad combinations, and turns it all off", async () => {
    expect((await browser(["add", "school"])).code).toBe("0");
    const none = await browser(["record", "school"]);
    expect(none.out).toMatch(/records\s+nothing \(the agent can still record a flow with browser_record\)/);
    expect(slashes(none.out)).toMatch(/flows\s+~\/\.local\/share\/turno\/browser\/flows\/school/);

    const on = await browser(["record", "school", "--flows", "--traces", "--max-size", "50MB"]);
    expect(on.code).toBe("0");
    expect(on.out).toMatch(/records\s+flows, traces \(up to 50MB\)/);
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8"))).toMatchObject({
      version: 7,
      record: { flows: true, traces: true, maxSize: "50MB" },
    });

    const json = await browser(["record", "school", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ id: "browser:school", dryRun: false, record: { flows: true } });
    expect((await browser(["record", "school", "--max-size", "1MB"])).code).toMatch(
      /--max-size must be a size from "10MB"/,
    );
    expect((await browser(["record", "school", "--off", "--flows"])).code).toMatch(/--off does not go with/);
    expect((await browser(["record", "school", "--off", "--dry-run"])).out).toMatch(
      /\(dry run\) would set record of "school" to null/,
    );
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).record).toBeDefined();
    expect((await browser(["record", "school", "--off"])).code).toBe("0");
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).record).toBeUndefined();
  });

  it("set takes --record-* like the other identity.json groups", async () => {
    await browser(["add", "school"]);
    const set = await browser(["set", "school", "--record-screenshots", "true", "--record-max-size", "20MB"]);
    expect(set.code).toBe("0");
    expect(set.out).toMatch(/recording\s+screenshots \(up to 20MB\)/);
    expect((await browser(["set", "school", "--record-traces", "maybe"])).code).toMatch(
      /--record-traces must be true or false/,
    );
    expect((await browser(["set", "school", "--record-max-size", "20TB"])).code).toMatch(
      /--record-max-size must be a size/,
    );
    expect((await browser(["set", "school", "--no-record", "--record-flows", "true"])).code).toMatch(
      /--no-record does not go with the other --record flags/,
    );
    expect((await browser(["set", "school", "--no-record"])).code).toBe("0");
    expect(JSON.parse(readFileSync(settingsFile("school"), "utf8")).record).toBeUndefined();
  });
});

describe("turno-browser flows", () => {
  it("lists, shows and removes saved flows", async () => {
    await browser(["add", "school"]);
    expect((await browser(["flows", "school"])).out).toMatch(/No saved flows for "school"/);
    saveFlow("school");
    const list = await browser(["flows", "school"]);
    expect(list.out).toMatch(/sign-in\s+4\s+email, password\*/);
    expect(list.out).toMatch(/\* sensitive: no value is saved/);
    const json = JSON.parse((await browser(["flows", "school", "--json"])).out);
    expect(json).toMatchObject([
      {
        name: "sign-in",
        steps: 4,
        auto: false,
        file: join("~", ".local", "share", "turno", "browser", "flows", "school", "sign-in.json"),
      },
    ]);
    const show = await browser(["flows", "school", "sign-in"]);
    expect(show.out).toMatch(/1\. browser_navigate https:\/\/example\.com\/login/);
    expect(show.out).toMatch(/2\. browser_type Email with \{email\}/);
    expect(show.out).toMatch(/4\. browser_login site "mail"/);
    expect(show.out).toMatch(/password\s+sensitive: give it at replay \(keychain:<item>\)/);
    expect((await browser(["flows", "school", "nope"])).code).toMatch(/has no flow "nope" \(saved: sign-in\)/);
    expect((await browser(["flows", "school", "sign-in", "--remove", "--dry-run"])).out).toMatch(
      /\(dry run\) would delete/,
    );
    expect(existsSync(join(flowsFolder("school"), "sign-in.json"))).toBe(true);
    expect((await browser(["flows", "school", "sign-in", "--remove"])).code).toBe("0");
    expect(existsSync(join(flowsFolder("school"), "sign-in.json"))).toBe(false);
  });
});

describe("turno-browser replay", () => {
  async function withFake() {
    const base = await real();
    base.addIdentity("school", sb.env);
    saveFlow("school");
    const calls: { id: string; flow: string; options: Record<string, unknown> }[] = [];
    const mod = {
      ...base,
      replayFlow: async (id: string, flow: string, options: Record<string, unknown>) => {
        calls.push({ id, flow, options });
        return { ok: true, text: "### Replay\n1. browser_navigate: ok" };
      },
    } as unknown as BrowserApi;
    return { mod, calls };
  }
  const input = (over: Partial<VaultInput> = {}): VaultInput => ({
    isTty: () => false,
    hidden: async () => "typed-at-prompt",
    visible: async () => "",
    stdin: async () => "",
    ...over,
  });

  it("never takes a sensitive value on the command line: a keychain: reference or the hidden prompt", async () => {
    const { mod, calls } = await withFake();
    const io = fakeIo(sb.env);
    expect(await run(replay(mod, ["school", "sign-in", "--param", "password=hunter2"], io, input()))).toMatch(
      /"password" is sensitive: pass it as --param password=keychain:<item>/,
    );
    expect(await run(replay(mod, ["school", "sign-in"], io, input()))).toMatch(
      /browser replay \(parameter password\) needs an answer; pass --param password=keychain:<item>/,
    );
    expect(calls).toHaveLength(0);
    expect(
      await run(
        replay(
          mod,
          ["school", "sign-in", "--param", "password=keychain:school-pw", "--from", "2", "--headless"],
          io,
          input(),
        ),
      ),
    ).toBe("0");
    expect(calls[0]).toEqual({
      id: "school",
      flow: "sign-in",
      options: { params: { password: "keychain:school-pw" }, from: 2, headless: true, env: sb.env },
    });
    expect(io.lines.join("\n")).toMatch(/Replay\n1\. browser_navigate: ok/);
    expect(await run(replay(mod, ["school", "sign-in"], io, input({ isTty: () => true })))).toBe("0");
    expect(calls[1]!.options.params).toEqual({ password: "typed-at-prompt" });
    expect(io.lines.join("\n")).not.toContain("typed-at-prompt");
  });

  it("exits 1 with the report on stderr when a step fails", async () => {
    const { mod } = await withFake();
    const failing = {
      ...mod,
      replayFlow: async () => ({ ok: false, text: "### Error\nStep 2 of 4 failed" }),
    } as unknown as BrowserApi;
    const io = fakeIo(sb.env);
    expect(await run(replay(failing, ["school", "sign-in", "--param", "password=keychain:x"], io, input()))).toBe("1");
    expect(io.errors.join("\n")).toMatch(/Error\nStep 2 of 4 failed/);
  });
});

describe("turno-browser traces", () => {
  const RECS = [
    {
      name: "20261118-100000-000",
      dir: "/x/recordings/20261118-100000-000",
      title: "claude-code",
      started: "2026-11-18T10:00:00.000Z",
      ended: "2026-11-18T10:05:00.000Z",
      steps: 7,
      screenshots: 6,
      traces: [
        { file: "/x/recordings/20261118-100000-000/trace-1.zip", from: 1, to: 3, bytes: 2048 },
        { file: "/x/recordings/20261118-100000-000/trace-2.zip", from: 5, to: 7, bytes: 4096 },
      ],
      discarded: 0,
      bytes: 9000,
      notes: [],
    },
  ];
  async function fake() {
    const base = await real();
    base.addIdentity("school", sb.env);
    const opened: string[] = [];
    const mod = {
      ...base,
      listRecordings: () => RECS,
      openTraceViewer: async (file: string) => {
        opened.push(file);
        return 0;
      },
    } as unknown as BrowserApi;
    return { mod, opened };
  }

  it("lists recordings and opens the last trace, or the segment asked for, with the bundled viewer", async () => {
    const { mod, opened } = await fake();
    const io = fakeIo(sb.env);
    expect(await run(traces(mod, ["school"], io))).toBe("0");
    expect(io.lines.join("\n")).toMatch(/7 steps, 6 screenshots, 2 traces/);
    expect(io.lines.join("\n")).toMatch(
      /trace 2: \/x\/recordings\/20261118-100000-000\/trace-2\.zip \(steps 5-7, 4 KB\)/,
    );
    expect(await run(traces(mod, ["school", "--open"], io))).toBe("0");
    expect(await run(traces(mod, ["school", "20261118-100000-000", "--open", "--segment", "1"], io))).toBe("0");
    expect(opened).toEqual([RECS[0]!.traces[1]!.file, RECS[0]!.traces[0]!.file]);
    expect(io.errors.join("\n")).toMatch(/patchright-core[/\\]cli\.js show-trace --host 127\.0\.0\.1 --port 0/);
    expect(io.errors.join("\n")).not.toMatch(/npx/);
    expect(await run(traces(mod, ["school", "--open", "--segment", "3"], io))).toMatch(/--segment takes 1 to 2/);
    const json = fakeIo(sb.env);
    await traces(mod, ["school", "--json"], json);
    expect(JSON.parse(json.lines.join("\n"))[0]).toMatchObject({ name: "20261118-100000-000", steps: 7 });
  });
});
