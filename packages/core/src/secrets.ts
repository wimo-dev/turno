import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "./paths.js";

/**
 * The secret store of this machine: the macOS Keychain through `security`, the Linux Secret
 * Service through libsecret's `secret-tool`, and on Windows files encrypted with DPAPI for the
 * current user, shared by turno-cli (the `keychain:<name>` references of mcp.toml) and
 * turno-browser. Values travel on stdin, never in a process argv, and this module never writes
 * them to a file or a log in the clear.
 */

export class SecretError extends Error {
  constructor(ref: string, why: string) {
    super(ref ? `cannot resolve ${ref}: ${why}` : why);
    this.name = "SecretError";
  }
}

/** The one-line error when the machine has no secret store turno can use. */
export const NO_SECRET_STORE =
  "no secret store found: turno uses the macOS Keychain (security), libsecret (secret-tool, package libsecret-tools) or Windows DPAPI (Windows PowerShell); install one, or use env:NAME references in mcp.toml";

/**
 * Where items live: the login Keychain on macOS, the Secret Service through libsecret's
 * `secret-tool` on Linux, one DPAPI-encrypted file per item on Windows. Every item belongs to
 * turno (Keychain account `turno`, libsecret attributes `service=turno account=<name>`, the
 * folder `%LOCALAPPDATA%\turno\secrets`); `name` is the item's own key.
 */
export interface SecretStore {
  readonly kind: "keychain" | "libsecret" | "dpapi";
  /** Human name for messages. */
  readonly label: string;
  /** Where the items are, for doctor (the DPAPI folder); absent when the label says it all. */
  readonly location?: string;
  /** The value, or undefined when there is no item. */
  get(service: string): Promise<string | undefined>;
  /** True when an item exists. Never reads the value into turno's output. */
  has(service: string): Promise<boolean>;
  /** Create or replace an item. The value never appears in any process argv. */
  set(service: string, value: string): Promise<void>;
  /** Delete an item; false when there was none. */
  remove(service: string): Promise<boolean>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout as bytes (DPAPI output is binary). */
  bytes: Buffer;
}

/** Run a command with optional stdin; never rejects (a missing binary is code 127). */
function exec(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string | Buffer,
  timeout = 10_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], timeout, windowsHide: true });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: (err as Error).message, bytes: Buffer.alloc(0) });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    let done = false;
    const finish = (r: ExecResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish({ code: e.code === "ENOENT" ? 127 : 1, stdout: "", stderr: e.message, bytes: Buffer.alloc(0) }),
    );
    child.on("close", (code) => {
      const bytes = Buffer.concat(out);
      finish({
        code: code ?? 1,
        stdout: bytes.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        bytes,
      });
    });
    child.stdin.on("error", () => {
      /* the process exited before reading; its exit code tells */
    });
    child.stdin.end(input ?? "");
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

/** Service names travel as arguments and in `security -i` lines: keep them to one plain line. */
function checkService(service: string): void {
  if (!service || /[\0\r\n]/.test(service)) throw new SecretError("", `invalid secret name ${JSON.stringify(service)}`);
}

