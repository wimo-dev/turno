import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { addIdentity } from "../src/identities.js";
import { base32Decode, totp } from "../src/totp.js";
import { vaultAdd, vaultSetSubmit } from "../src/vault.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * `browser_login` against a real Google Chrome, through the server dist/ that the
 * global setup builds once (test/helpers/build-dist.ts), with a fake `security`/`secret-tool`
 * on the sandbox PATH (never a real Keychain). The values are compared, never printed: an
 * assertion message shows only the redacted text.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const USERNAME = "alice.vault@example.com";
const PASSWORD = 'Pa55 w0rd&<"secret">';
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  fakeSecretStore(sb);
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

async function start(id: string, args: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless", ...args],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "login-tool", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(res: unknown): string {
  return ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
}

/** A tool's text and whether it failed. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; error: boolean }> {
  const res = await client.callTool({ name, arguments: args });
  return { text: textOf(res), error: Boolean(res.isError) };
}

/** No vault value, in any of the forms the redactor covers or a few it does not need to. */
function assertClean(text: string, codes: string[] = []): void {
  const leaks = [
    USERNAME,
    PASSWORD,
    encodeURIComponent(USERNAME),
    encodeURIComponent(PASSWORD),
    new URLSearchParams({ p: PASSWORD }).toString().slice(2),
    TOTP_SECRET,
    ...codes,
  ].filter((v) => text.includes(v));
  // Report how many leaked, never which value.
  expect(leaks.length, "vault values in a tool result").toBe(0);
}

