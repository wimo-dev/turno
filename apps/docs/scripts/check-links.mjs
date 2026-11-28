#!/usr/bin/env node
// Checks every internal link of the built site: starts `next start`, crawls from the home pages
// of each language, and fails on a link that does not answer 200, on an anchor (#section) that
// is not on the page it points to, and on an image that does not come back as an image (every
// <img>, fetched the way the page asks for it, optimizer included). External links are not
// fetched.
//
//   pnpm build && pnpm links
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4319);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const START = [
  "/",
  "/es",
  "/docs",
  "/es/docs",
  "/releases",
  "/es/releases",
  "/releases/feed.xml",
  "/releases/browser/feed.xml",
  "/releases/cli/feed.xml",
  "/llms.txt",
  "/llms-full.txt",
  "/docs/concepts/gateway.md",
];

if (!existsSync(join(APP, ".next/BUILD_ID"))) {
  console.error("check-links: build the site first: pnpm build");
  process.exit(1);
}

const server = spawn(join(APP, "node_modules/.bin/next"), ["start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: APP, stdio: ["ignore", "pipe", "inherit"] });
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${ORIGIN}/llms.txt`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("next start did not come up");
}

/** path -> { status, ids (anchors on the page), html? } */
const seen = new Map();
/** Every link found: [from, path, hash]. */
const links = [];
/** Every image a page shows: the URL as the page asks for it -> the first page that does. */
const images = new Map();

async function visit(path, from) {
  if (seen.has(path)) return;
  seen.set(path, { status: 0, ids: new Set() });
  const res = await fetch(`${ORIGIN}${path}`, { redirect: "manual" });
  const entry = seen.get(path);
  entry.status = res.status;
  entry.from = from;
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get("location"), ORIGIN);
    entry.redirect = to.pathname;
    if (to.origin === ORIGIN) await visit(to.pathname, from);
    return;
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return;
  const html = await res.text();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) entry.ids.add(m[1]);
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/g)) {
    const src = m[1].replace(/&amp;/g, "&");
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) && !images.has(src)) images.set(src, path);
  }
  const next = [];
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, "&");
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw) || raw.startsWith("/_next/")) continue;
    const url = new URL(raw, `${ORIGIN}${path}`);
    if (url.origin !== ORIGIN) continue;
    links.push([path, url.pathname, decodeURIComponent(url.hash.slice(1))]);
    next.push(url.pathname);
  }
  for (const p of next) await visit(p, path);
}

const resolve = (path) => {
  let e = seen.get(path);
  for (let i = 0; e?.redirect && i < 5; i++) e = seen.get(e.redirect);
  return e;
};

try {
  await waitForServer();
  for (const p of START) await visit(p, "(start)");
  const problems = [];
  for (const [path, e] of seen) {
    const end = resolve(path);
    if (!end || end.status !== 200) problems.push(`${end?.status ?? e.status}  ${path}  (linked from ${e.from})`);
  }
  for (const [from, path, hash] of links) {
    if (!hash) continue;
    const target = resolve(path);
    if (target?.status === 200 && target.ids.size && !target.ids.has(hash)) problems.push(`no #${hash} on ${path}  (linked from ${from})`);
  }
  for (const [src, from] of images) {
    const res = await fetch(new URL(src, ORIGIN));
    const type = res.headers.get("content-type") ?? "";
    const bytes = (await res.arrayBuffer()).byteLength;
    if (!res.ok || !type.startsWith("image/") || bytes === 0) problems.push(`image ${res.status} ${type || "no type"}  ${src}  (shown on ${from})`);
  }
  const unique = [...new Set(problems)].sort();
  if (unique.length) {
    console.error(`check-links: ${unique.length} broken link${unique.length === 1 ? "" : "s"}:`);
    for (const p of unique) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`check-links: ${seen.size} pages and files, ${links.length} links, ${images.size} images, all good`);
  }
} catch (err) {
  console.error(`check-links: ${err.message}`);
  process.exitCode = 1;
} finally {
  stop();
}
