import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { addIdentity } from "../src/identities.js";
import { readChallenges } from "../src/reputation.js";
import { chromeUnavailable, stopSandboxProcesses } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Sensitive fields and credentials against a real Google Chrome, through the server dist/ the
 * global setup builds: a password or one-time code the person typed never comes back in a
 * snapshot, a result or a file the server writes; the agent cannot type one; network output
 * keeps the names of credentials and drops their values; a challenge page is pointed out.
 * Secret values are compared, never printed.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const PERSON_PASSWORD = "Pers0n typed&<pw>";
const PERSON_CODE = "482913";
const DIGITS = "731";
const BEARER = "bearer-0123456789abcdef";
const API_KEY = "apikey-0123456789abcdef";
const QUERY_TOKEN = "querytoken-0123456789";
const BODY_PASSWORD = "BodyPa55word-0123";
const ACCESS_TOKEN = "accesstoken-0123456789";
const REFRESH_TOKEN = "refreshtoken-0123456789";
const OAUTH_CODE = "oauthcode-0123456789";
const CLIENT_SECRET = "clientsecret-0123456789";

let sb: Sandbox;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

/**
 * A sign-in form. With `?person=1` the page fills the password, the one-time code and the
 * three code digits as soon as it loads: the values a person types while the agent waits
 * (the agent itself cannot type them).
 */
const LOGIN = `<title>Sign in</title><h1>Sign in</h1>
  <form method="post" action="/session">
    <label>User <input name="user" autocomplete="username"></label>
    <label>Password <input id="pw" name="password" type="password" autocomplete="current-password"></label>
    <label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
    <label>Digit 1 <input name="otp-1" maxlength="1"></label>
    <label>Digit 2 <input name="otp-2" maxlength="1"></label>
    <label>Digit 3 <input name="otp-3" maxlength="1"></label>
    <button>Sign in</button>
  </form>
  <button id="other" onclick="this.textContent = 'Shown'">Show</button>
  <script>
    if (location.search.includes("person=1")) {
      document.getElementById("pw").value = ${JSON.stringify(PERSON_PASSWORD)};
      document.getElementById("code").value = ${JSON.stringify(PERSON_CODE)};
      ${JSON.stringify(DIGITS)}.split("").forEach((d, i) => { document.getElementsByName("otp-" + (i + 1))[0].value = d; });
    }
  </script>`;

/** A page whose button calls an API with credentials in a header, the query and both bodies. */
const API = `<title>API</title><button onclick="go()">Load</button><p id="out"></p>
  <script>
    async function go() {
      await fetch("/api/data?access_token=${QUERY_TOKEN}&page=2", {
        method: "POST",
        headers: { Authorization: "Bearer ${BEARER}", "X-Api-Key": "${API_KEY}", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "${BODY_PASSWORD}", name: "ada" }),
      });
      await fetch("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=${OAUTH_CODE}&client_secret=${CLIENT_SECRET}",
      });
      document.getElementById("out").textContent = "loaded";
    }
  </script>`;

const CHALLENGE = readFileSync(join(pkg, "test", "fixtures", "challenge.html"), "utf8");

interface Web {
  url: string;
  posted: string[];
  close(): Promise<void>;
}

const bodyOf = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
    });
    req.on("end", () => resolve(b));
  });

async function web(): Promise<Web> {
  const posted: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST") posted.push(await bodyOf(req));
    if (path.startsWith("/api/") || path === "/oauth/token") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer", user: "ada" }),
      );
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/session") res.end("<title>Welcome</title><h1>Signed in</h1>");
    else if (path === "/login") res.end(LOGIN);
    else if (path === "/api") res.end(API);
    else if (path === "/challenge") res.end(CHALLENGE);
    else res.end("<title>Plain</title><p>Nothing here</p>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, posted, close: () => new Promise((r) => server.close(() => r())) };
}

async function start(id: string): Promise<Client> {
  addIdentity(id, sb.env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless"],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "sensitive-chrome", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot);
  if (!m) throw new Error(`no ${role} "${name}" in the snapshot`);
  return m[1]!;
}

/** How many of the secret values a text holds, as typed or URL encoded. Never shows them. */
function leaks(text: string, values: string[]): number {
  return values.filter(
    (v) =>
      text.includes(v) ||
      text.includes(encodeURIComponent(v)) ||
      text.includes(new URLSearchParams({ v }).toString().slice(2)),
  ).length;
}

/** Every file the server wrote in the workspace (snapshots, console logs, saved results). */
function workspaceText(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? workspaceText(p) : readFileSync(p, "utf8");
  }
  return out;
}

