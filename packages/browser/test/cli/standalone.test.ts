import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The standalone executable (scripts/standalone-build.mjs) is a Node.js single executable
 * application: the package's own files live inside it, so an agent's config must run the
 * executable itself with `mcp`, never a script path.
 */

vi.mock("node:sea", () => ({ isSea: () => true }));

afterEach(() => vi.restoreAllMocks());

describe("the standalone executable", () => {
  it("is what setup gives an agent, with mcp before the identity", async () => {
    const { mcpCommand, setupConfig } = await import("../../src/cli/setup.js");
    const run = mcpCommand({ PATH: "" });
    expect(run).toEqual({ command: process.execPath, args: ["mcp"], onPath: true });
    const cfg = setupConfig("json", "work", run.command, run.args);
    expect(cfg.args).toEqual(["mcp", "--identity", "work"]);
    expect(JSON.parse(cfg.config!)).toEqual({
      mcpServers: { "browser-work": { command: process.execPath, args: ["mcp", "--identity", "work"] } },
    });
  });

  it("counts as turno-browser in an agent's config", async () => {
    const { isTurnoEntry } = await import("../../src/agent-mcp.js");
    const entry = (command: string, args: string[]) => ({
      agent: "claude-code" as const,
      server: "browser-work",
      file: "~/.claude.json",
      command,
      args,
    });
    expect(isTurnoEntry(entry("/opt/tools/turno-browser", ["mcp", "--identity", "work"]))).toBe(true);
    expect(isTurnoEntry(entry("C:\\Tools\\turno-browser.exe", ["mcp", "--identity", "work"]))).toBe(true);
    expect(isTurnoEntry(entry("/opt/tools/turno-browser", ["list"]))).toBe(false);
  });
});
