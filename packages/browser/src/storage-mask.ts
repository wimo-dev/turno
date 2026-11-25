import { credentialName } from "./network-redact.js";
import { wordsOf } from "./sensitive.js";

/**
 * Which cookie and web storage values the model never reads. The `storage` capability's tools
 * (cookies, localStorage, sessionStorage, the storage state file) are listed by default, so the
 * values that sign the identity in stay behind a mask: the name, domain, path, expiry and flags
 * of a cookie stay visible, and the agent can still set, delete and clear cookies and items.
 *
 * A value is masked when any of these holds (measured on the cookies of 60 popular sites and the
 * Open Cookie Database; the reasons are in the docs' security page):
 *
 * - the cookie is `HttpOnly`: a page's own scripts cannot read it, and sites set it on the
 *   cookies that carry a session (sign-in, anti-bot clearance, load balancer affinity);
 * - the name reads like a credential: `session`, `sess`, `sid` (`SID`, `HSID`, `__Secure-3PSID`),
 *   `token`, `auth` (`ESTSAUTHPERSISTENT`, `auth_token`, `oauth`), `jwt`, `csrf`, `xsrf`, `login`,
 *   `logged_in`, `remember`, `sso`, `saml`, `oidc`, `secret`, `key`, `sec`, `identity`, and the
 *   names `network-redact.ts` already treats as credentials;
 * - the value holds a run that looks random (`tokenLike`): session identifiers are random by
 *   design (at least 64 bits), so a cookie named like anything at all is still caught when its
 *   value is one. Analytics and advertising identifiers are caught too; that is the side the
 *   rule leans to.
 *
 * Values that stay readable are the short and plain ones: consent flags, a theme, a locale, a
 * currency, a timestamp.
 */

export const MASK = "[masked]";

/** A run of the characters tokens are made of: base64, base64url, hex, a JWT's dots. */
const RUN = /[A-Za-z0-9+/_\-.~=]{16,}/g;

/** Bits a string of these character classes can hold per character. */
function alphabetBits(run: string): { bits: number; classes: number } {
  const lower = /[a-z]/.test(run);
  const upper = /[A-Z]/.test(run);
  const digit = /[0-9]/.test(run);
  const symbol = /[^A-Za-z0-9]/.test(run);
  const size = (lower ? 26 : 0) + (upper ? 26 : 0) + (digit ? 10 : 0) + (symbol ? 4 : 0);
  return { bits: size > 1 ? Math.log2(size) : 0, classes: Number(lower) + Number(upper) + Number(digit) };
}

/** Shannon entropy of the characters of `s`, in bits per character. */
function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * True when `run` looks random: at least 64 bits by its alphabet, characters spread like a
 * random string's (not `aaaa...` or a date), and two of lowercase, uppercase and digits, so long
 * words joined by dashes (`dismissed-onboarding-banner`) stay readable. A run of 20 or more
 * digits counts too (account and device numbers).
 */
function randomRun(run: string): boolean {
  const { bits, classes } = alphabetBits(run);
  if (/^\d{20,}$/.test(run)) return true;
  if (classes < 2) return false;
  if (run.length * bits < 64) return false;
  return shannon(run) >= 3;
}

