import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { flowsDir, listFlows, readFlow, writeFlow } from "../src/flows.js";
import { addIdentity } from "../src/identities.js";
import { listRecordings, recordingsDir, tracesTmpDir, zipTexts } from "../src/recordings.js";
import { SESSION_META_KEY } from "../src/session.js";
import { writeIdentitySettings } from "../src/settings.js";
import { vaultAdd, vaultSetSubmit } from "../src/vault.js";
import { chromeUnavailable, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type FakeSecretStore, fakeSecretStore } from "./helpers/fake-secret-store.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

/**
 * Record and replay against a real Google Chrome, through the server dist/ that the global
 * setup builds once, with a fake `security`/`secret-tool` on the sandbox PATH (never a real
 * Keychain) and a throwaway profile. Secret values are compared, never printed.
 *
 * Each test starts Chrome once or twice (the first also replays from the command line's path,
 * a second server and Chrome) and takes 5 to 9 seconds alone. Next to the other Chrome suites
 * of a full run it takes several times that, so the tests get the 120 s the other real-Chrome
 * suites have instead of the 30 s default.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

const EMAIL = "alice.flow@example.com";
const PASSWORD = 'Fl0w pass&<"word">';
const PASSWORD_2 = "Second-Pa55word!";
const VAULT_PASSWORD = "Vault Pa55 w0rd&<secret>";

let sb: Sandbox;
let store: FakeSecretStore;
const running: StdioClientTransport[] = [];
beforeEach(() => {
  sb = sandbox();
  store = fakeSecretStore(sb);
});
afterEach(async () => {
  for (const t of running.splice(0)) await t.close().catch(() => {});
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

async function start(id: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, "--identity", id, "--headless"],
    env: sb.env as Record<string, string>,
    cwd: sb.home,
    stderr: "pipe",
  });
  running.push(transport);
  const client = new Client({ name: "record-replay", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  session?: string,
): Promise<{ text: string; error: boolean }> {
  const res = await client.callTool({
    name,
    arguments: args,
    ...(session ? { _meta: { [SESSION_META_KEY]: session } } : {}),
  });
  const text = ((res as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, error: Boolean(res.isError) };
}

function ref(snapshot: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snapshot);
  if (!m) throw new Error(`no ${role} "${name}" in the snapshot`);
  return m[1]!;
}

/** Count, never show, the secret values found in a text. */
function leaks(text: string, values: string[]): number {
  return values.filter(
    (v) =>
      text.includes(v) ||
      text.includes(encodeURIComponent(v)) ||
      text.includes(new URLSearchParams({ v }).toString().slice(2)),
  ).length;
}

/** Every file under a folder, as text, zips unpacked. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += allText(p);
    else {
      const buf = readFileSync(p);
      out += buf.toString("utf8");
      if (name.endsWith(".zip")) for (const t of zipTexts(buf)) out += t.text;
    }
  }
  return out;
}

type Variant = "normal" | "moved" | "renamed";

/** A sign-in page whose markup a test can change between runs; `posted` keeps form bodies. */
async function site(): Promise<{ url: string; posted: string[]; variant: { v: Variant }; close(): Promise<void> }> {
  const posted: string[] = [];
  const variant = { v: "normal" as Variant };
  const login = () => {
    const button =
      variant.v === "renamed"
        ? `<button id="other">Log in</button>`
        : variant.v === "moved"
          ? `<div class="wrap"><span>Help</span><button id="submit-2">Sign in</button></div>`
          : `<button id="go">Sign in</button>`;
    return `<title>Sign in</title><h1>Sign in</h1>
      <form method="post" action="/session">
        <label>Email <input name="email" type="email" autocomplete="username"></label>
        <label>Password <input name="password" type="password" autocomplete="current-password"></label>
        ${button}
      </form>`;
  };
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        posted.push(body);
        res.end("<title>Welcome</title><h1>Signed in</h1><a href='/login'>again</a>");
      });
      return;
    }
    res.end(new URL(req.url ?? "/", "http://x").pathname === "/login" ? login() : "<title>404</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, posted, variant, close: () => new Promise((r) => server.close(() => r())) };
}

