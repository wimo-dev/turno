import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DoctorOptions, runDoctor } from "../src/doctor.js";
import { addIdentity } from "../src/identities.js";
import { writeIdentitySettings } from "../src/settings.js";
import { type ProcTable, parseProcTable } from "../src/lifecycle.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * The engine rows of `turno browser doctor`: Lightpanda found or not (a failure only when an
 * identity uses read mode), an attach target with or without a listening Chrome, and a
 * Lightpanda an earlier server left running. Chrome, the smoke launch and the process table are
 * injected; nothing starts.
 */

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const base = (more: Partial<DoctorOptions> = {}): DoctorOptions => ({
  env: sb.env,
  platform: "darwin",
  launch: false,
  chrome: () => ({ path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", version: "157.0.0.0" }),
  otherBrowsers: () => [],
  lightpanda: () => undefined,
  camoufox: () => undefined,
  playwrightCore: () => undefined,
  procTable: () => new Map(),
  ...more,
});

const rows = async (opts: DoctorOptions, area?: string) =>
  (await runDoctor(opts)).checks.filter((c) => (area ? c.area === area : true));

describe("doctor engine checks", () => {
  it("shows Lightpanda when found, and only informs when it is missing and unused", async () => {
    const found = await rows(base({ lightpanda: () => ({ path: "/opt/lightpanda", version: "1.1.0" }) }), "engines");
    expect(found.filter((c) => /Lightpanda/.test(c.text))).toEqual([
      {
        area: "engines",
        level: "ok",
        text: "Lightpanda 1.1.0 at /opt/lightpanda (read mode); no identity uses it yet: turno-browser set <id> --engine lightpanda for read-only work",
      },
    ]);
    const [missing] = await rows(base(), "engines");
    expect(missing).toMatchObject({ level: "info", fix: "brew install lightpanda-io/browser/lightpanda" });
    expect(missing!.text).toMatch(/never downloads it/);
  });

  it("gives each platform its own install step", async () => {
    const [linux] = await rows(base({ platform: "linux" }), "engines");
    expect(linux).toMatchObject({
      level: "info",
      fix: expect.stringMatching(
        /^curl -fL --create-dirs -o ~\/\.local\/bin\/lightpanda https:\/\/github\.com\/lightpanda-io\/browser\/releases\/download\/nightly\/lightpanda-(x86_64|aarch64)-linux && chmod \+x ~\/\.local\/bin\/lightpanda$/,
      ),
    });
    const [windows] = await rows(base({ platform: "win32" }), "engines");
    expect(windows).toMatchObject({ level: "info", manual: expect.stringMatching(/no build for this platform/) });
    expect(windows!.fix).toBeUndefined();
  });

  it("fails when an identity uses read mode and Lightpanda is missing", async () => {
    addIdentity("reader", sb.env);
    writeIdentitySettings("reader", { engine: "lightpanda" }, sb.env);
    const checks = await rows(base());
    expect(checks.find((c) => c.area === "engines")).toMatchObject({
      level: "fail",
      text: "Lightpanda not found, and read mode needs it for browser:reader",
    });
    expect(checks.find((c) => c.area === "identity reader" && /read mode on Lightpanda/.test(c.text))).toBeDefined();
  });

  it("checks an attach target without connecting to it", async () => {
    addIdentity("mine", sb.env);
    const dir = `${sb.home}/chrome`;
    writeIdentitySettings("mine", { attach: dir }, sb.env);
    let checks = await rows(base(), "identity mine");
    expect(checks.find((c) => c.text.startsWith("attach:"))).toMatchObject({
      level: "warn",
      manual: expect.stringContaining("chrome://inspect/#remote-debugging"),
    });
    sb.write("chrome/DevToolsActivePort", "9333\n/devtools/browser/abc\n");
    checks = await rows(base(), "identity mine");
    expect(checks.find((c) => c.text.startsWith("attach:"))).toMatchObject({
      level: "ok",
      text: expect.stringContaining("ws://127.0.0.1:9333;"),
    });
  });

  it("warns about a Lightpanda left running by a server that is gone, and only that one", async () => {
    const table: ProcTable = parseProcTable(
      [
        "  1     0     1 /sbin/launchd",
        "  500   1   500 /usr/local/bin/lightpanda serve --unix-socket /tmp/turno-lightpanda-ab12/cdp.sock --log-level warn",
        "  600 450   450 /usr/local/bin/lightpanda serve --unix-socket /tmp/turno-lightpanda-cd34/cdp.sock --log-level warn",
        "  450   1   450 node turno-browser-mcp --engine lightpanda",
        "  700   1   700 /usr/local/bin/lightpanda serve --port 9222",
      ].join("\n"),
    );
    const checks = await rows(base({ procTable: () => table }), "engines");
    expect(checks.find((c) => c.level === "warn")).toMatchObject({
      text: "Lightpanda pid 500 was left running by a server that is gone",
      auto: true,
    });
  });
});
