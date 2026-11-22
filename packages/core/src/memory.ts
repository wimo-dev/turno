import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * How hard the machine is pressed for memory, read the way the operating system reports it.
 * mcpd shortens idle limits with it; turno-browser warns in tool results and in doctor.
 */
export type PressureLevel = "normal" | "warn" | "critical";

/** Reads the current level; injectable so tests and other platforms can plug in. */
export type PressureProbe = () => Promise<PressureLevel>;

/**
 * Linux pressure stall information (`/proc/pressure/memory`, kernel 4.20+). `some avg10` is the
 * share of the last 10 seconds in which at least one task waited for memory, `full avg10` the
 * share in which every task did. Thresholds: warn at some >= 10 %, critical at some >= 40 % or
 * full >= 10 %. Undefined when the text is not PSI.
 */
export function parsePsi(text: string): PressureLevel | undefined {
  const avg = (kind: string) => {
    const m = new RegExp(`^${kind}\\s+avg10=(\\d+(?:\\.\\d+)?)`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const some = avg("some");
  if (some === undefined) return undefined;
  const full = avg("full") ?? 0;
  if (some >= 40 || full >= 10) return "critical";
  if (some >= 10) return "warn";
  return "normal";
}

/** macOS `kern.memorystatus_vm_pressure_level` (the level `memory_pressure` reports): 1 normal, 2 warn, 4 critical. */
export function darwinLevel(n: number): PressureLevel | undefined {
  return n === 1 ? "normal" : n === 2 ? "warn" : n === 4 ? "critical" : undefined;
}

/** Fallback from free memory: warn below 10 % of RAM, critical below 5 %. */
export function freeMemLevel(free: number, total: number): PressureLevel {
  if (!(total > 0)) return "normal";
  const share = free / total;
  return share < 0.05 ? "critical" : share < 0.1 ? "warn" : "normal";
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  /** Root of procfs (Linux). Default /proc. */
  procRoot?: string;
  /** Reads `sysctl -n kern.memorystatus_vm_pressure_level` (macOS). */
  sysctl?: () => Promise<string>;
  freemem?: () => number;
  totalmem?: () => number;
}

async function realSysctl(): Promise<string> {
  const { stdout } = await run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
    encoding: "utf8",
    timeout: 2000,
  });
  return stdout;
}

/**
 * The best signal the platform has: PSI on Linux, the kernel pressure level on macOS, else
 * free memory. On macOS free memory is not a fallback: it leaves out reclaimable caches, so it
 * reads low on a healthy machine; a failed sysctl there means "normal".
 */
export function memoryPressureProbe(opts: ProbeOptions = {}): PressureProbe {
  const platform = opts.platform ?? process.platform;
  const free = opts.freemem ?? freemem;
  const total = opts.totalmem ?? totalmem;
  return async () => {
    if (platform === "darwin") {
      try {
        return darwinLevel(Number.parseInt((await (opts.sysctl ?? realSysctl)()).trim(), 10)) ?? "normal";
      } catch {
        return "normal";
      }
    }
    if (platform === "linux") {
      try {
        const level = parsePsi(readFileSync(join(opts.procRoot ?? "/proc", "pressure", "memory"), "utf8"));
        if (level) return level;
      } catch {
        /* no PSI (old kernel, some containers): use free memory */
      }
    }
    return freeMemLevel(free(), total());
  };
}
