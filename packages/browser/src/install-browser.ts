import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type DetectedBrowser, findBrowser } from "./browsers.js";

/**
 * `turno-browser install-browser`: Chrome for Testing for a machine without a Chromium-based
 * browser, where installing one needs an admin password. It runs the browser installer of the
 * patchright-core this package drives Chrome with (`patchright-core install chromium`), which
 * downloads the build matching that version into the user's cache: ~/Library/Caches/ms-playwright
 * on macOS, ~/.cache/ms-playwright on Linux, or PLAYWRIGHT_BROWSERS_PATH. No admin rights, no
 * system change; about 190 MB to download.
 *
 * It never installs the headless shell (turno runs the full browser headless too) and never
 * removes browsers other Playwright installations put in the same cache (`--no-remove`).
 * Chrome for Testing does not update itself: a newer turno-browser brings a newer build, and
 * running the command again fetches it.
 */

export interface InstallBrowserOptions {
  env?: NodeJS.ProcessEnv;
  /** Print where it would go and from where, download nothing. */
  dryRun?: boolean;
  /** Where the installer's own output goes (progress bars); default this process's stderr. */
  output?: (chunk: string) => void;
}

export interface InstallBrowserResult {
  /** The browser installed, when not a dry run. */
  browser?: DetectedBrowser;
  /** The installer's exit code. */
  code: number;
}

function installerScript(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("patchright-core/package.json")), "cli.js");
}

export async function installBrowser(options: InstallBrowserOptions = {}): Promise<InstallBrowserResult> {
  const env = options.env ?? process.env;
  const out = options.output ?? ((chunk: string) => process.stderr.write(chunk));
  const args = [
    installerScript(),
    "install",
    "--no-shell",
    "--no-remove",
    ...(options.dryRun ? ["--dry-run"] : []),
    "chromium",
  ];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => out(d.toString()));
    child.stderr.on("data", (d: Buffer) => out(d.toString()));
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0 || options.dryRun) return { code };
  const browser = findBrowser("chrome-for-testing", env);
  return browser ? { code, browser } : { code };
}
