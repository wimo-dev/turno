import { basename } from "node:path";
import type { API_VERSION, BrowserApi, BrowserCli, BrowserCliHost, OpenUrl, ServedIdentity } from "turno-browser";
import { type Manifest, loadManifest } from "../../core/manifest.js";
import { paths, tildify } from "../../core/paths.js";
import { hintsOn } from "../hints.js";
import type { Command, Io } from "../io.js";
import { type LoadOptions, OPTIONAL, loadOptional, notInstalled } from "../optional.js";
import { type DoDeps, defaultDoDeps, mcpdTransport } from "./browser-do.js";

/**
 * `turno browser <cmd>`: turno-browser's identity commands (`turno-browser <cmd>` on their own),
 * run through its typed api with turno's host: turno's command names, the mcp.toml block `add`
 * prints, the mcp.toml servers the doctor checks against `sharing`, and mcpd as the transport of
 * `do`. turno-browser is an optional package: its types come with `import type`, which the build
 * erases, and the package is loaded at run time.
 */
export type { BrowserApi };

/**
 * The API version this turno was built against. Typed by the package's own constant, so a
 * change of its API_VERSION in the workspace fails the typecheck until this line follows.
 */
export const BROWSER_API: typeof API_VERSION = { major: 1, minor: 14 };

/** What the package exports that the loader looks at. */
interface BrowserPackage {
  API_VERSION: unknown;
  api: BrowserApi;
}

export const INSTALL_HINT = OPTIONAL.browser.install;
export const NOT_INSTALLED = notInstalled(OPTIONAL.browser);

/** The summary in `turno help` (registry.ts HELP_SUMMARY). */
const SUMMARY = "developer tool: compare browser engines (needs turno-browser)";

/** A turno-browser this command can drive: its API object has the calls every subcommand needs. */
function isBrowserPackage(mod: unknown): mod is BrowserPackage {
  const api = (mod as Partial<BrowserPackage> | undefined)?.api as Partial<BrowserApi> | undefined;
  return (
    typeof api === "object" &&
    api !== null &&
    Array.isArray(api.ENGINES) &&
    typeof api.listIdentities === "function" &&
    typeof api.cli === "function"
  );
}

/**
 * Load turno-browser's API: next to this install first, then (with `global`) from the global
 * npm folder, which a Homebrew or npx install of turno cannot see on its own (loadOptional). A
 * package whose API_VERSION does not fit is refused with one message that says what to update.
 */
export async function loadBrowser(
  options: Pick<LoadOptions<BrowserPackage>, "global" | "env" | "importer" | "globalRoot"> = {},
): Promise<BrowserApi | undefined> {
  const mod = await loadOptional(OPTIONAL.browser, { ...options, api: BROWSER_API, guard: isBrowserPackage });
  return mod?.api;
}

export interface BrowserDeps {
  load(io: Io): Promise<BrowserApi | undefined>;
  /** True when a person can answer a question (a terminal, and no --no-input or agent session). */
  interactive(io: Io): boolean;
  /** Ask a yes/no question; true only for an explicit yes. */
  confirm(question: string, io: Io): Promise<boolean>;
  /** Opens a link in the default browser (`turno browser live`); tests inject a fake. */
  openUrl?: OpenUrl;
}

async function askOnTerminal(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export const defaultDeps: BrowserDeps = {
  load: (io) => loadBrowser({ global: true, env: io.env }),
  interactive: (io) => Boolean(io.ask),
  confirm: (question) => askOnTerminal(question),
};

const FOOTER = `A developer diagnostic for browser engine compatibility. It needs the separate
turno-browser package (${INSTALL_HINT}).
Identities are persistent Chrome profiles served by turno-browser-mcp, one session at a time
through mcpd; turno identity manages them too (browser:<id>). Ids use lowercase letters,
digits, "-" and "_", for example "school".
turno browser do <id> <action> runs one action (open, snapshot, click, type, read...) on an
identity's browser through mcpd, for coding agents that prefer shell commands (do --help).`;

/** The value of `--flag v` or `--flag=v` in a server's args. */
function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1];
    if (args[i]!.startsWith(`${flag}=`)) return args[i]!.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * The mcp.toml servers that run turno-browser-mcp for an identity, for the doctor's check of
 * `exclusive` against the identity's `sharing`. An unreadable mcp.toml gives none (`turno doctor`
 * reports it).
 */
export function servedIdentities(env: NodeJS.ProcessEnv): ServedIdentity[] {
  let manifest: Manifest;
  try {
    manifest = loadManifest(env);
  } catch {
    return [];
  }
  const out: ServedIdentity[] = [];
  for (const [name, server] of Object.entries(manifest.servers)) {
    if (server.kind !== "stdio") continue;
    const runs = [server.command, ...server.args].some((a) => basename(a) === "turno-browser-mcp");
    const identity = flagValue(server.args, "--identity");
    if (!runs || !identity) continue;
    const sharing = flagValue(server.args, "--sharing");
    out.push({
      name,
      identity: identity.replace(/^browser:/, ""),
      exclusive: server.exclusive,
      scope: server.scope,
      ...(sharing ? { sharing } : {}),
    });
  }
  return out;
}

