#!/usr/bin/env node
// Writes npm-shrinkwrap.json for a published package, so `npm install --global` and Homebrew
// install exactly the dependency tree that pnpm installed and CI tested.
//   node scripts/shrinkwrap.mjs <package dir>...          write <dir>/npm-shrinkwrap.json
//   node scripts/shrinkwrap.mjs --check <package dir>...  exit 1 if a file is missing or stale
// Offline: versions come from the pnpm install (node_modules), integrity from pnpm-lock.yaml.
// The layout is npm's: every package as high as it fits, nested only on a version conflict.
// A dependency on another package of this workspace (`workspace:*`) is published as
// its exact version, the way pnpm pack writes it; its entry has no integrity, because the
// tarball of a sibling released in the same run does not exist yet when this file is written.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
export const FILE = "npm-shrinkwrap.json";
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const keyOf = (name, version) => `${name}@${version}`;

/** Integrity of every `name@version` in a pnpm lockfile (v9 text, both documents). */
export function lockIntegrity(text) {
  const out = new Map();
  const re = /^ {2}'?((?:@[^@'\s/]+\/)?[^@'\s/]+@[^'\s:]+)'?:\n {4}resolution: \{integrity: ([^,}\s]+)/gm;
  // A Windows checkout can turn the lockfile's line endings into CRLF.
  for (const m of text.replaceAll("\r\n", "\n").matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Lifecycle scripts npm would run when installing this package (binding.gyp implies one). */
export function installScripts(manifest, dir) {
  const found = INSTALL_SCRIPTS.filter((s) => manifest.scripts?.[s]);
  if (!found.length && dir && existsSync(join(dir, "binding.gyp"))) found.push("install (binding.gyp)");
  return found;
}

/** The packages of the workspace above `from` (`packages/*`): name -> version. Empty outside one. */
export function workspaceVersions(from) {
  const out = new Map();
  let root;
  try {
    root = workspaceRoot(from);
  } catch {
    return out;
  }
  const dir = join(root, "packages");
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const file = join(dir, name, "package.json");
    if (!existsSync(file)) continue;
    const m = readJson(file);
    out.set(m.name, m.version);
  }
  return out;
}

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/**
 * The manifest as pnpm publishes it: `workspace:*` becomes the sibling's exact version,
 * `workspace:^` and `workspace:~` a range on it, `workspace:<spec>` the spec itself.
 */
export function publishedManifest(manifest, versions) {
  const out = { ...manifest };
  for (const f of DEP_FIELDS) {
    if (!manifest[f]) continue;
    out[f] = Object.fromEntries(
      Object.entries(manifest[f]).map(([n, spec]) => {
        if (typeof spec !== "string" || !spec.startsWith("workspace:")) return [n, spec];
        const rest = spec.slice("workspace:".length);
        const version = versions.get(n);
        if (version === undefined)
          throw new Error(`${manifest.name} depends on ${n}@${spec}, which is not a package of this workspace`);
        return [n, rest === "*" ? version : rest === "^" || rest === "~" ? `${rest}${version}` : rest];
      }),
    );
  }
  return out;
}

/** A folder with `/` between its parts, as on Windows it has `\`; the same length, so indexes carry over. */
const slashes = (dir) => dir.replaceAll("\\", "/");

/** Declared edges of a manifest: name -> { spec, optional }. Dev dependencies never count. */
function edgesOf(manifest) {
  const out = new Map();
  for (const [n, spec] of Object.entries(manifest.peerDependencies ?? {})) {
    out.set(n, { spec, optional: Boolean(manifest.peerDependenciesMeta?.[n]?.optional), peer: true });
  }
  for (const [n, spec] of Object.entries(manifest.dependencies ?? {})) out.set(n, { spec, optional: false });
  for (const [n, spec] of Object.entries(manifest.optionalDependencies ?? {})) out.set(n, { spec, optional: true });
  return out;
}

/**
 * Where pnpm put `name` for the package in `dir`: its own node_modules, then the node_modules
 * folder that holds it (pnpm's virtual store links each dependency, peers included, there).
 * Never further up, where pnpm hoists unrelated packages.
 */
function locate(dir, name, isRoot) {
  const candidates = [join(dir, "node_modules", name)];
  if (!isRoot) {
    const i = slashes(dir).lastIndexOf("/node_modules/");
    if (i >= 0) candidates.push(join(dir.slice(0, i), "node_modules", name));
  }
  for (const c of candidates) {
    if (existsSync(join(c, "package.json"))) return realpathSync(c);
  }
  return undefined;
}

/**
 * The installed production tree of the package in `pkgDir`: nodes keyed by name@version, each
 * with its manifest, folder and resolved edges (name -> key).
 */
