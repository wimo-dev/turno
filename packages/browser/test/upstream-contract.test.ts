import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUNING_FLAGS, buildArgv } from "../src/argv.js";
import { mcpEntryPath } from "../src/patchright.js";
import { TURNO_TOOLS, checkTurnoTools } from "../src/tools.js";
import { BACKGROUND_SWITCHES } from "../src/tuning.js";
import { upstream } from "../src/upstream.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";
import { DEFAULT_CAPS, DEFAULT_TOOL_NAMES } from "./helpers/upstream-tools.js";

/**
 * What turno-browser relies on in the Playwright MCP program bundled in patchright-core.
 * An upgrade that changes any of it fails here, not in a user's
 * session: the tool names agents see, the config keys and precedence of the generated
 * `--config`, the idle timer that honors `timeouts.idle` even when headed, the exit watchdog,
 * and the library entry points the host uses in place of the stock program.
 */

const pkg = fileURLToPath(new URL("..", import.meta.url));
const bin = join(pkg, "dist", "bin", "mcp.js");
const bundlePath = join(dirname(mcpEntryPath()), "..", "coreBundle.js");
const bundleSource = readFileSync(bundlePath, "utf8");

/** The source of one top-level function of the bundle (its body ends at the next "}" alone on a line). */
function bundleFunction(name: string): string {
  const start = bundleSource.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  expect(start, `function ${name} in the bundle`).toBeGreaterThanOrEqual(0);
  return bundleSource.slice(start, bundleSource.indexOf("\n}\n", start) + 2);
}

