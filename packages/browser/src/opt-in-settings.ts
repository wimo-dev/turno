import { parseDuration } from "./units.js";
import { names } from "./names.js";

/**
 * The format 8 keys of identity.json: natural language actions (`act`) and captcha solving
 * (`captcha`). Both send page content to a third party. Without the key, `act-chain.ts` finds a
 * model (MCP sampling, an API key in the environment, a subscription CLI) and `captcha.ts` a
 * solver key in the environment; with it, the group below decides:
 *
 *     "act": {
 *       "sampling": true,                    // ask the agent's own client (MCP sampling) first
 *       "provider": "chat-completions",      // else this HTTP API
 *       "endpoint": "https://models.example.com/v1",
 *       "model": "example-model",
 *       "key": "keychain:act-model",         // optional; a reference, never the key
 *       "maxSteps": 10, "maxTokens": 50000, "timeout": "2m"
 *     },
 *     "captcha": {
 *       "provider": "task-api",
 *       "endpoint": "https://solver.example.com",
 *       "key": "keychain:captcha-solver",
 *       "timeout": "3m"
 *     }
 *
 * A key is read from the secret store at use time (turno-core), never from a tool argument and
 * never written here: a value that is not a `keychain:` reference is refused, and the message
 * does not repeat it.
 */

/** The model providers `act` can name besides MCP sampling. */
const ACT_PROVIDERS = ["chat-completions"] as const;
/** The captcha solver protocols `captcha` can name. */
const CAPTCHA_PROVIDERS = ["task-api"] as const;

export interface ActSettings {
  /** Use MCP sampling when the client offers it (default true). */
  sampling?: boolean;
  provider?: (typeof ACT_PROVIDERS)[number];
  /** Base URL of the provider's API: https, or http on a loopback address. */
  endpoint?: string;
  model?: string;
  /** `keychain:<item>`: the API key, read from the secret store. */
  key?: string;
  /** Most actions one `browser_act` call takes (default 10, at most 30). */
  maxSteps?: number;
  /** Most model tokens one call spends, prompts and replies together (default 50000). */
  maxTokens?: number;
  /** Longest one call runs, like `"2m"` (default 2m, from 10s to 10m). */
  timeout?: string;
}

export interface CaptchaSettings {
  provider: (typeof CAPTCHA_PROVIDERS)[number];
  endpoint: string;
  /** `keychain:<item>`: the solver's account key, read from the secret store. */
  key: string;
  /** Longest one solve waits, like `"3m"` (default 3m, from 10s to 10m). */
  timeout?: string;
}

/** Budgets of one natural language call, after the defaults. */
export interface ActBudget {
  maxSteps: number;
  maxTokens: number;
  timeoutMs: number;
}

const ACT_DEFAULTS: ActBudget = { maxSteps: 10, maxTokens: 50_000, timeoutMs: 120_000 };
const MAX_STEPS = 30;
const MIN_TOKENS = 2_000;
const MAX_TOKENS = 1_000_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 600_000;
const CAPTCHA_DEFAULT_TIMEOUT_MS = 180_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for https, or http on a loopback host (a model server on this machine). */
export function allowedEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

const KEYCHAIN = /^keychain:[A-Za-z0-9._\-/]{1,200}$/;

/** True for a `keychain:<item>` reference. */
function isKeychainRef(value: unknown): value is string {
  return typeof value === "string" && KEYCHAIN.test(value);
}

function timeoutProblem(key: string, v: unknown, out: string[]): void {
  if (v === undefined) return;
  const ms = typeof v === "string" ? parseDuration(v) : undefined;
  if (ms === undefined || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS)
    out.push(`${key} must be a duration from "10s" to "10m", like "2m"`);
}

function keyProblem(key: string, v: unknown, out: string[], required: boolean): void {
  if (v === undefined) {
    if (required) out.push(`${key} is required: a keychain:<item> reference (${names().secretSet("<item>")})`);
    return;
  }
  // Never echo the value: a pasted key would land in a terminal or a log.
  if (!isKeychainRef(v))
    out.push(
      `${key} must be a keychain:<item> reference (store the key with ${names().secretSet("<item>")}), never the key itself`,
    );
}

