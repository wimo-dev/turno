import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileSync } from "turno-core/paths";
import { identityBrowserLaunch } from "./browsers.js";
import { clearHealth } from "./health.js";
import { identityStateDir } from "./ids.js";
import { IdentityError, identityDir, inUseBy, isInUse } from "./identities.js";
import { startedChromePid } from "./lifecycle.js";
import { CHROME_PROXY_ARGS, resolveProxy } from "./network.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { chromeEnv, keychainArgs, launchSettings, readIdentitySettings, systemTimezone } from "./settings.js";
import { names } from "./names.js";
import { type UiLocale, fill, uiLocale, uiStrings } from "./ui-strings.js";
import type { Page } from "patchright-core";

export interface LoginOptions {
  env?: NodeJS.ProcessEnv;
  /** Page to open first (default: a short page that says what to do). */
  url?: string;
}

/** What a login did: the sites the person opened in the window, by host name. */
export interface LoginResult {
  sites: string[];
}

/** The last login of an identity: when it ended and the sites opened in it. */
export interface LoginRecord {
  at: string;
  sites: string[];
}

function loginRecordPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(identityStateDir(id, env), "login.json");
}

/** The last login, or undefined when the identity was never signed in by hand (or before this was kept). */
export function readLoginRecord(id: string, env: NodeJS.ProcessEnv = process.env): LoginRecord | undefined {
  try {
    const v = JSON.parse(readFileSync(loginRecordPath(id, env), "utf8")) as Partial<LoginRecord>;
    if (typeof v.at === "string" && Array.isArray(v.sites)) return { at: v.at, sites: v.sites.map(String) };
  } catch {
    /* none */
  }
  return undefined;
}

/**
 * Whether the profile holds cookies at all: a profile signed in before turno-browser kept a
 * login record has no record but has cookies, and is not "never signed in".
 */
export function profileHasCookies(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = identityDir(id, env);
  return ["Default/Cookies", "Default/Network/Cookies"].some((f) => existsSync(join(dir, f)));
}

function writeLoginRecord(id: string, env: NodeJS.ProcessEnv, record: LoginRecord): void {
  const file = loginRecordPath(id, env);
  mkdirSync(identityStateDir(id, env), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  replaceFileSync(tmp, file);
}

/** The host of a page the person opened, without "www."; undefined for blank and internal pages. */
export function siteOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
}

/**
 * The page a login opens without --url: what this window is and what to do in it, in the
 * identity's language (`ui-strings.ts`). Works offline.
 */
export function welcomePage(id: string, loginCommand = names().identity("login", id), locale: UiLocale = "en"): string {
  const name = escapeHtml(id);
  const t = uiStrings(locale).welcome;
  const command = `<code>${escapeHtml(loginCommand)} --url https://mail.example.com</code>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${fill(escapeHtml(t.title), { id: name })}</title>
<style>
:root{color-scheme:light dark;--fg:#111;--muted:#555;--bg:#fff;--line:#ddd;--accent:#2b55e6}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#141414;--line:#333;--accent:#7d9bff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:560px;margin:12vh auto;padding:0 24px}
.tag{font:12px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-size:28px;line-height:1.2;margin:8px 0 16px}
code{font:14px ui-monospace,Menlo,monospace;color:var(--accent)}
ol{padding-left:20px}li{margin:8px 0}
p.note{color:var(--muted);border-top:1px solid var(--line);padding-top:16px;margin-top:28px;font-size:14px}
</style></head><body><main>
<div class="tag">turno-browser &middot; ${escapeHtml(t.identity)} <code>${name}</code></div>
<h1>${escapeHtml(t.heading)}</h1>
<ol>
${t.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("\n")}
</ol>
<p class="note">${fill(escapeHtml(t.next), { command })}</p>
</main></body></html>`;
}

/**
 * Opens the identity's persistent Chrome headed, with the same launch settings as the MCP
 * server (Chrome channel, no fixed viewport, the identity's languages and time zone), and
 * resolves when the user closes the last window or quits Chrome. Used once per site so the user
 * signs in by hand. It holds the identity's runtime lock while the window is open, and clears
 * the last session health result, so the next launch checks the sign-in again.
 *
 * With identity.json `proxy`, the sign-in goes through the same proxy as the agent's sessions,
 * so the site sees one network for both. A Camoufox identity is refused: it keeps its own profile.
 */
export async function loginIdentity(id: string, options: LoginOptions = {}): Promise<LoginResult> {
  const env = options.env ?? process.env;
  const dir = identityDir(id, env);
  const holder = inUseBy(id, env);
  if (holder) throw new IdentityError(holder);
  if (isInUse(id, env))
    throw new IdentityError(`identity "${id}" is in use (an MCP session holds its Chrome); close it first`);
  const settings = readIdentitySettings(id, env);
  if (settings?.engine === "camoufox" && settings.attach === undefined)
    throw new IdentityError(
      `identity "${id}" runs on Camoufox, which keeps its own profile, and \`${names().browser} login\` opens the Chrome profile: sign in from an agent session (browser_login with the vault), or use --engine chrome`,
    );
  // Read before the lock, so a missing secret leaves nothing to undo; the value goes only to Chrome.
  const proxy = settings?.proxy ? await resolveProxy(settings.proxy, env, () => {}) : undefined;
  const held = acquireRuntimeLock(id, env, { holder: "login" });
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const applied = launchSettings(settings, [], systemTimezone());
    const { chromium } = await import("patchright-core");
    const ctx = await chromium.launchPersistentContext(dir, {
      ...identityBrowserLaunch(settings, env, names().browser),
      headless: false,
      viewport: null,
      ...(applied.args.length || proxy ? { args: [...applied.args, ...(proxy ? CHROME_PROXY_ARGS : [])] } : {}),
      ...(proxy ? { proxy } : {}),
      ...(applied.timezoneId ? { timezoneId: applied.timezoneId } : {}),
      ...keychainArgs(settings),
      // Chrome gets the caller's environment (HOME, XDG dirs), not this process's.
      env: chromeEnv(env),
    });
    const sites = new Set<string>();
    const pid = startedChromePid(dir);
    if (pid !== undefined) held.update({ chromePid: pid, pgid: pid });
    const closed = new Promise<void>((resolve) => ctx.on("close", () => resolve()));
    // On macOS Chrome keeps running with no windows, so treat "last page closed" as done.
    const watch = (page: Page) => {
      // The sites the person opens, from the main frame of each tab: what the summary names.
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const site = siteOf(frame.url());
        if (site) sites.add(site);
      });
      page.on("close", () => {
        setTimeout(() => {
          if (ctx.pages().length === 0) void ctx.close().catch(() => undefined);
        }, 250);
      });
    };
    ctx.pages().forEach(watch);
    ctx.on("page", watch);
    const stop = () => void ctx.close().catch(() => undefined);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      if (options.url) await page.goto(options.url).catch(() => undefined);
      else await page.setContent(welcomePage(id, undefined, uiLocale(settings))).catch(() => undefined);
      await closed;
      clearHealth(id, env);
      const result = { sites: [...sites].sort() };
      writeLoginRecord(id, env, { at: new Date().toISOString(), sites: result.sites });
      return result;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    held.release();
  }
}