describe.skipIf(reason !== undefined)(
  reason ? `record and replay on real Chrome (skipped: ${reason})` : "record and replay on real Chrome",
  () => {
    it("records a sign-in without its password, replays it from the secret store when the page changed, and reports a step it cannot find", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("flows", sb.env);
      const client = await start("flows");
      expect((await call(client, "browser_record", { action: "start", name: "sign-in" })).error).toBe(false);
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const snap = (await call(client, "browser_snapshot")).text;
      await call(client, "browser_type", { element: "Email", target: ref(snap, "textbox", "Email"), text: EMAIL });
      // The agent never types a password: the call is refused, and the flow does not keep it.
      const typed = await call(client, "browser_type", {
        element: "Password",
        target: ref(snap, "textbox", "Password"),
        text: PASSWORD,
      });
      expect(typed.error).toBe(true);
      expect(typed.text).toContain("browser_type was refused: that field takes a password");
      const clicked = await call(client, "browser_click", {
        element: "Sign in button",
        target: ref(snap, "button", "Sign in"),
      });
      expect(clicked.error, clicked.text).toBe(false);
      const stopped = await call(client, "browser_record", { action: "stop" });
      expect(stopped.error, stopped.text).toBe(false);
      expect(stopped.text).toMatch(/Saved flow "sign-in" with 3 steps/);
      expect(web.posted).toHaveLength(1);

      const file = readFileSync(join(flowsDir("flows", sb.env), "sign-in.json"), "utf8");
      expect(leaks(file, [PASSWORD]), "password in the flow file").toBe(0);
      // A flow written by hand (or by an older turno-browser) types a sensitive parameter.
      const recorded = readFlow("flows", "sign-in", sb.env);
      writeFlow(
        "flows",
        {
          ...recorded,
          params: [...recorded.params, { name: "password", sensitive: true, description: "Password" }],
          steps: [
            recorded.steps[0]!,
            recorded.steps[1]!,
            {
              tool: "browser_type",
              args: { text: { $param: "password" } },
              targets: {
                target: {
                  description: "Password",
                  locators: [{ kind: "role", selector: 'internal:role=textbox[name="Password"s]' }],
                },
              },
            },
            recorded.steps[2]!,
          ],
        },
        sb.env,
      );
      const flow = readFlow("flows", "sign-in", sb.env);
      expect(flow.params.map((p) => [p.name, p.sensitive, p.default])).toEqual([
        ["email", false, EMAIL],
        ["password", true, undefined],
      ]);
      expect(flow.steps[3]!.targets!.target!.locators.map((l) => l.kind)).toEqual(["generated", "role", "text", "css"]);

      const missing = await call(client, "browser_replay", { flow: "sign-in" });
      expect(missing.error).toBe(true);
      expect(missing.text).toMatch(/Nothing ran: flow "sign-in" needs "password" \(sensitive\)/);

      // Passed in plain, the password would come from the agent: the replay stops at that step.
      const plain = await call(client, "browser_replay", { flow: "sign-in", params: { password: PASSWORD_2 } });
      expect(plain.error).toBe(true);
      expect(plain.text).toMatch(
        /Step 3 of 4 \(browser_type Password with \{password\}\) failed: browser_type was refused/,
      );
      expect(leaks(plain.text, [PASSWORD_2]), "parameter in the result").toBe(0);
      expect(web.posted).toHaveLength(1);

      // The button moved and lost its id: the CSS path fails, role and name still find it.
      store.write("flow-password", PASSWORD_2);
      web.variant.v = "moved";
      const replayed = await call(client, "browser_replay", {
        flow: "sign-in",
        params: { password: "keychain:flow-password" },
      });
      expect(replayed.error, replayed.text).toBe(false);
      expect(replayed.text).toMatch(/4\. browser_click Sign in button: ok \(found by (generated|role)\)/);
      expect(leaks(replayed.text, [PASSWORD_2]), "parameter in the result").toBe(0);
      expect(web.posted).toHaveLength(2);
      expect(new URLSearchParams(web.posted[1]).get("password") === PASSWORD_2).toBe(true);
      expect(new URLSearchParams(web.posted[1]).get("email")).toBe(EMAIL);

      // Renamed: nothing fits, and the report says what was tried and where to go on.
      web.variant.v = "renamed";
      const failed = await call(client, "browser_replay", {
        flow: "sign-in",
        params: { password: "keychain:flow-password" },
        wait: 1,
      });
      expect(failed.error).toBe(true);
      expect(failed.text).toMatch(
        /Step 4 of 4 \(browser_click Sign in button\) failed: no locator of "Sign in button"/,
      );
      expect(failed.text).toMatch(/- role internal:role=button\[name="Sign in"s\]: no element/);
      expect(failed.text).toMatch(/- css css=#go: no element/);
      expect(failed.text).toMatch(/It was the last step: do it yourself/);
      expect(failed.text).toMatch(/button "Log in"/); // the fresh snapshot
      expect(web.posted).toHaveLength(2);

      const listed = await call(client, "browser_flows");
      expect(listed.text).toMatch(
        /- sign-in: 4 steps, starts at http:\/\/127\.0\.0\.1:\d+\/login; params email, password \(sensitive, required\)/,
      );
      await client.close();

      // The same flow from the command line's path, the password read from the secret store.
      web.variant.v = "normal";
      const { replayFlow } = (await import(join(pkg, "dist", "replay.js"))) as typeof import("../src/replay.js");
      const cli = await replayFlow("flows", "sign-in", {
        params: { password: "keychain:flow-password" },
        headless: true,
        env: sb.env,
      });
      expect(cli.ok, cli.text).toBe(true);
      expect(leaks(cli.text, [PASSWORD_2])).toBe(0);
      expect(new URLSearchParams(web.posted[2]).get("password") === PASSWORD_2).toBe(true);
    }, 120_000);

    it("keeps vault values and passwords out of traces, screenshots and flows of an identity that records", async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("rec", sb.env);
      // One session, so browser_close ends the recording; the agent presses Sign in itself.
      writeIdentitySettings(
        "rec",
        { record: { flows: true, traces: true, screenshots: true }, sharing: "session" },
        sb.env,
      );
      await vaultAdd(
        "rec",
        "local",
        { urls: [`${web.url}/login`], username: EMAIL, password: VAULT_PASSWORD },
        { env: sb.env },
      );
      vaultSetSubmit("rec", "confirm", { env: sb.env });
      const client = await start("rec");
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const filled = await call(client, "browser_login", { site: "local" });
      expect(filled.error, filled.text).toBe(false);
      const snap = (await call(client, "browser_snapshot")).text;
      const clicked = await call(client, "browser_click", {
        element: "Sign in",
        target: ref(snap, "button", "Sign in"),
      });
      expect(clicked.error, clicked.text).toBe(false);
      // A password the person types is kept out the same way (the agent's own typing is refused).
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      const again = (await call(client, "browser_snapshot")).text;
      const refused = await call(client, "browser_type", { target: ref(again, "textbox", "Password"), text: PASSWORD });
      expect(refused.error).toBe(true);
      await call(client, "browser_evaluate", {
        function: `() => { const pw = document.querySelector("input[type=password]"); pw.value = ${JSON.stringify(PASSWORD)}; pw.focus(); }`,
      });
      await call(client, "browser_hover", { target: ref(again, "button", "Sign in") });
      await call(client, "browser_press_key", { key: "Enter" });
      await call(client, "browser_navigate", { url: `${web.url}/login` });
      await call(client, "browser_close");
      expect(await waitFor(() => listRecordings("rec", sb.env)[0]?.ended !== undefined, 15_000)).toBe(true);

      expect(new URLSearchParams(web.posted[0]).get("password") === VAULT_PASSWORD).toBe(true);
      expect(new URLSearchParams(web.posted[1]).get("password") === PASSWORD).toBe(true);
      const [rec] = listRecordings("rec", sb.env);
      // The trace before the vault fill is kept; the one that saw the person's password is deleted.
      expect(rec!.traces.length).toBeGreaterThanOrEqual(1);
      expect(rec!.discarded).toBeGreaterThanOrEqual(1);
      expect(rec!.screenshots).toBeGreaterThan(0);
      const index = JSON.parse(readFileSync(join(rec!.dir, "index.json"), "utf8")) as {
        steps: { tool: string; screenshot?: string; note?: string }[];
      };
      const login = index.steps.find((s) => s.tool === "browser_login");
      expect(login?.screenshot).toBeUndefined();
      // The refused call is no step of the recording.
      expect(index.steps.find((s) => s.tool === "browser_type")).toBeUndefined();

      const recorded = allText(recordingsDir("rec", sb.env)) + allText(flowsDir("rec", sb.env));
      expect(leaks(recorded, [VAULT_PASSWORD, PASSWORD]), "secrets in recordings or flows").toBe(0);
      expect(recorded).not.toContain(EMAIL); // the vault username was in the form only
      expect(existsSync(tracesTmpDir("rec", sb.env))).toBe(false);
      expect(existsSync(join(sb.home, ".playwright-mcp", "traces"))).toBe(false);

      const [auto] = listFlows("rec", sb.env);
      const steps = readFlow("rec", auto!.name, sb.env).steps;
      expect(steps.find((s) => s.tool === "browser_login")?.args).toEqual({ site: "local" });
      expect(steps.some((s) => s.tool === "browser_type")).toBe(false);
      await client.close();
    }, 120_000);

    it('with "sharing": "tabs", records only the session that started, and replays in its tabs', async () => {
      const web = await site();
      onTestFinished(() => web.close());
      addIdentity("team", sb.env);
      writeIdentitySettings("team", { sharing: "tabs", humanize: { level: "light", seed: 7 } }, sb.env);
      const client = await start("team");
      const A = "aaaaaaaa-1111-4111-8111-111111111111";
      const B = "bbbbbbbb-2222-4222-8222-222222222222";
      expect((await call(client, "browser_record", { action: "start", name: "a-only" }, A)).error).toBe(false);
      await call(client, "browser_navigate", { url: `${web.url}/login` }, A);
      await call(client, "browser_navigate", { url: `${web.url}/other` }, B);
      const snapA = (await call(client, "browser_snapshot", {}, A)).text;
      const typed = await call(client, "browser_type", { target: ref(snapA, "textbox", "Email"), text: EMAIL }, A);
      expect(typed.error, typed.text).toBe(false);
      // B is not recording: its own browser_record says so, and its calls stay out of A's flow.
      expect((await call(client, "browser_record", { action: "status" }, B)).text).toMatch(
        /No named flow is being recorded/,
      );
      await call(client, "browser_navigate", { url: `${web.url}/third` }, B);
      const stopped = await call(client, "browser_record", { action: "stop" }, A);
      expect(stopped.error, stopped.text).toBe(false);
      const flow = readFlow("team", "a-only", sb.env);
      expect(flow.steps.map((st) => st.tool)).toEqual(["browser_navigate", "browser_type"]);
      expect(flow.steps[0]!.args).toEqual({ url: `${web.url}/login` });

      // Replayed by A (with human-like input on), in A's tab; B's tab stays where it was.
      const replayed = await call(
        client,
        "browser_replay",
        { flow: "a-only", params: { email: "bob@example.com" } },
        A,
      );
      expect(replayed.error, replayed.text).toBe(false);
      expect((await call(client, "browser_snapshot", {}, B)).text).toContain(`${web.url}/third`);
      const after = (await call(client, "browser_snapshot", {}, A)).text;
      expect(after).toContain(`${web.url}/login`);
      expect(after).toMatch(/textbox "Email"[^\n]*: bob@example\.com/);
      await client.close();
    }, 120_000);
  },
);