function decoded(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The runs of `value` that look random, longest first: what a value-wide mask must hide. */
function tokenRuns(value: string): string[] {
  const out = new Set<string>();
  for (const v of new Set([value, decoded(value)])) for (const m of v.matchAll(RUN)) if (randomRun(m[0])) out.add(m[0]);
  return [...out].sort((a, b) => b.length - a.length);
}

/** True when a value holds a run that looks random (a session identifier, a token, a JWT). */
function tokenLike(value: string): boolean {
  return tokenRuns(value).length > 0;
}

/** A word of a cookie or storage key name that marks a credential. */
const CREDENTIAL_WORD =
  /sess|sid(ts|cc)?$|auth|token|jwt|csrf|xsrf|^log(ged)?(in|on)$|^remember|^sso$|saml|oidc|bearer|secret|credential|passw|apikey|^key$|^sec$|identity/;
/** The same, across word breaks (`logged_in`, `session-token`). */
const CREDENTIAL_JOINED = /loggedin|session|csrf|xsrf|authtoken|accesstoken|refreshtoken|idtoken/;

/** True when a cookie or storage key name reads like a credential. */
function credentialKey(name: string): boolean {
  if (credentialName(name)) return true;
  const words = wordsOf(name);
  return words.some((w) => CREDENTIAL_WORD.test(w)) || CREDENTIAL_JOINED.test(words.join(""));
}

/** The parts of a cookie the rule reads. */
export interface CookieFacts {
  name: string;
  value: string;
  httpOnly?: boolean;
}

/** Why a cookie's value is masked, or undefined when it stays readable. */
export function cookieMaskReason(c: CookieFacts): "HttpOnly" | "name" | "random value" | undefined {
  if (!c.value) return undefined;
  if (c.httpOnly) return "HttpOnly";
  if (credentialKey(c.name)) return "name";
  if (tokenLike(c.value)) return "random value";
  return undefined;
}

/** A parsed JSON value with credential fields and random-looking strings masked. */
function maskJson(value: unknown, key?: string): unknown {
  if (typeof value === "string")
    return value && ((key !== undefined && credentialKey(key)) || tokenLike(value)) ? MASK : value;
  if (typeof value === "number") return key !== undefined && credentialKey(key) ? MASK : value;
  if (Array.isArray(value)) return value.map((v) => maskJson(v, key));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskJson(v, k);
  return out;
}

function parseJson(value: string): unknown {
  const t = value.trim();
  if (!((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]")))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A localStorage or sessionStorage value as the model reads it. A JSON value keeps its layout
 * with its credential fields and random-looking strings masked (a sign-in library's state:
 * `{"access_token": "[masked]", "expires_at": 1767225600}`); any other value is masked whole
 * when its key reads like a credential or it holds a random-looking run.
 */
export function maskStorageValue(key: string, value: string): string {
  const json = parseJson(value);
  if (json !== undefined && typeof json === "object" && json !== null) {
    const masked = maskJson(json);
    return JSON.stringify(masked) === JSON.stringify(json) ? value : JSON.stringify(masked);
  }
  if (!value) return value;
  return credentialKey(key) || tokenLike(value) ? MASK : value;
}

/**
 * The strings a value-wide mask hides for one cookie or storage item, so no other tool shows
 * them either (`document.cookie` through browser_evaluate, a response body, a console message,
 * a page snapshot). Only random-looking runs: replacing a short plain value ("none", a date)
 * everywhere would wreck the page text, and such a value tells little anyway.
 */
export function secretStrings(value: string): string[] {
  const json = parseJson(value);
  const out = new Set<string>();
  if (json !== undefined && typeof json === "object" && json !== null) {
    const walk = (v: unknown): void => {
      if (typeof v === "string") for (const r of secretStrings(v)) out.add(r);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(json);
    return [...out];
  }
  const runs = tokenRuns(value);
  if (!runs.length) return [];
  // The whole value first (a value with separators, `v=3&mac=...`), then each run in it.
  if (value.length >= 16) out.add(value);
  for (const r of runs) out.add(r);
  return [...out];
}

/** The storage tools whose output shows values: their lines are masked by the rule above. */
export const STORAGE_READ_TOOLS: ReadonlySet<string> = new Set([
  "browser_cookie_list",
  "browser_cookie_get",
  "browser_localstorage_list",
  "browser_localstorage_get",
  "browser_sessionstorage_list",
  "browser_sessionstorage_get",
]);

/**
 * Applies `fn` to the Result section of a stock tool's text only (`### Result` up to the next
 * section), or to the `result` field of its JSON form; the code and page sections stay as they are.
 */
function inResult(text: string, fn: (result: string) => string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const payload = JSON.parse(t) as Record<string, unknown>;
      if (typeof payload.result !== "string") return text;
      return JSON.stringify({ ...payload, result: fn(payload.result) }, null, 2);
    } catch {
      /* not JSON: read it as sections */
    }
  }
  const lines = text.split("\n");
  const start = lines.indexOf("### Result");
  if (start < 0) return text.startsWith("### ") ? text : fn(text);
  let end = lines.findIndex((l, i) => i > start && l.startsWith("### "));
  if (end < 0) end = lines.length;
  const body = fn(lines.slice(start + 1, end).join("\n"));
  return [...lines.slice(0, start + 1), body, ...lines.slice(end)].join("\n");
}

/** A cookie line of browser_cookie_list or browser_cookie_get: `name=value (domain: d, path: p...)`. */
const COOKIE_LINE = /^([^=\n]*)=(.*) \(domain: ([^,\n]*), path: ([^,)\n]*)(.*)\)$/;

/**
 * The Result of browser_cookie_list or browser_cookie_get with each value masked by the rule.
 * `cookies` is the browser context's cookies read right after the call: they say which cookie is
 * HttpOnly (the list does not print it). A line whose cookie is not among them counts as
 * HttpOnly unless the line itself says it is not.
 */
export function maskCookieText(
  text: string,
  cookies: readonly { name: string; domain: string; path: string; httpOnly: boolean }[],
): string {
  return inResult(text, (result) =>
    result
      .split("\n")
      .map((line) => {
        const m = COOKIE_LINE.exec(line);
        if (!m) return line;
        const [, name, value, domain, path, rest] = m as unknown as [string, string, string, string, string, string];
        const known = cookies.find((c) => c.name === name && c.domain === domain && c.path === path);
        const httpOnly = known ? known.httpOnly : !/httpOnly: false/.test(rest);
        return cookieMaskReason({ name, value, httpOnly })
          ? `${name}=${MASK} (domain: ${domain}, path: ${path}${rest})`
          : line;
      })
      .join("\n"),
  );
}

/**
 * The Result of a localStorage or sessionStorage tool with each value masked. `items` are the
 * page's items read right after the call: a value may hold newlines, so each item is found
 * whole first; a remaining `key=value` line is masked by its own text.
 */
export function maskWebStorageText(text: string, items: readonly { name: string; value: string }[]): string {
  return inResult(text, (result) => {
    let out = result;
    const done = new Set<string>();
    for (const { name, value } of [...items].sort((a, b) => b.value.length - a.value.length)) {
      const masked = maskStorageValue(name, value);
      if (masked === value || !out.includes(`${name}=${value}`)) continue;
      out = out.split(`${name}=${value}`).join(`${name}=${masked}`);
      done.add(`${name}=${masked}`);
    }
    return out
      .split("\n")
      .map((line) => {
        const eq = line.indexOf("=");
        if (eq <= 0 || done.has(line)) return line;
        return `${line.slice(0, eq)}=${maskStorageValue(line.slice(0, eq), line.slice(eq + 1))}`;
      })
      .join("\n");
  });
}

/** The storage tools that write a value the model gives: a mask in it stands for the value it hides. */
export const STORAGE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "browser_cookie_set",
  "browser_localstorage_set",
  "browser_sessionstorage_set",
]);

