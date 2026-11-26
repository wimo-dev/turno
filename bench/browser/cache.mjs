#!/usr/bin/env node
// Does a recorded flow still act on the right elements after the page changed a little?
//
//   pnpm build && pnpm bench:cache                       # this build
//   pnpm bench:cache --before ../main/packages/browser/dist/bin/mcp.js   # and another build
//
// For each build it starts turno-browser-mcp on a throwaway identity in a throwaway HOME
// (headless), records a flow on a local form by refs, as an agent does (type an email, type a
// name, click Save), and replays it against variants of the page:
//
//   normal     the page as recorded
//   moved      Save moved into a toolbar after a new Cancel button, without its id
//   shuffled   the two fields swapped their ids
//   relabeled  the Email field's label is now "Work email"
//   swapped    Save is now "Submit" without an id, and Cancel took Save's id
//
// The page reports which element got each input and click (by a data attribute the variants
// keep on the element's meaning, never read by turno). Each step of a replay is then:
//
//   hit        it ran on the element it was recorded on
//   refused    it did not run: the element its selector finds is not the recorded one
//   not found  it did not run: no locator found one element
//   wrong      it ran on another element
//
// Then the same steps as single actions by CSS selector (`#email`, `#name`, `#save`), as a
// script, a batch or `turno-browser do` repeats them: the selectors the recording saw. Wrong-element
// actions are counted per 1,000 actions that ran.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_BIN, startServer } from "./lib/server.mjs";

const { values } = parseArgs({
  options: {
    before: { type: "string" },
    rounds: { type: "string", default: "3" },
    json: { type: "boolean", default: false },
  },
});
const ROUNDS = Number(values.rounds);

const VARIANTS = ["normal", "moved", "shuffled", "relabeled", "swapped"];

/** The form, as each variant writes it. `data-k` is what the element is; turno never reads it. */
function form(v) {
  const email = `<label>${v === "relabeled" ? "Work email" : "Email"} <input id="${v === "shuffled" ? "name" : "email"}" data-k="email"></label>`;
  const name = `<label>Name <input id="${v === "shuffled" ? "email" : "name"}" data-k="name"></label>`;
  const save =
    v === "moved"
      ? `<div class="toolbar"><button type="button" data-k="cancel">Cancel</button><button type="button" data-k="save">Save</button></div>`
      : v === "swapped"
        ? `<button type="button" id="save" data-k="cancel">Cancel</button> <button type="button" data-k="save">Submit</button>`
        : `<button type="button" id="save" data-k="save">Save</button>`;
  return `<!doctype html><title>Profile</title><h1>Profile</h1><form>${email}${name}${save}</form>
<script>
const send = (k, t) => fetch("/event?k=" + k + "&t=" + t);
document.addEventListener("click", (e) => { const k = e.target.closest("[data-k]")?.dataset.k; if (k) send(k, "click"); });
document.addEventListener("input", (e) => { const k = e.target.dataset?.k; if (k) send(k, "input"); });
</script>`;
}

