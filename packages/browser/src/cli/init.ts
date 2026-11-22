import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Exit,
  type FlagSpec,
  type Io,
  JSON_FLAG,
  bool,
  emit,
  fail,
  jsonOutput,
  needsAnswer,
  paint,
  parseFlags,
  str,
} from "turno-core/cli";
import { findOnPath, tildify } from "turno-core/paths";
import { AGENTS, agentReachable, execCommand, findEntry, recordRegistration } from "../agent-mcp.js";
import type { Ctx } from "./context.js";
import { describePolicy, readPolicyFile, rehearse } from "./identity.js";
import { loginSummary } from "./login-summary.js";
import {
  AGENT_NAMES,
  SETUP_AGENTS,
  type SetupAgent,
  mcpCommand,
  setupConfig,
  setupLines,
  shellLine,
  unknownAgent,
} from "./setup.js";

/**
 * `turno-browser init`: the first setup, step by step. It does what the three commands of the
 * docs do (`add`, `login`, `setup`) and asks before each step that opens a window or changes an
 * agent's config:
 *
 * 1. the identity: a name, created, or the existing one reused;
 * 2. the sign-in: Chrome opens on the identity's profile, on a first site when given;
 * 3. the agent: the agents found on this machine, and its `mcp add` command, run only on a yes
 *    (an agent without one gets the block to paste).
 *
 * Without a person to answer (`--no-input`, a pipe, an agent session) it needs `--identity` and
 * `--agent` and skips the sign-in (only a person can sign in). It then prints the agent's
 * command, or with `--yes` runs it with its output captured. An agent that already has the
 * identity's server is left as it is, so running init again changes nothing. `--json` prints
 * one report of what each step did, and never asks.
 */

const INIT_FLAGS: FlagSpec = {
  identity: { type: "string" },
  agent: { type: "string" },
  url: { type: "string" },
  "policy-file": { type: "string" },
  "no-login": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  ...JSON_FLAG,
};

export const INIT_SYNOPSIS =
  "[--identity <id>] [--agent <claude-code|codex|cursor|copilot|gemini|json|none>] [--url <url>] [--policy-file <file>] [--no-login] [--yes] [--dry-run] [--json]";

export const INIT_DETAILS = `Sets up a browser identity and gives it to your agent, asking at each step:
  1. the identity's name (a new one is created; an existing one is used as it is)
  2. signing in by hand: Chrome opens on the identity's profile (--url opens a first site)
  3. the agent: the agents found on this machine; its mcp add command runs only if you say yes,
     and an agent without one (cursor, json) gets the block to paste

--yes answers yes to every step, --no-login skips the sign-in, --agent none skips the agent.
--policy-file gives the identity a policy (allowed hosts, disabled features; see set --help),
checked before anything is created and applied in step 1, also to an identity already here.
Without a terminal (--no-input, a pipe or an agent session) it needs --identity and --agent and
skips the sign-in; it prints the agent's command, or with --yes runs it. An agent that already
has the identity's server is left as it is, so running init again changes nothing.

--json prints one report (what was created, the sign-in, the agent's registration with the
command it ran, its exit code and output) and never asks; it needs --identity and --agent.
Exit codes: 0 done, 1 the agent's command failed, 2 a missing answer, 127 --yes and the agent's
program is not on the PATH.`;

/** Runs an agent's `mcp add` command; tests replace it. Resolves to the exit code. */
export type RunCommand = (command: string, args: readonly string[], io: Io) => Promise<number>;

const runCommand: RunCommand = (command, args, io) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: "inherit", env: io.env });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** The agents installed here, in the order the question lists them. */
export function detectAgents(env: NodeJS.ProcessEnv): SetupAgent[] {
  const home = env.HOME ?? "";
  return SETUP_AGENTS.filter((a) => {
    if (a === "json") return false;
    if (a === "cursor")
      return Boolean(findOnPath("cursor-agent", env)) || (home !== "" && existsSync(join(home, ".cursor")));
    return agentReachable(a, env);
  });
}

