import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine } from "../src/engine.js";
import { createHost, serve } from "../src/host.js";
import { addIdentity } from "../src/identities.js";
import { liveFilePath, resolveLive } from "../src/live.js";
import { LiveError, liveLink, livePause, liveResume, liveStatus, readLiveFile } from "../src/live-client.js";
import { LiveServer } from "../src/live-server.js";
import { Redactor, VaultGuard } from "../src/redact.js";
import { writeIdentitySettings } from "../src/settings.js";
import { upstream } from "../src/upstream.js";
import { type Sandbox, sandbox, expectMode } from "./helpers/sandbox.js";

/**
 * The live view server without a browser: where it listens, who it answers, the one-time link,
 * and pause and resume through the control socket the CLI uses. Tokens and codes are compared,
 * never printed.
 */

let sb: Sandbox;
const servers: LiveServer[] = [];
beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  sb.cleanup();
});

async function startServer(refusal?: string): Promise<LiveServer> {
  const server = new LiveServer({
    identity: { id: "work", env: sb.env },
    policy: resolveLive({ enabled: true, wait: "5s" }),
    guard: new VaultGuard(),
    redactor: new Redactor(),
    headless: true,
    viewRefusal: () => refusal,
  });
  servers.push(server);
  await server.start();
  return server;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString("utf8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Signs in with a fresh link and returns the cookie header. */
async function signIn(port: number, id = "work"): Promise<string> {
  const link = new URL(await liveLink(id, sb.env));
  const res = await http(port, "GET", `${link.pathname}${link.search}`);
  expect(res.status).toBe(303);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return cookie;
}

describe("the live view server", () => {
  it("listens on 127.0.0.1 and a private socket, and live.json holds no secret", async () => {
    const server = await startServer();
    const file = liveFilePath("work", sb.env);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["pid", "port", "socket", "started", "version"]);
    expect(data.pid).toBe(process.pid);
    expectMode(file, 0o600);
    expectMode(server.socket!, 0o600);
    expectMode(dirname(server.socket!), 0o700);
    const status = await liveStatus("work", sb.env);
    expect(status).toMatchObject({ identity: "work", paused: null, browser: false, wait: 5_000, waiting: 0 });
    expect(status?.view).toEqual({ available: true, headless: true });
  });

  it("pauses and resumes through the socket, as turno browser pause and resume do", async () => {
    const server = await startServer();
    const paused = await livePause("work", sb.env);
    expect(paused.paused?.by).toBe("turno-browser pause");
    expect(server.paused).toBe(true);
    const held = server.gate.wait(server.waitMs);
    expect((await liveResume("work", sb.env)).paused).toBeNull();
    expect((await held).kind).toBe("resumed");
  });

  it("opens the view only with a link whose code works once", async () => {
    const server = await startServer();
    const port = (await liveStatus("work", sb.env))!.port;
    expect(server.socket).toBeDefined();

    const anonymous = await http(port, "GET", "/");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toContain("turno-browser live work");
    expect((await http(port, "GET", "/state")).status).toBe(401);
    // The stream of frames, steps and effects needs the cookie too.
    expect((await http(port, "GET", "/events")).status).toBe(401);
    expect((await http(port, "GET", "/?code=not-a-code")).status).toBe(403);

    const link = new URL(await liveLink("work", sb.env));
    expect(link.host).toBe(`127.0.0.1:${port}`);
    const first = await http(port, "GET", `/${link.search}`);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/");
    const setCookie = String(first.headers["set-cookie"]);
    expect(setCookie).toMatch(new RegExp(`^turno-live-${port}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/$`));
    expect((await http(port, "GET", `/${link.search}`)).status).toBe(403);

    const cookie = setCookie.split(";")[0]!;
    const page = await http(port, "GET", "/", { cookie });
    expect(page.status).toBe(200);
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    // The page's script (the effects engine included) parses.
    const open = `<script nonce="${nonce}">`;
    const script = page.body.slice(page.body.indexOf(open) + open.length, page.body.lastIndexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect((await http(port, "GET", "/state", { cookie: `${cookie}x` })).status).toBe(401);
  });

  it("answers only its loopback Host, and a POST only from its own origin with its header", async () => {
    const server = await startServer();
    const port = (await liveStatus("work", sb.env))!.port;
    const cookie = await signIn(port);
    expect((await http(port, "GET", "/state", { cookie, host: `evil.example:${port}` })).status).toBe(403);
    expect((await http(port, "GET", "/state", { cookie, host: `localhost:${port}` })).status).toBe(200);
    expect((await http(port, "POST", "/pause", { cookie })).status).toBe(403);
    expect(
      (await http(port, "POST", "/pause", { cookie, origin: "http://evil.example", "x-turno-live": "1" })).status,
    ).toBe(403);
    expect((await http(port, "POST", "/pause", { cookie, origin: `http://127.0.0.1:${port}` })).status).toBe(403);
    expect(server.paused).toBe(false);
    const ok = await http(port, "POST", "/pause", {
      cookie,
      origin: `http://127.0.0.1:${port}`,
      "x-turno-live": "1",
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).paused.by).toBe("the live view");
  });

  it("lets the side panel in only from its extension, with a code that works once, then its own token", async () => {
    const server = await startServer();
    const extension = `chrome-extension://${"b".repeat(32)}`;
    expect(await server.panelOffer("https://evil.example")).toBeUndefined();
    const offer = (await server.panelOffer(extension))!;
    const port = Number(new URL(offer.server).port);
    const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
      http(port, "POST", path, { "content-type": "application/json", ...headers }, JSON.stringify(body));
    // A page's origin, or no origin, never reaches the panel's routes (nor uses up the code).
    expect((await post("/panel/session", { origin: "http://evil.example" }, { code: offer.code })).status).toBe(401);
    expect((await post("/panel/session", {}, { code: offer.code })).status).toBe(401);
    const ok = await post("/panel/session", { origin: extension }, { code: offer.code });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(extension);
    const { token } = JSON.parse(ok.body) as { token: string };
    expect((await post("/panel/session", { origin: extension }, { code: offer.code })).status).toBe(401);
    expect((await post("/pause", { origin: extension })).status).toBe(401);
    expect((await post("/pause", { origin: extension, authorization: `Bearer ${token}x` })).status).toBe(401);
    const paused = await post("/pause", { origin: extension, authorization: `Bearer ${token}` });
    expect(paused.status).toBe(200);
    expect(JSON.parse(paused.body).paused.by).toBe("the side panel");
    // The token is the panel's alone: the view's own routes still want the view's cookie.
    expect((await http(port, "GET", "/state", { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("refuses input with no tab to send it to without pausing, and the link and input never from the wrong side", async () => {
    await startServer();
    const port = (await liveStatus("work", sb.env))!.port;
    const cookie = await signIn(port);
    const post = (path: string, body: unknown) =>
      http(
        port,
        "POST",
        path,
        { cookie, origin: `http://127.0.0.1:${port}`, "x-turno-live": "1", "content-type": "application/json" },
        JSON.stringify(body),
      );
    // Input takes the controls by itself, but a refused one does not pause the agent.
    const noTab = await post("/input", { type: "click", x: 10, y: 10 });
    expect(noTab.status).toBe(409);
    expect(JSON.parse(noTab.body).error).toBe("There is no tab to send it to.");
    expect((await liveStatus("work", sb.env))?.paused).toBeNull();
    // The one-time link comes only from the socket.
    expect((await post("/link", {})).status).toBe(404);
    expect((await post("/pause", [1, 2])).status).toBe(400);
  });

  it("gives no link where the view shows no pixels, but still pauses", async () => {
    await startServer("Read mode (Lightpanda) renders no pixels, so there is nothing to show.");
    const status = await liveStatus("work", sb.env);
    expect(status?.view.available).toBe(false);
    await expect(liveLink("work", sb.env)).rejects.toThrow(/^Read mode \(Lightpanda\) renders no pixels/);
    expect((await livePause("work", sb.env)).paused).not.toBeNull();
  });

  it("removes live.json and the socket on close, and the client then says how it starts", async () => {
    const server = await startServer();
    const socket = server.socket!;
    await server.close();
    expect(existsSync(liveFilePath("work", sb.env))).toBe(false);
    expect(existsSync(socket)).toBe(false);
    expect(await liveStatus("work", sb.env)).toBeUndefined();
    const error = await livePause("work", sb.env).catch((e: Error) => e);
    expect(error).toBeInstanceOf(LiveError);
    expect((error as Error).message).toContain("It starts with the server");
  });

  it("drops a live.json whose server is gone", () => {
    const file = liveFilePath("work", sb.env);
    sb.write(file.slice(sb.home.length + 1), "{}");
    writeFileSync(
      file,
      JSON.stringify({ version: 1, pid: 2 ** 22 + 12345, socket: "/nowhere", port: 1, started: "x" }),
    );
    expect(readLiveFile("work", sb.env)).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});

describe("the live view in the host", () => {
  async function host(id: string, flags?: { live?: boolean }) {
    const config = await upstream().tools.resolveCLIConfigForMCP(
      { browser: "chrome", userDataDir: `${sb.home}/profile`, headless: true },
      {},
    );
    const h = createHost({ config, cliOptions: {}, identity: { id, env: sb.env }, ...(flags ? { live: flags } : {}) });
    if (h.live) servers.push(h.live);
    await h.live?.start(); // the host started it already; this waits until it listens
    return h;
  }

  it("is on by default, off with identity.json live.enabled false, and in the identity's language", async () => {
    addIdentity("plain", sb.env);
    expect((await host("plain")).live).toBeDefined();
    addIdentity("off", sb.env);
    writeIdentitySettings("off", { live: { enabled: false } }, sb.env);
    expect((await host("off")).live).toBeUndefined();
    expect((await host("off", { live: true })).live).toBeDefined();
    addIdentity("on", sb.env);
    writeIdentitySettings("on", { locale: "es-MX", live: { enabled: true, wait: "10s" } }, sb.env);
    const h = await host("on");
    expect(h.live?.waitMs).toBe(10_000);
    const status = await liveStatus("on", sb.env);
    expect(status?.view).toEqual({ available: true, headless: true });
    const page = await http(status!.port, "GET", "/", { cookie: await signIn(status!.port, "on") });
    expect(page.body).toMatch(/<html lang="es">[\s\S]*>Pausar</);
  });

  it("holds the natural language and captcha tools like any browser call, and not the flow list", async () => {
    addIdentity("opt", sb.env);
    writeIdentitySettings(
      "opt",
      {
        act: {},
        captcha: { provider: "task-api", endpoint: "https://solver.example.com", key: "keychain:solver" },
        live: { enabled: true, wait: "5s" },
      },
      sb.env,
    );
    const noBrowser: Engine = {
      id: "chrome",
      async launch() {
        throw new Error("no browser in this test");
      },
    };
    const config = await upstream().tools.resolveCLIConfigForMCP(
      { browser: "chrome", userDataDir: `${sb.home}/profile`, headless: true },
      {},
    );
    const h = createHost({ config, cliOptions: {}, engine: noBrowser, identity: { id: "opt", env: sb.env } });
    if (h.live) servers.push(h.live);
    await h.live?.start();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await serve(h, serverSide);
    const client = new Client({ name: "live-test", version: "0.0.0" });
    await client.connect(clientSide);
    await livePause("opt", sb.env);
    const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;
    const flows = await client.callTool({ name: "browser_flows", arguments: {} });
    expect(text(flows)).not.toMatch(/paused/);
    const tools = ["browser_act", "browser_extract", "browser_observe", "browser_solve_captcha"];
    const held = await Promise.all(
      tools.map((name) =>
        client.callTool({ name, arguments: name === "browser_solve_captcha" ? {} : { instruction: "x" } }),
      ),
    );
    held.forEach((r, i) => {
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`has not resumed it within 5s, so ${tools[i]} was not run`);
    });
    await client.close();
  });

  it("refuses the view in read mode, in attach mode and with Camoufox before any browser starts, and pause still works", async () => {
    addIdentity("reader", sb.env);
    writeIdentitySettings("reader", { engine: "lightpanda", live: { enabled: true } }, sb.env);
    await host("reader");
    expect((await liveStatus("reader", sb.env))?.view.reason).toMatch(/^Read mode \(Lightpanda\) renders no pixels/);
    await expect(liveLink("reader", sb.env)).rejects.toThrow(/renders no pixels/);
    expect((await livePause("reader", sb.env)).paused?.by).toBe("turno-browser pause");

    addIdentity("mine", sb.env);
    writeIdentitySettings("mine", { attach: "auto", live: { enabled: true } }, sb.env);
    await host("mine");
    await expect(liveLink("mine", sb.env)).rejects.toThrow(
      /^Attach mode drives your own Chrome, which you already see/,
    );
    expect((await livePause("mine", sb.env)).paused).not.toBeNull();

    // Camoufox is Firefox: no CDP screencast. Nothing launches it here.
    addIdentity("fox", sb.env);
    writeIdentitySettings("fox", { engine: "camoufox", live: { enabled: true } }, sb.env);
    await host("fox");
    await expect(liveLink("fox", sb.env)).rejects.toThrow(/^The view is a Chrome DevTools Protocol screencast/);
    expect((await livePause("fox", sb.env)).paused).not.toBeNull();
  });
});
