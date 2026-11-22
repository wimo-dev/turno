import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { KEPT_FEATURE, PLAYWRIGHT_DISABLED_FEATURES, storagePartitioningArgs } from "../src/chrome-features.js";
import { addIdentity } from "../src/identities.js";
import { chromeUnavailable, stopSandboxProcesses, waitFor } from "./helpers/chrome.js";
import { type Sandbox, sandbox } from "./helpers/sandbox.js";

const bin = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "bin", "mcp.js");
const reason = chromeUnavailable();

/** Playwright's `disabledFeatures`, read from the installed patchright-core. */
function installedList(): string[] {
  const bundle = readFileSync(createRequire(import.meta.url).resolve("patchright-core/lib/coreBundle"), "utf8");
  const block = /disabledFeatures = \[([\s\S]*?)\]\.filter/.exec(bundle)?.[1];
  if (!block) throw new Error("patchright-core no longer has a disabledFeatures list where this test looks");
  // Playwright filters "MediaRouter" out of its own list (`.filter(... !== "MediaRouter")`).
  return [...block.replace(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((f) => f !== "MediaRouter");
}

describe("storage partitioning", () => {
  it("copies Playwright's disabled features exactly, so the list it drops is the one Chrome gets", () => {
    expect([...PLAYWRIGHT_DISABLED_FEATURES]).toEqual(installedList());
    expect(PLAYWRIGHT_DISABLED_FEATURES).toContain(KEPT_FEATURE);
  });

  it("drops Playwright's list and passes it again without third-party storage partitioning", () => {
    const { ignoreDefaultArgs, args } = storagePartitioningArgs();
    expect(ignoreDefaultArgs).toEqual([`--disable-features=${installedList().join(",")}`]);
    expect(args).toHaveLength(1);
    expect(args[0]).not.toContain(KEPT_FEATURE);
    expect(args[0]!.replace("--disable-features=", "").split(",")).toEqual(
      installedList().filter((f) => f !== KEPT_FEATURE),
    );
  });

  it("adds the low-resource preset's features to the same list, since Chrome reads only the last one", () => {
    const { args } = storagePartitioningArgs(["BackForwardCache"]);
    expect(args).toHaveLength(1);
    expect(args[0]!.split(",").at(-1)).toBe("BackForwardCache");
    expect(args[0]).not.toContain(KEPT_FEATURE);
  });
});

let sb: Sandbox | undefined;
// Closed before the sandbox goes: a server whose working folder is the sandbox keeps Windows from deleting it.
const clients: Client[] = [];
beforeEach(() => {
  sb = undefined;
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  if (!sb) return;
  await stopSandboxProcesses(sb.home);
  sb.cleanup();
});

describe.skipIf(reason !== undefined)(
  `storage partitioning on real Chrome${reason ? ` (skipped: ${reason})` : ""}`,
  () => {
    it("gives a site embedded in another site its own storage there, as Chrome does", async () => {
      const box = sandbox();
      sb = box;
      addIdentity("parts", box.env);
      // 127.0.0.1 and localhost are two sites: the frame of 127.0.0.1 inside localhost is third-party.
      const seen: string[] = [];
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        res.setHeader("content-type", "text/html; charset=utf-8");
        const pages: Record<string, string> = {
          "/set": `<title>Set</title><script>localStorage.setItem("x", "first");</script>`,
          "/read": `<script>fetch("/seen?x=" + String(localStorage.getItem("x")));</script>`,
          "/embed": `<title>Embed</title><iframe src="${url.searchParams.get("src")}"></iframe>`,
        };
        if (url.pathname === "/seen") seen.push(url.searchParams.get("x") ?? "");
        res.end(pages[url.pathname] ?? "");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
      const { port } = server.address() as { port: number };
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [bin, "--identity", "parts", "--headless"],
        env: box.env as Record<string, string>,
        cwd: box.home,
        stderr: "pipe",
      });
      const client = new Client({ name: "partitioning", version: "0.0.0" });
      await client.connect(transport);
      clients.push(client);
      await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${port}/set` } });
      const src = encodeURIComponent(`http://127.0.0.1:${port}/read`);
      await client.callTool({
        name: "browser_navigate",
        arguments: { url: `http://localhost:${port}/embed?src=${src}` },
      });
      expect(await waitFor(() => seen.length > 0, 10_000)).toBe(true);
      // Unpartitioned, the frame would read the first-party value.
      expect(seen).toEqual(["null"]);
    }, 60_000);
  },
);
