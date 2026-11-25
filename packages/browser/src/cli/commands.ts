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
  style,
} from "turno-core/cli";
import { tildify } from "turno-core/paths";
import { execCommand } from "../agent-mcp.js";
import { type RemovalItem, type RemovalReport, planRemoval, runRemoval } from "../destroy.js";
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
import { STATUS_JSON, status } from "./status.js";
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
  const pick = settings.browser === undefined && !settings.engine ? ident.defaultBrowser(c, id, io.env) : undefined;
  if (pick?.browser) settings.browser = pick.browser;
  // A person at a terminal gets the choices that are theirs to make: never on an existing identity.
  const person = c.deps.interactive(io);
  const chrome = settings.browser === undefined && !settings.engine && settings.attach === undefined && !pick;
  if (person && chrome && settings.keychain === undefined && process.platform === "darwin")
    settings.keychain = "system";
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would create browser identity "${id}"`);
    if (pick) io.out(pick.note);
    return 0;
  }
  const info = ident.hasSettings(settings) ? c.api.addIdentity(id, io.env, settings) : c.api.addIdentity(id, io.env);
  io.out(`identity "${id}" ready at ${tildify(info.dir, io.env)}`);
  io.out(`settings (time zone, languages, health check) in ${tildify(c.api.identitySettingsPath(id, io.env), io.env)}`);
  if (pick) io.out(style(io).note(pick.browser ? "ok" : "warn", pick.note));
  if (person) for (const offer of ident.addOffers(c, id, settings, io.env)) io.out(style(io).note("info", offer));
  c.host.connect(id, settings, io);
  return 0;
}

/** `install-browser --json`. */
const INSTALL_BROWSER_JSON = jsonOutput(["installed", "dryRun", "browser"]);

const INSTALL_BROWSER_DETAILS = `Downloads Chrome for Testing, the Chrome build Google publishes for automation, with the
installer of the patchright-core turno-browser drives it with, into your user cache:
~/Library/Caches/ms-playwright on macOS, ~/.cache/ms-playwright on Linux, or
PLAYWRIGHT_BROWSERS_PATH. No admin password and no change outside that folder; about 190 MB.

For a machine without Google Chrome, Edge, Brave or Chromium. Then point an identity at it:
  turno-browser add <id> --browser chrome-for-testing
  turno-browser set <id> --browser chrome-for-testing

Its limits: it does not update itself (run this again after updating turno-browser), it is one
major version behind Chrome stable at times, and Google publishes it for testing and
automation, not as an everyday browser. Sign-in pages load in it like in Chrome.`;

async function installBrowserCommand(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, { ...DRY_RUN, ...JSON_FLAG }, 0);
  const dryRun = bool(p, "dry-run");
  const json = bool(p, "json");
  const result = await c.api.installBrowser({
    env: io.env,
    dryRun,
    output: (chunk) => io.err(chunk.replace(/\n$/, "")),
  });
  if (result.code !== 0)
    return fail("the browser installer failed (its output is above); try again, or check the network");
  if (json) {
    emit(io, p, INSTALL_BROWSER_JSON, {
      installed: !dryRun && result.browser !== undefined,
      dryRun,
      browser: result.browser ? { ...result.browser, path: tildify(result.browser.path, io.env) } : null,
    });
    return 0;
  }
  if (dryRun) return 0;
  if (!result.browser) return fail("the installer finished, but turno-browser does not find Chrome for Testing");
  const b = result.browser;
  io.out(`${b.label}${b.version ? ` ${b.version}` : ""} at ${tildify(b.path, io.env)}`);
  io.out(`\nUse it for an identity:\n  ${c.names.browser} set <id> --browser chrome-for-testing`);
  io.out(`or for a new one:\n  ${c.names.identity("add", "<id>")} --browser chrome-for-testing`);
  return 0;
}

/** `remove --json`: what was deleted, what failed, what is still here and what was kept on purpose. */
const REMOVE_JSON = jsonOutput(["identity", "dryRun", "complete", "planned", "deleted", "failed", "left", "kept"]);

const REMOVE_FLAGS: FlagSpec = { ...DRY_RUN, ...JSON_FLAG, yes: { type: "boolean", short: "y" } };

const REMOVE_DETAILS = `Deletes everything turno-browser keeps for the identity, after it shows the list and asks:
  - it stops the identity's background server, a Chrome on its profile and the
    turno-browser-mcp processes started for it (nothing is deleted while one still runs)
  - it takes the identity's MCP server out of each agent that has it, with the agent's own
    command (claude mcp remove --scope user browser-<id>, codex mcp remove ...)
  - it deletes the vault's credentials and the keychain: items identity.json references from
    the secret store, unless another identity or turno's mcp.toml uses them too
  - it deletes the profile, identity.json, the vault index, the state folder, saved flows and
    the session exports it wrote

