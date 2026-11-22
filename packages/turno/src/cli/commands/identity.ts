import { effectivePolicy } from "../../accounts/policy.js";
import { loadRegistry } from "../../accounts/registry.js";
import { tildify } from "../../core/paths.js";
import { JSON_FLAG, bool, flagsOf, parseFlags, str } from "../args.js";
import { emit, jsonOutput } from "../output.js";
import { type Sub, group } from "../group.js";
import { launcherExists } from "../../accounts/delegate.js";
import { loadConfig } from "../../core/config.js";
import { type Command, type Io, fail } from "../io.js";
import { profileColor, style } from "../style.js";
import * as accounts from "./accounts.js";
import { policyLine } from "./accounts.js";
import {
  type BrowserApi,
  type BrowserDeps,
  NOT_INSTALLED,
  browserCli,
  defaultDeps,
  dispatch,
  preload,
} from "./browser.js";

/**
 * Who acts on an outside service for a session: a service account (`linear:work`, run by a
 * profile through the accounts bridge) or a browser identity (`browser:school`, a Chrome
 * profile with saved logins). One command for both; `accounts` and `browser` still work.
 */
const BROWSER = "browser:";

let deps: BrowserDeps = defaultDeps;

async function browserModule(io: Io): Promise<BrowserApi> {
  const mod = await deps.load(io);
  if (!mod) {
    io.err(`turno: ${NOT_INSTALLED}`);
    return fail("browser identities need turno-browser");
  }
  return mod;
}

/** The first argument that is not a flag or a flag value, without parsing the flags. */
function firstId(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/** `turno identity list --json`. */
const LIST_JSON = jsonOutput(["services", "browser", "preferences"]);

async function list(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const reg = loadRegistry(io.env);
  const mod = await deps.load(io);
  const browsers = mod ? mod.listIdentities(io.env) : [];
  if (bool(p, "json")) {
    emit(io, p, LIST_JSON, {
      services: Object.values(reg.accounts)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          service: a.service,
          profile: a.profile,
          tools: a.tools,
          readTools: a.readTools ?? null,
          confirm: effectivePolicy(a),
          description: a.description ?? null,
        })),
      browser: browsers.map((b) => ({ id: `${BROWSER}${b.id}`, inUse: b.inUse, dir: tildify(b.dir, io.env) })),
      preferences: reg.prefer.map((r) => ({ path: tildify(r.path, io.env), accounts: r.accounts })),
    });
    return 0;
  }
  const st = style(io);
  let colors: Record<string, { color?: string | number }> = {};
  try {
    colors = loadConfig(io.env).profiles;
  } catch {
    /* pills without their configured colors */
  }
  const pill = (name: string) => st.profile(name, profileColor(colors, name));
  io.out(st.header("Service accounts"));
  const services = Object.values(reg.accounts).sort((a, b) => a.id.localeCompare(b.id));
  if (!services.length)
    io.out(`  none yet ${st.muted("(turno identity add linear:work --profile work --tools 'mcp__linear__*')")}`);
  // Each account: id, profile, tools; under them its confirm policy and description.
  const rows = st.tableRows(
    services.map((a) => [
      st.bold(a.id),
      pill(a.profile),
      `${a.tools.join(", ")}${launcherExists(a.profile, io.env) ? "" : `  ${st.warn("(no launcher)")}`}`,
    ]),
  );
  // Under the profile name: a pill on a terminal starts with a space of its own.
  const under = " ".repeat(2 + Math.max(0, ...services.map((a) => a.id.length)) + 2 + (st.color ? 1 : 0));
  services.forEach((a, i) => {
    for (const l of rows[i]!) io.out(l);
    io.out(st.wrap(under, st.muted(policyLine(a))));
    if (a.description) io.out(st.wrap(under, st.muted(a.description)));
  });
  if (reg.prefer.length) {
    io.out("");
    io.out(st.header("Folder preferences"));
    for (const l of st.table(
      reg.prefer.map((r) => [
        tildify(r.path, io.env),
        Object.entries(r.accounts)
          .map(([sv, id]) => `${sv}=${id}`)
          .join("  ") || st.muted("(none)"),
      ]),
    ))
      io.out(l);
  }
  io.out("");
  io.out(st.header("Browser identities"));
  if (!mod) io.out(st.note("warn", NOT_INSTALLED));
  else if (!browsers.length) io.out(`  none yet ${st.muted("(turno identity add browser:<id>)")}`);
  else {
    const rows = browsers.map((b) => [
      st.bold(`${BROWSER}${b.id}`),
      b.inUse ? st.lead("on", st.warn("in use")) : st.lead("off", st.ok("free")),
      st.muted(tildify(b.dir, io.env)),
    ]);
    for (const l of st.table(rows)) io.out(l);
  }
  return 0;
}

/** `args` with its `browser:<id>` positional replaced by the bare id, for the browser command. */
function bareId(args: string[]): string[] {
  const at = args.findIndex((a) => !a.startsWith("-"));
  return args.map((a, i) => (i === at ? a.slice(BROWSER.length) : a));
}

async function add(args: string[], io: Io): Promise<number> {
  if (!firstId(args)?.startsWith(BROWSER)) return accounts.add(args, io);
  return dispatch(await browserModule(io), "add", bareId(args), io, deps);
}

/** `show` and `set` exist for browser identities only. */
async function browserOnly(sub: "show" | "set", args: string[], io: Io): Promise<number> {
  const id = firstId(args);
  if (!id?.startsWith(BROWSER))
    return fail(
      `identity ${sub} works on browser identities (browser:<id>); service accounts are listed by \`turno identity list\``,
    );
  return dispatch(await browserModule(io), sub, bareId(args), io, deps);
}

