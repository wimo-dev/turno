import { describe, expect, it } from "vitest";
import { STUCK_AFTER, Timeline } from "../src/live-timeline.js";
import { Redactor } from "../src/redact.js";
import type { ToolResult } from "../src/upstream.js";

/** The live view's step timeline: what a step may show, and when a session looks stuck. */

const SECRET = "hunter2-Vault-Value";
const ok: ToolResult = { content: [{ type: "text", text: "### Ran Playwright code\nawait page.click()" }] };
const failed = (why: string): ToolResult => ({ content: [{ type: "text", text: `### Error\n${why}` }], isError: true });

function timeline(): { t: Timeline; redactor: Redactor } {
  const redactor = new Redactor();
  redactor.add(SECRET, "bank");
  return { t: new Timeline(redactor), redactor };
}

const call = (tool: string, args: Record<string, unknown>, result: ToolResult = ok, session = "s1") => ({
  at: 1_000,
  ms: 12,
  session,
  agent: "Claude Code",
  tool,
  args,
  result,
});

describe("Timeline", () => {
  it("never shows a vault value, a typed text, a filled value, a script or an address's query", () => {
    const { t } = timeline();
    t.call(call("browser_click", { element: `Account ${SECRET}`, ref: "e3" }, failed(`no element "${SECRET}"`)));
    t.call(call("browser_type", { element: "Password", ref: "e4", text: "typed by the agent 123" }));
    t.call(
      call("browser_fill_form", {
        fields: [{ name: "Card number", type: "textbox", ref: "e5", value: "4111111111111111" }],
      }),
    );
    t.call(call("browser_evaluate", { function: "() => document.cookie" }));
    t.call(call("browser_navigate", { url: `https://bank.example/login?session=abc123&next=/x#${SECRET}` }));
    t.resumed("the live view", false, 3_000, [
      `Current tab: https://bank.example/a?token=zz9 -> https://b.example/${SECRET}`,
    ]);
    const all = JSON.stringify(t.list());
    for (const leak of [SECRET, "typed by the agent", "4111111111111111", "document.cookie", "abc123", "zz9"])
      expect(all).not.toContain(leak);
    const [click, type, form, , nav, back] = t.list();
    expect(click).toMatchObject({
      target: "Account [vault: bank]",
      outcome: "error",
      detail: 'no element "[vault: bank]"',
    });
    expect(type).toMatchObject({ target: "Password", outcome: "ok" });
    expect(form).toMatchObject({ target: "Card number" });
    expect(nav).toMatchObject({ target: "https://bank.example/login" });
    expect(back).toMatchObject({
      kind: "resume",
      lines: ["Current tab: https://bank.example/a -> https://b.example/[vault: bank]"],
    });
  });

  it("says a session is stuck when the same call on the same target keeps failing, until one works", () => {
    const { t } = timeline();
    const miss = call("browser_click", { element: "Buy now" }, failed("Timeout 5000ms exceeded"));
    // A snapshot between the tries (only reading) neither ends nor breaks the run.
    for (let i = 1; i < STUCK_AFTER; i++) {
      t.call(miss);
      t.call({ ...call("browser_snapshot", {}), readOnly: true });
    }
    // Another session's failures and another target do not add up.
    t.call(call("browser_click", { element: "Buy now" }, failed("Timeout"), "s2"));
    expect(t.stuck).toBeUndefined();
    t.call(miss);
    expect(t.stuck).toMatchObject({ session: "s1", tool: "browser_click", target: "Buy now", count: STUCK_AFTER });
    expect(t.list().at(-1)).toMatchObject({ stuck: STUCK_AFTER });
    t.call(call("browser_click", { element: "Buy now" }, ok));
    expect(t.stuck).toBeUndefined();
  });
});