/** Quote one word for a `security -i` command line (double quotes, backslash escapes). */
export function securityQuote(word: string): string {
  return `"${word.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The line `security -i` reads on stdin to store an item; exported for tests. */
export function keychainAddLine(service: string, value: string, account = "turno"): string {
  if (/[\0\r\n]/.test(value))
    throw new SecretError("", "the value has a line break or NUL byte; the Keychain store reads one line");
  return `add-generic-password -U -a ${securityQuote(account)} -s ${securityQuote(service)} -w ${securityQuote(value)} -T /usr/bin/security\n`;
}

/** Exit code of `security` when the item does not exist (errSecItemNotFound). */
const KEYCHAIN_NOT_FOUND = 44;

function keychainStore(bin: string, env: NodeJS.ProcessEnv): SecretStore {
  return {
    kind: "keychain",
    label: "Keychain",
    async get(service) {
      checkService(service);
      const r = await exec(bin, ["find-generic-password", "-s", service, "-w"], env);
      if (r.code === 0) return r.stdout.replace(/\n$/, "");
      if (r.code === KEYCHAIN_NOT_FOUND) return undefined;
      throw new SecretError(`keychain:${service}`, firstLine(r.stderr) || `security exited with ${r.code}`);
    },
    async has(service) {
      checkService(service);
      // Without -w this reads the item's attributes, never its value.
      return (await exec(bin, ["find-generic-password", "-s", service], env)).code === 0;
    },
    async set(service, value) {
      checkService(service);
      // `security -i` reads commands from stdin, so the value never shows in `ps`. The output is
      // not echoed back: an error line could quote the command.
      const r = await exec(bin, ["-i"], env, keychainAddLine(service, value), 60_000);
      if (r.code !== 0)
        throw new SecretError("", `the Keychain did not store ${service} (security exited with ${r.code})`);
    },
    async remove(service) {
      checkService(service);
      const r = await exec(bin, ["delete-generic-password", "-s", service], env);
      if (r.code === 0) return true;
      if (r.code === KEYCHAIN_NOT_FOUND) return false;
      throw new SecretError("", `the Keychain did not delete ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    },
  };
}

/** libsecret attributes of an item: service=turno, account=<name>. */
function attrs(service: string): string[] {
  return ["service", "turno", "account", service];
}

function libsecretStore(bin: string, env: NodeJS.ProcessEnv): SecretStore {
  const lookup = (service: string) => exec(bin, ["lookup", ...attrs(service)], env);
  return {
    kind: "libsecret",
    label: "Secret Service",
    async get(service) {
      checkService(service);
      const r = await lookup(service);
      if (r.code === 0) return r.stdout.replace(/\n$/, "");
      if (!r.stderr.trim()) return undefined; // not found: exit 1, nothing on stderr
      throw new SecretError(`keychain:${service}`, firstLine(r.stderr));
    },
    async has(service) {
      checkService(service);
      return (await lookup(service)).code === 0;
    },
    async set(service, value) {
      checkService(service);
      // secret-tool reads the value from stdin when stdin is not a terminal.
      const r = await exec(bin, ["store", `--label=turno: ${service}`, ...attrs(service)], env, value, 60_000);
      if (r.code !== 0)
        throw new SecretError("", `secret-tool did not store ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
    },
    async remove(service) {
      checkService(service);
      if (!(await this.has(service))) return false;
      const r = await exec(bin, ["clear", ...attrs(service)], env);
      if (r.code !== 0)
        throw new SecretError("", `secret-tool did not delete ${service}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
      return true;
    },
  };
}

// Windows -------------------------------------------------------------------------------------
//
// Each item is a file in %LOCALAPPDATA%\turno\secrets whose value is encrypted with DPAPI for
// the current user (ProtectedData, CurrentUser scope): only this Windows user on this machine
// can decrypt it, with no admin rights and no native addon. Windows Credential Manager was the
// other option; it caps a generic credential at 2560 bytes (CRED_MAX_CREDENTIAL_BLOB_SIZE), which
// an OAuth record or a value from `secret set` can pass, it has no credential set in a network
// logon (SSH), and every lookup there costs a PowerShell start, where `has` and `remove` here
// only touch the file. Windows PowerShell 5.1 does the encryption: it ships with every Windows
// 10 and 11, starts faster than pwsh, and is run from its fixed path, never from PATH.

/** Windows PowerShell 5.1, which every supported Windows has at this path. */
export function windowsPowerShell(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** The folder of the DPAPI items: `%LOCALAPPDATA%\turno\secrets`. */
export function dpapiDir(env: NodeJS.ProcessEnv): string {
  const local = env.LOCALAPPDATA || join(env.USERPROFILE || env.HOME || homedir(), "AppData", "Local");
  return join(local, "turno", "secrets");
}

/** What PowerShell runs; `exit 3` means DPAPI itself refused (wrong user, machine or name, or damaged data). */
export type DpapiOp = "Protect" | "Unprotect";

/**
 * The PowerShell script for one DPAPI call. It reads its whole input from the raw stdin stream
 * (one base64 line with the item name, then the bytes), writes the result to the raw stdout
 * stream, and never passes the data to a cmdlet, so the value appears in no argument, no
 * transcript and no pipeline log. The item name is DPAPI's optional entropy: a file copied over
 * another item's file does not decrypt.
 */
export function dpapiScript(op: DpapiOp): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  ${loadAssembly("System.Security")}`,
    "  $ms = [IO.MemoryStream]::new()",
    "  [Console]::OpenStandardInput().CopyTo($ms)",
    "  $all = $ms.ToArray()",
    "  $nl = [Array]::IndexOf($all, [byte]10)",
    "  if ($nl -lt 0) { [Console]::Error.Write('turno: no item name on stdin'); exit 2 }",
    "  $name = [Convert]::FromBase64String([Text.Encoding]::ASCII.GetString($all, 0, $nl))",
    "  $entropy = [byte[]]([Text.Encoding]::UTF8.GetBytes('turno-secret:') + $name)",
    "  $data = [byte[]]::new($all.Length - $nl - 1)",
    "  [Array]::Copy($all, $nl + 1, $data, 0, $data.Length)",
    `  $out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "  $o = [Console]::OpenStandardOutput()",
    "  $o.Write($out, 0, $out.Length)",
    "  $o.Flush()",
    "  exit 0",
    "} catch {",
    "  $e = $_.Exception",
    "  while ($e.InnerException) { $e = $e.InnerException }",
    "  [Console]::Error.Write($e.GetType().Name + ': ' + $e.Message)",
    "  if ($e -is [Security.Cryptography.CryptographicException]) { exit 3 }",
    "  exit 1",
    "}",
  ].join("\n");
}

