import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { BrowserContext, Page } from "patchright-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor, VaultGuard } from "../src/redact.js";
import {
  type RecordPlan,
  Recording,
  listRecordings,
  recordingsDir,
  traceLeaks,
  traceViewerCommand,
  tracesTmpDir,
  zipTexts,
} from "../src/recordings.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/** Recordings: folders, the size cap, the trace pause around secrets and the leak check. */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

/** A zip with deflated entries, the way Playwright writes a trace. */
function zip(entries: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = deflateRawSync(Buffer.from(content));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dirBuf, end]);
}

/** A page stand-in: a URL, a screenshot and the events the vault guard listens to. */
function fakePage(url = "https://example.com/app?token=abc"): Page & { navigate(): void } {
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const page = {
    url: () => url,
    screenshot: async () => Buffer.alloc(2048, 1),
    mainFrame: () => page,
    on(event: string, fn: (arg: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return page;
    },
    once(event: string, fn: (arg: unknown) => void) {
      return page.on(event, fn);
    },
    off(event: string, fn: (arg: unknown) => void) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((f) => f !== fn),
      );
      return page;
    },
    navigate() {
      for (const fn of listeners.get("framenavigated") ?? []) fn(page);
    },
  };
  return page as unknown as Page & { navigate(): void };
}

/** A context whose tracing writes a zip holding whatever `content()` says the page shows. */
function fakeContext(pages: Page[], content: () => string) {
  const calls: string[] = [];
  const context = {
    pages: () => pages,
    tracing: {
      async start(o: { name: string }) {
        calls.push(`start ${o.name}`);
      },
      async stop(o: { path: string }) {
        calls.push("stop");
        mkdirSync(join(o.path, ".."), { recursive: true });
        writeFileSync(o.path, zip({ "trace.trace": content(), "trace.network": "{}", "resources/a.png": "x" }));
      },
    },
  };
  return { context: context as unknown as BrowserContext, calls };
}

async function open(
  settings: Partial<RecordPlan>,
  context: BrowserContext,
  redactor = new Redactor(),
  guard = new VaultGuard(),
) {
  const r = await Recording.open({
    identity: { id: "work", env: sb.env },
    settings: { screenshots: false, traces: false, ...settings },
    context,
    redactor,
    guard,
    title: "test client",
  });
  if (!r) throw new Error("no recording");
  return { r, redactor, guard };
}

describe("zip reading", () => {
  it("reads the text of deflated entries and leaves images out", () => {
    const texts = zipTexts(zip({ "a.trace": "hello", "b.png": "img", "c.network": '{"x":1}' }));
    expect(texts).toEqual([
      { name: "a.trace", text: "hello" },
      { name: "c.network", text: '{"x":1}' },
    ]);
    expect(() => zipTexts(Buffer.from("not a zip at all, sorry"))).toThrow(/not a zip/);
  });

  it("finds a password or a one-time code in a trace, in its encodings, but not a username", () => {
    const redactor = new Redactor();
    redactor.add("alice@example.com", "mail username");
    redactor.add('Pa55 w0rd&"x"', "mail password");
    const file = join(sb.home, "t.zip");
    writeFileSync(file, zip({ "trace.network": `{"postData":"user=alice%40example.com&pw=Pa55+w0rd%26%22x%22"}` }));
    expect(traceLeaks(file, redactor)).toEqual(["mail password"]);
    writeFileSync(file, zip({ "trace.trace": "Signed in as alice@example.com" }));
    expect(traceLeaks(file, redactor)).toEqual([]);
    writeFileSync(file, "garbage");
    expect(traceLeaks(file, redactor)).toEqual(["unreadable"]);
  });
});

