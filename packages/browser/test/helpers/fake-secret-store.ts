import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./sandbox.js";

/**
 * A file-backed stand-in for the macOS `security` and libsecret `secret-tool` commands, put
 * first on the sandbox PATH. Items live under `<sandbox>/fake-secrets/`, never in a real
 * Keychain. `failWrites(true)` makes every store fail, like a locked Keychain.
 */
/**
 * Why a test that stores a secret cannot run here: the stand-ins replace the macOS and Linux
 * commands, and Windows' DPAPI store runs Windows PowerShell instead (turno-core tests it with
 * a real round trip). Undefined where the stand-ins work.
 */
export const noFakeSecretStore: string | undefined =
  process.platform === "win32" ? "the stand-ins replace macOS and Linux commands" : undefined;

export interface FakeSecretStore {
  dir: string;
  read(service: string): string | undefined;
  write(service: string, value: string): void;
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

export function fakeSecretStore(sb: Sandbox): FakeSecretStore {
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
