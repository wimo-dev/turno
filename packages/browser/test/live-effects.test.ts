import { describe, expect, it } from "vitest";
import { Stage, type StageEvent } from "../src/live-effects.js";
import { pageToStage, stageToCanvas } from "../src/live-map.js";
import { Timeline } from "../src/live-timeline.js";
import { Redactor } from "../src/redact.js";

/** The live view's effect events and where their boxes land on the picture. */

const SECRET = "hunter2-Vault-Value";
const TYPED = "typed by the agent 123";
const CARD = "4111111111111111";

function stage(): { s: Stage; events: StageEvent[] } {
  const redactor = new Redactor();
  redactor.add(SECRET, "bank");
  const timeline = new Timeline(redactor);
  const s = new Stage({
    target: (tool, args) => timeline.targetOf(tool, args),
    clean: (text, max) => timeline.clean(text, max),
    now: () => 1_000,
  });
  const events: StageEvent[] = [];
  s.onEvent((e) => events.push(e));
  return { s, events };
}

describe("the live view's effect events", () => {
  it("say how many characters were typed, never which, and never a vault value", () => {
    const { s, events } = stage();
    s.start({
      tool: "browser_type",
      args: { element: "Email", ref: "e4", text: TYPED },
      session: "s1",
      agent: "Codex",
    });
    s.mark({
      session: "s1",
      tab: 2,
      mark: "type",
      box: { x: 10, y: 20, width: 200, height: 30 },
      scroll: { x: 0, y: 400 },
    });
    s.end({ session: "s1", tool: "browser_type", at: 1_200, ms: 200, outcome: "ok", detail: "" });
    s.start({
      tool: "browser_fill_form",
      args: {
        fields: [
          { name: "Card", type: "textbox", ref: "e5", value: CARD },
          { name: "Terms", type: "checkbox", ref: "e6", value: "true" },
        ],
      },
      session: "s1",
    });
    s.start({ tool: "browser_press_sequentially", args: { text: SECRET }, session: "s2" });
    s.start({ tool: "browser_login", args: { site: "bank" }, session: "s3" });
    s.start({ tool: "browser_click", args: { element: `Pay ${SECRET}`, ref: "e9" }, session: "s4" });
    s.end({
      session: "s4",
      tool: "browser_click",
      at: 1_300,
      ms: 90,
      outcome: "error",
      detail: "ELEMENT_COVERED: Could not click",
      stuck: 3,
    });
    s.paused({
      by: "browser_request_human",
      step: true,
      cue: { kind: "last-click", text: `Pay with ${SECRET}`, detail: "Total $95.50." },
    });

    const json = JSON.stringify(events);
    for (const value of [TYPED, SECRET, CARD]) expect(json).not.toContain(value);
    const starts = events.flatMap((e) => (e.type === "start" ? [[e.tool, e.kind, e.chars, e.vault, e.target]] : []));
    expect(starts).toEqual([
      ["browser_type", "type", TYPED.length, undefined, "Email"],
      ["browser_fill_form", "type", CARD.length, undefined, "Card, Terms"],
      ["browser_press_sequentially", "type", SECRET.length, undefined, ""],
      ["browser_login", "type", undefined, true, ""],
      ["browser_click", "click", undefined, undefined, "Pay [vault: bank]"],
    ]);
    expect(events[1]).toEqual({
      type: "mark",
      step: 1,
      at: 1_000,
      tab: 2,
      mark: "type",
      box: { x: 10, y: 20, width: 200, height: 30 },
      scroll: { x: 0, y: 400 },
    });
    expect(events[2]).toMatchObject({ type: "end", step: 1, kind: "type", ms: 200, outcome: "ok" });
    expect(events.at(-2)).toMatchObject({ type: "end", step: 5, outcome: "error", code: "ELEMENT_COVERED", stuck: 3 });
    expect(events.at(-1)).toMatchObject({ type: "human", cue: "last-click", text: "Pay with [vault: bank]" });
  });
});

describe("pageToStage", () => {
  const frame = { w: 1280, h: 800, sx: 0, sy: 300, scale: 1, top: 0 };
  // The picture is shown at half its size, 30 px from the stage's left and 60 from its top.
  const view = { x: 30, y: 60, w: 640, h: 400 };
  const box = { x: 100, y: 200, width: 300, height: 40 };

  it("scales a page box to the picture, follows the scroll since, and lands in canvas pixels", () => {
    expect(pageToStage(box, { x: 0, y: 300 }, frame, view)).toEqual({ x: 80, y: 160, w: 150, h: 20 });
    // Measured at scroll 100; the frame is at 300, so the element is 200 page pixels higher now.
    expect(pageToStage(box, { x: 0, y: 100 }, frame, view)).toEqual({ x: 80, y: 60, w: 150, h: 20 });
    // Without its scroll the box is taken in the frame's own viewport; a point has no size.
    expect(pageToStage({ x: 640, y: 400 }, null, frame, view)).toEqual({ x: 350, y: 260, w: 0, h: 0 });
    // A pinch zoom of 2 doubles it on the picture.
    expect(pageToStage(box, null, { ...frame, scale: 2 }, view)).toEqual({ x: 130, y: 260, w: 300, h: 40 });
    expect(pageToStage(box, null, { ...frame, w: 0 }, view)).toBeNull();
    // A ratio of 3 is capped at 2; WebGL counts y from the bottom of the 1000 px canvas.
    expect(stageToCanvas({ x: 80, y: 160, w: 150, h: 20 }, 3, 1_000)).toEqual([160, 640, 300, 40]);
    expect(stageToCanvas({ x: 80, y: 160, w: 150, h: 20 }, 1, 500)).toEqual([80, 320, 150, 20]);
  });
});
