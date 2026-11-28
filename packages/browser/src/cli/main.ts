#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CliError,
  type ColorMode,
  Exit,
  type Io,
  UsageError,
  columns,
  confirm,
  defaultIo,
  exitName,
  fail,
  isColorMode,
  jsonError,
  noInputReason,
  style,
  withoutAsk,
  wrap,
} from "turno-core/cli";
import { api } from "../api.js";
import { type BrowserCli, browserCli } from "./commands.js";
import { standaloneHost } from "./context.js";
import { COMPLETION_USAGE, complete, completionScript } from "./completion.js";

/**
 * `turno-browser <command>`: the identity commands on their own, without turno-cli. The same
 * commands run inside turno as `turno browser <command>`; only the names in help and hints
 * differ. The MCP server itself is the other program of this package, `turno-browser-mcp`.
 */

const PROGRAM = "turno-browser";

/** The sections of `turno-browser --help`, in order. */
const SECTIONS: readonly { title: string; commands: readonly string[] }[] = [
  { title: "Start here", commands: ["init"] },
  { title: "Identities", commands: ["list", "add", "show", "set", "login", "remove"] },
  { title: "Connect an agent", commands: ["setup"] },
  { title: "Sign-ins and sessions", commands: ["vault", "secret", "export", "import"] },
  { title: "Flows and recordings", commands: ["record", "teach", "flows", "replay", "traces"] },
  { title: "Watch and take over", commands: ["live", "pause", "resume"] },
  { title: "From the shell", commands: ["do", "background"] },
  { title: "Checks", commands: ["status", "doctor", "reputation", "bench"] },
];

export function version(): string {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** The main help: every command by section, drawn the way turno draws its own. */
export function renderHelp(io: Io, cli: BrowserCli): string[] {
  const s = style(io);
  const width = Math.min(s.width, 100);
  const out: string[] = [];
  const tagline = `${PROGRAM}: a browser your agents use with your accounts. It stays light on your machine, and the model never sees your passwords.`;
  const first = wrap(tagline, width);
  out.push(s.color ? `${s.bold(s.accent(PROGRAM))}${s.bold(first[0]!.slice(PROGRAM.length))}` : first[0]!);
  for (const l of first.slice(1)) out.push(s.bold(l));
  if (cli.subs.init)
    out.push(
      "",
      `New here? ${s.accent(`${PROGRAM} init`)} sets it up step by step: an identity, a sign-in, your agent.`,
    );
  out.push("", s.header("Usage"));
  out.push(
    columns([
      [`${PROGRAM} <command> [flags]`, "manage identities: persistent Chrome profiles your agents sign in with"],
      [`${PROGRAM} <command> --help`, "the flags and examples of one command"],
      ["turno-browser-mcp --identity <id>", "the MCP server an agent runs for one identity (--help)"],
      [`${PROGRAM} completion <zsh|bash|fish>`, "shell completion for commands, identities and flags (--help)"],
    ]),
  );
  const left = Math.max(...SECTIONS.flatMap((x) => x.commands.map((n) => n.length)));
  for (const section of SECTIONS) {
    out.push("", s.header(section.title));
    out.push(
      columns(
        section.commands.map((n) => [n, cli.subs[n]?.summary ?? ""] as const),
        2,
        32,
        left,
      ),
    );
  }
  out.push("", s.header("Flags of every command"));
  out.push(
    columns([
      ["--json", "machine output, on commands that read (--json=fields lists the fields)"],
      ["--dry-run", "say what a command that writes would do, and do nothing"],
      ["--no-input", "never ask a question (also TURNO_NO_INPUT=1)"],
      ["--color auto|always|never", "colors in the output (also NO_COLOR, TURNO_COLOR)"],
      ["--version", `the ${PROGRAM} version`],
    ]),
  );
  out.push("", s.muted(`${PROGRAM} help <command> prints the same as ${PROGRAM} <command> --help.`));
  return out;
}

function colorValue(v: string | undefined): ColorMode {
  if (isColorMode(v)) return v;
  return fail(
    v === undefined || v.startsWith("-")
      ? "--color needs a value: auto, always or never"
      : `--color ${v}: use auto, always or never`,
  );
}

/**
 * Take the global flags out of argv: `--no-input` and `--color auto|always|never` (or
 * `--color=<mode>`), before the command or among its flags, never after `--`.
 */
export function takeGlobals(argv: readonly string[]): { argv: string[]; noInput: boolean; color?: ColorMode } {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  const kept: string[] = [];
  let noInput = false;
  let color: ColorMode | undefined;
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (a === "--no-input") noInput = true;
    else if (a === "--color") color = colorValue(own[++i]);
    else if (a.startsWith("--color=")) color = colorValue(a.slice("--color=".length));
    else kept.push(a);
  }
  return { argv: [...kept, ...(end < 0 ? [] : argv.slice(end))], noInput, ...(color ? { color } : {}) };
}

