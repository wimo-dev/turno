import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { privateRoots } from "turno-core/paths";

/**
 * The `policy` key of identity.json (format 13): what an identity may do, set from the command
 * line only, so a product that creates an identity for its own sites can keep the agent there
 * and keep some features off for good. No MCP tool writes identity.json, and the one tool that
 * could (`browser_run_code_unsafe`, which runs code in the server process) is off under any
 * policy.
 *
 *     "policy": {
 *       "allowedDomains": ["example.com", "*.example.com", "localhost:*"],
 *       "disabled": ["captcha", "act", "evaluate"],
 *       "autoSubmit": false
 *     }
 *
 * - `allowedDomains`: the hosts a page of the identity may show. Every main-frame navigation
 *   of every tab is checked (`policy-guard.ts`); requests a page makes for its scripts, images
 *   and data are not, since real sites load them from CDNs and sign-in providers.
 * - `disabled`: features that do not exist for the identity (`POLICY_FEATURES`): their tools are
 *   not listed and are refused, and the settings they need are refused while the policy names
 *   them.
 * - `autoSubmit: false`: `browser_login` never submits the form, whatever the vault's submit
 *   setting says (`turno-browser vault submit`), and `vault submit auto` is refused.
 *
 * The server reads the policy when it starts: a change applies from the next start.
 */

/** What `disabled` can name, the tools each one removes and the setting it needs. */
const POLICY_FEATURES = {
  /** Natural language actions. */
  act: { tools: ["browser_act", "browser_extract", "browser_observe"], setting: "act" },
  /** Captcha solving. */
  captcha: { tools: ["browser_solve_captcha"], setting: "captcha" },
  /** The credential vault's sign-in tool. */
  login: { tools: ["browser_login"] },
  /** One-time codes from the vault: browser_login fills the username and password only. */
  totp: { tools: [] },
  /** Attach mode: the user's own Chrome. */
  attach: { tools: [], setting: "attach" },
  /** Scripts in the page. */
  evaluate: { tools: ["browser_evaluate"] },
  /** Code in the server process; off under any policy. */
  run_code: { tools: ["browser_run_code_unsafe"] },
  /** Cookies, localStorage, sessionStorage and the storage state file (the `storage` capability). */
  storage: {
    tools: [
      "browser_cookie_list",
      "browser_cookie_get",
      "browser_cookie_set",
      "browser_cookie_delete",
      "browser_cookie_clear",
      "browser_storage_state",
      "browser_set_storage_state",
      "browser_localstorage_list",
      "browser_localstorage_get",
      "browser_localstorage_set",
      "browser_localstorage_delete",
      "browser_localstorage_clear",
      "browser_sessionstorage_list",
      "browser_sessionstorage_get",
      "browser_sessionstorage_set",
      "browser_sessionstorage_delete",
      "browser_sessionstorage_clear",
    ],
  },
  /** Request routing and offline mode (the `network` capability); off with allowedDomains. */
  network: { tools: ["browser_route", "browser_route_list", "browser_unroute", "browser_network_state_set"] },
} as const satisfies Record<string, { tools: readonly string[]; setting?: string }>;

export type PolicyFeature = keyof typeof POLICY_FEATURES;

const FEATURE_NAMES = Object.keys(POLICY_FEATURES) as PolicyFeature[];

export interface IdentityPolicy {
  /** Host patterns: `example.com`, `*.example.com` (subdomains only), `localhost:*`, `host:8443`. */
  allowedDomains?: string[];
  disabled?: PolicyFeature[];
  /** false: browser_login never submits the form. true is the same as leaving it out. */
  autoSubmit?: boolean;
}

/** Most patterns `allowedDomains` takes. */
const MAX_DOMAINS = 200;

/** A parsed `allowedDomains` entry. */
export interface HostPattern {
  /** The host, lowercase and in its ASCII form (punycode), IPv6 in brackets. */
  host: string;
  /** `*.host`: any subdomain of the host, not the host itself. */
  subdomains: boolean;
  /** undefined: the scheme's default port (443 for https, 80 for http); `*`: any port. */
  port: number | "*" | undefined;
}

const PATTERN = /^(\*\.)?(\[[0-9a-f:.]+\]|[^:/\s*[\]]+)(?::(\*|\d{1,5}))?$/;

/** A host pattern, or why it is not one. */
export function parseHostPattern(raw: string): HostPattern | { error: string } {
  const text = raw.trim().toLowerCase();
  const bad = {
    error: `policy.allowedDomains: "${raw}" is not a host pattern (like "example.com", "*.example.com" or "localhost:*")`,
  };
  const m = PATTERN.exec(text);
  if (!m) return bad;
  let host: string;
  try {
    host = new URL(`http://${m[2]}`).hostname;
  } catch {
    return bad;
  }
  if (!host) return bad;
  const subdomains = m[1] !== undefined;
  // A wildcard over a whole top-level domain would allow most of the web.
  if (subdomains && !host.includes(".")) return bad;
  let port: HostPattern["port"];
  if (m[3] === "*") port = "*";
  else if (m[3] !== undefined) {
    port = Number(m[3]);
    if (port < 1 || port > 65535) return bad;
  }
  return { host, subdomains, port };
}