async function startSite() {
  const state = { v: "normal", events: [] };
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/event") {
      state.events.push(`${u.searchParams.get("k")}:${u.searchParams.get("t")}`);
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(u.pathname === "/form" ? form(state.v) : "<title>404</title>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What each recorded step must reach: the element and the event. */
const INTENDED = { 2: "email:input", 3: "name:input", 4: "save:click" };

async function measure(name, bin, site) {
  const server = await startServer({ name, bin });
  const tally = { hit: 0, refused: 0, "not found": 0, wrong: 0, steps: 0 };
  const byVariant = {};
  const repeated = {};
  const rtally = { hit: 0, refused: 0, "not found": 0, wrong: 0, steps: 0 };
  try {
    const call = async (tool, args = {}) => {
      const res = await server.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 90_000 });
      return { text: textOf(res), error: Boolean(res.isError) };
    };
    const refOf = (snap, role, label) =>
      new RegExp(`${role} "${label}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snap)?.[1];
    site.state.v = "normal";
    await call("browser_record", { action: "start", name: "profile" });
    await call("browser_navigate", { url: `${site.url}/form` });
    const snap = (await call("browser_snapshot")).text;
    await call("browser_type", { target: refOf(snap, "textbox", "Email"), text: "alice@example.com" });
    await call("browser_type", { target: refOf(snap, "textbox", "Name"), text: "Alice" });
    await call("browser_click", { target: refOf(snap, "button", "Save") });
    const stopped = await call("browser_record", { action: "stop" });
    if (stopped.error) throw new Error(`${name}: recording failed: ${stopped.text}`);
    for (const v of VARIANTS) {
      const row = { hit: 0, refused: 0, "not found": 0, wrong: 0 };
      byVariant[v] = row;
      for (let r = 0; r < ROUNDS; r++) {
        site.state.v = v;
        site.state.events = [];
        const out = await call("browser_replay", { flow: "profile", wait: 1 });
        await sleep(300); // the page's last event request
        for (const [n, want] of Object.entries(INTENDED)) {
          const line = new RegExp(`^${n}\\. .*: (ok|failed)`, "m").exec(out.text)?.[1];
          let kind;
          if (line === "ok") kind = site.state.events.includes(want) ? "hit" : "wrong";
          else if (line === "failed")
            kind = /is not the one this action was recorded on/.test(out.text) ? "refused" : "not found";
          else continue; // an earlier step stopped the replay
          row[kind]++;
          tally[kind]++;
          tally.steps++;
        }
        // The same steps repeated by selector.
        await call("browser_navigate", { url: `${site.url}/form` });
        for (const [selector, tool, args, want] of [
          ["#email", "browser_type", { text: "alice@example.com" }, "email:input"],
          ["#name", "browser_type", { text: "Alice" }, "name:input"],
          ["#save", "browser_click", {}, "save:click"],
        ]) {
          const before = site.state.events.length;
          const res = await call(tool, { target: selector, ...args });
          await sleep(200);
          const got = site.state.events.slice(before);
          const kind = res.error
            ? /is not the one this action was recorded on/.test(res.text)
              ? "refused"
              : "not found"
            : got.includes(want)
              ? "hit"
              : "wrong";
          repeated[v] ??= { hit: 0, refused: 0, "not found": 0, wrong: 0 };
          repeated[v][kind]++;
          rtally[kind]++;
          rtally.steps++;
        }
      }
    }
  } finally {
    await server.stop();
  }
  return { name, tally, byVariant, repeated, rtally };
}

const site = await startSite();
const results = [];
try {
  if (values.before) results.push(await measure("before", resolve(values.before), site));
  results.push(await measure("this build", DEFAULT_BIN, site));
} finally {
  await site.close();
}

if (values.json) console.log(JSON.stringify({ kind: "turno-browser-cache", rounds: ROUNDS, results }, null, 2));
else {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
  const line = (label, t) => {
    const ran = t.hit + t.wrong;
    return `${label}: ${t.steps} steps, hit ${pct(t.hit, t.steps)}, refused ${pct(t.refused, t.steps)}, not found ${pct(t["not found"], t.steps)}, wrong ${t.wrong} (${ran ? Math.round((1000 * t.wrong) / ran) : 0} per 1,000 that ran)`;
  };
  const rows = (by) => {
    for (const [v, row] of Object.entries(by))
      console.log(
        `  ${v.padEnd(10)} hit ${row.hit}, refused ${row.refused}, not found ${row["not found"]}, wrong ${row.wrong}`,
      );
  };
  for (const { name, tally, byVariant, repeated, rtally } of results) {
    console.log(line(`${name}, replay`, tally));
    rows(byVariant);
    console.log(line(`${name}, repeated by selector`, rtally));
    rows(repeated);
  }
}