function endpointProblem(key: string, v: unknown, out: string[]): void {
  if (typeof v !== "string" || !allowedEndpoint(v))
    out.push(`${key} must be an https:// URL (or http:// on 127.0.0.1, localhost or [::1]) without a user or password`);
}

/** Problems with `act`, in key order. */
export function actProblems(a: unknown, out: string[]): void {
  if (a === undefined || a === false) return;
  if (!isObject(a)) {
    out.push('act must be an object, like {} (MCP sampling) or { "provider": "chat-completions", ... }');
    return;
  }
  if (a.sampling !== undefined && typeof a.sampling !== "boolean") out.push("act.sampling must be true or false");
  if (a.provider !== undefined) {
    if (!(ACT_PROVIDERS as readonly unknown[]).includes(a.provider))
      out.push(`act.provider must be ${ACT_PROVIDERS.map((p) => `"${p}"`).join(", ")}`);
    endpointProblem("act.endpoint", a.endpoint, out);
    if (typeof a.model !== "string" || !a.model.trim() || a.model.length > 200)
      out.push("act.model must be the model name the provider expects");
    keyProblem("act.key", a.key, out, false);
  } else {
    for (const k of ["endpoint", "model", "key"] as const)
      if (a[k] !== undefined) out.push(`act.${k} needs act.provider`);
    if (a.sampling === false) out.push("act needs act.provider when act.sampling is false: nothing would answer");
  }
  if (
    a.maxSteps !== undefined &&
    (typeof a.maxSteps !== "number" || !Number.isInteger(a.maxSteps) || a.maxSteps < 1 || a.maxSteps > MAX_STEPS)
  )
    out.push(`act.maxSteps must be a whole number from 1 to ${MAX_STEPS}`);
  if (
    a.maxTokens !== undefined &&
    (typeof a.maxTokens !== "number" ||
      !Number.isInteger(a.maxTokens) ||
      a.maxTokens < MIN_TOKENS ||
      a.maxTokens > MAX_TOKENS)
  )
    out.push(`act.maxTokens must be a whole number from ${MIN_TOKENS} to ${MAX_TOKENS}`);
  timeoutProblem("act.timeout", a.timeout, out);
  for (const k of Object.keys(a))
    if (!["sampling", "provider", "endpoint", "model", "key", "maxSteps", "maxTokens", "timeout"].includes(k))
      out.push(`unknown key "act.${k}"`);
}

/** Problems with `captcha`, alone and with the engine keys. */
export function captchaProblems(c: unknown, settings: Record<string, unknown>, out: string[]): void {
  if (c === undefined || c === false) return;
  if (!isObject(c)) {
    out.push('captcha must be an object with provider, endpoint and key, like { "provider": "task-api", ... }');
    return;
  }
  if (!(CAPTCHA_PROVIDERS as readonly unknown[]).includes(c.provider))
    out.push(`captcha.provider must be ${CAPTCHA_PROVIDERS.map((p) => `"${p}"`).join(", ")}`);
  endpointProblem("captcha.endpoint", c.endpoint, out);
  keyProblem("captcha.key", c.key, out, true);
  timeoutProblem("captcha.timeout", c.timeout, out);
  for (const k of Object.keys(c))
    if (!["provider", "endpoint", "key", "timeout"].includes(k)) out.push(`unknown key "captcha.${k}"`);
  if (settings.engine === "lightpanda")
    out.push('captcha does not go with engine "lightpanda": read mode runs no captcha widget to solve');
  if (settings.engine === "camoufox")
    out.push(
      "captcha does not go with engine \"camoufox\": the token is set from Patchright's isolated script world and the widget's callback from the page's own, and Camoufox runs on stock Playwright",
    );
}

/** The budgets of an `act` group, defaults filled in. */
export function actBudget(a: ActSettings): ActBudget {
  return {
    maxSteps: a.maxSteps ?? ACT_DEFAULTS.maxSteps,
    maxTokens: a.maxTokens ?? ACT_DEFAULTS.maxTokens,
    timeoutMs: (a.timeout !== undefined ? parseDuration(a.timeout) : undefined) ?? ACT_DEFAULTS.timeoutMs,
  };
}

/** How long one captcha solve may wait. */
export function captchaTimeoutMs(c: CaptchaSettings): number {
  return (c.timeout !== undefined ? parseDuration(c.timeout) : undefined) ?? CAPTCHA_DEFAULT_TIMEOUT_MS;
}