/** The patterns of a policy that passed `policyProblems`. */
export function hostPatterns(policy: IdentityPolicy | undefined): HostPattern[] | undefined {
  if (!policy?.allowedDomains) return undefined;
  return policy.allowedDomains.map((p) => parseHostPattern(p)).filter((p): p is HostPattern => !("error" in p));
}

function defaultPort(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

/** True when an http or https URL's host and port match one of the patterns. */
export function hostAllowed(patterns: readonly HostPattern[], url: URL): boolean {
  const host = url.hostname;
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  return patterns.some(
    (p) =>
      (p.subdomains ? host.endsWith(`.${p.host}`) : host === p.host) &&
      (p.port === "*" || (p.port ?? defaultPort(url.protocol)) === port),
  );
}

/** What the domain check says about a main-frame URL. */
export type NavigationVerdict =
  | { allowed: true }
  /** `target` names what was blocked: a host (with its port when it is not the default), or a scheme. */
  | { allowed: false; target: string }
  /** Chrome's own error page (a navigation that failed or was blocked): neither. */
  | { allowed: "error-page" };

/**
 * The domain check of one main-frame URL. Besides http and https on an allowed host, a page may
 * be `about:blank` (every new tab starts there) or a `blob:` URL of an allowed origin; any other
 * scheme (`data:`, `file:`, `chrome:`) is refused.
 */
export function navigationVerdict(patterns: readonly HostPattern[], raw: string): NavigationVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, target: raw };
  }
  if (url.protocol === "http:" || url.protocol === "https:")
    return hostAllowed(patterns, url) ? { allowed: true } : { allowed: false, target: url.host };
  if (url.protocol === "about:")
    return url.pathname === "blank" || url.pathname === "srcdoc"
      ? { allowed: true }
      : { allowed: false, target: `about:${url.pathname}` };
  if (url.protocol === "blob:") {
    const origin = url.origin;
    return origin.startsWith("http") ? navigationVerdict(patterns, origin) : { allowed: false, target: "a blob: URL" };
  }
  if (url.protocol === "chrome-error:") return { allowed: "error-page" };
  return { allowed: false, target: `a ${url.protocol} URL` };
}

/** The URL `browser_navigate` loads for what the agent typed: upstream adds a scheme the same way. */
function navigateUrl(input: string): string {
  try {
    new URL(input);
    return input;
  } catch {
    return input.startsWith("localhost") ? `http://${input}` : `https://${input}`;
  }
}

/** What the agent reads when a navigation is blocked. The host and the allowed list are the contract. */
export function blockedMessage(id: string, target: string, policy: IdentityPolicy): string {
  return `Navigation to ${target} is blocked by the policy of browser identity "${id}": it opens only ${(policy.allowedDomains ?? []).join(", ")}. Stay on those sites.`;
}

/** The tools a policy removes: those of its `disabled` features, `run_code` always, `network` with allowedDomains. */
export function disabledTools(policy: IdentityPolicy | undefined): Map<string, PolicyFeature> {
  const out = new Map<string, PolicyFeature>();
  if (!policy) return out;
  const features = new Set<PolicyFeature>([...(policy.disabled ?? []), "run_code"]);
  if (policy.allowedDomains) features.add("network");
  for (const f of features) for (const tool of POLICY_FEATURES[f].tools) out.set(tool, f);
  return out;
}