async function listToolsOver(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: env as Record<string, string>,
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "contract", version: "0.0.0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

interface McpTools {
  resolveCLIConfigForMCP(
    options: Record<string, unknown>,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ timeouts: { idle?: number }; configFile?: string }>;
  createBrowserWithInfo: (...args: unknown[]) => unknown;
  setupExitWatchdog: () => void;
}
const tools = (createRequire(import.meta.url)(bundlePath) as { tools: McpTools }).tools;
const lib = () => upstream().tools;

/** The tools a default `turno-browser-mcp` serves, in the order it lists them. */
/** The turno tools, listed after the stock ones. */
const TURNO_NAMES = [
  "browser_batch",
  "browser_login",
  "browser_record",
  "browser_replay",
  "browser_flows",
  "browser_request_human",
];

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

describe("upstream contract (patchright-core 1.64.3)", () => {
  it("pins the version this contract was written against", () => {
    const version = JSON.parse(readFileSync(join(dirname(bundlePath), "..", "package.json"), "utf8")).version;
    expect(version).toBe("1.64.3");
  });

  it("serves exactly these tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--identity", "contract"],
      env: sb.env as Record<string, string>,
      cwd: sb.home,
      stderr: "pipe",
    });
    const client = new Client({ name: "contract", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools: listed } = await client.listTools();
      // The stock tools in upstream's order, then turno's.
      expect(listed.map((t) => t.name)).toEqual([...DEFAULT_TOOL_NAMES, ...TURNO_NAMES]);
    } finally {
      await client.close();
    }
  });

  it("reads timeouts.idle from the generated config, and lets --idle-timeout and the env win", async () => {
    const built = buildArgv(["--identity", "contract"], { env: { ...sb.env, TURNO_BROWSER_IDLE: "2s" } });
    const file = sb.write("cfg/mcp-config.json", JSON.stringify(built.config?.data));
    const fromFile = await tools.resolveCLIConfigForMCP({ config: file }, {});
    expect(fromFile.timeouts.idle).toBe(2000);
    expect(fromFile.configFile).toBe(file);
    expect((await tools.resolveCLIConfigForMCP({ config: file, idleTimeout: 0 }, {})).timeouts.idle).toBe(0);
    expect(
      (await tools.resolveCLIConfigForMCP({ config: file }, { PLAYWRIGHT_MCP_IDLE_TIMEOUT: "5000" })).timeouts.idle,
    ).toBe(5000);
  });

  it("starts the idle timer from timeouts.idle whatever the headless setting", () => {
    // Headless gets a one hour default; headed gets none unless the config sets one.
    const src = tools.createBrowserWithInfo.toString();
    expect(src).toMatch(/const idleTimeout = config\.timeouts\?\.idle \?\? \(/);
    expect(src).toMatch(/new IdleTimer\(idleTimeout, \(\) => info\.browser\.close\(\)/);
  });

  it("closes the browser when stdin closes or on SIGINT and SIGTERM, within 15 seconds", () => {
    const src = tools.setupExitWatchdog.toString();
    expect(src).toMatch(/process\.stdin\.on\("close"/);
    expect(src).toMatch(/process\.on\("SIGTERM"/);
    expect(src).toMatch(/setTimeout\(\(\) => \(0, import_bootstrap\d*\.processExit\)\(0\), 15e3\)/);
  });

  it("serves exactly the tool definitions of the stock program (names, schemas, annotations)", async () => {
    // With no --caps the host lists the default capabilities, so stock gets them by name.
    for (const [caps, stockCaps] of [
      [[], ["--caps", DEFAULT_CAPS.join(",")]],
      [
        ["--caps", "vision,pdf,devtools"],
        ["--caps", "vision,pdf,devtools"],
      ],
    ]) {
      const host = await listToolsOver([bin, "--identity", "contract", ...caps!], sb.env, sb.home);
      const stock = await listToolsOver(
        [mcpEntryPath(), "--browser", "chrome", "--user-data-dir", join(sb.home, "stock"), ...stockCaps!],
        sb.env,
        sb.home,
      );
      expect(host.length).toBeGreaterThanOrEqual(25 + TURNO_NAMES.length);
      expect(host.slice(0, host.length - TURNO_NAMES.length)).toEqual(stock);
      expect(host.slice(-TURNO_NAMES.length).map((t) => (t as { name: string }).name)).toEqual(TURNO_NAMES);
    }
  });

  it("serves the same tools over HTTP with --port, through upstream's HTTP server", async () => {
    const { spawn } = await import("node:child_process");
    // A temporary profile is made under TMPDIR and removed when the server exits on SIGTERM.
    const env = { ...sb.env, TMPDIR: sb.home };
    const child = spawn(process.execPath, [bin, "--port", "0"], {
      env,
      cwd: sb.home,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const exited = new Promise((r) => child.once("exit", r));
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let err = "";
        child.stderr.on("data", (d: Buffer) => {
          err += d.toString();
          const m = /Listening on (http:\/\/\S+)/.exec(err);
          if (m) resolve(m[1]!);
        });
        child.once("exit", () => reject(new Error(`exited: ${err}`)));
      });
      const client = new Client({ name: "contract", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => t.name)).toEqual([...DEFAULT_TOOL_NAMES, ...TURNO_NAMES]);
      expect(client.getServerVersion()?.name).toBe("turno-browser");
      await client.close();
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });

  it("exports the library entry points the host uses, with these arities", () => {
    const { tools: lib, utils } = upstream();
    const arity: Record<string, number> = {
      decorateMCPCommand: 1,
      resolveCLIConfigForMCP: 2,
      filteredTools: 1,
      createBrowserWithInfo: 4,
      setupExitWatchdog: 0,
      start: 1,
      isProfileLocked: 1,
      outputDir: 1,
    };
    for (const [name, n] of Object.entries(arity)) {
      expect(typeof (lib as unknown as Record<string, unknown>)[name], name).toBe("function");
      expect((lib as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.length, name).toBe(n);
    }
    expect(Array.isArray(lib.browserTools)).toBe(true);
    expect(typeof lib.BrowserBackend).toBe("function");
    for (const method of ["initialize", "callTool", "dynamicTools", "dispose"]) {
      expect(typeof (lib.BrowserBackend.prototype as Record<string, unknown>)[method], method).toBe("function");
    }
    expect(typeof utils.program.constructor).toBe("function");
    for (const fn of ["object", "string", "toJSONSchema", "prettifyError"] as const)
      expect(typeof utils.z[fn], fn).toBe("function");
    expect(typeof upstream().core.utils.gracefullyProcessExitDoNotHang).toBe("function");
  });

  it("lets the host replace the action of upstream's program and keep its options", async () => {
    const { tools: lib, utils } = upstream();
    const program = new utils.program.constructor().name("Playwright MCP");
    lib.decorateMCPCommand(program);
    let seen: Record<string, unknown> | undefined;
    program.action((options) => {
      seen = options;
    });
    await program.parseAsync(["--headless", "--caps", "vision,pdf", "--idle-timeout", "5"], { from: "user" });
    expect(seen).toMatchObject({ headless: true, caps: ["vision", "pdf"], idleTimeout: 5 });
  });

  it("runs stock tools through BrowserBackend with the idle timer and dispose callback the host passes", () => {
    const src = lib().BrowserBackend.toString();
    expect(src).toMatch(/constructor\(config, browserContext, tools, options = \{\}\)/);
    expect(src).toMatch(/this\._disposeCallback = options\.dispose;/);
    expect(src).toMatch(/this\._idleTimer = options\.idleTimer;/);
    expect(src).toMatch(/async callTool\(name, rawArguments = \{\}, signal\) \{\n\s*this\._idleTimer\?\.poke\(\);/);
    expect(src).toMatch(/this\.emit\("disconnected"\)/);
    expect(src).toMatch(/onWebMCPToolsChanged: \(\) => this\.emit\("dynamictoolschange"\)/);
  });

  it("launches a persistent browser the way the chrome engine copies (createPersistentBrowser)", () => {
    const src = bundleFunction("createPersistentBrowser");
    expect(src).toContain("if (await isProfileLocked5Times(userDataDir))");
    expect(src).toMatch(
      /const launchOptions = \{\s*tracesDir,\s*\.\.\.config\.browser\.launchOptions,\s*\.\.\.config\.browser\.contextOptions,\s*handleSIGINT: false,\s*handleSIGTERM: false,/,
    );
    expect(src).toMatch(/ignoreDefaultArgs: configIgnoreDefaultArgs === true \? true : \[\s*"--disable-extensions",/);
    expect(src).toContain("await browserType.launchPersistentContext(userDataDir, launchOptions)");
    expect(bundleFunction("computeTracesDir")).toContain('outputDir({ config, cwd: clientInfo.cwd }), "traces")');
    expect(bundleFunction("createBrowser")).toContain(
      "await browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir })",
    );
    expect(bundleFunction("createBrowserWithInfo")).toContain(
      'info.ownership === "own" && config.browser.launchOptions.headless ? defaultIdleTimeout : void 0',
    );
  });

  it("serves sessions the way the host copies (program.ts, server.ts)", () => {
    const program = bundleFunction("decorateMCPCommand");
    expect(program).toContain("setupExitWatchdog();");
    expect(program).toContain("const config = await resolveCLIConfigForMCP(options);");
    expect(program).toContain("const useSharedBrowser = config.sharedBrowserContext || config.browser.isolated;");
    expect(program).toContain("return new BrowserBackend(config, browserContext, tools, {");
    expect(program).toContain("await start(factory, config.server);");
    const server = bundleFunction("createServer");
    expect(server).toContain("capabilities: {\n      tools: { listChanged: true }");
    expect(server).toContain('content: [{ type: "text", text: "### Error\\n" + String(error) }],');
    expect(bundleFunction("toMcpTool")).toContain("inputSchema: zod.toJSONSchema(tool.inputSchema),");
    expect(bundleFunction("start")).toContain("if (options.port === void 0) {");
  });

  it("keeps each session's tabs where the tab governor reads them", () => {
    const backend = lib().BrowserBackend.toString();
    expect(backend).toMatch(/this\._context = new Context\(this\._browserContext, \{/);
    const context = bundleSource.slice(
      bundleSource.indexOf("    Context = class {"),
      bundleSource.indexOf("// packages/playwright-core/src/tools/backend/response.ts"),
    );
    expect(context).toMatch(/\n {6}tabs\(\) \{\n {8}return this\._tabs;/);
    expect(context).toMatch(/\n {6}currentTab\(\) \{\n {8}return this\._currentTab;/);
    expect(context).toContain("const tab2 = new Tab(this, page, isolatedContext, (tab3) => this._onPageClosed(tab3));");
    // "sharing": "tabs" points each session's backend at its own tab with these.
    expect(context).toMatch(
      /\n {6}_setCurrentTab\(tab2\) \{\n {8}if \(this\._currentTab === tab2\)\n {10}return;\n {8}this\._currentTab = tab2;/,
    );
    expect(context).toMatch(/\n {6}async newTab\(isolatedContext\) \{[\s\S]*?return this\._currentTab;/);
    expect(context).toContain("async ensureBrowserContext(isolatedContext) {");
    // Upstream adopts the next page when a backend has no current tab, and a neighbour on close.
    expect(context).toContain("if (!this._currentTab)\n          this._setCurrentTab(tab2);");
    expect(context).toContain("this._setCurrentTab(this._tabs[Math.min(index, this._tabs.length - 1)]);");
    // Disposing a session's backend leaves the pages of the shared browser context open.
    expect(context).toMatch(
      /async dispose\(\) \{[\s\S]*?for \(const tab2 of this\._tabs\)\n {10}await tab2\.dispose\(\);/,
    );
    expect(bundleSource).toContain(
      "async dispose() {\n        await disposeAll(this._disposables);\n        this._consoleLog.stop();\n      }",
    );
    expect(bundleSource).toMatch(
      /Tab = class _Tab extends import_events\d+\.EventEmitter \{\n {6}constructor\(context, page, isolatedContext, onPageClose\) \{[\s\S]*?this\.page = page;/,
    );
  });

  it("lets the host mask sensitive fields and redact what a tool writes, where it hooks in", () => {
    // Every text result, written file and session log line passes the context's redactSecrets.
    expect(bundleSource).toContain(
      '{ type: "text", text: sanitizeUnicode(this._context.redactSecrets(serializedText)) }',
    );
    expect(bundleSource).toMatch(
      /await import_fs\d+\.default\.promises\.writeFile\(resolvedFile\.fileName, this\._context\.redactSecrets\(data\), "utf-8"\);/,
    );
    // The snapshot of a result comes from the page's own ariaSnapshot, which the host wraps.
    expect(bundleSource).toContain('await this.page.ariaSnapshot({ mode: "ai", depth, boxes })');
    expect(bundleSource).toContain('await this.page.ariaSnapshotJSON({ mode: "ai", depth, boxes })');
    // Each element keeps its ref, which the host reads to mask that line.
    expect(bundleSource).toContain("element._ariaRef = ariaRef;");
    // Request details list one header per line, as network-redact.ts reads them.
    expect(bundleSource).toContain("lines.push(`    ${k}: ${v}`);");
  });

  it("launches Chromium with the anti-throttling switches and focus emulation that backgroundThrottling turns off", () => {
    const switches = bundleSource.slice(
      bundleSource.indexOf("chromiumSwitches = (options) => ["),
      bundleSource.indexOf("chromiumSwitches = (options) => [") + 3000,
    );
    for (const flag of BACKGROUND_SWITCHES) expect(switches).toContain(`"${flag}"`);
    expect(bundleSource).toContain(
      'if (this._isMainFrame() && !this._crPage._browserContext._options.focusControl)\n            promises2.push(this._client.send("Emulation.setFocusEmulationEnabled", { enabled: true }));',
    );
  });

  it("reads the settle and snapshot mode the host changes per session from the config, on every call", () => {
    expect(bundleSource).toContain("const settleMs = tab2.context.config.timeouts?.settle ?? 500;");
    expect(bundleSource).toContain('this._includeSnapshot = this._context.config.snapshot?.mode ?? "full";');
    expect(bundleSource).toContain('const ariaFormat = this._includeSnapshot === "none" ? "none"');
    expect(bundleSource).toContain("settle: cliOptions.timeoutSettle");
    expect(bundleSource).toContain("options.timeoutSettle = numberParser(e.PLAYWRIGHT_MCP_TIMEOUT_SETTLE);");
  });

  it("lets the host replace a tab's wait after an action (action-wait.ts)", () => {
    // The method the adaptive wait replaces on each tab, with what it keeps of it.
    expect(bundleSource).toContain(
      "      async waitForCompletion(callback) {\n        await this._initializedPromise;\n        await this._raceAgainstModalStates(() => waitForCompletion(this, callback));\n      }",
    );
    expect(bundleSource).toContain("      modalStates() {\n        return this._modalStates;");
    // Upstream's own wait, which stays the ceiling: settle, 5 s for requests, 10 s for load.
    const wait = bundleFunction("waitForCompletion");
    expect(wait).toContain("const settleMs = tab2.context.config.timeouts?.settle ?? 500;");
    expect(wait).toContain('await tab2.page.mainFrame().waitForLoadState("load", { timeout: 1e4 })');
    expect(wait).toContain("const timeout = new Promise((resolve) => setTimeout(resolve, 5e3));");
    // The DOM check runs in the utility world: patchright's fourth evaluate argument.
    expect(bundleSource).toContain("async evaluate(pageFunction, arg2, options, isolatedContext = true) {");
  });

  it("reports a failed action the way the click diagnosis reads it", () => {
    expect(bundleSource).toContain(
      'content: [{ type: "text", text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],',
    );
    expect(bundleSource).toContain(
      "throw new Error(`Ref ${param.target} not found in the current page snapshot. Try capturing new snapshot.`);",
    );
    expect(bundleSource).toMatch(/getByRef\(ref\) \{\n\s+return this\.locator\(`aria-ref=\$\{ref\}`\);/);
  });

  it("turns Chrome's HTTP cache off while a route intercepts, which is why the resource cache exists", () => {
    expect(bundleSource).toContain(
      'info.session.send("Network.setCacheDisabled", { cacheDisabled: this._page.needsRequestInterception() })',
    );
  });

  it("skips patchright's catch-all route for init scripts on a context marked as routed, and never fills it", () => {
    // The host sets routeInjecting (`skipInjectRoute`): the route only turns the HTTP cache off, since the scripts it
    // would put into HTML are a list nothing adds to.
    expect(bundleSource).toContain("if (this.routeInjecting || this.context().routeInjecting) return;");
    expect(bundleSource).toMatch(/async installInjectRoute\(\) \{\n\s+if \(this\.routeInjecting\) return;/);
    expect(bundleSource.match(/_evaluateOnNewDocumentScripts\.push/g)).toBeNull();
    expect(bundleSource).toContain(
      'this._client.send("Page.addScriptToEvaluateOnNewDocument", {\n          source: initScript.source,',
    );
  });

  it("has no option with the name of a turno flag", () => {
    const help = execFileSync(process.execPath, [bin, "--help"], { env: sb.env, encoding: "utf8" });
    const upstreamPart = help.slice(help.indexOf("Every other flag is a Playwright MCP flag:"));
    for (const flag of Object.keys(TUNING_FLAGS)) expect(upstreamPart).not.toContain(`${flag} `);
  });

  it("has no upstream tool with the name of a turno tool", () => {
    expect(() => checkTurnoTools(TURNO_TOOLS, upstream().tools.browserTools)).not.toThrow();
  });

  it("still accepts the flags turno passes or documents", () => {
    const help = execFileSync(process.execPath, [bin, "--help"], { env: sb.env, encoding: "utf8" });
    for (const flag of [
      "--browser <browser>",
      "--user-data-dir <path>",
      "--config <path>",
      "--idle-timeout <timeout>",
      "--isolated",
      "--headless",
    ]) {
      expect(help).toContain(flag);
    }
  });
});
