import type { ChildProcess } from "node:child_process";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Browser, CDPSession, Page } from "patchright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAttachEndpoint } from "../src/engine-attach.js";
import { playwright } from "../src/upstream.js";
import { chromeUnavailable, spawnChrome, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * A page's passkey prompts, end to end on a real Google Chrome with no person: the test starts a
 * headless Chrome with remote debugging, the server attaches to it (attach mode counts as a
 * Chrome the person can see), and the test gives the agent's tab a virtual authenticator over
 * its own CDP connection (WebAuthn.enable, WebAuthn.addVirtualAuthenticator), which answers
 * every ceremony at once as a person with Touch ID would.
 *
 * The sign-in page starts passkey autofill (conditional mediation) on load, which must not stop
 * the agent (its start and settle reach the server before the modal ones, and no note is about it); a click on "Create a passkey" and one on "Sign in with a passkey" (modal) each hand
 * the browser to the person, the step ends when the ceremony settles, and a result says how it
 * went, without any credential data.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();
const exe =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/opt/google/chrome/chrome";

const PAGE = `<!doctype html><title>Sign in</title>
<button id="create">Create a passkey</button>
<button id="signin">Sign in with a passkey</button>
<input autocomplete="username webauthn" aria-label="Email">
<script>
  window.log = [];
  const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
  const note = (what) => (v) => log.push(what + ":" + (v && v.name ? v.name : "ok"));
  const autofill = new AbortController();
  const pending = navigator.credentials
    .get({ mediation: "conditional", signal: autofill.signal, publicKey: { challenge: rnd(32), rpId: location.hostname } })
    .then(note("conditional"), note("conditional"));
  // As sign-in pages do, a ceremony of its own first withdraws the autofill request.
  const withdraw = () => (autofill.abort(), pending);
  document.getElementById("create").onclick = () =>
    withdraw().then(() =>
      navigator.credentials
        .create({ publicKey: { rp: { name: "Example" }, user: { id: rnd(16), name: "alice@example.com", displayName: "Alice" },
          challenge: rnd(32), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "preferred" } } })
        .then(note("create"), note("create")));
  document.getElementById("signin").onclick = () =>
    withdraw().then(() =>
      navigator.credentials
        .get({ publicKey: { challenge: rnd(32), rpId: location.hostname, userVerification: "preferred" } })
        .then(note("get"), note("get")));
</script>`;

let sb: Sandbox;
let chrome: ChildProcess | undefined;
let web: Server;
let origin: string;
let watcher: Browser | undefined;
let cdp: CDPSession;
let authenticatorId: string;
let transport: StdioClientTransport | undefined;
let client: Client;

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return textOf(res);
}

type PasskeyData = { op: string; origin: string; ended?: string; outcome?: string; error?: string; note: string };

/** The passkey part of a JSON result. */
function passkeyOf(text: string): PasskeyData | undefined {
  return (JSON.parse(text) as { turno?: { passkey?: PasskeyData } }).turno?.passkey;
}

/** Clicks `target` and returns the passkey note, from the click's result or, when it came later, a next call's. */
async function clickForPasskey(target: string, label: string): Promise<{ data: PasskeyData; on: string }> {
  const clicked = passkeyOf(await call("browser_click", { element: label, target, _meta: { json: true } }));
  if (clicked) return { data: clicked, on: "browser_click" };
  const end = Date.now() + 15_000;
  for (;;) {
    const later = passkeyOf(await call("browser_tabs", { action: "list", _meta: { json: true } }));
    if (later) return { data: later, on: "browser_tabs" };
    if (Date.now() > end) throw new Error("no passkey note within 15s");
  }
}

