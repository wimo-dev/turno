import { readFileSync } from "node:fs";
import {
  type Command,
  type Io,
  JSON_FLAG,
  type Sub,
  bool,
  emit,
  fail,
  group,
  jsonOutput,
  needsAnswer,
  noInputReason,
  parseFlags,
} from "turno-core/cli";
import { SecretError, type SecretStore, requireSecretStore } from "turno-core/secrets";
import type { Ctx, VaultInput } from "./context.js";
import { terminalInput } from "./vault.js";

/**
 * `turno-browser secret`: the items of the secret store that identity.json and replay
 * parameters name as `keychain:<item>` (a proxy password, an act or captcha API key). The same
 * store and the same items as turno's `turno secret`: the macOS Keychain or the Linux Secret
 * Service. Values come from a hidden prompt or stdin, never from an argument, and are never
 * printed. The vault's sign-in credentials have their own command (`vault`).
 */

/** `secret list --json`: one element per keychain: reference in identity.json. */
const SECRET_JSON = jsonOutput(["item", "stored", "identities"]);

function store(io: Io): SecretStore {
  try {
    return requireSecretStore(io.env);
  } catch (err) {
    return fail((err as Error).message);
  }
}

/** The keychain:<item> references in one identity.json. */
function keychainRefs(text: string): string[] {
  return [...new Set([...text.matchAll(/"keychain:([^"\\]+)"/g)].map((m) => m[1]!))].sort();
}

/** One item name and no flags: an unknown flag must not become an item name. */
function itemOf(c: Ctx, sub: string, args: string[]): string {
  const item = parseFlags(args, {}, 1).positionals[0];
  if (!item)
    return fail(`secret ${sub} needs an item name (for example: ${c.names.browser} secret ${sub} proxy-password)`);
  return item;
}

async function set(c: Ctx, args: string[], io: Io, input: VaultInput): Promise<number> {
  const item = itemOf(c, "set", args);
  const s = store(io);
  let value: string;
  if (input.isTty()) {
    // The hidden prompt waits for a person: never with --no-input or inside an agent session.
    if (noInputReason(io.env)) needsAnswer(`${c.names.subject}secret set`, "the value on stdin");
    value = await input.hidden("value (input hidden, end with Enter): ");
  } else value = await input.stdin(); // without one trailing line break
  if (!value) return fail("empty value: nothing stored");
  await s.set(item, value);
  io.out(`stored keychain:${item}`);
  return 0;
}

async function has(c: Ctx, args: string[], io: Io): Promise<number> {
  const item = itemOf(c, "has", args);
  if (await store(io).has(item)) {
    io.out(`keychain:${item} exists`);
    return 0;
  }
  io.out(`keychain:${item} not found`);
  return 1;
}

async function remove(c: Ctx, args: string[], io: Io): Promise<number> {
  const item = itemOf(c, "remove", args);
  if (!(await store(io).remove(item))) {
    io.out(`keychain:${item} not found`);
    return 1;
  }
  io.out(`removed keychain:${item}`);
  return 0;
}

async function list(c: Ctx, args: string[], io: Io): Promise<number> {
  const p = parseFlags(args, JSON_FLAG, 0);
  const users = new Map<string, string[]>();
  for (const { id } of c.api.listIdentities(io.env)) {
    let text = "";
    try {
      text = readFileSync(c.api.identitySettingsPath(id, io.env), "utf8");
    } catch {
      continue;
    }
    for (const item of keychainRefs(text)) users.set(item, [...(users.get(item) ?? []), id]);
  }
  const items = [...users.keys()].sort();
  const s = items.length ? store(io) : undefined;
  const found = s ? await Promise.all(items.map((i) => s.has(i))) : [];
  if (bool(p, "json")) {
    emit(
      io,
      p,
      SECRET_JSON,
      items.map((item, i) => ({ item, stored: found[i], identities: users.get(item) })),
    );
    return found.every(Boolean) ? 0 : 1;
  }
  if (!items.length) io.out("no keychain: references in any identity.json");
  for (const [i, item] of items.entries())
    io.out(
      `${found[i] ? "stored " : "MISSING"}  keychain:${item}  (${users.get(item)!.join(", ")})${found[i] ? "" : `  ${c.names.browser} secret set ${item}`}`,
    );
  return found.every(Boolean) ? 0 : 1;
}

/** The `secret` group. */
export function secretCommand(c: Ctx): Command {
  const input = c.deps.input ?? terminalInput;
  const b = c.names.browser;
  const guarded =
    (run: (args: string[], io: Io) => Promise<number>): Sub["run"] =>
    async (args, io) => {
      try {
        return await run(args, io);
      } catch (err) {
        if (err instanceof SecretError) return fail(err.message);
        throw err;
      }
    };
  const subs: Record<string, Sub> = {
    set: {
      summary: "store a value read from a hidden prompt or stdin",
      synopsis: "<item>",
      run: guarded((args, io) => set(c, args, io, input)),
    },
    has: {
      summary: "exit 0 when the item exists",
      synopsis: "<item>",
      run: guarded((args, io) => has(c, args, io)),
    },
    list: {
      summary: "every keychain: reference in identity.json and whether it is stored",
      synopsis: "[--json]",
      flags: ["--json"],
      json: SECRET_JSON,
      run: guarded((args, io) => list(c, args, io)),
    },
    remove: {
      summary: "delete the item",
      synopsis: "<item>",
      run: guarded((args, io) => remove(c, args, io)),
    },
    rm: { summary: "same as remove", hidden: true, run: guarded((args, io) => remove(c, args, io)) },
  };
  return group(`${c.names.subject}secret`, "items of the secret store identity.json names", subs, {
    fallback: "list",
    footer: `An identity.json names a secret as "keychain:<item>" (proxy.password, act.key, captcha.key), and
so does a replay parameter (--param password=keychain:<item>). The store is the login Keychain on
macOS, the Secret Service (libsecret's secret-tool) on Linux and files encrypted with DPAPI for
the current user on Windows (%LOCALAPPDATA%\\turno\\secrets), the same items turno secret uses.
Values are never printed and never passed as an argument. Sign-in credentials live in the vault
(${b} vault).`,
    prefix: `${b} secret`,
    examples: [
      `printf %s "$PROXY_PASSWORD" | ${b} secret set proxy-password`,
      `${b} secret has proxy-password`,
      `${b} secret list --json`,
      `${b} secret remove proxy-password`,
    ],
  });
}
