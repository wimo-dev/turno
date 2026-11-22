#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BuiltArgv, buildArgv } from "../argv.js";
import { type BackgroundFlags, extractBackground, serveBackground, sharingOf } from "../background.js";
import { engineChoice } from "../engine.js";
import { lightpandaCookieJar, sweepOrphanLightpandas } from "../engine-lightpanda.js";
import { runHost } from "../host.js";
import { watchStdinCalls } from "../last-used.js";
import { installShutdownGuard, sweepOrphan } from "../lifecycle.js";
import { readIdentitySettings } from "../settings.js";

/**
 * turno-browser-mcp [--identity <id>] [playwright-mcp flags]
 *
 * Serves the Playwright MCP tools of patchright-core from turno's own MCP host, with
 * turno's defaults and lifecycle: a generated config that closes an idle Chrome, a sweep of a
 * Chrome an earlier run left behind on the same profile, and a deadline on shutdown. With
 * `--identity`, the identity module: identity.json applied at launch,
 * a runtime lock while Chrome runs, the session health check and the reputation log.
 * Speaks MCP over stdio; `--port` with `--identity` needs `--allow-http-identity`; `--background`
 * serves the identity to the shell from a private socket (`background.ts`).
 */

const HELP = `turno-browser-mcp: a browser MCP server that drives your installed Chrome, with one
persistent profile per identity (turno-browser add <id>).

  --identity <id>          use the identity's saved profile (served one session at a time by
                           mcpd, unless the identity's "sharing" is "tabs")
  --allow-http-identity    allow --port or --host together with --identity; the server then
                           binds to 127.0.0.1 only. Any local process can use that browser.

  TURNO_BROWSER_IDLE=15m   close Chrome after this long without a tool call (headed too); the
                           next call opens it again with the same profile. "0" keeps it open.
                           --idle-timeout <ms> and a --config of your own take precedence.

Tabs (these flags win over the identity's identity.json):
  --max-tabs <n>           most pages open at once, the least recently used closes past it
                           (default 8; 0: no cap)
  --popups <close|keep>    close popups that open while no tool call runs (default close)
  --park-after <duration>  park a page unused this long on about:blank; it loads again on its
                           next use (default 5m; 0: never)
  --close-after <duration> close a page unused this long (default 15m; 0: never)
  --background-throttling  let Chrome slow down tabs that are not in front (default off); the
                           agent's tab is brought to the front before each call
  --sharing <session|tabs> "tabs": several agent sessions use the browser at once, each in
                           its own tabs, which it locks (default "session", one at a time;
                           mcp.toml then needs exclusive = false for this server)

Input (wins over the identity's identity.json):
  --humanize <level>       off (default), light, full or adaptive: the pointer travels a curve
                           to a point inside the target, keys are typed with human delays;
                           full adds overshoot, reading pauses and wheel scrolling; adaptive is
                           light, and full on a site that showed a challenge page
  --cursor <auto|on|off>   the agent cursor: a named arrow that glides to what the agent acts
                           on, a ring, click ripples and a frame with a badge while it works.
                           auto (default): when the browser can be seen (a window, or the live
                           view). It is an element in each page, which a page script can see:
                           off leaves pages as they are

Engines (these flags win over the identity's identity.json; all off by default):
  --engine lightpanda      read mode: Lightpanda instead of Chrome, for reading pages
                           (navigate, snapshot, find, click a link, evaluate); other tools are
                           refused. Needs lightpanda on PATH or TURNO_LIGHTPANDA_PATH
  --engine camoufox        Camoufox (a Firefox build) instead of Chrome, with its own profile;
                           off by default. Needs Camoufox and
                           playwright-core (turno-browser doctor says how); never downloaded
  --engine chrome          the default; turns off an identity's read, Camoufox or attach mode
  --attach <target>        connect to a Chrome you already have open instead of launching
                           one: "auto" (your default Chrome profile, after you turn on remote
                           debugging at chrome://inspect/#remote-debugging), a Chrome user
                           data dir, or a loopback endpoint. The agent sees every window of
                           that profile; turno closes only the tabs it opened

Live view (wins over the identity's identity.json; off by default):
  --live                   serve a view of the agent's tab on 127.0.0.1 (turno-browser live
                           <id> opens it) and let you pause the agent to take the controls
  --live-wait <duration>   how long a call waits while you have the agent paused (default 2m,
                           "5s" to "30m"); then it fails and tells the agent you still have it

Background server (for shell use without turno; turno-browser do starts it):
  --background             serve the identity over MCP streamable HTTP on a Unix socket in a
                           folder only you can enter (<state>/browser/identities/<id>/background),
                           or on 127.0.0.1 with a per-server token in a file only you can read
                           where a socket cannot be used. Writes server.json there while it runs.
                           Needs --identity; --port and --host do not apply
  --background-idle <duration>
                           exit after this long without a request (default 15m; "0" never);
                           also TURNO_BROWSER_BACKGROUND_IDLE. Chrome closes first
  While the background server of an identity runs, it alone drives the identity's browser: a
  stdio server of that identity (an agent's, or mcpd's) answers each call that needs the browser
  with an error that names the background server, and the background server does not start while
  another process has the identity's Chrome open. Stop it with turno-browser background stop <id>
  (or kill <pid>); turno-browser background shows which run.

Examples:
  turno-browser-mcp --identity work
  turno-browser-mcp --identity work --max-tabs 4 --park-after 2m
  turno-browser-mcp --identity work --humanize light
  turno-browser-mcp --headless --popups keep
  turno-browser-mcp --engine lightpanda
  turno-browser-mcp --attach auto
  turno-browser-mcp --identity work --live
  turno-browser-mcp --identity work --background --background-idle 30m

Every other flag is a Playwright MCP flag:
`;

