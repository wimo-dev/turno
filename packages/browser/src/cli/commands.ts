import {
  type Command,
  DRY_RUN,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  type Sub,
  bool,
  fail,
  group,
  jsonOutput,
  emit,
  needsAnswer,
  paint,
  parseFlags,
  str,
} from "turno-core/cli";
import { tildify } from "turno-core/paths";
import type { BrowserFunctions } from "../api.js";
import { useNames } from "../names.js";
import { type BrowserCliHost, type CliDeps, type Ctx, context } from "./context.js";
import { ACTION_NAMES, DO_JSON, browserDo, doDetails, doFlagNames, doSynopsis } from "./do.js";
import * as flowCmd from "./flows.js";
import * as ident from "./identity.js";
import * as liveCmd from "./live.js";
import * as session from "./session.js";
import { vaultCommand } from "./vault.js";
import { BACKGROUND_JSON, backgroundCommand } from "./background.js";
import { secretCommand } from "./secret.js";
import { SETUP_DETAILS, SETUP_JSON, setup } from "./setup.js";
import { INIT_DETAILS, INIT_JSON, INIT_SYNOPSIS, init } from "./init.js";
import { loginSummary } from "./login-summary.js";

/**
 * The identity commands of turno-browser: `turno-browser <cmd>` on its own, `turno browser <cmd>`
 * inside turno-cli. Each command reads its names from the host, so help, hints and errors name
 * the program the person typed.
 */

/** `bench --json`: turno-browser's report. */
const BENCH_JSON = jsonOutput(["version", "startedAt", "finishedAt", "engines", "results", "file"]);
/** `identities --json` (and `list --json`): one element per identity. */
const IDENTITIES_JSON = jsonOutput(["id", "inUse", "dir"]);

function checkId(c: Ctx, id: string | undefined, sub: string): string {
  if (!id) return fail(`${c.names.subject}${sub} needs an identity id (for example: ${c.names.browser} ${sub} school)`);
  try {
    c.api.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  return id;
}

const BENCH_FLAGS: FlagSpec = {
  engine: { type: "string", multiple: true },
  url: { type: "string", multiple: true },
  "only-urls": { type: "boolean" },
  // Older name of --only-urls, kept so scripts keep working.
  "no-detectors": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  ...JSON_FLAG,
};

const BENCH_PROMPT = "This opens Chrome and visits third-party test pages. Continue? [y/N] ";
const URLS_PROMPT = "This opens Chrome and visits the URLs you gave. Continue? [y/N] ";

async function bench(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, BENCH_FLAGS, 0);
  const list = (name: string) =>
    ((p.values[name] as string[] | undefined) ?? [])
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
  const given = list("engine");
  const urls = (p.values.url as string[] | undefined) ?? [];
  const onlyUrls = bool(p, "only-urls") || bool(p, "no-detectors");
  const engines: NonNullable<ReturnType<BrowserFunctions["engineId"]>>[] = [];
  for (const e of given) {
    const id = mod.engineId(e);
    if (!id) return fail(`unknown engine "${e}" (known: ${mod.ENGINES.join(", ")})`);
    engines.push(id);
  }
  for (const u of urls) {
    if (!/^https?:\/\//.test(u)) return fail(`--url must start with http:// or https://: ${u}`);
  }
  if (onlyUrls && urls.length === 0) return fail("--only-urls needs at least one --url");
  // Opening a browser on outside pages needs a yes from a person: --json is not consent.
  if (!bool(p, "yes")) {
    if (!c.deps.interactive(io)) {
      io.err(`${c.names.subject}bench opens Chrome and visits third-party test pages.`);
      return needsAnswer(`${c.names.subject}bench`);
    }
    if (!(await c.deps.confirm(onlyUrls ? URLS_PROMPT : BENCH_PROMPT, io))) {
      io.err("Cancelled; nothing was opened.");
      return 1;
    }
  }
  const report = await mod.runBench({
    engines,
    urls,
    detectors: !onlyUrls,
    env: io.env,
    onProgress: (m) => io.err(paint(io, m, "2")),
  });
  if (bool(p, "json")) {
    emit(io, p, BENCH_JSON, report);
  } else {
    io.out(mod.formatBenchTable(report));
    if (report.file) io.out(`\nreport: ${tildify(report.file, io.env)}`);
  }
  return 0;
}

function identities(c: Ctx, args: string[], io: Io): number {
  const p = parseFlags(args, JSON_FLAG, 0);
  const list = c.api.listIdentities(io.env);
  if (bool(p, "json")) {
    emit(
      io,
      p,
      IDENTITIES_JSON,
      list.map((i) => ({ id: i.id, inUse: i.inUse, dir: tildify(i.dir, io.env) })),
    );
    return 0;
  }
  if (!list.length) {
    io.out(`No browser identities yet. Create one with \`${c.names.identity("add", "<id>")}\`.`);
    return 0;
  }
  const width = Math.max(...list.map((i) => i.id.length));
  for (const i of list) {
    const state = i.inUse ? paint(io, "in use    ", "33") : paint(io, "not in use", "32");
    io.out(`${i.id.padEnd(width)}  ${state}  ${tildify(i.dir, io.env)}`);
  }
  return 0;
}

function add(c: Ctx, args: string[], io: Io): number {
  const p = parseFlags(args, { ...DRY_RUN, ...ident.SETTINGS_FLAGS }, 1);
  const id = checkId(c, p.positionals[0], "add");
  const settings = ident.settingsPatch(p);
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would create browser identity "${id}"`);
    return 0;
  }
  const info = ident.hasSettings(settings) ? c.api.addIdentity(id, io.env, settings) : c.api.addIdentity(id, io.env);
  io.out(`identity "${id}" ready at ${tildify(info.dir, io.env)}`);
  io.out(`settings (time zone, languages, health check) in ${tildify(c.api.identitySettingsPath(id, io.env), io.env)}`);
  c.host.connect(id, settings, io);
  return 0;
}

async function remove(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, DRY_RUN, 1);
  const id = checkId(c, p.positionals[0], "remove");
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would delete browser identity "${id}", its saved logins and its vault credentials`);
    return 0;
  }
  if (mod.isInUse(id, io.env)) return fail(`identity "${id}" is in use by a running Chrome; close it first`);
  // The vault's secret store items first: removeIdentity refuses while they exist.
  const cleared = await mod.vaultClear(id, { env: io.env });
  if (cleared)
    io.out(`deleted ${cleared} vault credential${cleared === 1 ? "" : "s"} of "${id}" from the secret store`);
  mod.removeIdentity(id, io.env);
  io.out(`removed identity "${id}" and its saved browser data`);
  c.host.removed?.(id, io);
  return 0;
}