/**
 * A value the model writes back, with each mask replaced by the value it hides now, so writing
 * back what a read showed keeps the session (a JSON item with one field changed keeps its
 * masked tokens). Undefined when a mask stands for nothing: the item is gone, or the mask sits
 * where the current value has no masked field. A mask never moves a value to another key,
 * field, cookie or site, so a write cannot carry it anywhere a read would show it.
 */
export function unmaskStorageValue(
  key: string,
  written: string,
  current: string | null | undefined,
): string | undefined {
  if (!written.includes(MASK)) return written;
  if (current === null || current === undefined) return undefined;
  if (written === MASK || written === maskStorageValue(key, current)) return current;
  const w = parseJson(written);
  const c = parseJson(current);
  if (w === undefined || c === undefined) return undefined;
  let ok = true;
  const merge = (wv: unknown, cv: unknown, k: string | undefined): unknown => {
    if (wv === MASK) {
      if ((typeof cv === "string" || typeof cv === "number") && maskJson(cv, k) === MASK) return cv;
      ok = false;
      return wv;
    }
    if (typeof wv === "string" && wv.includes(MASK)) ok = false;
    if (Array.isArray(wv)) return wv.map((v, i) => merge(v, Array.isArray(cv) ? cv[i] : undefined, k));
    if (wv && typeof wv === "object") {
      const out: Record<string, unknown> = {};
      const cur = cv && typeof cv === "object" && !Array.isArray(cv) ? (cv as Record<string, unknown>) : {};
      for (const [kk, v] of Object.entries(wv)) out[kk] = merge(v, cur[kk], kk);
      return out;
    }
    return wv;
  };
  const merged = merge(w, c, undefined);
  return ok ? JSON.stringify(merged) : undefined;
}

