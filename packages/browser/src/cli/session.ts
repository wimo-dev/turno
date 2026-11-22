import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DRY_RUN, type Io, bool, fail, needsAnswer, noInputReason, parseFlags, str } from "turno-core/cli";
import { tildify } from "turno-core/paths";
import { recordExportFile } from "../session-export.js";
import type { Ctx, VaultInput } from "./context.js";
import { terminalInput } from "./vault.js";

/**
 * `export` and `import`: an identity's signed-in session
 * (cookies, localStorage, IndexedDB) as one file encrypted under a passphrase, with an expiry
 * inside. The passphrase comes from a hidden prompt (asked twice on export) or the first line
 * of stdin, never from a flag.
 */

const EXPORT_FLAGS = {
  out: { type: "string", short: "o" },
  expires: { type: "string" },
  force: { type: "boolean" },
} as const;
const IMPORT_FLAGS = { as: { type: "string" }, yes: { type: "boolean", short: "y" }, ...DRY_RUN } as const;

const DAY = 24 * 3600_000;

/** `7d`, `36h`: how long an export can be imported. */
export function parseExpiry(text: string): number {
  const m = /^(\d+)\s*(d|h)$/.exec(text.trim());
  const ms = m ? Number(m[1]) * (m[2] === "d" ? DAY : 3600_000) : Number.NaN;
  if (!(ms > 0 && ms <= 90 * DAY))
    return fail(`--expires takes hours or days up to 90d, like 7d or 12h, not "${text}"`);
  return ms;
}

async function passphrase(io: Io, input: VaultInput, confirm: boolean, subject: string): Promise<string> {
  if (input.isTty()) {
    if (noInputReason(io.env)) needsAnswer(`${subject}${confirm ? "export" : "import"}`, "the passphrase on stdin");
    const first = await input.hidden("Passphrase (input hidden): ");
    if (confirm && (await input.hidden("Passphrase again: ")) !== first)
      return fail("the passphrases differ; nothing was written");
    return first;
  }
  return (await input.stdin()).split(/\r?\n/)[0] ?? "";
}

export async function exportSession(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const input = c.deps.input ?? terminalInput;
  const p = parseFlags(args, EXPORT_FLAGS, 1);
  const id = p.positionals[0];
  if (!id) return fail(`usage: ${c.names.browser} export <id> --out <file> [--expires 7d] [--force]`);
  mod.assertIdentityId(id);
  if (!mod.identityExists(id, io.env)) return fail(`browser identity "${id}" does not exist`);
  const out = str(p, "out");
  if (!out) return fail("give the file to write with --out (for example --out school.session)");
  const expiresInMs = parseExpiry(str(p, "expires") ?? "7d");
  const file = resolve(out);
  const secret = await passphrase(io, input, true, c.names.subject);
  const { sealed, summary } = await mod.exportSession(id, { passphrase: secret, expiresInMs, env: io.env });
  try {
    writeFileSync(file, sealed, { mode: 0o600, flag: bool(p, "force") ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      return fail(`${tildify(file, io.env)} exists; pass --force to replace it`);
    throw err;
  }
  try {
    recordExportFile(id, file, io.env);
  } catch {
    /* only a hint for remove, which deletes the exports it knows of */
  }
  io.out(
    `exported the session of "${id}" (${summary.cookies} cookies, storage of ${summary.origins} sites) to ${tildify(file, io.env)}`,
  );
  io.out(`it can be imported until ${summary.expiresAt}; it holds no vault credentials`);
  return 0;
}

export async function importSession(c: Ctx, args: string[], io: Io): Promise<number> {
  const mod = c.api;
  const deps = c.deps;
  const input = c.deps.input ?? terminalInput;
  const p = parseFlags(args, IMPORT_FLAGS, 1);
  const path = p.positionals[0];
  if (!path) return fail(`usage: ${c.names.browser} import <file> [--as <id>] [--yes] [--dry-run]`);
  let text: string;
  try {
    text = readFileSync(resolve(path), "utf8");
  } catch {
    return fail(`cannot read ${path}`);
  }
  const as = str(p, "as");
  if (as) mod.assertIdentityId(as);
  const secret = await passphrase(io, input, false, c.names.subject);
  const { summary } = await mod.readSessionExport(text, secret);
  const id = as ?? summary.identity;
  const exists = mod.identityExists(id, io.env);
  const what = `${summary.cookies} cookies and the storage of ${summary.origins} sites, exported from "${summary.identity}" on ${summary.createdAt}`;
  if (bool(p, "dry-run")) {
    io.out(`(dry run) would ${exists ? "replace the session of" : "create"} browser identity "${id}" with ${what}`);
    return 0;
  }
  if (exists && !bool(p, "yes")) {
    if (!deps.interactive(io)) needsAnswer(`${c.names.subject}import into an existing identity`);
    if (
      !(await deps.confirm(
        `Replace the cookies and site storage of "${id}"? Its current sign-ins are lost. [y/N] `,
        io,
      ))
    ) {
      io.out("nothing imported");
      return 1;
    }
  }
  const done = await mod.importSession(text, { passphrase: secret, ...(as ? { as } : {}), env: io.env });
  io.out(`${done.created ? "created" : "replaced the session of"} browser identity "${done.identity}" with ${what}`);
  return 0;
}