/** Why a feature is off, for the message of a refused tool or setting. */
function why(feature: PolicyFeature, policy: IdentityPolicy): string {
  if (policy.disabled?.includes(feature)) return `"${feature}" is in its disabled list`;
  if (feature === "run_code")
    return "any policy turns it off: it runs code in the server process, which could change the policy";
  return "allowedDomains turns it off: a route could take requests away from the domain check";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Problems with the `policy` key, alone and with the other keys of identity.json: a setting a
 * disabled feature needs is refused while the policy names it, and the domain check does not go
 * with attach mode (the user's own tabs) or read mode.
 */
export function policyProblems(p: unknown, engine: string, settings: Record<string, unknown>, out: string[]): void {
  if (p === undefined) return;
  if (!isObject(p)) {
    out.push('policy must be an object, like { "allowedDomains": ["example.com"], "disabled": ["captcha"] }');
    return;
  }
  if (p.allowedDomains !== undefined) {
    const list = p.allowedDomains;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_DOMAINS)
      out.push(`policy.allowedDomains must be a list of 1 to ${MAX_DOMAINS} host patterns`);
    else
      for (const entry of list) {
        if (typeof entry !== "string") {
          out.push("policy.allowedDomains must be a list of host patterns (strings)");
          break;
        }
        const parsed = parseHostPattern(entry);
        if ("error" in parsed) out.push(parsed.error);
      }
    if (engine === "attach")
      out.push(
        "policy.allowedDomains does not go with attach mode: the domain check would apply to your own tabs. Drop attach",
      );
    if (engine === "lightpanda")
      out.push(
        'policy.allowedDomains does not go with engine "lightpanda": read mode is not covered by the domain check',
      );
  }
  if (p.disabled !== undefined) {
    if (!Array.isArray(p.disabled)) out.push(`policy.disabled must be a list of ${FEATURE_NAMES.join(", ")}`);
    else
      for (const f of p.disabled) {
        if (!(FEATURE_NAMES as unknown[]).includes(f)) {
          out.push(`policy.disabled: unknown feature "${String(f)}" (one of ${FEATURE_NAMES.join(", ")})`);
          continue;
        }
        const setting = (POLICY_FEATURES[f as PolicyFeature] as { setting?: string }).setting;
        // `false` says the feature is off, which the policy agrees with.
        if (setting && settings[setting] !== undefined && settings[setting] !== false)
          out.push(`${setting} is set while policy.disabled has "${f}": remove ${setting}`);
      }
  }
  if (p.autoSubmit !== undefined && typeof p.autoSubmit !== "boolean")
    out.push("policy.autoSubmit must be true or false");
  for (const k of Object.keys(p))
    if (!["allowedDomains", "disabled", "autoSubmit"].includes(k)) out.push(`unknown key "policy.${k}"`);
}

/**
 * Why an engine picked at launch (a server flag wins over identity.json) cannot run under the
 * policy, or undefined.
 */
export function policyEngineClash(engine: string, policy: IdentityPolicy | undefined): string | undefined {
  if (!policy) return undefined;
  if (engine === "attach" && policy.disabled?.includes("attach"))
    return 'attach mode is disabled by the policy of this identity ("attach" is in policy.disabled)';
  if (engine === "attach" && policy.allowedDomains)
    return "attach mode does not go with the policy's allowedDomains: the domain check would apply to your own tabs";
  if (engine === "lightpanda" && policy.allowedDomains)
    return 'engine "lightpanda" does not go with the policy\'s allowedDomains: read mode is not covered by the domain check';
  return undefined;
}

function within(file: string, root: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A path with its symbolic links resolved as far as it exists. */
function realPath(path: string): string {
  let head = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...rest.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return path;
      rest.push(head.slice(parent.length).replace(/^[/\\]/, ""));
      head = parent;
    }
  }
}

/** The file arguments of a stock tool call: `filename` and `paths`. */
function fileArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.filename === "string") out.push(args.filename);
  if (Array.isArray(args.paths)) for (const p of args.paths) if (typeof p === "string") out.push(p);
  return out;
}

export interface PolicyCall {
  id: string;
  policy: IdentityPolicy;
  /** The client's workspace, which upstream resolves relative file names against. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Why the policy refuses a tool call, before it runs, or undefined: a disabled tool; a
 * navigation (`browser_navigate`, `browser_tabs` new) to a host the policy does not allow; a new
 * isolated browser context, which the domain check would not cover; and a file argument inside
 * turno's own folders (identity.json lives there, so a tool that writes a file must not reach it).
 */
export function policyRefusal(call: PolicyCall, name: string, args: Record<string, unknown>): string | undefined {
  const { id, policy } = call;
  const feature = disabledTools(policy).get(name);
  if (feature) return `${name} is disabled by the policy of browser identity "${id}": ${why(feature, policy)}.`;
  const patterns = hostPatterns(policy);
  if (patterns) {
    const url =
      name === "browser_navigate" ? args.url : name === "browser_tabs" && args.action === "new" ? args.url : undefined;
    if (typeof url === "string" && url) {
      const verdict = navigationVerdict(patterns, navigateUrl(url));
      if (verdict.allowed === false) return blockedMessage(id, verdict.target, policy);
      if (verdict.allowed === "error-page") return blockedMessage(id, "chrome-error:", policy);
    }
    if (
      name === "browser_tabs" &&
      typeof args.isolatedContext === "string" &&
      args.isolatedContext !== "" &&
      args.isolatedContext !== "default"
    )
      return `browser_tabs with an isolatedContext is refused by the policy of browser identity "${id}": a new browser context would not carry its domain check.`;
  }
  const files = fileArgs(args);
  if (files.length) {
    const roots = privateRoots(call.env).map(realPath);
    for (const f of files) {
      const path = realPath(resolve(call.cwd, f));
      if (roots.some((r) => within(path, r)))
        return `${name} cannot use ${f}: files inside turno's own folders are off limits under the policy of browser identity "${id}".`;
    }
  }
  return undefined;
}
