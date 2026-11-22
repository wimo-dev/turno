import { describe, expect, it } from "vitest";
import type { PressureLevel } from "turno-core/memory";
import { MemoryWatch, memoryNote } from "../src/memory.js";

/**
 * The memory note of the low-resource preset: a short line in tool results while the system
 * reports memory pressure, when the level rises and then every few minutes, never on every call.
 */

function watch() {
  let now = 0;
  let level: PressureLevel = "normal";
  const w = new MemoryWatch({ probe: async () => level, now: () => now, checkMs: 0, repeatMs: 60_000 });
  return {
    async step(next: PressureLevel, ms = 1_000): Promise<string | undefined> {
      level = next;
      now += ms;
      // The first wait ends a reading `take` started before this level; the second reads it.
      await w.refresh();
      await w.refresh();
      return w.take();
    },
  };
}

describe("MemoryWatch", () => {
  it("says nothing while memory is fine", async () => {
    const w = watch();
    expect(await w.step("normal")).toBeUndefined();
    expect(memoryNote("normal")).toBeUndefined();
  });

  it("notes a rise at once, stays quiet while the level holds, and repeats after a while", async () => {
    const w = watch();
    expect(await w.step("warn")).toBe(memoryNote("warn"));
    expect(await w.step("warn")).toBeUndefined();
    expect(await w.step("critical")).toBe(memoryNote("critical"));
    expect(await w.step("warn")).toBeUndefined();
    expect(await w.step("warn", 60_000)).toBe(memoryNote("warn"));
    expect(await w.step("normal")).toBeUndefined();
    expect(await w.step("warn")).toBe(memoryNote("warn"));
  });

  it("never throws when the probe fails, and keeps the last level it read", async () => {
    let fail = false;
    const w = new MemoryWatch({
      probe: async () => {
        if (fail) throw new Error("sysctl gone");
        return "warn";
      },
      checkMs: 0,
    });
    await w.refresh();
    expect(w.take()).toBe(memoryNote("warn"));
    fail = true;
    await w.refresh();
    expect(w.take()).toBeUndefined();
  });
});
