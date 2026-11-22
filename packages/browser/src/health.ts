import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import { identityStateDir } from "./ids.js";
import type { HealthCheck } from "./settings.js";
import { names } from "./names.js";

/**
 * Session health: whether an identity is still signed in where it matters. The check
 * in identity.json is a URL plus a text or selector that only a signed-in page shows, as in
 * agent-browser's `--restore-check-text` and Kernel's health checks. The host runs it in the
 * identity's own browser when it launches Chrome (at most every 30 minutes while it passes); a
 * page without the proof marks the identity NEEDS_AUTH, every tool call then fails with a
 * message that tells the user to sign in again (`turno browser login <id>`), and
 * `turno browser doctor` shows it. A page that does not load is an error, not NEEDS_AUTH.
 *
 * The result is kept in `<state>/browser/identities/<id>/health.json`; a login clears it.
 */

type HealthStatus = "ok" | "needs_auth" | "error";

export interface HealthRecord {
  status: HealthStatus;
  url: string;
  checkedAt: string;
  /** Why it is not ok. */
  detail?: string;
}

/** A passing check is trusted this long before the next launch checks again. */
const HEALTH_TTL_MS = 30 * 60_000;
/** After NEEDS_AUTH, calls fail without launching Chrome for this long (no window per call). */
export const NEEDS_AUTH_HOLD_MS = 60_000;

export function healthPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "health.json");
}

export function readHealth(id: string, env: NodeJS.ProcessEnv = process.env): HealthRecord | undefined {
  try {
    const v = JSON.parse(readFileSync(healthPath(id, env), "utf8")) as Partial<HealthRecord>;
    if (
      (v.status === "ok" || v.status === "needs_auth" || v.status === "error") &&
      typeof v.url === "string" &&
      typeof v.checkedAt === "string"
    )
      return v as HealthRecord;
  } catch {
    /* none, or not a record */
  }
  return undefined;
}

export function writeHealth(id: string, env: NodeJS.ProcessEnv, record: HealthRecord): void {
  const file = healthPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, file);
}

/** Forget the last result (after a login), so the next launch checks again. */
export function clearHealth(id: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(healthPath(id, env), { force: true });
}

/** Whether a launch should run the check: no result, a failure, another URL, or an old pass. */
export function healthDue(record: HealthRecord | undefined, check: HealthCheck, now: Date = new Date()): boolean {
  if (!record || record.status !== "ok" || record.url !== check.url) return true;
  return now.getTime() - Date.parse(record.checkedAt) > HEALTH_TTL_MS;
}

/** The tool error for an identity that is not signed in. Written for the agent to relay. */
export function needsAuthMessage(id: string, record: HealthRecord): string {
  return (
    `NEEDS_AUTH: browser identity "${id}" is not signed in: ${record.detail ?? "the check failed"} at ${record.url} (checked ${record.checkedAt}). ` +
    `Ask the user to run \`${names().browser} login ${id}\`, sign in and close the window, then call this tool again.`
  );
}

interface LocatorLike {
  first(): LocatorLike;
  waitFor(options: { state: "visible" | "attached"; timeout: number }): Promise<void>;
}

interface PageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  getByText(text: string): LocatorLike;
  locator(selector: string): LocatorLike;
  close(): Promise<void>;
}

/** The part of a Playwright BrowserContext the check uses. */
export interface HealthContext {
  newPage(): Promise<PageLike>;
}

export interface HealthOptions {
  navigationTimeoutMs?: number;
  /** How long the proof may take to show after the page loaded. */
  waitMs?: number;
  now?: () => Date;
}

const firstLine = (e: unknown) => String((e as Error).message ?? e).split("\n")[0]!;

/** Runs the check in a new tab of the identity's browser and closes the tab. */
export async function runHealthCheck(
  context: HealthContext,
  check: HealthCheck,
  opts: HealthOptions = {},
): Promise<HealthRecord> {
  const now = opts.now ?? (() => new Date());
  const done = (status: HealthStatus, detail?: string): HealthRecord => ({
    status,
    url: check.url,
    checkedAt: now().toISOString(),
    ...(detail ? { detail } : {}),
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: opts.navigationTimeoutMs ?? 20_000 });
    } catch (err) {
      return done("error", `could not load the page: ${firstLine(err)}`);
    }
    const waitMs = opts.waitMs ?? 10_000;
    const proofs: [LocatorLike, "visible" | "attached", string][] = [];
    if (check.text) proofs.push([page.getByText(check.text), "visible", `the page did not show "${check.text}"`]);
    if (check.selector) proofs.push([page.locator(check.selector), "attached", `no element matched ${check.selector}`]);
    for (const [locator, state, missing] of proofs) {
      try {
        await locator.first().waitFor({ state, timeout: waitMs });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") return done("needs_auth", missing);
        return done("error", firstLine(err));
      }
    }
    return done("ok");
  } finally {
    await page.close().catch(() => {});
  }
}
