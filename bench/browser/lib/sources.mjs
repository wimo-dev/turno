// The detector pages the reputation bench serves itself, on 127.0.0.1: rebrowser-bot-detector
// and CreepJS (both MIT, from their GitHub repositories) and BotD (MIT, from npm through
// jsDelivr). Each file is pinned to a commit or a release and to its SHA-256, downloaded once
// into a cache folder, and refused when its hash differs, so a run always serves the same code
// and a changed upstream file never runs unnoticed. Only the download touches the network; the
// browsers under test then load everything from the bench's own server.
//
// To move to a newer upstream version: change the commit or version, run the bench once with
// --update-sources, and paste the hashes it prints.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache");

const REBROWSER = "55fa59b9da0610563d896aa956f145ef00431a6b";
const CREEPJS = "10aa6724cd33a1015db1574211890518cd04f0cc";
const BOTD = "2.0.0";

const github = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;

/** Every pinned source: where it comes from, where it goes in the cache, and its SHA-256. */
export const SOURCES = {
  rebrowser: {
    origin: `github.com/rebrowser/rebrowser-bot-detector@${REBROWSER.slice(0, 12)}`,
    license: "MIT",
    files: [
      ["index.html", "7f1a5310db9f9ac5dab0c516fc0472b9dbc740b839038f82ecb19af3a6834048"],
      ["index.js", "cd60904619d05fb6fa9a3f73a748493a50d2ea1d820b492688cf7d75d3a9e0a5"],
      ["index.css", "42564c14aba24beda5f28e18f44fdd9289b69cd46e49655605fac8ea2bcf0087"],
      ["aba/mid/index.html", "44f9d053ed874ff7b6fbf7b6868b2396885b4b42b9d1f466a109a8a5215c1340"],
      ["aba/leaf/index.html", "1a7737500ce30276b1ac670d8a50403edb64594902f4764ecbb181fb6e84cd49"],
    ].map(([path, sha256]) => ({
      path,
      sha256,
      url: github("rebrowser/rebrowser-bot-detector", REBROWSER, path),
    })),
  },
  creepjs: {
    origin: `github.com/abrahamjuliot/creepjs@${CREEPJS.slice(0, 12)}`,
    license: "MIT",
    files: [
      ["index.html", "e59328901b58f9cd77776a282a9de8c01aa57e4ea36b3e94283050807ae28b59"],
      ["creep.js", "80f43f364bd973bc03cb5b82de033ce28b2bbb145cb04237632a46ef040a92be"],
      ["style.min.css", "6756a37800b6050c73d799a5099da121b3498d75ed01577d84f3e182e105cbd3"],
    ].map(([path, sha256]) => ({ path, sha256, url: github("abrahamjuliot/creepjs", CREEPJS, `docs/${path}`) })),
  },
  botd: {
    origin: `npm @fingerprintjs/botd@${BOTD}`,
    license: "MIT",
    files: [
      {
        path: "botd.esm.js",
        sha256: "f438ed251dc7414ece9d4a2b6941441ad9ffae1a1905817f5f0c7366e701dd86",
        url: `https://cdn.jsdelivr.net/npm/@fingerprintjs/botd@${BOTD}/dist/botd.esm.js`,
      },
    ],
  },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Throws unless `buf` has the pinned hash: a changed upstream file is never served. */
export function verified(file, buf) {
  const got = sha256(buf);
  if (got !== file.sha256)
    throw new Error(`${file.url} has SHA-256 ${got}, expected ${file.sha256}; refusing to serve it`);
  return buf;
}

/**
 * The files of every source, read from the cache and downloaded when missing. Returns a map from
 * source id to a map of relative path to contents. With `update`, nothing is verified: the files
 * are downloaded again and their hashes printed, for moving a pin.
 */
export async function loadSources({ cache = DEFAULT_CACHE, update = false, log = () => undefined } = {}) {
  const out = {};
  for (const [id, source] of Object.entries(SOURCES)) {
    const files = new Map();
    for (const file of source.files) {
      const local = join(cache, id, file.path);
      let buf = !update && existsSync(local) ? readFileSync(local) : undefined;
      if (!buf) {
        log(`sources: downloading ${file.url}`);
        const res = await fetch(file.url);
        if (!res.ok) throw new Error(`${file.url}: ${res.status} ${res.statusText}`);
        buf = Buffer.from(await res.arrayBuffer());
        if (update) log(`sources: ${id} ${file.path} ${sha256(buf)}`);
        else verified(file, buf);
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(`${local}.part`, buf);
        renameSync(`${local}.part`, local);
      } else {
        verified(file, buf);
      }
      files.set(file.path, buf);
    }
    out[id] = files;
  }
  return out;
}
