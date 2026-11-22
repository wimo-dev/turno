#!/usr/bin/env node
// Smoke test of a standalone turno-browser executable (scripts/standalone-build.mjs), run by the
// standalone workflow on each platform: `--version` prints the version, and `mcp` answers an
// MCP initialize over stdio. It runs with a throwaway HOME, no node on the PATH, and starts no
// browser.
//   node scripts/standalone-smoke.mjs <executable> <version>
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const [exe, version] = process.argv.slice(2);
if (!exe || !version) {
  console.error("usage: node scripts/standalone-smoke.mjs <executable> <version>");
  process.exit(2);
}
const bin = resolve(exe);
const home = mkdtempSync(join(tmpdir(), "turno-smoke-"));
// No node on the PATH: the executable must not need one.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const withoutNode = (process.env[pathKey] ?? "")
  .split(delimiter)
  .filter((dir) => !existsSync(join(dir, "node")) && !existsSync(join(dir, "node.exe")))
  .join(delimiter);
const env = {
  ...process.env,
  [pathKey]: withoutNode,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
};

try {
  let t = performance.now();
  const printed = execFileSync(bin, ["--version"], { env, encoding: "utf8", timeout: 60_000 }).trim();
  if (printed !== `turno-browser ${version}`) throw new Error(`--version printed "${printed}"`);
  console.log(`--version: ${printed} (${Math.round(performance.now() - t)} ms)`);

  t = performance.now();
  const info = await initialize(bin, env);
  if (info?.name !== "turno-browser" || info?.version !== version)
    throw new Error(`initialize answered ${JSON.stringify(info)}`);
  console.log(`mcp initialize: ${info.name} ${info.version} (${Math.round(performance.now() - t)} ms)`);
} catch (err) {
  console.error(`standalone-smoke: ${err.message}`);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
}

/** Starts `<bin> mcp`, sends initialize, returns serverInfo, and closes stdin so the server exits. */
function initialize(file, environment) {
  return new Promise((ok, ko) => {
    const child = spawn(file, ["mcp", "--headless"], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      ko(new Error(`no answer to initialize in 60 s\n${err}`));
    }, 60_000);
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.includes('"id":1'));
      if (!line) return;
      clearTimeout(timer);
      child.stdin.end();
      // The server exits when stdin closes; a server that does not is stopped.
      const stop = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("exit", () => clearTimeout(stop));
      ok(JSON.parse(line).result?.serverInfo);
    });
    child.once("error", ko);
    child.once("exit", (code) => {
      clearTimeout(timer);
      ko(new Error(`the server exited (${code}) before it answered\n${err}`));
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      })}\n`,
    );
  });
}
