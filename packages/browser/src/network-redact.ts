import { wordsOf } from "./sensitive.js";

/**
 * Credentials in what `browser_network_requests` and `browser_network_request` show: header
 * values, query parameters, form fields and JSON fields that carry a credential keep their
 * names and lose their values, which read `[redacted]`.
 *
 * - Headers: `Authorization` and `Proxy-Authorization` (the scheme stays: `Bearer [redacted]`),
 *   `Cookie` and `Set-Cookie` (each cookie's name stays, its attributes too), and any header
 *   named like a credential (`X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token`).
 * - Query parameters, fragment parameters and form fields (`name=value`), and JSON fields
 *   (`"name": value`), whose name reads like a credential: `access_token`, `id_token`,
 *   `refresh_token`, `token`, `code`, `session`, `sid`, `api_key`, `key`, `secret`, `password`,
 *   `client_secret`, `code_verifier`, `signature` and names built on them (`sessionId`,
 *   `X-Amz-Security-Token`, `user[password]`).
 *
 * The rest of a request (URL path, other headers, other fields, status) is left as it is, so the
 * agent can still debug the page. A credential in some other shape (a path segment, a custom
 * body format) is not recognized.
 */

export const REDACTED = "[redacted]";

/** The upstream tools whose output these rules apply to. */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(["browser_network_requests", "browser_network_request"]);

/** Whole names that carry a credential. */
const EXACT = new Set([
  "auth",
  "authorization",
  "code",
  "cookie",
  "key",
  "password",
  "secret",
  "session",
  "sid",
  "sig",
  "signature",
  "ticket",
  "token",
  "assertion",
  "samlresponse",
  "jwt",
  "otp",
]);
/** A word anywhere in the name. */
const WORD =
  /token|secret|passw(or)?d|passcode|passphrase|sess(ion)?id|^session$|^sid$|^jwt$|apikey|^otp$|credential|verifier|^pwd$|^signature$|cookie/;
/** `<word>_key` and `<word>_code` names that carry a credential (`api_key`, `auth_code`). */
const KEY_OWNERS = new Set([
  "api",
  "access",
  "private",
  "secret",
  "client",
  "subscription",
  "auth",
  "session",
  "signing",
]);
const CODE_OWNERS = new Set([
  "auth",
  "authorization",
  "verification",
  "otp",
  "mfa",
  "totp",
  "sms",
  "login",
  "access",
  "device",
  "user",
  "security",
  "time",
  "recovery",
  "backup",
  "confirmation",
  "reset",
]);

/** Names about a credential that do not hold one (`token_endpoint`, `token_type`, `expires_in`). */
const ABOUT = new Set(["endpoint", "uri", "url", "type", "expires", "expiry", "expiration", "name"]);
/** Headers whose value is a credential, whatever words they are made of. */
const HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/** True when a header, parameter or field name reads like a credential. */
export function credentialName(name: string): boolean {
  const words = wordsOf(name);
  if (!words.length) return false;
  if (EXACT.has(words.join(""))) return true;
  const last = words[words.length - 1]!;
  if (ABOUT.has(last)) return false;
  if (words.some((w) => WORD.test(w))) return true;
  const before = words[words.length - 2];
  if (before && last === "key" && KEY_OWNERS.has(before)) return true;
  if (before && last === "code" && CODE_OWNERS.has(before)) return true;
  return false;
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/** `a=1; b=2` with each value replaced. */
function redactCookies(value: string): string {
  return value
    .split(";")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq < 0 ? part : `${part.slice(0, eq)}=${REDACTED}`;
    })
    .join(";");
}

/** `sid=abc; Path=/; HttpOnly` with the cookie's value replaced and its attributes kept. */
function redactSetCookie(value: string): string {
  const semi = value.indexOf(";");
  const pair = semi < 0 ? value : value.slice(0, semi);
  const eq = pair.indexOf("=");
  const redacted = eq < 0 ? REDACTED : `${pair.slice(0, eq)}=${REDACTED}`;
  return semi < 0 ? redacted : redacted + value.slice(semi);
}

function redactHeaderValue(name: string, value: string): string {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization") {
    const m = /^([A-Za-z][\w-]*) +\S/.exec(value);
    return m ? `${m[1]} ${REDACTED}` : REDACTED;
  }
  if (lower === "cookie") return redactCookies(value);
  if (lower === "set-cookie") return redactSetCookie(value);
  return REDACTED;
}

const HEADER_LINE = /^([ \t]*)([!#$%&'*+.^_`|~0-9A-Za-z-]+): (.*)$/;
const JSON_FIELD = /"((?:[^"\\\n]|\\.){1,100})"(\s*:\s*)("(?:[^"\\\n]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const PAIR = /(^|[?&#;\s])([^\s=&#?;"'<>]{1,100})=([^\s&#;"'<>]*)/g;

/** Header lines, then JSON fields, then `name=value` pairs, in plain text. */
function redactPlain(text: string): string {
  let setCookie = false;
  const lines = text.split("\n").map((line) => {
    const m = HEADER_LINE.exec(line);
    if (!m) {
      // Playwright joins several Set-Cookie values with a newline: the next ones have no name.
      if (setCookie && line.trim() && !line.startsWith("#")) return redactSetCookie(line);
      setCookie = false;
      return line;
    }
    const [, indent, name, value] = m as unknown as [string, string, string, string];
    setCookie = name.toLowerCase() === "set-cookie";
    if (!HEADERS.has(name.toLowerCase()) && !credentialName(name)) return line;
    return `${indent}${name}: ${redactHeaderValue(name, value)}`;
  });
  return lines
    .join("\n")
    .replace(JSON_FIELD, (all, name: string, colon: string) =>
      credentialName(name) ? `"${name}"${colon}"${REDACTED}"` : all,
    )
    .replace(PAIR, (all, lead: string, name: string, value: string) =>
      value && value !== REDACTED && credentialName(decodeName(name)) ? `${lead}${name}=${REDACTED}` : all,
    );
}

/** A parsed JSON value with credential fields replaced, and every string redacted as text. */
function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redactNetworkText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      credentialName(k) && (typeof v === "string" || typeof v === "number") && v !== REDACTED
        ? REDACTED
        : redactJson(v);
  }
  return out;
}

/**
 * The output of the network tools with credentials replaced: a JSON document (a JSON body, a
 * result in JSON mode) field by field and kept in its layout, anything else as text.
 */
export function redactNetworkText(text: string): string {
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const redacted = redactJson(parsed);
      const before = JSON.stringify(parsed);
      const after = JSON.stringify(redacted);
      if (before === after) return text;
      return trimmed.includes("\n") ? JSON.stringify(redacted, null, 2) : after;
    } catch {
      /* not JSON after all: read it as text */
    }
  }
  return redactPlain(text);
}