/** The argv of one DPAPI call: the script only, never the name or the value (those go on stdin). */
export function dpapiArgs(op: DpapiOp): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", dpapiScript(op)];
}

/** The stdin of one DPAPI call: the item name in base64 on the first line, then the bytes. */
export function dpapiInput(service: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${Buffer.from(service, "utf8").toString("base64")}\n`, "ascii"), data]);
}

/** Runs one DPAPI call: (operation, stdin) to the process result. Tests pass a stand-in. */
export type DpapiRunner = (op: DpapiOp, input: Buffer) => Promise<ExecResult>;

/**
 * The environment Windows PowerShell gets: the caller's, with SystemRoot, which it cannot start
 * without, even when the caller trimmed it (an agent hands its MCP servers a few variables).
 */
export function windowsPowerShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, SystemRoot: env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot || "C:\\Windows" };
}

/**
 * Loads a .NET Framework assembly by its full name. The scripts here call .NET only, never a
 * cmdlet such as Add-Type: with the trimmed environment an agent gives its servers, the first
 * cmdlet that PowerShell loads from a module takes 20 seconds (measured on windows-latest).
 */
export function loadAssembly(name: "System.Security" | "System.Management"): string {
  return `$null = [Reflection.Assembly]::Load('${name}, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')`;
}

function powershellRunner(env: NodeJS.ProcessEnv): DpapiRunner {
  const bin = windowsPowerShell(env);
  const childEnv = windowsPowerShellEnv(env);
  return (op, input) => exec(bin, dpapiArgs(op), childEnv, input, 30_000);
}

/** One item on disk: the name in the clear (names are not secret: mcp.toml lists them) and the DPAPI blob. */
interface DpapiFile {
  v: 1;
  name: string;
  dpapi: string;
}

/** The file name of an item: the SHA-256 of its name, since names hold "/" and NTFS ignores case. */
export function dpapiFileName(service: string): string {
  return `${createHash("sha256").update(service, "utf8").digest("hex")}.json`;
}

/** Parse an item file; a SecretError when it is not one of ours or belongs to another name. */
export function parseDpapiFile(text: string, service: string): Buffer {
  let v: Partial<DpapiFile> | undefined;
  try {
    v = JSON.parse(text) as Partial<DpapiFile>;
  } catch {
    v = undefined;
  }
  if (!v || v.v !== 1 || typeof v.dpapi !== "string" || v.name !== service)
    throw new SecretError(`keychain:${service}`, "its file is damaged; store it again");
  return Buffer.from(v.dpapi, "base64");
}

/** The error for a failed DPAPI call; stderr carries an exception message, never the value. */
export function dpapiFailure(r: ExecResult, op: DpapiOp, service: string): SecretError {
  const ref = `keychain:${service}`;
  if (r.code === 127) return new SecretError(ref, `Windows PowerShell is not available: ${firstLine(r.stderr)}`);
  if (r.code === 3 && op === "Unprotect")
    return new SecretError(
      ref,
      "Windows could not decrypt it (DPAPI): it was stored by another Windows user or on another machine, or its file is damaged; store it again",
    );
  return new SecretError(
    ref,
    `DPAPI ${op === "Protect" ? "did not encrypt" : "did not decrypt"} it: ${firstLine(r.stderr) || `powershell exited with ${r.code}`}`,
  );
}

function fsError(err: unknown, service: string, file: string): SecretError {
  const code = (err as NodeJS.ErrnoException).code;
  const why = code === "EACCES" || code === "EPERM" ? "access denied" : (err as Error).message;
  return new SecretError(`keychain:${service}`, `${file}: ${why}`);
}

/** Rename over an existing file, retrying briefly while another process has it open (Windows). */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** The DPAPI store over `dir`; `run` does the encryption (PowerShell, or a stand-in in tests). */
export function dpapiStore(dir: string, run: DpapiRunner): SecretStore {
  const fileOf = (service: string) => join(dir, dpapiFileName(service));
  return {
    kind: "dpapi",
    label: "Windows DPAPI store",
    location: dir,
    async get(service) {
      checkService(service);
      const file = fileOf(service);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw fsError(err, service, file);
      }
      const r = await run("Unprotect", dpapiInput(service, parseDpapiFile(text, service)));
      if (r.code !== 0) throw dpapiFailure(r, "Unprotect", service);
      return r.bytes.toString("utf8");
    },
    async has(service) {
      checkService(service);
      const file = fileOf(service);
      try {
        return statSync(file).isFile();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw fsError(err, service, file);
      }
    },
    async set(service, value) {
      checkService(service);
      const r = await run("Protect", dpapiInput(service, Buffer.from(value, "utf8")));
      if (r.code !== 0 || !r.bytes.length) throw dpapiFailure(r, "Protect", service);
      const file = fileOf(service);
      const body: DpapiFile = { v: 1, name: service, dpapi: r.bytes.toString("base64") };
      // Only the encrypted blob reaches the disk; a reader never sees a half-written file.
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
        await replaceFile(tmp, file);
      } catch (err) {
        throw fsError(err, service, file);
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    async remove(service) {
      checkService(service);
      const file = fileOf(service);
      try {
        rmSync(file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw fsError(err, service, file);
      }
    },
  };
}

/**
 * The secret store of this machine: `security` on macOS, DPAPI through Windows PowerShell on
 * Windows, `secret-tool` elsewhere (found on the PATH of `env`). Undefined when there is none
 * (the caller prints NO_SECRET_STORE).
 */
export function secretStore(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): SecretStore | undefined {
  if (platform === "darwin") {
    const bin = findOnPath("security", env);
    return bin ? keychainStore(bin, env) : undefined;
  }
  if (platform === "win32")
    return existsSync(windowsPowerShell(env)) ? dpapiStore(dpapiDir(env), powershellRunner(env)) : undefined;
  const bin = findOnPath("secret-tool", env);
  return bin ? libsecretStore(bin, env) : undefined;
}

/** What doctor shows for the store in use: which store, and for DPAPI where its files are. */
export function describeSecretStore(store: SecretStore): string {
  if (store.kind === "keychain") return "macOS Keychain (security)";
  if (store.kind === "libsecret") return "Secret Service (secret-tool)";
  return `Windows DPAPI, current user (files in ${store.location ?? dpapiDir(process.env)})`;
}

/** The store, or a SecretError with the one-line hint. */
export function requireSecretStore(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): SecretStore {
  const store = secretStore(env, platform);
  if (!store) throw new SecretError("", NO_SECRET_STORE);
  return store;
}
