// Matches the tool calls of a run with the input events the fixture pages recorded (see
// RECORDER in fixtures.mjs). Pure functions, so the unit tests feed them synthetic runs.
//
// Each action call (click, type, fill a form, select) owns the events from its start until the
// next call starts. An action is:
//   ok       every event it caused landed on an element the call named
//   wrong    an event landed on an element the call did not name (the wrong-element rate)
//   none     the call succeeded and no input event reached the page
//   refused  the call returned an error (Playwright refused it, for example a covered button)

/** The input events each action tool causes on its target. */
const LANDING = {
  browser_click: ["pointerdown", "click"],
  browser_type: ["input", "keydown"],
  browser_fill_form: ["pointerdown", "click", "input", "change", "keydown"],
  browser_select_option: ["input", "change"],
};

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The events of step `i`: from its start (less `slackMs` for clock rounding) to the next step's start. */
function eventsOf(steps, i, events, slackMs) {
  const from = steps[i].start - slackMs;
  const to = i + 1 < steps.length ? steps[i + 1].start - slackMs : steps[i].end + 2000;
  return events.filter((e) => e.t >= from && e.t < to);
}

/** One outcome per action step of a run. */
export function auditActions(steps, events, { slackMs = 5 } = {}) {
  const out = [];
  for (const [i, s] of steps.entries()) {
    if (!s.intents || !LANDING[s.tool]) continue;
    if (s.error) {
      out.push({ step: i, tool: s.tool, outcome: "refused" });
      continue;
    }
    const landed = eventsOf(steps, i, events, slackMs).filter((e) => LANDING[s.tool].includes(e.type));
    if (!landed.length) {
      out.push({ step: i, tool: s.tool, outcome: "none" });
      continue;
    }
    const wanted = new Set(s.intents.map((x) => norm(x.name)).filter(Boolean));
    const stray = landed.filter((e) => !(e.names ?? []).some((n) => wanted.has(norm(n))));
    out.push(
      stray.length
        ? {
            step: i,
            tool: s.tool,
            outcome: "wrong",
            wanted: s.intents.map((x) => x.name),
            landed: [...new Set(stray.map((e) => e.names?.[0] ?? e.tag))],
          }
        : { step: i, tool: s.tool, outcome: "ok" },
    );
  }
  return out;
}

/**
 * How each successful click's time splits around its input events, from the page's own clock:
 * `beforeMs` from the call to the press (finding the element, waiting for it to be actionable,
 * scrolling, moving the pointer), `inputMs` from the press to the click event, and `afterMs` from
 * the click event to the result (the settle wait, any wait for the requests the click started,
 * and the result itself). `requests` tells whether the click made the page send a request.
 */
export function clickTimings(steps, events, requests = [], { slackMs = 5 } = {}) {
  const out = [];
  for (const [i, s] of steps.entries()) {
    if (s.tool !== "browser_click" || s.error) continue;
    const own = eventsOf(steps, i, events, slackMs);
    const down = own.find((e) => e.type === "pointerdown");
    const click = down && own.find((e) => e.type === "click" && e.t >= down.t);
    if (!click) continue;
    out.push({
      beforeMs: Math.round(down.t - s.start),
      inputMs: Math.round(((click.ts ?? click.t) - (down.ts ?? down.t)) * 10) / 10,
      afterMs: Math.round(s.end - click.t),
      requests: requests.some((r) => r.t >= click.t && r.t <= s.end),
    });
  }
  return out;
}
