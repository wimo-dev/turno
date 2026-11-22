import { describe, expect, it } from "vitest";
import { UI_STRINGS } from "../src/ui-strings.js";

/** The person-facing strings: the type makes every table have every key; this checks none is empty. */
describe("UI_STRINGS", () => {
  it("has no empty text in any language", () => {
    const empty = (value: unknown, path: string): string[] =>
      typeof value === "string"
        ? value.trim()
          ? []
          : [path]
        : Object.entries(value as object).flatMap(([k, v]) => empty(v, `${path}.${k}`));
    for (const [locale, table] of Object.entries(UI_STRINGS)) expect(empty(table, locale)).toEqual([]);
  });
});