/** turno's host for turno-browser's commands: what only turno has. */
export function turnoHost(mod: BrowserApi, doDeps: DoDeps = defaultDoDeps): BrowserCliHost {
  const mcpFile = (env: NodeJS.ProcessEnv) => tildify(paths(env).mcpFile, env);
  return {
    names: {
      program: "turno",
      browser: "turno browser",
      subject: "browser ",
      identity: (sub, id) => `turno identity ${sub} browser:${id}`,
      secretSet: (item) => `turno secret set ${item}`,
      secretStore: "turno secret set",
    },
    footer: FOOTER,
    addSummary: "create an identity (pinned to this time zone) and print its mcp.toml block",
    connect(id, settings, io) {
      io.out(`\nAdd this to ${mcpFile(io.env)}, then run \`turno mcp sync\`:\n`);
      io.out(settings.sharing === "tabs" ? mod.manifestSnippet(id, { sharing: "tabs" }) : mod.manifestSnippet(id));
      io.out(`Sign in to your sites once with \`turno identity login browser:${id}\`.`);
    },
    removed(id, io) {
      io.out(`Remove its [server.browser-${id}] block from ${mcpFile(io.env)} if you added one.`);
    },
    // mcpd decides how many sessions reach the server, so `sharing` needs mcp.toml to follow.
    sharingNote: (id, sharing) =>
      sharing === "tabs"
        ? `In mcp.toml, set exclusive = false for [server.browser-${id}] (and drop lease), then run \`turno mcp sync\`: mcpd then lets every session in, and each gets its own tabs.`
        : `In mcp.toml, set exclusive = true for [server.browser-${id}], then run \`turno mcp sync\`: one agent session at a time.`,
    busy: { holder: "probably an MCP session through mcpd", end: "its lease to end" },
    restart: "a new agent session, or turno mcp daemon restart",
    servers: servedIdentities,
    doTransport: mcpdTransport(doDeps),
    hints: hintsOn,
  };
}

/** turno-browser's commands with turno's host, on the functions of `mod`. */
export function browserCli(
  mod: BrowserApi,
  deps: BrowserDeps = defaultDeps,
  doDeps: DoDeps = defaultDoDeps,
): BrowserCli {
  return mod.cli(turnoHost(mod, doDeps), {
    api: mod,
    interactive: deps.interactive,
    confirm: deps.confirm,
    ...(deps.openUrl ? { openUrl: deps.openUrl } : {}),
    ...(doDeps.stdin ? { stdin: doDeps.stdin } : {}),
  });
}

/** Run one browser subcommand with a loaded module. `identity` uses it for browser:<id>. */
export function dispatch(
  mod: BrowserApi,
  sub: string,
  rest: string[],
  io: Io,
  deps: BrowserDeps = defaultDeps,
): Promise<number> {
  return browserCli(mod, deps).run(sub, rest, io);
}

/** `turno browser` before turno-browser is there: the usage says how to install it. */
const FALLBACK_USAGE = `Usage:
  turno browser <command> [args]

${FOOTER}`;

/**
 * The `browser` command. `preloaded` is the module the registry loaded to describe the
 * subcommands (help, completion, the docs); null when it is not installed. Without it the
 * command loads the module when it runs, with `deps` (tests inject a fake).
 */
export function browserCommand(
  deps: BrowserDeps = defaultDeps,
  doDeps: DoDeps = defaultDoDeps,
  preloaded?: BrowserApi | null,
): Command {
  const run: Command["run"] = async (args, io) => {
    const mod = preloaded === null ? undefined : (preloaded ?? (await deps.load(io)));
    if (!mod) {
      if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help" || args.includes("--help")) {
        io.out(FALLBACK_USAGE);
        return 0;
      }
      io.err(`turno: ${NOT_INSTALLED}`);
      return 1;
    }
    return browserCli(mod, deps, doDeps).command.run(args, io);
  };
  if (!preloaded) return { summary: SUMMARY, usage: FALLBACK_USAGE, run };
  const described = browserCli(preloaded, deps, doDeps).command;
  return { ...described, summary: SUMMARY, run };
}

/** turno-browser when it loads without a word, for the registry: undefined when it does not. */
export async function preload(): Promise<BrowserApi | null | undefined> {
  try {
    return (await loadBrowser({ global: true, env: process.env })) ?? null;
  } catch {
    // An API that does not fit: the command loads it again when it runs, and says what to update.
    return undefined;
  }
}

/** The command as the registry loads it: described by the installed turno-browser. */
export async function loadCommand(): Promise<Command> {
  return browserCommand(defaultDeps, defaultDoDeps, await preload());
}