/** A sign-in page and a code page on 127.0.0.1; `posted` collects form bodies. */
async function site(): Promise<{ url: string; posted: string[]; close(): Promise<void> }> {
  const posted: string[] = [];
  const pages: Record<string, string> = {
    "/login": `<title>Sign in</title><h1>Sign in</h1>
      <form method="post" action="/session">
        <label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        <label>Notes <textarea name="notes"></textarea></label>
        <button>Sign in</button>
      </form>`,
    "/code": `<title>Two-step</title><form method="post" action="/session"><label>Code <input name="otp" autocomplete="one-time-code" inputmode="numeric"></label><button>Verify</button></form>`,
    // Counts the trusted key presses in each field, so a test sees the typing without a value.
    "/typed": `<title>Sign in</title><form method="post" action="/session">
        <label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        <button>Sign in</button></form><p id="keys">none</p>
      <script>const n = {}; document.addEventListener("keydown", (e) => { if (!e.isTrusted || !e.target.name) return;
        n[e.target.name] = (n[e.target.name] || 0) + 1; document.getElementById("keys").textContent = "keys " + Object.entries(n).map(([k, v]) => k + "=" + v).join(" "); }, true);</script>`,
    "/echo": `<title>Echo</title><form method="post" action="/session"><label>Email <input id="user" name="user"></label><label>Password <input type="password" name="pw"></label>
      <button type="button" onclick="document.getElementById('out').textContent = document.getElementById('user').value + ' / ' + document.querySelector('[name=pw]').value">Show</button></form><p id="out"></p>`,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        posted.push(body);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<title>Welcome</title><h1>Signed in</h1>");
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[new URL(req.url ?? "/", "http://x").pathname] ?? "<title>404</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, posted, close: () => new Promise((r) => server.close(() => r())) };
}

async function store(id: string, url: string, withTotp = false): Promise<void> {
  addIdentity(id, sb.env);
  await vaultAdd(
    id,
    "local",
    { urls: [`${url}/login`], username: USERNAME, password: PASSWORD, ...(withTotp ? { totp: TOTP_SECRET } : {}) },
    { env: sb.env },
  );
}

describe.skipIf(reason !== undefined)(
  reason ? `browser_login on real Chrome (skipped: ${reason})` : "browser_login on real Chrome",
  () => {
    it("fills without submitting with submit confirm, and no result shows a value: snapshot, network, errors", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      await store("login", web.url);
      vaultSetSubmit("login", "confirm", { env: sb.env });
      const client = await start("login");
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const filled = await call(client, "browser_login", { site: "local" });
      expect(filled.error, filled.text).toBe(false);
      expect(filled.text).toMatch(/Filled the username and password of "local"/);
      expect(filled.text).toMatch(/Nothing was submitted/);
      expect(filled.text).toMatch(/\[vault: local (username|password)\]/);
      assertClean(filled.text);
      expect(web.posted).toEqual([]);

      // The script tools are refused on the filled page.
      const evaluated = await call(client, "browser_evaluate", {
        function: "() => document.querySelector('[type=password]').value",
      });
      expect(evaluated.error).toBe(true);
      expect(evaluated.text).toMatch(/holds values browser_login filled/);
      assertClean(evaluated.text);

      // The model clicks sign in itself; the POST body and the network log stay redacted.
      const clicked = await call(client, "browser_click", { target: "button", element: "Sign in button" });
      assertClean(clicked.text);
      expect(web.posted).toHaveLength(1);
      expect(new URLSearchParams(web.posted[0]).get("password") === PASSWORD).toBe(true);
      const network = await call(client, "browser_network_requests", { static: true });
      assertClean(network.text);
      const posts = network.text.split("\n").filter((l) => /POST/.test(l));
      expect(posts.length, network.text).toBeGreaterThan(0);
      const index = Number(
        /^\s*\[?(\d+)/.exec(posts[0]!.replace(/^[-*\s]+/, ""))?.[1] ?? network.text.split("\n").indexOf(posts[0]!) + 1,
      );
      const request = await call(client, "browser_network_request", { index, part: "request-body" });
      expect(request.text).toMatch(/\[vault: local (username|password)\]/);
      assertClean(request.text);
      for (const t of [
        (await call(client, "browser_snapshot")).text,
        (await call(client, "browser_console_messages")).text,
      ])
        assertClean(t);

      // After the navigation the page is no longer held.
      const after = await call(client, "browser_evaluate", { function: "() => document.title" });
      expect(after.error, after.text).toBe(false);
      expect(after.text).toContain("Welcome");
    }, 120_000);

    it("submits by default, and neither the result nor the page after it shows a value", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      await store("auto", web.url);
      const client = await start("auto");
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const signedIn = await call(client, "browser_login", { site: "local" });
      expect(signedIn.error, signedIn.text).toBe(false);
      expect(signedIn.text).toMatch(/Submitted the form/);
      assertClean(signedIn.text);
      expect(web.posted).toHaveLength(1);
      expect(new URLSearchParams(web.posted[0]).get("password") === PASSWORD).toBe(true);
      for (const t of [
        (await call(client, "browser_snapshot")).text,
        (await call(client, "browser_network_requests", { static: true })).text,
        (await call(client, "browser_console_messages")).text,
      ])
        assertClean(t);
    }, 120_000);

    it("refuses another origin, and browser_run_code_unsafe for an identity with a vault", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      await store("origin", web.url);
      const client = await start("origin");
      const other = web.url.replace("127.0.0.1", "localhost");
      await call(client, "browser_navigate", { url: `${other}/login` });
      const refused = await call(client, "browser_login", { site: "local" });
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/not on an origin "local" was stored for/);
      const unknown = await call(client, "browser_login", { site: "nowhere" });
      expect(unknown.error).toBe(true);
      expect(unknown.text).toMatch(/no credentials for "nowhere"/);
      const code = await call(client, "browser_run_code_unsafe", { code: "async (page) => page.title()" });
      expect(code.error).toBe(true);
      expect(code.text).toMatch(/has vault credentials/);
    }, 120_000);

    it("fills the current TOTP code on a second step and submits when the identity opted in", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("twostep", sb.env);
      await vaultAdd(
        "twostep",
        "local",
        { urls: [`${web.url}/login`], username: USERNAME, password: PASSWORD, totp: TOTP_SECRET },
        { env: sb.env },
      );
      vaultSetSubmit("twostep", "auto", { env: sb.env });
      const client = await start("twostep");
      await call(client, "browser_navigate", { url: `${web.url}/code` });
      const before = Date.now();
      const filled = await call(client, "browser_login", { site: "local" });
      expect(filled.error, filled.text).toBe(false);
      expect(filled.text).toMatch(/Filled the one-time code/);
      expect(filled.text).toMatch(/Submitted the form/);
      expect(web.posted).toHaveLength(1);
      const sent = new URLSearchParams(web.posted[0]).get("otp") ?? "";
      const params = { secret: TOTP_SECRET, algorithm: "SHA1" as const, digits: 6, period: 30 };
      const valid = [before, before + 30_000, Date.now()].map((t) => totp(params, t));
      expect(valid.includes(sent), "the code is one of the current TOTP codes").toBe(true);
      assertClean(filled.text, [sent]);
      expect(base32Decode(TOTP_SECRET).length).toBe(20);
    }, 120_000);

    it("types the values key by key when humanize is on, and still no result shows one", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("human", sb.env);
      await vaultAdd(
        "human",
        "local",
        { urls: [`${web.url}/typed`], username: USERNAME, password: PASSWORD },
        { env: sb.env },
      );
      const client = await start("human", ["--humanize", "light"]);
      await call(client, "browser_navigate", { url: `${web.url}/typed` });
      const filled = await call(client, "browser_login", { site: "local" });
      expect(filled.error, "browser_login failed").toBe(false);
      assertClean(filled.text);
      // The page counted a trusted key press per character in each field.
      const snap = await call(client, "browser_snapshot");
      assertClean(snap.text);
      const keys = /keys [^\n"]*/.exec(snap.text)?.[0];
      expect(keys).toBe(`keys email=${USERNAME.length} password=${PASSWORD.length}`);
      await call(client, "browser_click", { target: "button", element: "Sign in button" });
      expect(web.posted).toHaveLength(1);
      const sent = new URLSearchParams(web.posted[0]);
      expect(sent.get("email") === USERNAME && sent.get("password") === PASSWORD, "the form got both values").toBe(
        true,
      );
    }, 120_000);

    it("checks a field the model names: a password goes only into a password input", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      await store("named", web.url);
      const client = await start("named");
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const wrong = await call(client, "browser_login", { site: "local", passwordField: "textarea" });
      expect(wrong.error).toBe(true);
      expect(wrong.text).toMatch(/not a password field/);
      assertClean(wrong.text);
    }, 120_000);

    it("is refused while the server saves its session", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      await store("traced", web.url);
      const client = await start("traced", ["--save-session", "--output-dir", join(sb.home, "out")]);
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const refused = await call(client, "browser_login", { site: "local" });
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/records the session/);
    }, 120_000);
  },
);
