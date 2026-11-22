import { totalmem } from "node:os";
import { type PressureLevel, type PressureProbe, memoryPressureProbe } from "turno-core/memory";

/**
 * The memory note of the low-resource preset (`tuning.ts`): when the machine is short of
 * memory, a tool result says so, so the agent can wrap up or close tabs before the system
 * starts swapping or the laptop reboots. It reads the same pressure level as mcpd
 * (`turno-core/memory`: the kernel's level on macOS, PSI on Linux). It only warns: it never
 * closes a tab or stops a session that is working.
 *
 * The level is read in the background, at most every `checkMs`, so a call never waits for it.
 * A note goes out when the level rises, and again every `repeatMs` while it stays up.
 */

/** How often the pressure level is read, at most. */
const CHECK_MS = 15_000;
/** How often the same note repeats while memory stays low. */
const REPEAT_MS = 5 * 60_000;

export interface MemoryWatchOptions {
  probe?: PressureProbe;
  now?: () => number;
  checkMs?: number;
  repeatMs?: number;
}

/** The note for a level, or undefined when memory is fine. */
export function memoryNote(level: PressureLevel): string | undefined {
  if (level === "warn")
    return "memory is low on this machine: finish what needs the open tabs and close the ones you no longer use (browser_tabs)";
  if (level === "critical")
    return "memory is critically low on this machine: save your progress and close this browser (browser_close) as soon as the task allows";
  return undefined;
}

export class MemoryWatch {
  private level: PressureLevel = "normal";
  private checkedAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | undefined;
  private noted: { level: PressureLevel; at: number } | undefined;
  private readonly probe: PressureProbe;
  private readonly now: () => number;
  private readonly checkMs: number;
  private readonly repeatMs: number;

  constructor(options: MemoryWatchOptions = {}) {
    this.probe = options.probe ?? memoryPressureProbe();
    this.now = options.now ?? Date.now;
    this.checkMs = options.checkMs ?? CHECK_MS;
    this.repeatMs = options.repeatMs ?? REPEAT_MS;
  }

  /** Reads the level again when the last reading is old; never throws. */
  refresh(): Promise<void> {
    if (this.reading || this.now() - this.checkedAt < this.checkMs) return this.reading ?? Promise.resolve();
    this.checkedAt = this.now();
    this.reading = this.probe()
      .then((level) => {
        this.level = level;
      })
      .catch(() => {})
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  /**
   * The note for the next tool result, if one is due: the level went up since the last note, or
   * the same note is `repeatMs` old. Starts a new reading for the call after this one.
   */
  take(): string | undefined {
    void this.refresh();
    const note = memoryNote(this.level);
    if (!note) {
      this.noted = undefined;
      return undefined;
    }
    const now = this.now();
    const rose = !this.noted || rank(this.level) > rank(this.noted.level);
    if (!rose && now - this.noted!.at < this.repeatMs) return undefined;
    this.noted = { level: this.level, at: now };
    return note;
  }
}

const rank = (level: PressureLevel) => (level === "critical" ? 2 : level === "warn" ? 1 : 0);

/** The machine's memory in all, like "16 GB", for doctor. */
export function totalMemory(bytes: number = totalmem()): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}
