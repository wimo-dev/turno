import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "patchright-core";
import { replaceFileSync } from "turno-core/paths";
import { identityStateDir } from "./ids.js";
import type { HealthCheck } from "./settings.js";

/**
 * The health check turno finds by itself after a sign-in by hand (`turno-browser login`): while
 * the person browses, every page that loads is searched for a sign-out link or form, which only
 * a signed-in page has. The last page that had one becomes the identity's check (its URL and
 * that selector), kept in the identity's state folder, never in identity.json: the person's own
 * `health` wins over it, and `health: false` turns it off (`defaults.ts`).
 *
 * A found check is a guess, so it only informs: when it fails, `show` and `status` say the
 * identity may need a new sign-in, but the server does not refuse to start as it does for a
 * check the person wrote.
 */

/** A sign-out link or form: what a page shows only to a signed-in user. */
const SIGNED_IN_SELECTOR = ["logout", "log-out", "log_out", "signout", "sign-out", "sign_out"]
  .flatMap((word) => [`a[href*="${word}" i]`, `form[action*="${word}" i]`])
  .join(", ");

function detectedHealthPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "health-detected.json");
}

/** The check the last `login` found; undefined when it found none or the file is unreadable. */
export function readDetectedHealth(id: string, env: NodeJS.ProcessEnv = process.env): HealthCheck | undefined {
  try {
    const v = JSON.parse(readFileSync(detectedHealthPath(id, env), "utf8")) as Partial<HealthCheck>;
    if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url) || typeof v.selector !== "string") return undefined;
    return { url: v.url, selector: v.selector };
  } catch {
    return undefined;
  }
}

export function writeDetectedHealth(id: string, env: NodeJS.ProcessEnv, check: HealthCheck): void {
  const file = detectedHealthPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ url: check.url, selector: check.selector }, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, file);
}

/** The page's URL without query or fragment, when it is http or https. */
function pageUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? `${url.origin}${url.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

/** A health check for this page when it shows a sign-out link or form; undefined otherwise. */
export async function signedInCheck(page: Pick<Page, "url" | "locator">): Promise<HealthCheck | undefined> {
  const url = pageUrl(page.url());
  if (!url) return undefined;
  const found = await page
    .locator(SIGNED_IN_SELECTOR)
    .count()
    .catch(() => 0);
  return found > 0 ? { url, selector: SIGNED_IN_SELECTOR } : undefined;
}
