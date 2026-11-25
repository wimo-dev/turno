import type { PressureLevel } from "turno-core/memory";
import { resolveActFallback } from "./act-chain.js";
import { captchaKeyOf } from "./captcha.js";
import { type EffectiveSettings, resolveDefaults, systemLocale } from "./defaults.js";
import { exitReport } from "./exit-geo.js";
import { engineChoice } from "./engine.js";
import { readDetectedHealth } from "./health-detect.js";
import { type IdentitySettings, readIdentitySettings, systemTimezone } from "./settings.js";
import { describeSystemProxy, systemProxy } from "./system-proxy.js";
import { vaultSummary } from "./vault.js";

export interface EffectiveOptions {
  env?: NodeJS.ProcessEnv;
  /** The memory pressure now, when the caller read it; without it `resources` says it is decided at launch. */
  pressure?: PressureLevel;
  /** Whether the server runs headless, when the caller knows it (a running server does). */
  headless?: boolean;
  /** Reads the system's proxy (tests give their own). */
  systemProxy?: () => ReturnType<typeof systemProxy>;
}

/**
 * The effective settings of an identity as `show`, `status` and `doctor` report them: identity.json
 * and, for each key it leaves out, the default with where it comes from. Without a server there
 * is no launch, so what depends on it (headless, the live view of that server) is reported as
 * the rule that decides it. A broken identity.json counts as empty here: `show` reports the
 * problem itself.
 */
export function effectiveSettings(id: string, options: EffectiveOptions = {}): EffectiveSettings {
  const env = options.env ?? process.env;
  let settings: ReturnType<typeof readIdentitySettings>;
  try {
    settings = readIdentitySettings(id, env);
  } catch {
    settings = undefined;
  }
  let engine = "chrome";
  try {
    const kind = engineChoice({}, settings).kind;
    engine = kind === "default" ? "chrome" : kind;
  } catch {
    /* an engine setting that does not resolve: reported by show and doctor */
  }
  const vault = vaultSummary(id, env);
  const detectedHealth = readDetectedHealth(id, env);
  const locale = systemLocale(env);
  // Only read when it can apply: an identity proxy (or `false`) and other engines do not need it.
  const proxyApplies = settings?.proxy === undefined && engine === "chrome";
  const system = proxyApplies
    ? ((options.systemProxy ?? (() => systemProxy(process.platform, env)))() ?? null)
    : undefined;
  return resolveDefaults(settings, {
    actFallback: resolveActFallback(env),
    captchaKey: captchaKeyOf(env),
    identity: true,
    engine,
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.pressure ? { pressure: options.pressure } : {}),
    ...(settings?.policy ? { policy: settings.policy } : {}),
    ...(locale ? { systemLocale: locale } : {}),
    ...(detectedHealth ? { detectedHealth } : {}),
    ...(vault?.chosen ? { vaultSubmit: vault.submit } : {}),
    ...(system !== undefined ? { systemProxy: system } : {}),
  });
}

/** The proxy an identity's traffic goes through, as `show` and `status` report it; undefined: none. */
export function proxyInUse(
  settings: IdentitySettings | undefined,
  effective: EffectiveSettings,
  env: NodeJS.ProcessEnv = process.env,
  read: () => ReturnType<typeof systemProxy> = () => systemProxy(process.platform, env),
): { server?: string; system?: string } | undefined {
  if (settings?.proxy) return { server: settings.proxy.server };
  if (effective.proxy.origin.from !== "auto" || effective.proxy.value !== true) return undefined;
  const sys = read();
  return sys ? { ...(sys.server ? { server: sys.server } : {}), system: describeSystemProxy(sys) } : undefined;
}

/** What the last exit lookup through the identity's proxy found wrong (no lookup is made here). */
export function exitProblems(
  id: string,
  settings: IdentitySettings | undefined,
  effective: EffectiveSettings,
  server: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!server) return [];
  const locale = typeof effective.locale.value === "string" ? effective.locale.value : settings?.languages?.[0];
  return (
    exitReport(id, env, server, { timezone: settings?.timezone ?? systemTimezone(), ...(locale ? { locale } : {}) })
      ?.problems ?? []
  );
}
