import { NO_SECRET_STORE, SecretError, requireSecretStore, secretStore } from "turno-core/secrets";

/**
 * The store itself (macOS Keychain, Linux Secret Service) lives in turno-core, shared with
 * turno-browser; this module keeps what mcp.toml references need on top of it.
 */
export {
  NO_SECRET_STORE,
  SecretError,
  type SecretStore,
  describeSecretStore,
  keychainAddLine,
  requireSecretStore,
  secretStore,
  securityQuote,
} from "turno-core/secrets";

/** Resolves "keychain:<service>" and "env:<NAME>" references; plain values pass through. */
export type SecretResolver = (value: string) => Promise<string>;

/** `${VAR}`, `${VAR:-default}` and Cursor's `${env:VAR}` anywhere inside a string. */
const VAR_REF = /\$\{(env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
/** Cursor's own placeholders: not environment variables, so they stay as written. */
const EDITOR_PLACEHOLDERS = new Set(["userHome", "workspaceFolder", "workspaceFolderBasename", "pathSeparator"]);

/**
 * Expand `${VAR}`, `${VAR:-default}` and `${env:VAR}` inside a string from `env`, the way Claude
 * Code expands them in its own MCP config. A variable that is unset and has no default is an
 * error (SecretError), never an empty string. Anything else (`${workspaceFolder}`, a lone `$`)
 * stays as written.
 */
export function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.includes("${")) return value;
  return value.replace(VAR_REF, (whole, prefix: string | undefined, name: string, fallback: string | undefined) => {
    if (!prefix && EDITOR_PLACEHOLDERS.has(name)) return whole;
    const v = env[name];
    if (fallback !== undefined && !v) return fallback;
    if (v === undefined) throw new SecretError(whole, `environment variable ${name} is not set`);
    return v;
  });
}

/**
 * The variables a value reads from `env` that are unset there and have no default: `env:NAME`
 * as the whole value (with `whole`, as mcpd resolves env values and headers) and `${NAME}`
 * inside it. Names only; a value is never returned.
 */
export function unsetVars(value: string, env: NodeJS.ProcessEnv, whole = true): string[] {
  if (whole && value.startsWith("env:")) {
    const [name, fallback] = value.slice(4).split(/:-(.*)/s, 2) as [string, string | undefined];
    return fallback === undefined && env[name] === undefined ? [name] : [];
  }
  if (whole && value.startsWith("keychain:")) return [];
  const out: string[] = [];
  for (const [, prefix, name, fallback] of value.matchAll(VAR_REF)) {
    if (!prefix && EDITOR_PLACEHOLDERS.has(name!)) continue;
    if (fallback === undefined && env[name!] === undefined && !out.includes(name!)) out.push(name!);
  }
  return out;
}

/**
 * Resolves whole-value references (`keychain:<name>`, `env:NAME`) and expands `${VAR}` inside any
 * other value. mcpd uses it for stdio env values and remote headers.
 */
export function keychainResolver(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): SecretResolver {
  return async (value) => {
    if (value.startsWith("env:")) {
      // env:NAME, or env:NAME:-default (what `turno mcp import` writes for ${NAME:-default}).
      const [name, fallback] = value.slice(4).split(/:-(.*)/s, 2) as [string, string | undefined];
      const v = fallback !== undefined && !env[name] ? fallback : env[name];
      if (v === undefined) throw new SecretError(value, `environment variable ${name} is not set`);
      return v;
    }
    if (value.startsWith("keychain:")) {
      const service = value.slice("keychain:".length);
      const store = secretStore(env, platform);
      if (!store) throw new SecretError(value, NO_SECRET_STORE);
      const v = await store.get(service);
      if (v === undefined)
        throw new SecretError(value, `no ${store.label} item "${service}" (turno secret set ${service})`);
      return v;
    }
    return expandVars(value, env);
  };
}

/** Store a secret in this machine's store (Keychain or Secret Service), keeping it out of argv. */
export async function storeKeychainSecret(service: string, secret: string, env: NodeJS.ProcessEnv): Promise<void> {
  await requireSecretStore(env).set(service, secret);
}

export async function resolveRecord(
  record: Record<string, string>,
  resolve: SecretResolver,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) out[k] = await resolve(v);
  return out;
}