/** Split a printed shell line back into words: setup only quotes with single quotes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line))
    words.push(m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!);
  return words;
}

async function askYes(io: Io, question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const answer = (await io.ask!(`${question} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function askText(io: Io, question: string, fallback: string): Promise<string> {
  const answer = (await io.ask!(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
  return answer || fallback;
}

/** What step 3 did with the agent, in `init --json`. */
type McpStatus =
  /** The agent's own command added the server. */
  | "added"
  /** The agent already had the identity's server with this command; nothing ran. */
  | "already"
  /** The agent already has a server of that name with another command; it was left as it is. */
  | "differs"
  /** The agent's command ran and failed. */
  | "failed"
  /** --yes, and the agent's program is not on the PATH. */
  | "not_installed"
  /** The command was printed for the person to run (no --yes, or no terminal to ask on). */
  | "printed"
  /** The agent has no add command (cursor, json): the block to paste was printed. */
  | "manual"
  /** The person answered no. */
  | "declined"
  /** --agent none. */
  | "skipped"
  /** --dry-run: what would run. */
  | "would_add";

interface McpReport {
  status: McpStatus;
  agent: SetupAgent | "none";
  /** The server's name in the agent's config. */
  server: string | null;
  /** The agent's config file the server goes in, when known. */
  file: string | null;
  /** What the agent runs for the identity: the command and its arguments. */
  run: string[] | null;
  /** The agent's own command that adds it, as words (null when there is none). */
  register: string[] | null;
  exitCode: number | null;
  /** What the agent's command printed (at most its last 4000 characters). */
  output: string | null;
  /** The block to paste, for an agent without an add command. */
  config: string | null;
  notes: string[];
}

/** `init --json`: what each step created, registered or skipped. */
export const INIT_JSON = jsonOutput(["dryRun", "identity", "login", "mcp", "next"]);

const sameArgs = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((w, i) => w === b[i]);