export function collectGraph(pkgDir, versions = workspaceVersions(pkgDir)) {
  const root = publishedManifest(readJson(join(pkgDir, "package.json")), versions);
  const nodes = new Map();
  const resolveEdges = (dir, manifest, isRoot, who) => {
    const edges = new Map();
    const declared = isRoot
      ? new Map([
          ...Object.entries(manifest.dependencies ?? {}).map(([n, spec]) => [n, { spec, optional: false }]),
          ...Object.entries(manifest.optionalDependencies ?? {}).map(([n, spec]) => [n, { spec, optional: true }]),
        ])
      : edgesOf(manifest);
    for (const [name, edge] of declared) {
      const at = locate(dir, name, isRoot);
      if (!at) {
        if (edge.peer && edge.optional) continue;
        throw new Error(
          `${who} needs ${name}@${edge.spec}, which is not installed here; ` +
            `${edge.optional ? "an optional dependency left out of the shrinkwrap would be resolved by npm at install time" : "run pnpm install"}`,
        );
      }
      const m = readJson(join(at, "package.json"));
      const key = keyOf(m.name, m.version);
      edges.set(name, key);
      if (!nodes.has(key)) {
        // A sibling of the workspace is linked from its own folder, never from a node_modules.
        const workspace = !slashes(at).includes("/node_modules/") && versions.get(m.name) === m.version;
        const node = { key, name: m.name, version: m.version, dir: at, manifest: m, edges: new Map(), workspace };
        nodes.set(key, node);
        node.edges = resolveEdges(at, m, false, key);
      } else if (nodes.get(key).dir !== at) {
        // pnpm can install one version twice with different peers; npm cannot express that.
        const other = nodes.get(key);
        const mine = resolveEdges(at, m, false, key);
        const same = mine.size === other.edges.size && [...mine].every(([n, k]) => other.edges.get(n) === k);
        if (!same)
          throw new Error(
            `${key} is installed with different peer dependencies in two places; npm-shrinkwrap.json cannot express that`,
          );
      }
    }
    return edges;
  };
  const rootEdges = resolveEdges(realpathSync(pkgDir), root, true, root.name);
  return { root, rootEdges, nodes };
}

function ancestors(path) {
  const out = [path];
  while (path) {
    const i = path.lastIndexOf("/node_modules/");
    path = i < 0 ? "" : path.slice(0, i);
    out.push(path);
  }
  return out;
}