/** Whether this run asked for --json: then an error is a JSON line on stderr. */
function wantsJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).some((a) => a === "--json" || a.startsWith("--json="));
}

/** Error classes whose message is the whole story: printed without a stack trace. */
const ONE_LINE_ERRORS = new Set(["SecretError", "IdentityError", "VaultError", "SealError", "FlowError", "LiveError"]);

function report(err: unknown, io: Io, json: boolean): number {
  const e = err as Error;
  const code = err instanceof UsageError ? Exit.usage : err instanceof CliError ? err.code : Exit.failure;
  const known = err instanceof UsageError || err instanceof CliError || ONE_LINE_ERRORS.has(e?.name);
  if (json) {
    const fields = (err as { fields?: unknown }).fields;
    io.err(
      jsonError(e?.message ?? String(err), code, exitName(code), {
        ...(Array.isArray(fields) ? { fields } : {}),
        ...(known ? {} : { stack: e?.stack }),
      }),
    );
  } else io.err(`${PROGRAM}: ${known ? e.message : (e?.stack ?? e?.message ?? String(err))}`);
  return code;
}

export async function main(args: string[], io: Io = defaultIo()): Promise<number> {
  let picked: ReturnType<typeof takeGlobals>;
  try {
    picked = takeGlobals(args);
  } catch (err) {
    io.err(`${PROGRAM}: ${(err as Error).message}`);
    return Exit.usage;
  }
  if (picked.color) io = { ...io, color: picked.color };
  // --no-input is TURNO_NO_INPUT=1, as in turno.
  if (picked.noInput) io = { ...withoutAsk(io), env: { ...io.env, TURNO_NO_INPUT: "1" } };
  else if (io.ask && noInputReason(io.env)) io = withoutAsk(io);
  const cli = browserCli(standaloneHost(), {
    api,
    interactive: (o) => Boolean(o.ask),
    confirm: (question, o) => confirm(o, question.replace(/ \[y\/N\] $/, "")),
  });
  const [head, ...tail] = picked.argv;
  const json = wantsJson(picked.argv);
  try {
    if (head === undefined || head === "-h" || head === "--help" || (head === "help" && !tail.length)) {
      for (const l of renderHelp(io, cli)) io.out(l);
      return Exit.ok;
    }
    if (head === "--version" || head === "-v") {
      io.out(`${PROGRAM} ${version()}`);
      return Exit.ok;
    }
    if (head === "__complete") {
      const words = tail[0] === "--" ? tail.slice(1) : tail;
      for (const c of complete(words.length ? words : [""], cli.subs, io.env)) io.out(c);
      return Exit.ok;
    }
    if (head === "completion") {
      if (tail[0] === "--help" || tail[0] === "-h") {
        io.out(COMPLETION_USAGE(PROGRAM));
        return Exit.ok;
      }
      const script = completionScript(PROGRAM, tail[0]);
      if (!script || tail.length > 1) throw new UsageError(`usage: ${PROGRAM} completion <zsh|bash|fish>`);
      io.out(script.trimEnd());
      return Exit.ok;
    }
    if (head === "help" && tail[0] === "completion") {
      io.out(COMPLETION_USAGE(PROGRAM));
      return Exit.ok;
    }
    if (head === "help") return await cli.command.run([...tail, "--help"], io);
    if (head.startsWith("-")) return fail(`unknown option ${head} (${PROGRAM} --help)`);
    return await cli.command.run(picked.argv, io);
  } catch (err) {
    return report(err, io, json);
  }
}

function isEntry(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${PROGRAM}: ${(err as Error).stack ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
