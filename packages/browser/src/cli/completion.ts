/**
 * Shell completion for the turno-browser program: `turno-browser completion <shell>` prints the
 * script, and the script calls `turno-browser __complete -- <words...>` for candidates. It only
 * reads identity folders: completing never starts Chrome or reads the secret store.
 */
import { SHELLS, type Sub, completionScripts } from "turno-core/cli";
import { BROWSER_IDS } from "../browsers.js";
import { listIdentities } from "../identities.js";
import { CURSOR_MODES, RESOURCE_MODES } from "../settings.js";
import { ACTION_NAMES } from "./do.js";
import { SETUP_AGENTS } from "./setup.js";

/** Commands whose first argument is an identity. */
const IDENTITY_FIRST = new Set([
  "show",
  "set",
  "login",
  "remove",
  "export",
  "record",
  "teach",
  "flows",
  "replay",
  "traces",
  "live",
  "pause",
  "resume",
  "do",
  "reputation",
  "status",
]);

/** Commands with their own subcommands, and whether an identity follows the subcommand. */
const NESTED: Record<string, { subs: string[]; identity: boolean }> = {
  background: { subs: ["status", "start", "stop"], identity: true },
  vault: { subs: ["add", "list", "remove", "submit"], identity: true },
  secret: { subs: ["set", "has", "list", "remove"], identity: false },
};

/** Flags whose value can be completed: a list, or the identities, or a path. */
const FLAG_VALUES: Record<string, readonly string[] | "identity" | "file"> = {
  "--identity": "identity",
  "--engine": ["chrome", "lightpanda", "camoufox"],
  "--out": "file",
  "--color": ["auto", "always", "never"],
  "--agent": [...SETUP_AGENTS, "none"],
  "--cursor": CURSOR_MODES,
  "--resources": RESOURCE_MODES,
  "--browser": BROWSER_IDS,
};

const GLOBAL_FLAGS = ["--help", "--version", "--no-input", "--color"];

function identities(env: NodeJS.ProcessEnv): string[] {
  try {
    return listIdentities(env).map((i) => i.id);
  } catch {
    return [];
  }
}

/** Candidates for the last word, given the words before it (both after `turno-browser`). */
export function complete(words: readonly string[], subs: Record<string, Sub>, env: NodeJS.ProcessEnv): string[] {
  const cur = words[words.length - 1] ?? "";
  const before = words.slice(0, -1);
  const match = (list: readonly string[]) => [...new Set(list)].filter((c) => c.startsWith(cur));
  const visible = Object.keys(subs).filter((s) => !subs[s]!.hidden);
  const commands = [...visible, "help", "completion"];
  if (before.length === 0) return match(cur.startsWith("-") ? GLOBAL_FLAGS : commands);

  const [name, ...rest] = before as [string, ...string[]];
  const prev = before[before.length - 1]!;
  const value = FLAG_VALUES[prev];
  if (value && before.length > 1) {
    if (value === "file") return [":file"];
    return match(value === "identity" ? identities(env) : value);
  }
  if (name === "help") return before.length === 1 ? match(visible) : [];
  if (name === "completion") return before.length === 1 ? match(SHELLS) : [];
  const sub = subs[name];
  if (!sub) return [];
  if (cur.startsWith("-")) return match([...(sub.flags ?? []), "--help"]);

  // The positional arguments typed so far, without flags and the values they took.
  const positionals = rest.filter((a, i) => !a.startsWith("-") && !(i > 0 && FLAG_VALUES[rest[i - 1]!]));
  const n = positionals.length;
  const nested = NESTED[name];
  if (nested) {
    if (n === 0) return match(nested.subs);
    return n === 1 && nested.identity ? match(identities(env)) : [];
  }
  if (name === "setup") return n === 0 ? match(SETUP_AGENTS) : [];
  if (name === "import") return n === 0 ? [":file"] : [];
  if (IDENTITY_FIRST.has(name) && n === 0) return match(identities(env));
  if (name === "do" && n === 1) return match(ACTION_NAMES);
  return [];
}

/** `turno-browser completion <shell>`: the script, or undefined for an unknown shell. */
export function completionScript(program: string, shell: string | undefined): string | undefined {
  const scripts = completionScripts(program);
  return shell && shell in scripts ? scripts[shell as keyof typeof scripts] : undefined;
}

export const COMPLETION_USAGE = (program: string) =>
  [
    `Usage: ${program} completion <zsh|bash|fish>`,
    "",
    "Prints the completion script: commands, identities, flags and do actions. To load it in every shell:",
    `  zsh   echo 'source <(${program} completion zsh)' >> ~/.zshrc`,
    `  bash  echo 'eval "$(${program} completion bash)"' >> ~/.bashrc`,
    `  fish  ${program} completion fish > ~/.config/fish/completions/${program}.fish`,
  ].join("\n");