const childPath = (parent, name) => (parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`);

/** What Node finds for `name` from the package at `path`, in a tree of placed paths. */
export function resolveIn(placed, path, name) {
  for (const a of ancestors(path)) {
    const p = childPath(a, name);
    if (placed.has(p)) return p;
  }
  return undefined;
}

/**
 * npm's node_modules layout for a graph: breadth first from the root, each dependency at the
 * top level unless a different version is already visible there, then nested under the
 * package that needs it. Returns path -> key, without the root ("").
 */
export function layout(rootEdges, edgesOfKey) {
  const placed = new Map();
  const queue = [{ path: "", edges: rootEdges, depth: 0 }];
  while (queue.length) {
    const { path, edges, depth } = queue.shift();
    if (depth > 64) throw new Error(`dependency chain too deep at ${path}`);
    for (const name of [...edges.keys()].sort()) {
      const key = edges.get(name);
      const found = resolveIn(placed, path, name);
      if (found && placed.get(found) === key) continue;
      const target = found ? childPath(path, name) : childPath("", name);
      if (placed.has(target)) throw new Error(`layout conflict at ${target}`);
      placed.set(target, key);
      queue.push({ path: target, edges: edgesOfKey(key), depth: depth + 1 });
    }
  }
  return placed;
}

function tarballUrl(name, version) {
  return `${REGISTRY}/${name}/-/${basename(name)}-${version}.tgz`;
}

function binOf(manifest) {
  if (!manifest.bin) return undefined;
  if (typeof manifest.bin === "string") return { [basename(manifest.name)]: manifest.bin };
  return manifest.bin;
}

/** Copy the fields npm records for a package in a lockfile, in npm's order. */
function entry(manifest, extra) {
  const e = { ...extra };
  if (manifest.license) e.license = manifest.license;
  for (const f of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (manifest[f] && Object.keys(manifest[f]).length) e[f] = manifest[f];
  }
  const bin = binOf(manifest);
  if (bin) e.bin = bin;
  for (const f of ["engines", "os", "cpu"]) if (manifest[f]) e[f] = manifest[f];
  return e;
}

/** The npm-shrinkwrap.json object of a package (lockfile v3, production dependencies only). */
export function buildShrinkwrap(graph, integrity) {
  const { root, rootEdges, nodes } = graph;
  const placed = layout(rootEdges, (key) => nodes.get(key).edges);
  const rootEntry = { name: root.name, version: root.version };
  if (root.license) rootEntry.license = root.license;
  for (const f of ["dependencies", "optionalDependencies"])
    if (root[f] && Object.keys(root[f]).length) rootEntry[f] = root[f];
  const bin = binOf(root);
  if (bin) rootEntry.bin = bin;
  if (root.engines) rootEntry.engines = root.engines;
  const packages = { "": rootEntry };
  for (const path of [...placed.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
    const node = nodes.get(placed.get(path));
    const hash = integrity.get(node.key);
    if (!hash && !node.workspace) throw new Error(`${node.key} is not in pnpm-lock.yaml; run pnpm install`);
    const extra = {
      version: node.version,
      resolved: tarballUrl(node.name, node.version),
      ...(hash ? { integrity: hash } : {}),
    };
    if (node.name !== basename(path) && !path.endsWith(`/${node.name}`)) extra.name = node.name;
    const e = entry(node.manifest, extra);
    if (installScripts(node.manifest, node.dir).length) e.hasInstallScript = true;
    packages[path] = e;
  }
  return { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages };
}

export function shrinkwrapText(pkgDir, lockText) {
  return `${JSON.stringify(buildShrinkwrap(collectGraph(pkgDir), lockIntegrity(lockText)), null, 2)}\n`;
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Dependencies of a published manifest that are not pinned to one exact version. */
export function inexactDependencies(manifest) {
  const out = [];
  for (const f of DEP_FIELDS) {
    for (const [n, spec] of Object.entries(manifest[f] ?? {})) if (!EXACT.test(spec)) out.push(`${f}.${n}: ${spec}`);
  }
  return out;
}

/**
 * Problems with the shrinkwrap of a package, given its installed graph: missing entries,
 * entries without resolved or integrity, a root that disagrees with package.json, and any
 * package that would run an install script.
 */
export function shrinkwrapProblems(manifest, shrinkwrap, graph) {
  const problems = [];
  const root = shrinkwrap?.packages?.[""];
  if (!root) return ["npm-shrinkwrap.json has no root entry"];
  if (shrinkwrap.lockfileVersion !== 3) problems.push(`lockfileVersion is ${shrinkwrap.lockfileVersion}, expected 3`);
  if (root.name !== manifest.name || root.version !== manifest.version)
    problems.push(`root is ${root.name}@${root.version}, package is ${manifest.name}@${manifest.version}`);
  if (JSON.stringify(root.dependencies ?? {}) !== JSON.stringify(manifest.dependencies ?? {}))
    problems.push("root dependencies differ from package.json");
  const want = new Set([...graph.nodes.keys()]);
  const siblings = new Set([...graph.nodes.values()].filter((n) => n.workspace).map((n) => n.key));
  const have = new Set();
  for (const [path, e] of Object.entries(shrinkwrap.packages)) {
    if (!path) continue;
    const name = e.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const key = keyOf(name, e.version);
    have.add(key);
    if (!e.resolved?.startsWith(`${REGISTRY}/`)) problems.push(`${path}: resolved is not on ${REGISTRY}`);
    if (!siblings.has(key) && !e.integrity?.startsWith("sha512-")) problems.push(`${path}: no sha512 integrity`);
    if (e.hasInstallScript) problems.push(`${path}: has an install script`);
    if (e.dev || e.link) problems.push(`${path}: dev or link entry in a published shrinkwrap`);
  }
  for (const k of want) if (!have.has(k)) problems.push(`${k} is installed but not in npm-shrinkwrap.json`);
  for (const k of have) if (!want.has(k)) problems.push(`${k} is in npm-shrinkwrap.json but not installed`);
  for (const node of graph.nodes.values()) {
    for (const s of installScripts(node.manifest, node.dir)) problems.push(`${node.key} runs an install script (${s})`);
  }
  return problems;
}

/** The workspace root above a package folder (the one with pnpm-lock.yaml). */
export function workspaceRoot(from) {
  let dir = resolve(from);
  while (!existsSync(join(dir, "pnpm-lock.yaml"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`no pnpm-lock.yaml above ${from}`);
    dir = up;
  }
  return dir;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const dirs = args.filter((a) => a !== "--check");
  if (!dirs.length) {
    console.error("usage: shrinkwrap.mjs [--check] <package dir>...");
    process.exit(2);
  }
  let failed = 0;
  for (const dir of dirs) {
    const lock = readFileSync(join(workspaceRoot(dir), "pnpm-lock.yaml"), "utf8");
    const file = join(dir, FILE);
    const text = shrinkwrapText(dir, lock);
    const count = Object.keys(JSON.parse(text).packages).length - 1;
    if (check) {
      const ok = existsSync(file) && !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8") === text;
      if (!ok) {
        failed++;
        console.error(
          `${file} is ${existsSync(file) ? "out of date" : "missing"}; run node scripts/shrinkwrap.mjs ${dir}`,
        );
      }
    } else {
      writeFileSync(file, text);
      console.log(`${FILE}: ${count} packages for ${readJson(join(dir, "package.json")).name}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
