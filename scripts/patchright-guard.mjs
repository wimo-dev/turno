// Fails when the patchright-core turno-browser depends on, the one installed, and the version
// the reputation suite last passed with (VERIFIED_PATCHRIGHT in packages/browser/src/patchright.ts)
// disagree. turno's init scripts rely on internals of patchright-core, so a bump ships only after
// the suite ran on it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const browser = join(import.meta.dirname, "..", "packages", "browser");
const declared = JSON.parse(readFileSync(join(browser, "package.json"), "utf8")).dependencies?.["patchright-core"];
const installed = JSON.parse(
  readFileSync(createRequire(join(browser, "package.json")).resolve("patchright-core/package.json"), "utf8"),
).version;
const source = readFileSync(join(browser, "src", "patchright.ts"), "utf8");
const verified = /VERIFIED_PATCHRIGHT = \{ version: "([^"]+)"/.exec(source)?.[1];

const problems = [];
if (!verified) problems.push("VERIFIED_PATCHRIGHT was not found in packages/browser/src/patchright.ts");
if (declared !== verified)
  problems.push(`packages/browser/package.json pins patchright-core ${declared}, the record says ${verified}`);
if (installed !== declared)
  problems.push(`patchright-core ${installed} is installed, package.json pins ${declared} (run pnpm install)`);
if (problems.length) {
  console.error(
    `patchright-core is not the version the reputation suite last passed with:\n  ${problems.join("\n  ")}\n` +
      "After a bump, run `pnpm build && pnpm bench:reputation` on the new version, check the results against the last ones, then update VERIFIED_PATCHRIGHT.",
  );
  process.exit(1);
}
