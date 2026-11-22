#!/usr/bin/env node
// Builds the standalone turno-browser executables: one file per platform that runs without Node
// or npm installed. Each is a Node.js single executable application (SEA) whose assets are the
// npm package of turno-browser, installed with its shrinkwrap, served from a read-only virtual
// file system inside the executable (useVfs, Node.js 26.9 or newer).
//   node scripts/standalone-build.mjs --from <version|tarball folder> --out <dir> [--targets a,b]
// --from takes a published version (installed from registry.npmjs.org, so the executable holds
// exactly what npm users get) or a folder of packed workspace tarballs (served by
// scripts/local-registry.mjs, for a pull request). Targets: darwin-arm64, darwin-x64, linux-x64,
// win-x64 (default: all). Every target is built on the host running this script with the Node.js
// release pinned in standalone-node.json, whose archives are checked against their SHA-256
// before use. The macOS executables are stripped of local symbols and signed ad hoc (Apple
// Silicon runs no unsigned code), so those two targets need a macOS host.
// Writes <out>/turno-browser-<target>.zip (the executable, its license files and Node.js's)
// and <out>/SHA256SUMS.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ZipEntry, ZipFile, createZipArchive } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, "standalone-node.json"), "utf8"));
// Fixed entry times, so the same inputs give the same archives.
const MODIFIED = new Date("2000-01-01T00:00:00Z");

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    out: { type: "string" },
    targets: { type: "string", default: Object.keys(pin.targets).join(",") },
  },
});
if (!values.from || !values.out) {
  console.error("usage: node scripts/standalone-build.mjs --from <version|tarball folder> --out <dir> [--targets a,b]");
  process.exit(2);
}
const targets = values.targets.split(",").filter(Boolean);
for (const t of targets) if (!pin.targets[t]) fail(`unknown target ${t} (${Object.keys(pin.targets).join(", ")})`);
// A SEA blob only loads in the Node.js release that wrote it.
if (process.version !== `v${pin.version}`) fail(`run this with Node.js ${pin.version} (this is ${process.version})`);
if (process.platform !== "darwin" && targets.some((t) => t.startsWith("darwin")))
  fail("the macOS targets need a macOS host: their executables are signed with codesign");