/** A cookie as Playwright's storage state and `cookies()` hold it. */
export interface StateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  [key: string]: unknown;
}

/** Playwright's storage state: what browser_storage_state saves and browser_set_storage_state restores. */
export interface StorageState {
  cookies: StateCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[]; [key: string]: unknown }[];
  [key: string]: unknown;
}

function isStorageState(v: unknown): v is StorageState {
  const s = v as StorageState | undefined;
  return !!s && typeof s === "object" && Array.isArray(s.cookies) && Array.isArray(s.origins);
}

/** A storage state with every value the rule masks replaced; names, domains, expiry and flags kept. */
function maskStorageState(state: StorageState): StorageState {
  return {
    ...state,
    cookies: state.cookies.map((c) => (cookieMaskReason(c) ? { ...c, value: MASK } : c)),
    origins: state.origins.map((o) => ({
      ...o,
      localStorage: (o.localStorage ?? []).map((i) => ({ ...i, value: maskStorageValue(i.name, i.value) })),
    })),
  };
}

/**
 * The text of a storage state file (browser_storage_state writes one) with its values masked;
 * any other text as it is.
 */
export function maskStorageStateText(text: string): string {
  const json = parseJson(text);
  if (!isStorageState(json)) return text;
  return JSON.stringify(maskStorageState(json), null, 2);
}

/** True when a storage state holds a mask anywhere. */
export function stateHoldsMask(state: unknown): boolean {
  return JSON.stringify(state).includes(MASK);
}

/**
 * A storage state to restore, with each masked value taken from the browser's live state: the
 * cookie of the same name, domain and path, the item of the same origin and key. A masked value
 * with nothing live behind it is left out (restoring the mask itself would sign the identity
 * out). `dropped` counts them.
 */
export function unmaskStorageState(state: StorageState, live: StorageState): { state: StorageState; dropped: number } {
  let dropped = 0;
  const cookies: StateCookie[] = [];
  for (const c of state.cookies) {
    if (typeof c.value !== "string" || !c.value.includes(MASK)) {
      cookies.push(c);
      continue;
    }
    const now = live.cookies.find((l) => l.name === c.name && l.domain === c.domain && l.path === c.path);
    if (now && c.value === MASK) cookies.push({ ...c, value: now.value });
    else dropped++;
  }
  const origins = state.origins.map((o) => {
    const liveItems = live.origins.find((l) => l.origin === o.origin)?.localStorage ?? [];
    const items: { name: string; value: string }[] = [];
    for (const i of o.localStorage ?? []) {
      const value = unmaskStorageValue(i.name, i.value, liveItems.find((l) => l.name === i.name)?.value);
      if (value === undefined) dropped++;
      else items.push({ ...i, value });
    }
    return { ...o, localStorage: items };
  });
  return { state: { ...state, cookies, origins }, dropped };
}
