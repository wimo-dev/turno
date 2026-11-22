import type { PressureLevel } from "turno-core/memory";

export {
  type PressureLevel,
  type PressureProbe,
  darwinLevel,
  freeMemLevel,
  memoryPressureProbe,
  parsePsi,
} from "turno-core/memory";

/**
 * The idle limit (seconds) that applies now: the server's own limit, shortened to
 * `underPressure` when memory is tight and to a quarter of it when critical. It never grows,
 * and `underPressure` 0 turns the feature off.
 */
export function effectiveIdle(idle: number, level: PressureLevel, underPressure: number): number {
  if (!(underPressure > 0) || level === "normal") return idle;
  const limit = level === "critical" ? Math.max(1, Math.round(underPressure / 4)) : underPressure;
  return Math.min(idle, limit);
}
