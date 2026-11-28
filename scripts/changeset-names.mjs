#!/usr/bin/env node
// Fails when a changeset names a package that is not in the workspace. The release workflow's
// `changeset version` stops on such a file, so no version pull request opens until it is fixed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const names = new Set(
  readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      try {
        return [JSON.parse(readFileSync(join(root, "packages", d.name, "package.json"), "utf8")).name];
      } catch {
        return [];
      }
    }),
);
const dir = join(root, ".changeset");
const bad = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
  const front = readFileSync(join(dir, file), "utf8").match(/^---\n([\s\S]*?)\n---/);
  for (const line of front ? front[1].split("\n") : []) {
    const m = line.match(/^["']?([^"':]+)["']?\s*:/);
    if (m && !names.has(m[1])) bad.push(`${file}: "${m[1]}" is not a workspace package`);
  }
}
if (bad.length) {
  console.error(`changesets name unknown packages (known: ${[...names].join(", ")}):\n${bad.join("\n")}`);
  process.exit(1);
}