const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help) process.stdout.write(`${HELP}\n`);

let built: BuiltArgv;
let background: BackgroundFlags;
try {
  background = extractBackground(process.argv.slice(2));
  built = buildArgv(background.rest);
  if (background.background && built.identity === undefined)
    throw new Error("--background needs --identity <id>: it serves one identity's browser");
} catch (err) {
  process.stderr.write(`turno-browser-mcp: ${(err as Error).message}\n`);
  process.exit(2);
}

if (built.identity !== undefined && built.userDataDir) mkdirSync(built.userDataDir, { recursive: true, mode: 0o700 });
if (built.tempDir) {
  const dir = built.tempDir;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
if (built.config && !help) {
  mkdirSync(dirname(built.config.path), { recursive: true, mode: 0o700 });
  writeFileSync(built.config.path, `${JSON.stringify(built.config.data, null, 2)}\n`, { mode: 0o600 });
}
if (built.userDataDir && !help) {
  const swept = await sweepOrphan(built.userDataDir);
  if (swept.action === "exited" || swept.action === "killed") {
    process.stderr.write(
      `turno-browser-mcp: closed a Chrome an earlier run left open on this profile (pid ${swept.pid})\n`,
    );
  } else if (swept.action === "survived") {
    process.stderr.write(
      `turno-browser-mcp: a Chrome an earlier run left open on this profile (pid ${swept.pid}) did not stop\n`,
    );
  }
  installShutdownGuard(built.userDataDir, { stdin: !background.background });
}

if (!help && readMode(built)) {
  const jar = built.identity !== undefined ? lightpandaCookieJar(built.identity, process.env) : undefined;
  for (const swept of await sweepOrphanLightpandas(jar)) {
    process.stderr.write(
      swept.action === "survived"
        ? `turno-browser-mcp: a Lightpanda an earlier run left open (pid ${swept.pid}) did not stop\n`
        : `turno-browser-mcp: closed a Lightpanda an earlier run left open (pid ${swept.pid})\n`,
    );
  }
}

/** True when this server runs on Lightpanda (`--engine lightpanda`, or the identity's engine). */
function readMode(argv: BuiltArgv): boolean {
  try {
    const settings = argv.identity !== undefined ? readIdentitySettings(argv.identity, process.env) : undefined;
    return engineChoice(argv.engineFlags ?? {}, settings).kind === "lightpanda";
  } catch {
    return false; // the launch reports a bad identity.json or flag
  }
}

const identity = built.identity !== undefined ? { id: built.identity, env: process.env } : undefined;
// `status` shows when the identity last served a call; the background server counts its own.
if (identity && !background.background && !help) watchStdinCalls(identity.id, identity.env);
await runHost(built.args, {
  ...(identity ? { identity } : {}),
  ...(built.tuning ? { tuning: built.tuning } : {}),
  ...(built.engineFlags ? { engineFlags: built.engineFlags } : {}),
  ...(built.live ? { live: built.live } : {}),
  ...(background.background && identity
    ? {
        serve: async (host) => {
          try {
            await serveBackground(host, {
              identity,
              idleMs: background.idleMs,
              sharing: sharingOf(built.tuning?.sharing, () => readIdentitySettings(identity.id, identity.env)?.sharing),
            });
          } catch (err) {
            process.stderr.write(`turno-browser-mcp: ${(err as Error).message}\n`);
            process.exit(1);
          }
        },
      }
    : {}),
});