const out = resolve(values.out);
const work = join(tmpdir(), `turno-standalone-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });
try {
  const stage = await stagePackage(values.from, join(work, "stage"));
  const version = JSON.parse(readFileSync(join(stage, "node_modules/turno-browser/package.json"), "utf8")).version;
  console.log(`turno-browser ${version}, Node.js ${pin.version}`);
  const payload = join(work, "payload.zip");
  await writePayload(stage, payload);
  const files = [];
  for (const target of targets) files.push(await buildTarget(target, stage, payload, version));
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${sha256(readFileSync(f))}  ${basename(f)}\n`).join(""));
  for (const f of [...files, join(out, "SHA256SUMS")]) console.log(`${basename(f)}  ${statSync(f).size} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

function fail(message) {
  console.error(`standalone-build: ${message}`);
  process.exit(1);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
}

/** npm installs turno-browser into `dir` as a user's install would: its shrinkwrap, no scripts, no dev deps. */
async function stagePackage(from, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
  const npm = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
  if (!existsSync(from)) {
    run("npm", [...npm, `turno-browser@${from}`], { cwd: dir });
    return dir;
  }
  // Packed workspace tarballs: turno-core may not be on npm yet, so a local registry serves them.
  const folder = resolve(from);
  const tarball = readdirSync(folder).find((n) => /^turno-browser-\d.*\.tgz$/.test(n));
  if (!tarball) fail(`no turno-browser-<version>.tgz in ${folder}`);
  const registry = spawn(process.execPath, [join(here, "local-registry.mjs"), folder], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const url = await new Promise((ok, ko) => {
      registry.stdout.once("data", (d) => ok(String(d).trim()));
      registry.once("exit", (code) => ko(new Error(`the local registry exited (${code})`)));
    });
    run("npm", [...npm, "--registry", url, join(folder, tarball)], { cwd: dir });
  } finally {
    registry.kill();
  }
  return dir;
}

/** Every regular file under `dir`, as paths relative to it with forward slashes. */
function walk(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path, base));
    else if (entry.isFile()) found.push(relative(base, path).split(sep).join("/"));
  }
  return found.sort();
}

async function writeZip(file, entries) {
  await pipeline(createZipArchive(entries), createWriteStream(file));
}

/**
 * The virtual file system: the launcher at the root and node_modules next to it. Entries are
 * stored, not deflated: the executable starts faster, and the release archive compresses them.
 * The .bin links and npm's own bookkeeping are left out.
 */
async function writePayload(stage, file) {
  const names = walk(join(stage, "node_modules"))
    .filter((n) => !n.startsWith(".") && !n.includes("/.bin/") && !n.endsWith("/.package-lock.json"))
    .map((n) => `node_modules/${n}`);
  const entries = [];
  for (const name of names) {
    const data = readFileSync(join(stage, name));
    entries.push(await ZipEntry.create(name, data, { method: "store", modified: MODIFIED }));
  }
  await writeZip(file, entries);
  console.log(`payload: ${names.length} files`);
}

/** The pinned Node.js archive for `target`, downloaded once and checked against its SHA-256. */
async function nodeArchive(target) {
  const { archive, sha256: want } = pin.targets[target];
  const cache = join(tmpdir(), "turno-standalone-node");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, archive);
  if (!existsSync(file) || sha256(readFileSync(file)) !== want) {
    const url = `https://nodejs.org/dist/v${pin.version}/${archive}`;
    const res = await fetch(url);
    if (!res.ok) fail(`${url}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(readFileSync(file));
  if (got !== want) fail(`${archive}: SHA-256 ${got}, expected ${want}`);
  return file;
}

/** The node executable and LICENSE of the archive, extracted into `dir`. */
async function extractNode(target, dir) {
  const archive = await nodeArchive(target);
  const top = basename(archive).replace(/\.(tar\.gz|zip)$/, "");
  const exe = target.startsWith("win") ? "node.exe" : "node";
  mkdirSync(dir, { recursive: true });
  if (archive.endsWith(".zip")) {
    const zip = await ZipFile.open(archive);
    try {
      for (const [name, to] of [
        [`${top}/${exe}`, exe],
        [`${top}/LICENSE`, "LICENSE"],
      ]) {
        const entry = await zip.get(name);
        if (!entry) fail(`${archive} has no ${name}`);
        writeFileSync(join(dir, to), await entry.content());
      }
    } finally {
      await zip.close();
    }
  } else {
    run("tar", ["-xzf", archive, "-C", dir, "--strip-components", "1", `${top}/bin/node`, `${top}/LICENSE`]);
    copyFileSync(join(dir, "bin", "node"), join(dir, exe));
  }
  return { exe: join(dir, exe), license: join(dir, "LICENSE") };
}

/** Builds one target and packs it as <out>/turno-browser-<target>.zip. */
async function buildTarget(target, stage, payload, version) {
  const dir = join(work, target);
  const node = await extractNode(target, join(dir, "node"));
  const windows = target.startsWith("win");
  const darwin = target.startsWith("darwin");
  if (darwin) run("strip", ["-x", node.exe]);
  const name = windows ? "turno-browser.exe" : "turno-browser";
  const exe = join(dir, name);
  const config = join(dir, "sea-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      main: join(here, "standalone-launcher.mjs"),
      mainFormat: "module",
      executable: node.exe,
      output: exe,
      useVfs: true,
      vfsArchive: payload,
      disableExperimentalSEAWarning: true,
    }),
  );
  run(process.execPath, ["--build-sea", config]);
  if (darwin) run("codesign", ["--force", "--sign", "-", exe]);
  const pkg = join(stage, "node_modules/turno-browser");
  const zip = join(out, `turno-browser-${target}.zip`);
  const entries = [
    await ZipEntry.create(name, readFileSync(exe), { mode: 0o755, modified: MODIFIED }),
    await ZipEntry.create("LICENSE", readFileSync(join(pkg, "LICENSE")), { modified: MODIFIED }),
    await ZipEntry.create("NOTICE", readFileSync(join(pkg, "NOTICE")), { modified: MODIFIED }),
    await ZipEntry.create("LICENSE.node.txt", readFileSync(node.license), { modified: MODIFIED }),
  ];
  await writeZip(zip, entries);
  console.log(`${target}: turno-browser ${version}, ${statSync(exe).size} bytes unpacked`);
  return zip;
}