/** A browser identity's removal is turno-browser's own: its flags (--yes, --dry-run, --json) pass on. */
async function remove(args: string[], io: Io): Promise<number> {
  if (!firstId(args)?.startsWith(BROWSER)) return accounts.remove(args, io);
  return dispatch(await browserModule(io), "remove", bareId(args), io, deps);
}

async function login(args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { url: { type: "string" } }, 1);
  const id = p.positionals[0];
  if (!id) return fail("usage: turno identity login browser:<id> [--url <url>]");
  if (!id.startsWith(BROWSER))
    return fail(
      "only browser identities sign in by hand; service accounts sign in through their profile (claude-<profile>)",
    );
  const url = str(p, "url");
  return dispatch(
    await browserModule(io),
    "login",
    [id.slice(BROWSER.length), ...(url !== undefined ? ["--url", url] : [])],
    io,
    deps,
  );
}

/** Swap the turno-browser loader and prompt, for tests. Returns the previous ones. */
export function setBrowserDeps(next: BrowserDeps): BrowserDeps {
  const prev = deps;
  deps = next;
  return prev;
}

/**
 * The `identity` command. The browser parts of its help (the settings flags of `add` and `set`,
 * set's details, the JSON of `show` and `set`) come from turno-browser when it is installed.
 */
export function identityCommand(browser?: Record<string, Sub>): Command {
  const setSynopsis = browser?.set?.synopsis?.replace(/^<id> /, "") ?? "[flags] [--dry-run] [--json]";
  return group(
    "identity",
    "who acts on outside services: service accounts (linear:work) and browser identities (browser:school)",
    {
      list: {
        summary: "service accounts, browser identities and folder preferences",
        synopsis: "[--json]",
        flags: ["--json"],
        json: LIST_JSON,
        run: list,
      },
      add: {
        summary: "add a service account, or create a browser identity (browser:<id>)",
        synopsis:
          "<service:label> --profile <p> --tools <pattern>[,...] [--read-tools <pattern>[,...]] [--confirm always|writes|never] | browser:<id> [--timezone <zone>] [--languages <tag,...>] [--health-url <url> --health-text <text>]  [--dry-run]",
        args: ["any"],
        flags: [
          "--profile",
          "--tools",
          "--read-tools",
          "--confirm",
          "--service",
          "--description",
          ...(browser?.add?.flags ?? ["--dry-run"]),
        ],
        run: add,
      },
      show: {
        summary: "a browser identity's settings, session health and who holds it",
        synopsis: "browser:<id> [--json]",
        args: ["identity"],
        flags: ["--json"],
        ...(browser?.show?.json ? { json: browser.show.json } : {}),
        run: (a, io) => browserOnly("show", a, io),
      },
      set: {
        summary: "change a browser identity's identity.json: place, languages, health check, tabs, blocking, cache",
        synopsis: `browser:<id> ${setSynopsis}`,
        details: browser?.set?.details ?? `The settings flags come with turno-browser (${NOT_INSTALLED}).`,
        args: ["identity"],
        flags: browser?.set?.flags ?? ["--dry-run", "--json"],
        ...(browser?.set?.json ? { json: browser.set.json } : {}),
        run: (a, io) => browserOnly("set", a, io),
      },
      remove: {
        summary: "remove a service account, or delete a browser identity and everything it left (asks first)",
        synopsis: "<id> [--dry-run] | browser:<id> [--yes] [--dry-run] [--json]",
        args: ["identity"],
        // --yes and --json are turno-browser's (a service account's remove has --dry-run only).
        flags: browser?.remove?.json ? ["--dry-run", "--yes", "--json"] : ["--dry-run"],
        ...(browser?.remove?.json ? { json: browser.remove.json } : {}),
        run: remove,
      },
      login: {
        summary: "open a browser identity's Chrome to sign in by hand once",
        synopsis: "browser:<id> [--url <url>]",
        args: ["identity"],
        flags: ["--url"],
        run: login,
      },
      prefer: {
        summary: "pick the account of a service for a folder (empty account removes it)",
        synopsis: "<dir> <service>=<account> [--dry-run]",
        args: ["dir"],
        flags: ["--dry-run"],
        run: async (a, io) => accounts.prefer(a, io),
      },
      log: {
        summary: "recent calls to the accounts bridge; --verify checks the log's hash chain",
        synopsis: "[-n N] [--verify] [--json]",
        flags: flagsOf(accounts.LOG_SPEC),
        json: accounts.LOG_JSON,
        run: async (a, io) => accounts.log(a, io),
      },
    },
    {
      fallback: "list",
      examples: [
        "turno identity list",
        "turno identity add linear:work --profile work --tools 'mcp__linear__*'",
        "turno identity add browser:school",
        "turno identity login browser:school",
        "turno identity show browser:school",
        "turno identity set browser:school --timezone Europe/Madrid --languages es-ES,es,en",
        "turno identity set browser:school --tabs-max 5 --tabs-park 10m --background-throttling true",
        "turno identity set browser:school --block-trackers true --block-types image,font --cache-max-size 200MB",
        "turno identity set browser:school --settle 500ms --dry-run --json",
        "turno identity set browser:school --humanize adaptive",
        "turno identity set browser:school --no-block --no-cache",
        "turno identity set browser:school --sharing tabs",
        "turno identity prefer ~/code/acme linear=linear:work",
        "turno identity remove linear:work --dry-run",
        "turno identity log --verify",
      ],
    },
  );
}

export const command = identityCommand();

/** The command as the registry loads it: with the help of the installed turno-browser. */
export async function loadCommand(): Promise<Command> {
  const mod = await preload();
  return identityCommand(mod ? browserCli(mod).subs : undefined);
}