describe.skipIf(reason)(`a page's passkey prompt on a real Chrome${reason ? ` (skipped: ${reason})` : ""}`, () => {
  beforeAll(async () => {
    sb = sandbox();
    const env = { ...sb.env, XDG_CONFIG_HOME: join(sb.home, ".config"), XDG_CACHE_HOME: join(sb.home, ".cache") };
    web = createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      // Only the sign-in page asks: a passkey request another page left pending would make its
      // autofill request fail at once (OperationError) instead of waiting.
      res.end(req.url === "/" ? PAGE : "<!doctype html><title>Elsewhere</title>");
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    // WebAuthn needs a secure context and a domain for its RP ID: localhost is both.
    origin = `http://localhost:${(web.address() as { port: number }).port}`;
    const dir = join(sb.home, "chrome");
    chrome = spawnChrome(exe, dir, ["--headless=new", "--remote-debugging-port=0", "about:blank"], env);
    // Chrome creates the file before it writes the port and path into it: wait for both.
    const endpoint = await resolveAttachEndpoint({ kind: "dir", dir }, env, process.platform, 20_000);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--attach", dir],
      env: env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    client = new Client({ name: "passkey-test", version: "0.0.0" });
    await client.connect(transport);
    // The server opens a tab of its own; find it by the page it loads, and give it the authenticator.
    await call("browser_navigate", { url: `${origin}/?agent` });
    watcher = await playwright().chromium.connectOverCDP(endpoint);
    const agentTab = () =>
      watcher!
        .contexts()[0]!
        .pages()
        .find((p) => p.url().endsWith("/?agent"));
    expect(await waitFor(() => agentTab() !== undefined, 10_000)).toBe(true);
    cdp = await watcher.contexts()[0]!.newCDPSession(agentTab()!);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }));
  }, 90_000);

  afterAll(async () => {
    await transport?.close().catch(() => {});
    await watcher?.close().catch(() => {});
    chrome?.kill("SIGKILL");
    await new Promise<void>((r) => (web ? web.close(() => r()) : r()));
    if (sb) {
      await stopSandboxProcesses(sb.home);
      sb.cleanup();
    }
  });

  it("ignores passkey autofill, and hands each modal ceremony to the person until it settles", async () => {
    const loaded = await call("browser_navigate", { url: `${origin}/` });
    const tab = watcher!
      .contexts()[0]!
      .pages()
      .find((p) => p.url().startsWith(origin)) as Page;
    const log = () => tab.evaluate("window.log.join(',')", undefined, undefined, false) as Promise<string>;

    // Passkey autofill starts on load: no step, no note. The page reports in order, so its start
    // and its settle reached the server before the create below.
    expect(loaded).not.toContain("### Passkey");
    const snapshot = await call("browser_snapshot");
    expect(snapshot).not.toContain("### Passkey");
    expect(snapshot).not.toContain("Waited for the person");

    const created = await clickForPasskey("#create", "Create a passkey");
    expect(created.data).toMatchObject({ op: "create", origin, ended: "settled", outcome: "created" });
    expect(await log()).toContain("create:ok");

    const used = await clickForPasskey("#signin", "Sign in with a passkey");
    expect(used.data).toMatchObject({ op: "get", origin, ended: "settled", outcome: "used" });
    expect(await log()).toContain("get:ok");
    expect(await log()).toMatch(/conditional:(AbortError|NotAllowedError)/);
    for (const note of [created.data.note, used.data.note]) expect(note).not.toMatch(/alice|challenge/i);

    const after = await call("browser_snapshot");
    expect(after).not.toContain("### Passkey");

    // A page that navigates while the person has not answered takes the request with it: the
    // step ends then, not at its timeout. With no presence the authenticator never answers.
    await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false });
    const left = clickForPasskey("#signin", "Sign in with a passkey");
    const banner = () =>
      tab.evaluate("!!document.querySelector('turno-human-step')", undefined, undefined, false).catch(() => false);
    const until = Date.now() + 20_000;
    while (!(await banner()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(await banner()).toBe(true);
    await tab.goto(`${origin}/?elsewhere`);
    expect((await left).data).toMatchObject({ op: "get", origin, ended: "settled", outcome: "left" });
  }, 90_000);
});
