import type { PressureLevel } from "turno-core/memory";
import { type EffectiveSettings, resolveDefaults, systemLocale } from "./defaults.js";
import { engineChoice } from "./engine.js";
import { readDetectedHealth } from "./health-detect.js";
import { readIdentitySettings } from "./settings.js";
import { vaultSummary } from "./vault.js";

export interface EffectiveOptions {
  env?: NodeJS.ProcessEnv;
  /** The memory pressure now, when the caller read it; without it `resources` says it is decided at launch. */
  pressure?: PressureLevel;
  /** Whether the server runs headless, when the caller knows it (a running server does). */
  headless?: boolean;
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
  return resolveDefaults(settings, {
    identity: true,
    engine,
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.pressure ? { pressure: options.pressure } : {}),
    ...(settings?.policy ? { policy: settings.policy } : {}),
    ...(locale ? { systemLocale: locale } : {}),
    ...(detectedHealth ? { detectedHealth } : {}),
    ...(vault?.chosen ? { vaultSubmit: vault.submit } : {}),
  });
}
