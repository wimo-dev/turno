import { describe, expect, it } from "vitest";
import type { Page } from "patchright-core";
import {
  type Diagnosis,
  coveredBeforeCall,
  explainFailure,
  failureMessage,
  isActionabilityFailure,
} from "../src/diagnose.js";

const TIMEOUT = `locator.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('aria-ref=e7')
  - <div class="cookie">...</div> intercepts pointer events`;

describe("isActionabilityFailure", () => {
  it("is true for the timeouts of an action and false for a stale ref or another error", () => {
    expect(isActionabilityFailure(TIMEOUT)).toBe(true);
    expect(isActionabilityFailure("element is not enabled")).toBe(true);
    expect(isActionabilityFailure("Ref e9 not found in the current page snapshot. Try capturing new snapshot.")).toBe(
      false,
    );
    expect(isActionabilityFailure("net::ERR_NAME_NOT_RESOLVED")).toBe(false);
  });
});

describe("failureMessage", () => {
  const target = { role: "button", name: "Save", selector: "button#save" };

  it("names the element that covers the target and its buttons", () => {
    const d: Diagnosis = {
      state: "covered",
      target,
      cover: { role: "dialog", name: "We use cookies", selector: "div.cookie-banner" },
      buttons: ["Accept all", "Reject"],
    };
    const text = failureMessage("browser_click", "e7", d, TIMEOUT);
    expect(text).toBe(
      [
        'ELEMENT_COVERED: Could not click button "Save" (button#save), e7: dialog "We use cookies" (div.cookie-banner) covers it and would get the click instead.',
        'Next: close or answer that element first (it has "Accept all", "Reject"), then try again; take a new snapshot if the page changed.',
        "Playwright: locator.click: Timeout 5000ms exceeded.",
      ].join("\n"),
    );
  });

  it("says when the target is hidden, by what, disabled, read-only or gone, each with its code", () => {
    expect(
      failureMessage(
        "browser_click",
        "e7",
        { state: "hidden", target, because: { role: "navigation", name: "Menu", selector: "nav.menu" } },
        TIMEOUT,
      ),
    ).toMatch(
      /^ELEMENT_HIDDEN: .*it is not visible \(navigation "Menu" \(nav\.menu\) hides it\)\.\nNext: open the menu, tab or section that holds it/,
    );
    expect(
      failureMessage(
        "browser_type",
        "#email",
        { state: "disabled", target: { role: "textbox", name: "Email", selector: "input#email" } },
        TIMEOUT,
      ),
    ).toMatch(
      /^ELEMENT_DISABLED: Could not type into textbox "Email" \(input#email\), #email: it is disabled\.\nNext: do what enables it first/,
    );
    expect(failureMessage("browser_type", "e2", { state: "readonly", target }, TIMEOUT)).toMatch(
      /^ELEMENT_READONLY: .*it is read-only\./,
    );
    expect(failureMessage("browser_click", "e2", { state: "ok", target }, TIMEOUT)).toMatch(/^ELEMENT_NOT_STABLE: /);
    expect(failureMessage("browser_hover", "e2", undefined, TIMEOUT)).toMatch(
      /^ELEMENT_GONE: Could not hover over e2: the element is no longer on the page\.\nNext: take a new snapshot/,
    );
  });
});

describe("explainFailure", () => {
  const result = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

  it("leaves successes, other tools, other errors and calls without a page alone", async () => {
    const ok = { content: [{ type: "text" as const, text: "### Result\nok" }] };
    expect(
      await explainFailure(undefined, "browser_click", { target: "e7" }, result(`### Error\n${TIMEOUT}`), false),
    ).toEqual(result(`### Error\n${TIMEOUT}`));
    const page = {} as never;
    expect(await explainFailure(page, "browser_click", { target: "e7" }, ok, false)).toBe(ok);
    const nav = result("### Error\nnet::ERR_NAME_NOT_RESOLVED");
    expect(await explainFailure(page, "browser_navigate", { url: "x" }, nav, false)).toBe(nav);
    const stale = result("### Error\nRef e9 not found in the current page snapshot. Try capturing new snapshot.");
    expect(await explainFailure(page, "browser_click", { target: "e9" }, stale, false)).toBe(stale);
  });
});

describe("coveredBeforeCall", () => {
  const target = { role: "button", name: "Save", selector: "button#save" };
  const covered = (selector: string): Diagnosis => ({
    state: "covered",
    target,
    cover: { role: "dialog", name: "We use cookies", selector },
    buttons: ["Accept all"],
  });
  /** A page whose one element answers each look with the next diagnosis in `looks`. */
  const pageWith = (looks: (Diagnosis | Error)[], count = 1) => {
    const seen: unknown[] = [];
    const page = {
      locator: () => ({
        count: async () => count,
        evaluate: async (_fn: unknown, scroll: unknown) => {
          seen.push(scroll);
          const next = looks.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      }),
    } as unknown as Page;
    return { page, seen };
  };
  const noWait = async () => {};

  it("refuses the call when the same element covers the target twice, without scrolling", async () => {
    const { page, seen } = pageWith([covered("div.cookie"), covered("div.cookie")]);
    const res = await coveredBeforeCall(page, "browser_click", { target: "#save" }, false, noWait);
    expect(res?.isError).toBe(true);
    const text = (res!.content[0] as { text: string }).text;
    expect(text).toMatch(
      /^### Error\nELEMENT_COVERED: Could not click button "Save" \(button#save\), #save: dialog "We use cookies" \(div\.cookie\) covers it/,
    );
    expect(text).toContain("turno: the call did not run: the target is covered");
    expect(seen).toEqual([false, false]);
  });

  it("lets the call run when the cover goes or changes, the target is free, unknown, not one element, or the tool is not diagnosed", async () => {
    const run = (looks: (Diagnosis | Error)[], tool = "browser_click", count = 1) =>
      coveredBeforeCall(pageWith(looks, count).page, tool, { target: "#save" }, false, noWait);
    expect(await run([covered("div.cookie"), { state: "ok", target }])).toBeUndefined();
    expect(await run([covered("div.cookie"), covered("div.other")])).toBeUndefined();
    expect(await run([{ state: "ok", target }])).toBeUndefined();
    expect(await run([new Error("Timeout")])).toBeUndefined();
    expect(await run([covered("div.cookie"), covered("div.cookie")], "browser_click", 2)).toBeUndefined();
    expect(await run([covered("div.cookie"), covered("div.cookie")], "browser_snapshot")).toBeUndefined();
    expect(await coveredBeforeCall(undefined, "browser_click", { target: "#save" }, false, noWait)).toBeUndefined();
  });

  it("answers in JSON when the call asked for it", async () => {
    const { page } = pageWith([covered("div.cookie"), covered("div.cookie")]);
    const res = await coveredBeforeCall(page, "browser_click", { target: "#save" }, true, noWait);
    expect(JSON.parse((res!.content[0] as { text: string }).text)).toMatchObject({
      isError: true,
      code: "ELEMENT_COVERED",
      cover: { role: "dialog", name: "We use cookies", selector: "div.cookie" },
    });
  });
});