export async function init(c: Ctx, args: string[], io: Io, run: RunCommand = runCommand): Promise<number> {
  const p = parseFlags(args, INIT_FLAGS, 0);
  const b = c.names.browser;
  const api = c.api;
  const yes = bool(p, "yes");
  const dry = bool(p, "dry-run");
  const json = bool(p, "json");
  const exec = c.deps.exec ?? execCommand;
  // --json is for programs: it never asks, and only the report goes to stdout.
  const canAsk = c.deps.interactive(io) && !json;
  const interactive = canAsk && !dry;
  const say = (line = "") => {
    if (!json) io.out(line);
  };
  const complain = (line: string) => {
    if (!json) io.err(line);
  };
  const step = (n: number, title: string) => say(`\n${paint(io, `Step ${n} of 3`, "2")}  ${paint(io, title, "1")}`);

  const url = str(p, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) return fail(`--url must start with http:// or https://: ${url}`);
  const agentFlag = str(p, "agent");
  if (agentFlag !== undefined && agentFlag !== "none" && !(SETUP_AGENTS as readonly string[]).includes(agentFlag))
    return fail(unknownAgent(agentFlag));
  if ((json || (!canAsk && !dry)) && (str(p, "identity") === undefined || agentFlag === undefined)) {
    return needsAnswer(`${b} init`, "--identity and --agent");
  }

  say(`Set up ${b}: a browser identity, signed in once, given to your agent.`);
  say(paint(io, "Ctrl-C stops at any step; each step that is done stays done.", "2"));

  // 1. The identity.
  step(1, "the identity");
  const existing = api.listIdentities(io.env).map((i) => i.id);
  if (existing.length) say(`Identities here: ${existing.join(", ")}`);
  say("An identity is one Chrome profile your agent uses, with your sign-ins. Name it after what it is for.");
  let id = str(p, "identity");
  while (id === undefined) {
    const answer = await askText(io, "Name", existing.length === 1 ? existing[0]! : "personal");
    try {
      api.assertIdentityId(answer);
      id = answer;
    } catch (err) {
      io.err((err as Error).message);
    }
  }
  try {
    api.assertIdentityId(id);
  } catch (err) {
    return fail((err as Error).message);
  }
  // A policy is checked before the identity exists, so a bad file creates nothing.
  const policyFile = str(p, "policy-file");
  const policy = policyFile === undefined ? undefined : readPolicyFile(policyFile);
  if (policy) {
    try {
      rehearse(api, id, { policy }, io.env);
    } catch (err) {
      return fail(`--policy-file ${policyFile}: ${(err as Error).message}`);
    }
  }
  let created = false;
  const existed = api.identityExists(id, io.env);
  if (existed) say(`Using the identity "${id}" that is already here.`);
  else if (dry) say(`(dry run) would create the identity "${id}"`);
  else {
    const info = api.addIdentity(id, io.env);
    created = true;
    say(`Created "${id}" at ${tildify(info.dir, io.env)}`);
  }
  if (policy) {
    if (dry) say(`(dry run) would give "${id}" the policy: ${describePolicy(policy)}`);
    else {
      api.writeIdentitySettings(id, { policy }, io.env);
      say(`Policy of "${id}": ${describePolicy(policy)}`);
    }
  }
  const identity = {
    id,
    created,
    existed,
    dir: tildify(api.identityDir(id, io.env), io.env),
    settingsFile: tildify(api.identitySettingsPath(id, io.env), io.env),
    policy: policy ?? null,
  };

  // 2. The sign-in.
  step(2, "sign in by hand once");
  let firstSite = url;
  let login: { status: "done" | "skipped" | "would_open"; reason: string | null; sites: string[] } = {
    status: "skipped",
    reason: null,
    sites: [],
  };
  if (bool(p, "no-login")) {
    login.reason = "--no-login";
    say(`Skipped. Sign in later with ${b} login ${id}.`);
  } else if (dry && canAsk) {
    login = { status: "would_open", reason: null, sites: [] };
    say(`(dry run) would open Chrome for "${id}"${url ? ` on ${url}` : ""} so you sign in`);
  } else if (!interactive) {
    login.reason = "no terminal: only a person can sign in";
    say(`Skipped: only a person can sign in. Run ${b} login ${id} on a terminal.`);
  } else if (api.isInUse(id, io.env)) {
    login.reason = "the identity is in use";
    say(`Skipped: "${id}" is in use right now. Sign in later with ${b} login ${id}.`);
  } else {
    say("Chrome opens on this identity's profile. Sign in to the sites your agent needs, then close the window.");
    if (firstSite === undefined && !yes) {
      const answer = await askText(io, "First site to open (Enter for none)", "");
      if (answer) firstSite = /^https?:\/\//.test(answer) ? answer : `https://${answer}`;
    }
    if (await askYes(io, "Open Chrome now?", yes)) {
      const result = await api.loginIdentity(id, { env: io.env, ...(firstSite ? { url: firstSite } : {}) });
      login = { status: "done", reason: null, sites: result?.sites ?? [] };
      say(loginSummary(c, id, login.sites));
    } else {
      login.reason = "declined";
      say(`Skipped. Sign in later with ${b} login ${id}.`);
    }
  }

  // 3. The agent.
  step(3, "give it to your agent");
  const found = detectAgents(io.env);
  let agent: SetupAgent | "none" | undefined = agentFlag as SetupAgent | "none" | undefined;
  if (agent === undefined) {
    say(
      found.length
        ? `Agents found here: ${found.map((a) => `${a} (${AGENT_NAMES[a]})`).join(", ")}`
        : "No agent found on the PATH.",
    );
    say(`Agents: ${SETUP_AGENTS.join(", ")}, or none.`);
    while (agent === undefined) {
      const answer = (await askText(io, "Agent", found[0] ?? "json")).toLowerCase();
      if (answer === "none" || (SETUP_AGENTS as readonly string[]).includes(answer))
        agent = answer as SetupAgent | "none";
      else io.err(unknownAgent(answer));
    }
  }
  const mcp: McpReport = {
    status: "skipped",
    agent,
    server: null,
    file: null,
    run: null,
    register: null,
    exitCode: null,
    output: null,
    config: null,
    notes: [],
  };
  let exit: number = Exit.ok;
  if (agent === "none") say(`Skipped. ${b} setup <agent> --identity ${id} prints it later.`);
  else {
    const { command, onPath } = mcpCommand(io.env);
    const cfg = setupConfig(agent, id, command);
    if (!onPath) cfg.notes.push("turno-browser-mcp is not on the PATH here, so this names it by its full path.");
    const info = agent === "json" ? undefined : AGENTS[agent];
    const register = info?.add?.(cfg.server, command, cfg.args) ?? null;
    Object.assign(mcp, {
      server: cfg.server,
      file: info ? tildify(info.file(io.env), io.env) : cfg.file,
      run: [command, ...cfg.args],
      register,
      notes: cfg.notes,
    });
    const label = AGENT_NAMES[agent];
    const remember = () => {
      if (dry || agent === "json" || !info) return;
      try {
        recordRegistration(id, io.env, {
          agent,
          server: cfg.server,
          file: info.file(io.env),
          at: new Date().toISOString(),
        });
      } catch {
        /* only a hint for remove: it also reads the agent's own config */
      }
    };
    const there = agent === "json" ? undefined : findEntry(agent, id, io.env);
    const reachable = agent !== "json" && agentReachable(agent, io.env);
    if (register === null) {
      mcp.status = "manual";
      mcp.config = cfg.config;
      for (const l of setupLines(cfg)) say(l);
    } else if (there) {
      const matches = there.command === command && sameArgs(there.args, cfg.args);
      mcp.status = matches ? "already" : "differs";
      if (matches) say(`${label} already has the browser "${id}" (${cfg.server} in ${mcp.file}); nothing to add.`);
      else {
        const note = `${label} already has a server named ${cfg.server} in ${mcp.file}, with another command (${[there.command ?? "?", ...(there.args ?? [])].join(" ")}); it was left as it is.`;
        mcp.notes = [...mcp.notes, note];
        say(note);
        if (info?.remove) say(`To replace it: ${shellLine(info.remove(cfg.server))}, then run this again.`);
      }
      remember();
    } else if (dry) {
      mcp.status = reachable ? "would_add" : "printed";
      if (reachable) say(`(dry run) would ${yes ? "run" : "ask to run"}: ${cfg.shell}`);
      else for (const l of setupLines(cfg)) say(l);
    } else if (!reachable) {
      for (const l of setupLines(cfg)) say(l);
      if (yes) {
        mcp.status = "not_installed";
        exit = Exit.notInstalled;
        complain(
          `${info?.program} is not on the PATH, so ${label} cannot be given the browser now; run the line above once it is.`,
        );
      } else mcp.status = "printed";
    } else if (interactive) {
      say(`This adds the browser to ${label}:`);
      say(`  ${cfg.shell}`);
      if (await askYes(io, "Run it now?", yes)) {
        const [bin, ...rest] = register;
        const code = await run(bin!, rest, io);
        mcp.exitCode = code;
        if (code === 0) {
          mcp.status = "added";
          remember();
          say(`Done: ${label} has the browser "${id}".`);
        } else {
          mcp.status = "failed";
          exit = Exit.failure;
          io.err(`That command ended with code ${code}; run it yourself, or ${b} setup ${agent} --identity ${id}.`);
        }
      } else {
        mcp.status = "declined";
        for (const l of setupLines(cfg)) say(l);
      }
    } else if (yes) {
      const [bin, ...rest] = register;
      const result = await exec(bin!, rest, io.env);
      mcp.exitCode = result.code;
      mcp.output = result.output || null;
      if (result.code === 0 || /already exists/i.test(result.output)) {
        mcp.status = result.code === 0 ? "added" : "already";
        remember();
        say(`Done: ${label} has the browser "${id}" (${cfg.shell}).`);
      } else {
        mcp.status = "failed";
        exit = Exit.failure;
        complain(
          `${cfg.shell} ended with code ${result.code}${result.output ? `:\n${result.output}` : ""}\nRun it yourself, or ${b} setup ${agent} --identity ${id}.`,
        );
      }
    } else {
      mcp.status = "printed";
      for (const l of setupLines(cfg)) say(l);
    }
  }

  // What is left.
  const next: string[] = [];
  if (agent !== "none") {
    // "json" names no agent ("any MCP client"), so it reads as "your MCP client".
    const who = agent === "json" ? "your MCP client" : AGENT_NAMES[agent];
    const session = agent === "json" ? `a new session of ${who}` : `a new ${who} session`;
    const connected = mcp.status === "added" || mcp.status === "already";
    next.push(
      `${connected ? "Start" : "Once it is added, start"} ${session} and ask it to open ${firstSite ?? "a site you signed in to"}.`,
    );
  }
  if (login.status !== "done" && !dry) next.push(`Sign in by hand once on a terminal: ${b} login ${id}`);
  next.push(`${b} doctor checks Chrome and the identity; ${b} show ${id} shows its settings.`);
  if (json) {
    emit(io, p, INIT_JSON, { dryRun: dry, identity, login, mcp, next });
    return exit;
  }
  io.out(`\n${paint(io, "Next", "1")}`);
  for (const l of next.filter((l) => !l.startsWith("Sign in by hand"))) io.out(l);
  return exit;
}