describe("a recording", () => {
  it("writes screenshots and an index per step, without the query string, and nothing for read-only work", async () => {
    const page = fakePage();
    const { context } = fakeContext([page], () => "");
    const { r } = await open({ screenshots: true }, context);
    await r.afterStep({ tool: "browser_click", element: "Sign in button", ok: true, page, screenshot: true });
    await r.close();
    const [rec] = listRecordings("work", sb.env);
    expect(rec).toMatchObject({ steps: 1, screenshots: 1, traces: [], title: "test client" });
    const index = JSON.parse(readFileSync(join(rec!.dir, "index.json"), "utf8"));
    expect(index.steps[0]).toMatchObject({
      tool: "browser_click",
      element: "Sign in button",
      url: "https://example.com/app",
    });
    expect(readdirSync(join(rec!.dir, "steps"))).toEqual(["001-browser_click.jpg"]);
    expect(index.ended).toBeTruthy();
  });

  it("stops the trace before a secret, keeps it stopped while the page holds it, and starts again after it navigates", async () => {
    const page = fakePage();
    let shows = "the form";
    const { context, calls } = fakeContext([page], () => shows);
    const { r, redactor } = await open({ traces: true, screenshots: true }, context);
    expect(calls).toEqual(["start segment-1"]);
    await r.pauseForSecret(page);
    redactor.add("hunter2-secret", "mail password");
    expect(calls).toEqual(["start segment-1", "stop"]);
    await r.beforeCall(); // the page still holds the value: no new trace
    await r.afterStep({ tool: "browser_type", ok: true, page, screenshot: true });
    expect(calls).toEqual(["start segment-1", "stop"]);
    page.navigate();
    await r.beforeCall();
    expect(calls).toEqual(["start segment-1", "stop", "start segment-2"]);
    shows = "a page that echoes hunter2-secret";
    await r.close();
    const [rec] = listRecordings("work", sb.env);
    const index = JSON.parse(readFileSync(join(rec!.dir, "index.json"), "utf8"));
    expect(index.steps[0].note).toMatch(/no screenshot: the page holds vault or sensitive values/);
    expect(index.steps[0].screenshot).toBeUndefined();
    expect(index.traces.map((t: { file: string; discarded?: string }) => [t.file, t.discarded ?? "kept"])).toEqual([
      ["trace-1.zip", "kept"],
      ["trace-2.zip", "deleted: it held a vault or sensitive value"],
    ]);
    expect(existsSync(join(rec!.dir, "trace-2.zip"))).toBe(false);
    expect(rec!.traces.map((t) => t.file)).toEqual([join(rec!.dir, "trace-1.zip")]);
    expect(existsSync(tracesTmpDir("work", sb.env))).toBe(false);
  });

  it('keeps only the traces with a failed step by default ("failed")', async () => {
    const page = fakePage();
    const { context } = fakeContext([page], () => "");
    const { r } = await open({ traces: "failed" }, context);
    await r.afterStep({ tool: "browser_click", ok: true, page, screenshot: false });
    await r.pauseForSecret(page); // ends segment 1, whose only step worked
    page.navigate();
    await r.beforeCall();
    await r.afterStep({ tool: "browser_click", ok: false, page, screenshot: false });
    await r.close();
    const [rec] = listRecordings("work", sb.env);
    const index = JSON.parse(readFileSync(join(rec!.dir, "index.json"), "utf8"));
    expect(index.traces.map((t: { file: string; discarded?: string }) => [t.file, t.discarded ?? "kept"])).toEqual([
      ["trace-1.zip", "deleted: no step failed (traces are kept for failed steps only)"],
      ["trace-2.zip", "kept"],
    ]);
    expect(rec!.traces.map((t) => t.file)).toEqual([join(rec!.dir, "trace-2.zip")]);
  });

  it("keeps the recordings under the size cap, the oldest going first", async () => {
    for (const name of ["20261101-000000-000", "20261102-000000-000"]) {
      const dir = join(recordingsDir("work", sb.env), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "index.json"),
        JSON.stringify({ version: 1, identity: "work", title: "old", started: "x", steps: [], traces: [], notes: [] }),
      );
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(4 * 1024 ** 2));
    }
    const page = fakePage();
    const { context } = fakeContext([page], () => "");
    const { r } = await open({ screenshots: true, maxSize: "10MB" }, context);
    // At start, older recordings may take half the cap: the oldest goes.
    expect(listRecordings("work", sb.env).map((x) => x.name)).not.toContain("20261101-000000-000");
    await r.afterStep({ tool: "browser_click", ok: true, page, screenshot: true });
    expect(listRecordings("work", sb.env).length).toBe(2);
  });
});

describe("the trace viewer", () => {
  it("is patchright-core's own show-trace on 127.0.0.1, never npx", () => {
    const { command, args } = traceViewerCommand("/tmp/trace-1.zip");
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/patchright-core[/\\]cli\.js$/);
    expect(args.slice(1)).toEqual(["show-trace", "--host", "127.0.0.1", "--port", "0", "/tmp/trace-1.zip"]);
  });
});