describe.skipIf(reason !== undefined)(
  reason ? `sensitive fields on real Chrome (skipped: ${reason})` : "sensitive fields on real Chrome",
  () => {
    it("never shows a password or one-time code the person typed: snapshots, JSON, files, scripts, requests", async () => {
      const site = await web();
      onTestFinished(() => site.close());
      const client = await start("work");
      await call(client, "browser_navigate", { url: `${site.url}/login?person=1` });

      const snap = await call(client, "browser_snapshot");
      expect(snap.error, snap.text).toBe(false);
      expect(leaks(snap.text, [PERSON_PASSWORD, PERSON_CODE]), "typed value in the snapshot").toBe(0);
      expect(snap.text).toMatch(/textbox "Password" \[ref=e\d+\]: \[sensitive field\]/);
      expect(snap.text).toMatch(/textbox "Code" \[ref=e\d+\]: \[sensitive field\]/);
      // One digit per box is too short to redact by value; the snapshot masks each box.
      for (const n of [1, 2, 3])
        expect(snap.text).toMatch(new RegExp(`textbox "Digit ${n}" \\[ref=e\\d+\\]: \\[sensitive field\\]`));
      expect(snap.text).toMatch(/textbox "User" \[ref=e\d+\]\n/);

      const json = await call(client, "browser_snapshot", { _meta: { json: true } });
      expect(json.error, json.text).toBe(false);
      expect(leaks(json.text, [PERSON_PASSWORD, PERSON_CODE]), "typed value in the JSON snapshot").toBe(0);
      expect(json.text).toContain("[sensitive field]");

      // An action writes its snapshot to a file in the workspace: that file is masked too.
      const shown = await call(client, "browser_click", { target: ref(snap.text, "button", "Show"), element: "Show" });
      expect(shown.error, shown.text).toBe(false);
      const files = workspaceText(join(sb.home, ".playwright-mcp"));
      expect(files).toContain("[sensitive field]");
      expect(leaks(files, [PERSON_PASSWORD, PERSON_CODE]), "typed value in a workspace file").toBe(0);

      // A script that reads the field back gets the placeholder.
      const read = await call(client, "browser_evaluate", { function: "() => document.getElementById('pw').value" });
      expect(read.error, read.text).toBe(false);
      expect(leaks(read.text, [PERSON_PASSWORD]), "typed value in an evaluate result").toBe(0);
      expect(read.text).toContain("[sensitive field]");

      // Submitted, the form body holds it: the request shows neither the value nor the code.
      const signedIn = await call(client, "browser_click", {
        target: ref(snap.text, "button", "Sign in"),
        element: "Sign in",
      });
      expect(signedIn.error, signedIn.text).toBe(false);
      expect(site.posted).toHaveLength(1);
      expect(new URLSearchParams(site.posted[0]).get("password") === PERSON_PASSWORD).toBe(true);
      const list = await call(client, "browser_network_requests", { static: true });
      const index = /^(\d+)\. \[POST\] [^\n]*\/session/m.exec(list.text)?.[1];
      expect(index, list.text).toBeDefined();
      const body = await call(client, "browser_network_request", { index: Number(index), part: "request-body" });
      expect(body.error, body.text).toBe(false);
      expect(leaks(body.text, [PERSON_PASSWORD, PERSON_CODE]), "typed value in the request body").toBe(0);
      expect(body.text).toContain("user=");
    }, 90_000);

    it("refuses an agent that types a password or a one-time code, and says who should", async () => {
      const site = await web();
      onTestFinished(() => site.close());
      const client = await start("work");
      await call(client, "browser_navigate", { url: `${site.url}/login` });
      const snap = (await call(client, "browser_snapshot")).text;
      const value = async (selector: string) =>
        (
          await call(client, "browser_evaluate", {
            function: `() => JSON.stringify(document.querySelector('${selector}').value)`,
          })
        ).text;

      const typed = await call(client, "browser_type", {
        target: ref(snap, "textbox", "Password"),
        element: "Password",
        text: "agent-guess-123",
      });
      expect(typed.error).toBe(true);
      expect(typed.text).toContain("browser_type was refused: that field takes a password");
      expect(typed.text).toContain("browser_request_human");
      expect(typed.text).toContain("browser_login");
      expect(await value("#pw")).toContain('\\"\\"');

      const filled = await call(client, "browser_fill_form", {
        fields: [
          { name: "User", type: "textbox", target: ref(snap, "textbox", "User"), value: "ada" },
          { name: "Password", type: "textbox", target: ref(snap, "textbox", "Password"), value: "agent-guess-123" },
        ],
      });
      expect(filled.error).toBe(true);
      expect(filled.text).toContain("browser_fill_form was refused: that field takes a password");
      // The whole call is refused: not even the user name went in.
      expect(await value("[name=user]")).toContain('\\"\\"');

      const code = await call(client, "browser_type", { target: ref(snap, "textbox", "Code"), text: "123456" });
      expect(code.error).toBe(true);
      expect(code.text).toContain("that field takes a one-time code");
      const digit = await call(client, "browser_type", { target: ref(snap, "textbox", "Digit 1"), text: "1" });
      expect(digit.error).toBe(true);
      expect(digit.text).toContain("that field takes a one-time code");

      // Key presses into the focused password field are refused too; Tab is not typing.
      await call(client, "browser_click", { target: ref(snap, "textbox", "Password"), element: "Password" });
      const key = await call(client, "browser_press_key", { key: "x" });
      expect(key.error).toBe(true);
      expect(key.text).toContain("browser_press_key was refused");
      expect((await call(client, "browser_press_key", { key: "Tab" })).error).toBe(false);

      // Everything else is typed as before.
      const user = await call(client, "browser_type", { target: ref(snap, "textbox", "User"), text: "ada" });
      expect(user.error, user.text).toBe(false);
      expect(await value("[name=user]")).toContain('\\"ada\\"');
      expect(await value("#pw")).toContain('\\"\\"');
    }, 90_000);

    it("keeps the names of credentials in network output and drops their values, in text, JSON and files", async () => {
      const site = await web();
      onTestFinished(() => site.close());
      const client = await start("work");
      await call(client, "browser_navigate", { url: `${site.url}/api` });
      const snap = (await call(client, "browser_snapshot")).text;
      await call(client, "browser_click", { target: ref(snap, "button", "Load"), element: "Load" });
      await call(client, "browser_wait_for", { text: "loaded" });
      const secrets = [
        BEARER,
        API_KEY,
        QUERY_TOKEN,
        BODY_PASSWORD,
        ACCESS_TOKEN,
        REFRESH_TOKEN,
        OAUTH_CODE,
        CLIENT_SECRET,
      ];

      const list = await call(client, "browser_network_requests");
      expect(list.error, list.text).toBe(false);
      expect(leaks(list.text, secrets), "credential in the request list").toBe(0);
      expect(list.text).toMatch(/\/api\/data\?access_token=\[redacted\]&page=2/);
      const api = Number(/^(\d+)\. \[POST\] [^\n]*\/api\/data/m.exec(list.text)?.[1]);
      const oauth = Number(/^(\d+)\. \[POST\] [^\n]*\/oauth\/token/m.exec(list.text)?.[1]);

      const details = await call(client, "browser_network_request", { index: api });
      expect(leaks(details.text, secrets), "credential in the request details").toBe(0);
      expect(details.text).toContain("authorization: Bearer [redacted]");
      expect(details.text).toContain("x-api-key: [redacted]");
      expect(details.text).toContain("content-type: application/json");

      const parts = [
        await call(client, "browser_network_request", { index: api, part: "request-body" }),
        await call(client, "browser_network_request", { index: api, part: "response-body" }),
        await call(client, "browser_network_request", { index: oauth, part: "request-body" }),
        await call(client, "browser_network_request", { index: api, part: "request-headers" }),
      ];
      for (const p of parts) expect(leaks(p.text, secrets), "credential in a request part").toBe(0);
      expect(parts[0]!.text).toContain('"password":"[redacted]"');
      expect(parts[0]!.text).toContain('"name":"ada"');
      expect(parts[1]!.text).toContain('"access_token":"[redacted]"');
      expect(parts[1]!.text).toContain('"token_type":"Bearer"');
      expect(parts[2]!.text).toContain("grant_type=authorization_code&code=[redacted]&client_secret=[redacted]");

      const json = await call(client, "browser_network_request", { index: api, _meta: { json: true } });
      expect(leaks(json.text, secrets), "credential in JSON mode").toBe(0);
      expect(json.text).toContain("authorization: Bearer [redacted]");

      // Saved to a file in the workspace, the same output is redacted the same way.
      const saved = await call(client, "browser_network_request", {
        index: oauth,
        part: "response-body",
        filename: "oauth-response.json",
      });
      expect(saved.error, saved.text).toBe(false);
      const file = readFileSync(join(sb.home, "oauth-response.json"), "utf8");
      expect(leaks(file, secrets), "credential in the saved file").toBe(0);
      expect(file).toContain('"refresh_token":"[redacted]"');
    }, 90_000);

    it("tells the agent when the page it ended on is a challenge, once, and logs it", async () => {
      const site = await web();
      onTestFinished(() => site.close());
      const client = await start("work");
      const plain = await call(client, "browser_navigate", { url: `${site.url}/plain` });
      expect(plain.text).not.toContain("### Challenge");

      const challenged = await call(client, "browser_navigate", { url: `${site.url}/challenge` });
      expect(challenged.error, challenged.text).toBe(false);
      expect(challenged.text).toMatch(
        /### Challenge\nThis page \(127\.0\.0\.1\) shows a captcha\. A person should handle it/,
      );
      expect(challenged.text).toContain("browser_request_human");
      expect((await call(client, "browser_snapshot")).text).not.toContain("### Challenge");

      // Again within a minute: the log counts it once, the agent hears it every time.
      const again = await call(client, "browser_navigate", { url: `${site.url}/challenge`, _meta: { json: true } });
      expect(JSON.parse(again.text).turno.challenge).toMatch(/shows a captcha/);
      expect(readChallenges("work", sb.env).map((e) => [e.site, e.kind])).toEqual([["127.0.0.1", "captcha"]]);
    }, 90_000);
  },
);