--yes deletes without asking; without a terminal it is required. --dry-run shows the list.
Afterwards it checks that nothing is left. Exit codes: 0 all gone, 1 something is left (--json
lists it under left, with the step that removes it), 2 no terminal and no --yes.`;

/** One line about a removal item, for people. */
function describeItem(item: RemovalItem, env: NodeJS.ProcessEnv): string {
  switch (item.kind) {
    case "path":
      return `${tildify(item.path!, env)} (${item.what})`;
    case "keychain":
      return `keychain:${item.item} (${item.what})`;
    case "process":
      return `${item.what}, pid ${item.pid}`;
    case "mcp":
      return `${item.what} in ${tildify(item.file!, env)}`;
  }
}

/** A removal item as `remove --json` prints it: paths with ~, nothing that is not set. */
function itemJson(item: RemovalItem, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    ...item,
    ...(item.path ? { path: tildify(item.path, env) } : {}),
    ...(item.file ? { file: tildify(item.file, env) } : {}),
  };
}

async function remove(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, REMOVE_FLAGS, 1);
  const id = checkId(c, p.positionals[0], "remove");
  const json = bool(p, "json");
  const dry = bool(p, "dry-run");
  const options = { env: io.env, exec: c.deps.exec ?? execCommand };
  const plan = await planRemoval(id, options);
  if (!plan.exists) return fail(`identity "${id}" does not exist`);
  const env = io.env;
  const asJson = (report: Partial<Omit<RemovalReport, "complete">> & { complete: boolean | null }) =>
    emit(io, p, REMOVE_JSON, {
      identity: id,
      dryRun: dry,
      complete: report.complete,
      planned: plan.items.map((i) => itemJson(i, env)),
      deleted: (report.deleted ?? []).map((i) => itemJson(i, env)),
      failed: (report.failed ?? []).map((i) => itemJson(i, env)),
      left: (report.left ?? plan.left).map((i) => itemJson(i, env)),
      kept: (report.kept ?? plan.kept).map((i) => itemJson(i, env)),
    });
  const planLines = () => {
    const out = [`This deletes browser identity "${id}":`];
    for (const item of plan.items) out.push(`  ${describeItem(item, env)}`);
    for (const item of plan.left)
      out.push(`  ${describeItem(item, env)}: cannot be removed here (${item.reason}); by hand: ${item.command ?? ""}`);
    for (const item of plan.kept) out.push(`  kept: ${describeItem(item, env)}, ${item.reason}`);
    return out;
  };
  if (dry) {
    if (json) asJson({ complete: null });
    else for (const l of planLines()) io.out(`(dry run) ${l}`);
    return 0;
  }
  if (!bool(p, "yes")) {
    // Deleting needs a yes from a person: --json is not one.
    if (json || !c.deps.interactive(io)) {
      if (!json) for (const l of planLines()) io.err(l);
      return needsAnswer(`${c.names.subject}remove`);
    }
    for (const l of planLines()) io.out(l);
    if (!(await c.deps.confirm("Delete all of this? [y/N] ", io))) {
      io.err("Cancelled; nothing was deleted.");
      return 1;
    }
  }
  const report = await runRemoval(plan, options);
  if (json) asJson(report);
  else {
    const s = style(io);
    for (const item of report.deleted) io.out(s.note("ok", `deleted ${describeItem(item, env)}`));
    for (const item of report.kept) io.out(s.note("info", `kept ${describeItem(item, env)}: ${item.reason}`));
    for (const item of report.failed)
      io.out(s.note("err", `could not delete ${describeItem(item, env)}: ${item.error}`));
    for (const item of report.left)
      io.out(
        s.note(
          "warn",
          `left ${describeItem(item, env)}: ${item.reason}${item.command ? `; to remove it: ${item.command}` : ""}`,
        ),
      );
    if (report.complete) io.out(`removed identity "${id}" and its saved browser data`);
    else io.err(`identity "${id}" is not completely removed; see the lines above`);
  }
  // The host's note (turno: the mcp.toml block) goes to stderr under --json: stdout is the report.
  if (!c.api.identityExists(id, env)) c.host.removed?.(id, json ? { ...io, out: io.err } : io);
  return report.complete ? 0 : 1;
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
      case "destroy":
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
      case "install-browser":
        return await installBrowserCommand(c, rest, io);
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
      case "status":
        return await status(c, rest, io);
      default:
        return fail(`unknown ${c.names.subject}command "${sub}"`);
    }
  } catch (err) {
    const name = (err as Error).name;
    if (["IdentityError", "VaultError", "SealError", "FlowError", "LiveError", "BrowserNotFound"].includes(name))
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
    `${b} status --json`,
    `${b} doctor --fix`,
    `${b} add work --browser brave`,
    `${b} install-browser --dry-run`,
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
    `${b} remove school --yes --json`,
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
        "<id> [--timezone <zone>] [--locale <tag>] [--languages <tag,...>] [--region <CC>] [--health-url <url> --health-text <text>] [--browser <name|path>] [--dry-run]",
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
    status: {
      summary: "each identity at a glance: settings, sign-ins, last use, which agents have it",
      synopsis: "[<id>] [--json]",
      details: `Only reads. For each identity: its profile, a summary of identity.json, who holds it, the
vault's sites, the last sign-in by hand, the host names the profile holds cookies for (never their
values; not read while Chrome has the profile open), when it last served a tool call, and the
agents whose config has it.`,
      flags: ["--json"],
      json: STATUS_JSON,
      run: run("status"),
    },
    doctor: {
      summary: "check the browsers, a test launch and every identity (browser, settings, lock, sign-in), with fixes",
      synopsis: "[--fix] [--no-launch] [--json]",
      flags: ["--fix", "--no-launch", "--json"],
      json: ident.DOCTOR_JSON,
      run: run("doctor"),
    },
    "install-browser": {
      summary: "download Chrome for Testing into your user cache, for a machine without Chrome (no admin)",
      synopsis: "[--dry-run] [--json]",
      details: INSTALL_BROWSER_DETAILS,
      flags: ["--dry-run", "--json"],
      json: INSTALL_BROWSER_JSON,
      run: run("install-browser"),
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
      summary: "delete an identity and everything it left on this machine (asks first)",
      synopsis: "<id> [--yes] [--dry-run] [--json]",
      details: REMOVE_DETAILS,
      flags: ["--yes", "--dry-run", "--json"],
      json: REMOVE_JSON,
      run: run("remove"),
    },
    rm: { summary: "same as remove", hidden: true, json: REMOVE_JSON, run: run("remove") },
    destroy: { summary: "same as remove", hidden: true, json: REMOVE_JSON, run: run("remove") },
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
