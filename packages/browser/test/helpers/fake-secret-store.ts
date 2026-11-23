import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dpapiDir, dpapiFileName } from "turno-core/secrets";
import type { Sandbox } from "./sandbox.js";

/**
 * A file-backed stand-in for the macOS `security` and libsecret `secret-tool` commands, put
 * first on the sandbox PATH. Items live under `<sandbox>/fake-secrets/`, never in a real
 * Keychain. `failWrites(true)` makes every store fail, like a locked Keychain.
 *
 * On Windows the store is the real one: DPAPI files under the sandbox's LOCALAPPDATA,
 * encrypted for the account that runs the tests, so nothing reaches the account's own store.
 */
export interface FakeSecretStore {
  dir: string;
  read(service: string): string | undefined;
  write(service: string, value: string): void;
  /** Deletes an item behind turno's back, as a person could in Keychain Access. */
  remove(service: string): void;
  services(): string[];
  failWrites(on: boolean): void;
}

/** Undo securityQuote for one `security -i` line: words split on spaces, "..." with \ escapes. */
const SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_SECRETS_DIR || path.join(__dirname, "..", "fake-secrets");
const file = (s) => path.join(dir, encodeURIComponent(s));
const cli = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
const failing = () => fs.existsSync(path.join(dir, ".fail-writes"));
function words(line) {
  const out = []; let i = 0;
  while (i < line.length) {
    if (line[i] === " ") { i++; continue; }
    let w = "";
    if (line[i] === '"') { i++; while (i < line.length && line[i] !== '"') { if (line[i] === "\\\\") i++; w += line[i++]; } i++; }
    else { while (i < line.length && line[i] !== " ") w += line[i++]; }
    out.push(w);
  }
  return out;
}
function flag(list, f) { const i = list.indexOf(f); return i >= 0 ? list[i + 1] : undefined; }
if (cli === "security") {
  const cmd = args[0];
  if (cmd === "-i") {
    const line = stdin().replace(/\\n$/, "");
    const w = words(line);
    if (w[0] !== "add-generic-password") process.exit(1);
    if (failing()) { process.stderr.write("security: write refused (fake)\\n"); process.exit(1); }
    fs.writeFileSync(file(flag(w, "-s")), flag(w, "-w"));
    process.exit(0);
  }
  const s = flag(args, "-s");
  if (cmd === "find-generic-password") {
    if (!fs.existsSync(file(s))) { process.stderr.write("security: The specified item could not be found in the keychain.\\n"); process.exit(44); }
    if (args.includes("-w")) process.stdout.write(fs.readFileSync(file(s), "utf8") + "\\n");
    process.exit(0);
  }
  if (cmd === "delete-generic-password") {
    if (!fs.existsSync(file(s))) process.exit(44);
    fs.rmSync(file(s)); process.exit(0);
  }
  process.exit(1);
}
const cmd = args[0];
const rest = args.slice(cmd === "store" ? 2 : 1);
if (rest[0] !== "service" || rest[1] !== "turno" || rest[2] !== "account") { process.stderr.write("bad attributes\\n"); process.exit(2); }
const s = rest[3];
if (cmd === "store") {
  const value = stdin();
  if (failing()) { process.stderr.write("secret-tool: write refused (fake)\\n"); process.exit(1); }
  fs.writeFileSync(file(s), value); process.exit(0);
}
if (cmd === "lookup") { if (!fs.existsSync(file(s))) process.exit(1); process.stdout.write(fs.readFileSync(file(s), "utf8")); process.exit(0); }
if (cmd === "clear") { fs.rmSync(file(s), { force: true }); process.exit(0); }
process.exit(1);
`;

/** Sets (value on stdin) or gets one item through turno-core's DPAPI store, in a child process so the helper stays synchronous. */
const DPAPI_SCRIPT = `
const { secretStore } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("turno-core/secrets")).href)});
const store = secretStore(process.env, "win32");
const name = process.env.TURNO_TEST_ITEM;
if (process.env.TURNO_TEST_OP === "set") {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  await store.set(name, Buffer.concat(chunks).toString("utf8"));
} else process.stdout.write(JSON.stringify((await store.get(name)) ?? null));
`;

function windowsStore(sb: Sandbox): FakeSecretStore {
  const dir = dpapiDir(sb.env);
  const call = (op: "get" | "set", service: string, value = "") =>
    execFileSync(process.execPath, ["--input-type=module", "-e", DPAPI_SCRIPT], {
      env: { ...sb.env, TURNO_TEST_OP: op, TURNO_TEST_ITEM: service },
      input: value,
      encoding: "utf8",
      windowsHide: true,
    });
  return {
    dir,
    read: (s) => (JSON.parse(call("get", s)) as string | null) ?? undefined,
    write: (s, v) => void call("set", s, v),
    remove: (s) => rmSync(join(dir, dpapiFileName(s))),
    services: () =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { name: string }).name)
        : [],
    // A file where the folder should be: every write fails, as with a locked Keychain.
    failWrites(on) {
      const aside = `${dir}.aside`;
      if (on) {
        if (existsSync(dir)) renameSync(dir, aside);
        mkdirSync(join(dir, ".."), { recursive: true });
        writeFileSync(dir, "");
      } else {
        rmSync(dir, { force: true });
        if (existsSync(aside)) renameSync(aside, dir);
      }
    },
  };
}

export function fakeSecretStore(sb: Sandbox): FakeSecretStore {
  if (process.platform === "win32") return windowsStore(sb);
  const bin = join(sb.home, "fakebin");
  const dir = join(sb.home, "fake-secrets");
  mkdirSync(bin, { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const name of ["security", "secret-tool"]) {
    const f = join(bin, name);
    writeFileSync(f, `#!${process.execPath}\n${SCRIPT}`);
    chmodSync(f, 0o755);
  }
  if (!sb.env.PATH?.startsWith(bin)) sb.env.PATH = `${bin}:${sb.env.PATH ?? ""}`;
  const file = (s: string) => join(dir, encodeURIComponent(s));
  return {
    dir,
    read: (s) => (existsSync(file(s)) ? readFileSync(file(s), "utf8") : undefined),
    write: (s, v) => writeFileSync(file(s), v),
    remove: (s) => rmSync(file(s)),
    services: () =>
      readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map(decodeURIComponent),
    failWrites(on) {
      const flagFile = join(dir, ".fail-writes");
      if (on) writeFileSync(flagFile, "");
      else rmSync(flagFile, { force: true });
    },
  };
}