async function login(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const p = parseFlags(args, { url: { type: "string" } }, 1);
  const id = checkId(c, p.positionals[0], "login");
  const url = str(p, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) return fail(`--url must start with http:// or https://: ${url}`);
  const holder = mod.inUseBy(id, io.env);
  if (holder) return fail(holder);
  if (mod.isInUse(id, io.env)) {
    return fail(
      `identity "${id}" is in use by a running Chrome (${c.host.busy?.holder ?? "probably an agent's MCP session"}). Close that session or wait for ${c.host.busy?.end ?? "it to end"}, then retry.`,
    );
  }
  io.out(`Opening Chrome for identity "${id}". Sign in to your sites, then close the window to save the session.`);
  const options: { env: NodeJS.ProcessEnv; url?: string } = { env: io.env };
  if (url) options.url = url;
  const result = await mod.loginIdentity(id, options);
  io.out(loginSummary(c, id, result?.sites ?? []));
  return 0;
}

/** The first argument that is not a flag, without parsing the flags. */
function firstId(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/** Run one subcommand. turno's `identity` command uses it for browser:<id>. */
async function dispatch(c: Ctx, sub: string, rest: string[], io: Io): Promise<number> {
  try {
    switch (sub) {
      case "identities":
      case "list":
        return identities(c, rest, io);
      case "add":
        return add(c, rest, io);
      case "remove":
      case "rm":
        return await remove(c, rest, io);
      case "login":
        return await login(c, rest, io);
      case "bench":
        return await bench(c, rest, io);
      case "export":
        return await session.exportSession(c, rest, io);
      case "import":
        return await session.importSession(c, rest, io);
      case "show":
        return ident.show(c, checkId(c, firstId(rest), "show"), rest, io);
      case "set":
        return ident.set(c, checkId(c, firstId(rest), "set"), rest, io);
      case "doctor":
        return await ident.doctor(c, rest, io);
      case "reputation":
        return ident.reputation(c, rest, io, (id) => checkId(c, id, "reputation"));
      case "flows":
        return flowCmd.flows(c, rest, io);
      case "replay":
        return await flowCmd.replay(c, rest, io);
      case "traces":
        return await flowCmd.traces(c, rest, io);
      case "record":
        return flowCmd.record(c, rest, io);
      case "live":
        return await liveCmd.live(c, rest, io);
      case "pause":
        return await liveCmd.pause(c, rest, io);
      case "resume":
        return await liveCmd.resume(c, rest, io);
      case "setup":
        return setup(c, rest, io);
      default:
        return fail(`unknown ${c.names.subject}command "${sub}"`);
    }
  } catch (err) {
    const name = (err as Error).name;
    if (["IdentityError", "VaultError", "SealError", "FlowError", "LiveError"].includes(name))
      return fail((err as Error).message);
    throw err;
  }
}

/**
 * `<browser> <id> <action>`, the short form of `<browser> do <id> <action>`: taken when the first
 * word is not a subcommand and the second is an action. An identity named like a subcommand
 * (`show`, `flows`) needs the long form, and the docs use the long form so a later subcommand can
 * never change what a written command does.
 */
function shortDo(args: readonly string[], subs: Record<string, Sub>): boolean {
  const [first, second] = args;
  return (
    first !== undefined &&
    second !== undefined &&
    !(first in subs) &&
    /^[a-z0-9][a-z0-9_-]*$/.test(first) &&
    ACTION_NAMES.includes(second)
  );
}

/** The examples of the group's help, typed the way the host names the commands. */
function examples(c: Ctx): string[] {
  const b = c.names.browser;
  return [
    `${b} identities`,
    `${b} add school --languages es-MX,es,en`,
    `${b} show school`,
    `${b} set school --health-url https://mail.example.com/ --health-text Inbox`,
    `${b} set school --tabs-max 5 --tabs-popups keep --settle 250ms`,
    `${b} set school --block-trackers true --cache --json`,
    `${b} set school --humanize light`,
    `${b} set school --sharing tabs`,
    `${b} login school --url https://example.com`,
    `${b} doctor --fix`,
    `${b} reputation school --json`,
    `${b} vault add school mail --url https://mail.example.com --username alice`,
    `${b} record school --flows --traces`,
    `${b} flows school`,
    `${b} replay school submit-timesheet --param password=keychain:school-password`,
    `${b} traces school --open`,
    `${b} set school --live true`,
    `${b} live school`,
    `${b} pause school`,
    `${b} resume school`,
    `${b} export school --out school.session --expires 2d`,
    `${b} import school.session --as school-laptop`,
    `${b} remove school --dry-run`,
    `${b} bench --only-urls --url https://example.com --yes`,
    `${b} do school open https://example.com`,
    `${b} do school snapshot`,
    `${b} do school click e12`,
    `${b} do school end`,
  ];
}

/** The subcommands, each with its help and completion data. */
function subcommands(c: Ctx): Record<string, Sub> {
  const b = c.names.browser;
  const alone = c.names.subject === "";
  const run =
    (sub: string): Sub["run"] =>
    (args, io) =>
      dispatch(c, sub, args, io);
  // What only turno-browser on its own has: inside turno, `turno mcp sync` writes the agents'
  // configs, `turno secret` stores secrets and `do` goes through mcpd, not a background server.
  const own: Record<string, Sub> = alone
    ? {
        init: {
          summary: "set up step by step: an identity, a sign-in by hand, and your agent (asks first)",
          synopsis: INIT_SYNOPSIS,
          details: INIT_DETAILS,
          flags: ["--identity", "--agent", "--url", "--no-login", "--yes", "--dry-run", "--json"],
          json: INIT_JSON,
          run: (args, io) => init(c, args, io, c.deps.run),
        },
        setup: {
          summary: "print the MCP config that gives an agent an identity (Claude Code, Codex, Cursor...)",
          synopsis: "<claude-code|codex|cursor|copilot|gemini|json> [--identity <id>] [--json]",
          details: SETUP_DETAILS,
          flags: ["--identity", "--json"],
          json: SETUP_JSON,
          run: run("setup"),
        },
        background: {
          summary: "the background server do starts per identity: status, start, stop",
          synopsis: "status|start|stop [<id>]",
          ownHelp: true,
          json: BACKGROUND_JSON,
          run: (args, io) => backgroundCommand(c).run(args, io),
        },
        secret: {
          summary: "store the secrets identity.json names as keychain:<item> (never printed)",
          synopsis: "set|has|list|remove <item>",
          ownHelp: true,
          run: (args, io) => secretCommand(c).run(args, io),
        },
      }
    : {};
  return {
    ...own,
    // On its own the program says `list`, like `turno identity list`; turno browser keeps `identities`.
    identities: {
      summary: alone ? "same as list" : "list browser identities and whether they are in use",
      hidden: alone,
      synopsis: "[--json]",
      flags: ["--json"],
      json: IDENTITIES_JSON,
      run: run("identities"),
    },
    list: {
      summary: alone ? "list browser identities and whether they are in use" : "same as identities",
      hidden: !alone,
      synopsis: "[--json]",
      flags: ["--json"],
      json: IDENTITIES_JSON,
      run: run("identities"),
    },
    add: {
      summary: c.host.addSummary,
      synopsis:
        "<id> [--timezone <zone>] [--locale <tag>] [--languages <tag,...>] [--region <CC>] [--health-url <url> --health-text <text>] [--dry-run]",
      flags: ["--dry-run", ...ident.SETTINGS_FLAG_NAMES],
      run: run("add"),
    },
    show: {
      summary: "an identity's settings, session health and who holds it",
      synopsis: "<id> [--json]",
      flags: ["--json"],
      json: ident.SHOW_JSON,
      run: run("show"),
    },
    set: {
      summary: "change an identity's identity.json (an empty value removes a setting)",
      synopsis: `<id> ${ident.SET_SYNOPSIS}`,
      details: ident.setDetails(c.names),
      flags: ident.SET_FLAG_NAMES,
      json: ident.SET_JSON,
      run: run("set"),
    },
    doctor: {
      summary: "check Chrome, a test launch and every identity (settings, lock, sign-in), with fixes",
      synopsis: "[--fix] [--no-launch] [--json]",
      flags: ["--fix", "--no-launch", "--json"],
      json: ident.DOCTOR_JSON,
      run: run("doctor"),
    },
    reputation: {
      summary: "challenges each identity met per site (captcha, verify it's you, block) and their trend",
      synopsis: "[<id>] [--json]",
      flags: ["--json"],
      json: ident.REPUTATION_JSON,
      run: run("reputation"),
    },
    vault: {
      summary: "credentials browser_login fills without showing them to the agent",
      synopsis: "add|list|remove|submit <id> ...",
      ownHelp: true,
      run: (args, io) => vaultCommand(c).run(args, io),
    },
    record: {
      summary: "what an identity records (flows, traces, screenshots); turn it on or off",
      synopsis: "<id> [--flows] [--traces] [--screenshots] [--max-size <size>] [--off] [--dry-run] [--json]",
      details: `With no flag, shows what the identity records and where. --flows, --traces and --screenshots
turn those on (the next Chrome start uses them), --off turns everything off; turn one off with
${b} set <id> --record-traces false. All are off by default.

  flows        every session's actions saved as a flow (auto-<time>, newest 20 kept)
  traces       a Playwright trace of each browser session (${b} traces)
  screenshots  a screenshot after each action

Vault sign-ins never reach a flow, a trace or a screenshot: the trace stops before a fill and
starts again after the page navigates, and a password or one-time code is never saved.`,
      flags: ["--flows", "--traces", "--screenshots", "--max-size", "--off", "--dry-run", "--json"],
      json: flowCmd.RECORD_JSON,
      run: run("record"),
    },
    flows: {
      summary: "an identity's saved flows; name one to see its steps, --remove to delete it",
      synopsis: "<id> [<flow>] [--remove] [--dry-run] [--json]",
      flags: ["--remove", "--dry-run", "--json"],
      json: flowCmd.FLOWS_JSON,
      run: run("flows"),
    },
    replay: {
      summary: "run a saved flow on the identity's Chrome, without an agent",
      synopsis: "<id> <flow> [--param <name=value>]... [--from <step>] [--headless] [--json]",
      details: `Runs the flow through turno-browser-mcp, the same way an agent's browser_replay does. A
sensitive parameter is never a value on the command line: pass --param <name>=keychain:<item>
(store it once with ${c.names.secretSet("<item>")}), or type it at the hidden prompt. When a step fails,
the report says which locators it tried; --from continues at a later step.`,
      flags: ["--param", "--from", "--headless", "--json"],
      json: flowCmd.REPLAY_JSON,
      run: run("replay"),
    },
    traces: {
      summary: "an identity's recordings (traces, screenshots); --open shows a trace in the viewer",
      synopsis: "<id> [<recording>] [--open] [--segment <n>] [--json]",
      details: `--open serves the trace on 127.0.0.1 with the trace viewer patchright-core ships and opens it
in your default browser; Ctrl-C stops it. A recording has one trace per stretch of activity (a
vault sign-in or the idle limit ends one): --segment picks one, the last by default.`,
      flags: ["--open", "--segment", "--json"],
      json: flowCmd.TRACES_JSON,
      run: run("traces"),
    },
    live: {
      summary: "watch the agent in an identity's browser and take the controls (opens the live view)",
      synopsis: "<id> [--no-open] [--json]",
      details: `Shows what the agent is doing (paused or not, its tabs) and opens the live view in your
default browser: the agent's tab as a picture, Pause and Resume buttons, and while the agent is
paused, your clicks, keys and scrolls go to the page. The view is served on 127.0.0.1 only; the
link it opens works once. Off by default: turn it on with ${b} set <id> --live true
(it starts with the next turno-browser-mcp for the identity).

Read mode (Lightpanda) has no pixels, attach mode is your own Chrome, which you already see, and
Camoufox (Firefox) has no Chrome screencast: there the view is off, and pause and resume still work. A page that holds a vault or password
value is never shown until it navigates.`,
      flags: ["--no-open", "--json"],
      json: liveCmd.LIVE_JSON,
      run: run("live"),
    },
    pause: {
      summary: "pause the agent in an identity's browser: its next call waits until you resume",
      synopsis: "<id> [--json]",
      details: `A call that is running finishes; the next one waits up to the identity's live wait (2m by
default), then fails and tells the agent you still have the browser. A batch or replay stops at its
next step. In a headed Chrome the agent's tab comes to the front. Needs the live view on.`,
      flags: ["--json"],
      json: liveCmd.LIVE_JSON,
      run: run("pause"),
    },
    resume: {
      summary: "give the browser back to the agent; each waiting call is told what changed",
      synopsis: "<id> [--json]",
      details: `The waiting calls go on. Each starts with a note: how long the pause lasted and what changed
(the current tab's URL and title, tabs opened and closed, your input in the view). When something
changed, a call that does more than read does not run, and the agent gets a fresh snapshot instead.`,
      flags: ["--json"],
      json: liveCmd.LIVE_JSON,
      run: run("resume"),
    },
    export: {
      summary: "write an identity's cookies and site storage to a file encrypted with a passphrase",
      synopsis: "<id> --out <file> [--expires 7d] [--force]",
      flags: ["--out", "--expires", "--force"],
      run: run("export"),
    },
    import: {
      summary: "replace an identity's session with an export (asks first), or create it",
      synopsis: "<file> [--as <id>] [--yes] [--dry-run]",
      flags: ["--as", "--yes", "--dry-run"],
      run: run("import"),
    },
    remove: {
      summary: "delete an identity, its saved logins and its vault",
      synopsis: "<id> [--dry-run]",
      flags: ["--dry-run"],
      run: run("remove"),
    },
    rm: { summary: "same as remove", hidden: true, run: run("remove") },
    login: {
      summary: "open the identity's Chrome to sign in by hand once",
      synopsis: "<id> [--url <url>]",
      flags: ["--url"],
      run: run("login"),
    },
    do: {
      summary: "one action on an identity's browser from the shell: open, snapshot, click, type, read...",
      synopsis: doSynopsis(c),
      details: doDetails(c),
      ownHelp: true,
      json: DO_JSON,
      flags: doFlagNames(c),
      run: (args, io) => browserDo(c, args, io),
    },
    bench: {
      summary: "check how each browser engine loads reference test pages and your URLs (asks first)",
      synopsis: "[--engine <name>]... [--url <url>]... [--only-urls] [--yes] [--json]",
      flags: ["--engine", "--url", "--only-urls", "--yes", "--json"],
      json: BENCH_JSON,
      run: run("bench"),
    },
  };
}

/** The identity commands for one host. */
export interface BrowserCli {
  /** Every subcommand as one group, typed as `names.browser <sub>`. */
  command: Command;
  /** Each subcommand on its own, for a host that lists some of them under another command. */
  subs: Record<string, Sub>;
  /** Run one subcommand (`add`, `show`...) with its arguments. */
  run(sub: string, args: string[], io: Io): Promise<number>;
}

/**
 * The identity commands, named and wired by `host`. turno-cli calls it through the typed api
 * (`api.cli`) with its own host; the `turno-browser` program with `standaloneHost()`.
 */
export function browserCli(host: BrowserCliHost, deps: CliDeps): BrowserCli {
  // Messages from the library (doctor fixes, errors) name the commands the way this host does.
  useNames(host.names);
  const c = context(host, deps);
  const subs = subcommands(c);
  const name = c.names.subject.trim() || c.names.program;
  const command = group(name, `browser identities: ${c.names.browser} <command>`, subs, {
    footer: host.footer,
    examples: examples(c),
    prefix: c.names.browser,
  });
  return {
    command: {
      ...command,
      run: (args, io) => (shortDo(args, subs) ? browserDo(c, args, io) : command.run(args, io)),
    },
    subs,
    run: (sub, args, io) => dispatch(c, sub, args, io),
  };
}
