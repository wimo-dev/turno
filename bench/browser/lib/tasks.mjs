// The evaluation tasks. Each one is what an agent does for a short request on one fixture
// page, written as a fixed script of MCP tool calls: take a snapshot, act on the refs it shows,
// read errors and recover. A fixed script makes runs comparable (the same calls in every
// configuration); a configuration that breaks a step shows up as a failed task, and one that
// makes the agent need extra calls shows up in the call count. The check reads what the
// fixture site received, never what the script believes.

import { isDeepStrictEqual } from "node:util";
import { CLICKS, PRODUCTS, REPORTS, productPrice, reportValue } from "./fixtures.mjs";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The ref of the first snapshot line with this role and accessible name, like
 * `- button "Save" [ref=e12]`. Throws when the snapshot does not show it, which is a failure
 * of the task (the agent could not see the element).
 */
export function refOf(snapshot, role, name) {
  const re = new RegExp(`^\\s*- ${escapeRe(role)} "${escapeRe(name)}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`, "m");
  const m = re.exec(snapshot);
  if (!m) throw new Error(`the snapshot shows no ${role} "${name}"`);
  return m[1];
}

/** The tabs of a `browser_tabs` result or an "Open tabs" section: index, title, url, current. */
export function parseTabs(text) {
  return [...text.matchAll(/^- (\d+): (\(current\) )?\[(.*)\]\((.*)\)$/gm)].map((m) => ({
    index: Number(m[1]),
    current: Boolean(m[2]),
    title: m[3],
    url: m[4],
  }));
}

async function selectTab(agent, title) {
  const tabs = parseTabs(await agent.must("browser_tabs", { action: "list" }));
  const tab = tabs.find((t) => t.title === title);
  if (!tab) throw new Error(`no tab titled "${title}" (open: ${tabs.map((t) => t.title).join(", ")})`);
  if (!tab.current) await agent.must("browser_tabs", { action: "select", index: tab.index });
  return tabs;
}

/** Waits up to `ms` for the site to receive a task's submission. */
async function received(site, key, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (site.submissions[key] !== undefined) return site.submissions[key];
    await new Promise((r) => setTimeout(r, 50));
  }
  return site.submissions[key];
}

function expectBody(actual, expected) {
  return isDeepStrictEqual(actual, expected)
    ? { ok: true }
    : {
        ok: false,
        detail: `site received ${JSON.stringify(actual) ?? "nothing"}, expected ${JSON.stringify(expected)}`,
      };
}

/**
 * @typedef {object} TaskContext
 * @property {import("./server.mjs").Agent} agent
 * @property {{ url: string, altUrl: string, submissions: Record<string, unknown> }} site
 * @property {unknown} [answer] what a read-only task found
 */

/**
 * A task: `start` (a path on the fixture site) and `goal` (the request in words) are what a
 * model-driven run gets (see --driver in eval.mjs); `run` is the scripted run, and `check` reads
 * what the site received, the same way for both.
 */

export const TASKS = [
  {
    id: "form",
    start: "/form",
    goal: "Create an account for Alice Example, alice@example.com, on the Pro plan, to be contacted by phone, accepting the terms.",
    title: "Fill a sign-up form (text, email, select, radio, checkbox) and submit it",
    smoke: true,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/form` });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_fill_form", {
        fields: [
          { name: "Full name", type: "textbox", target: refOf(snap, "textbox", "Full name"), value: "Alice Example" },
          { name: "Email", type: "textbox", target: refOf(snap, "textbox", "Email"), value: "alice@example.com" },
          { name: "Plan", type: "combobox", target: refOf(snap, "combobox", "Plan"), value: "Pro" },
          { name: "Phone", type: "radio", target: refOf(snap, "radio", "Phone"), value: "true" },
          { name: "Terms", type: "checkbox", target: refOf(snap, "checkbox", "I accept the terms"), value: "true" },
        ],
      });
      await agent.must("browser_click", { target: refOf(snap, "button", "Create account") });
      await agent.must("browser_wait_for", { text: "Account created" });
    },
    async check({ site }) {
      return expectBody(await received(site, "form"), {
        name: "Alice Example",
        email: "alice@example.com",
        plan: "pro",
        contact: "phone",
        terms: true,
      });
    },
  },
  {
    id: "popup",
    start: "/popup",
    goal: "Connect the calendar: approve the authorization window, then confirm the page says the calendar is connected.",
    title: "Approve an authorization popup and come back to the page that opened it",
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/popup` });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_click", { target: refOf(snap, "button", "Connect calendar") });
      await selectTab(agent, "Authorize access");
      const popup = await agent.must("browser_snapshot");
      await agent.must("browser_click", { target: refOf(popup, "button", "Allow") });
      await selectTab(agent, "Integrations");
      await agent.must("browser_wait_for", { text: "Calendar connected" });
    },
    async check({ site }) {
      return expectBody(await received(site, "popup"), { connected: true });
    },
  },
  {
    id: "overlay",
    start: "/overlay",
    goal: "Download the quarterly report.",
    title: "Click a button that a cookie banner covers: read the error, dismiss the banner, retry",
    smoke: true,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/overlay` });
      const snap = await agent.must("browser_snapshot");
      const first = await agent.call("browser_click", { target: refOf(snap, "button", "Download report") });
      if (first.error) {
        await agent.must("browser_click", { target: refOf(snap, "button", "Accept all") });
        await agent.must("browser_click", { target: refOf(snap, "button", "Download report") });
      }
      await agent.must("browser_wait_for", { text: "Download started" });
    },
    async check({ site }) {
      return expectBody(await received(site, "overlay"), { downloaded: true });
    },
  },
  {
    id: "slow",
    start: "/slow",
    goal: "Wait for the order total, then confirm the order.",
    title: "Wait for a slow page and its late data, then confirm the order",
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/slow` });
      await agent.must("browser_wait_for", { text: "Order total" });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_click", { target: refOf(snap, "button", "Confirm order") });
      await agent.must("browser_wait_for", { text: "Order confirmed" });
    },
    async check({ site }) {
      return expectBody(await received(site, "slow"), { confirmed: true });
    },
  },
  {
    id: "tabs",
    start: "/tabs",
    goal: "Open every monthly report, add up their values, and submit the total.",
    title: `Open ${REPORTS} reports in new tabs, read a value from each, submit the sum`,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/tabs` });
      let index = await agent.must("browser_snapshot");
      let sum = 0;
      for (let i = 1; i <= REPORTS; i++) {
        await agent.must("browser_click", { target: refOf(index, "link", `Report ${i}`) });
        await selectTab(agent, `Report ${i}`);
        const found = await agent.must("browser_find", { text: "Value:" });
        const value = /Value: (\d+)/.exec(found)?.[1];
        if (value === undefined) throw new Error(`no value found on report ${i}`);
        sum += Number(value);
        await selectTab(agent, "Monthly reports");
        if (i === REPORTS) index = await agent.must("browser_snapshot");
      }
      await agent.must("browser_type", { target: refOf(index, "textbox", "Total"), text: String(sum) });
      await agent.must("browser_click", { target: refOf(index, "button", "Submit total") });
      await agent.must("browser_wait_for", { text: "Total received" });
    },
    async check({ site }) {
      let total = 0;
      for (let i = 1; i <= REPORTS; i++) total += reportValue(i);
      return expectBody(await received(site, "tabs"), { total });
    },
  },
  {
    id: "shadow",
    start: "/shadow",
    goal: "Apply the promo code SPRING25 to the cart.",
    title: "Type a promo code into a field two shadow roots deep and apply it",
    smoke: true,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/shadow` });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_type", { target: refOf(snap, "textbox", "Promo code"), text: "SPRING25" });
      await agent.must("browser_click", { target: refOf(snap, "button", "Apply code") });
      await agent.must("browser_wait_for", { text: "Code applied" });
    },
    async check({ site }) {
      return expectBody(await received(site, "shadow"), { code: "SPRING25" });
    },
  },
  {
    id: "frames",
    start: "/frames",
    goal: "Save Alice Example as the name on the card, then pay.",
    title: "Fill a form in a same-origin iframe and press a button in a cross-origin iframe",
    smoke: true,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/frames` });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_type", { target: refOf(snap, "textbox", "Name on card"), text: "Alice Example" });
      await agent.must("browser_click", { target: refOf(snap, "button", "Save name") });
      await agent.must("browser_click", { target: refOf(snap, "button", "Pay now") });
    },
    async check({ site }) {
      const holder = expectBody(await received(site, "frames-holder"), { holder: "Alice Example" });
      if (!holder.ok) return holder;
      return expectBody(await received(site, "frames-pay"), { paid: true });
    },
  },
  {
    id: "dialog",
    start: "/dialog",
    goal: "Delete the draft, confirming when asked.",
    title: "Delete a draft behind a confirm() dialog",
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/dialog` });
      const snap = await agent.must("browser_snapshot");
      await agent.must("browser_click", { target: refOf(snap, "button", "Delete draft") });
      await agent.must("browser_handle_dialog", { accept: true });
      await agent.must("browser_wait_for", { text: "Draft deleted" });
    },
    async check({ site }) {
      return expectBody(await received(site, "dialog"), { deleted: true });
    },
  },
  {
    id: "find",
    start: "/catalog",
    goal: "What is the price of Product 287? Answer with the number only, like 12.34.",
    title: `Read one price from a ${PRODUCTS}-row catalog without reading the whole page`,
    async run(ctx) {
      const { agent, site } = ctx;
      await agent.must("browser_navigate", { url: `${site.url}/catalog` });
      const found = await agent.must("browser_find", { text: "Product 287" });
      let price = /\$(\d+\.\d\d)/.exec(found)?.[1];
      if (!price) {
        // The find result did not carry the row: fall back to the whole page, as an agent would.
        const snap = await agent.must("browser_snapshot");
        price = /Product 287\b[^$]*\$(\d+\.\d\d)/.exec(snap)?.[1];
      }
      ctx.answer = price;
    },
    async check(ctx) {
      const expected = (productPrice(287) / 100).toFixed(2);
      return ctx.answer === expected
        ? { ok: true }
        : { ok: false, detail: `answered ${ctx.answer ?? "nothing"}, expected ${expected}` };
    },
  },
  {
    id: "clicks",
    start: "/clicks",
    goal: `Press every Toggle button, then every Save button.`,
    title: `Press ${CLICKS.toggles} buttons that change the page and ${CLICKS.saves} that also send a request`,
    async run({ agent, site }) {
      await agent.must("browser_navigate", { url: `${site.url}/clicks` });
      const snap = await agent.must("browser_snapshot");
      for (let i = 1; i <= CLICKS.toggles; i++)
        await agent.must("browser_click", { target: refOf(snap, "button", `Toggle ${i}`) });
      for (let i = 1; i <= CLICKS.saves; i++)
        await agent.must("browser_click", { target: refOf(snap, "button", `Save ${i}`) });
    },
    async check({ site }) {
      for (let i = 1; i <= CLICKS.saves; i++) {
        const got = await received(site, `clicks-${i}`);
        if (!got?.saved) return { ok: false, detail: `the site received no save ${i}` };
      }
      return { ok: true };
    },
  },
];

/** The tasks a list of ids names, in the suite's order; throws on an unknown id. */
export function pickTasks(ids, { smoke = false } = {}) {
  if (!ids?.length) return smoke ? TASKS.filter((t) => t.smoke) : TASKS;
  for (const id of ids) {
    if (!TASKS.some((t) => t.id === id))
      throw new Error(`unknown task "${id}" (tasks: ${TASKS.map((t) => t.id).join(", ")})`);
  }
  return TASKS.filter((t) => ids.includes(t.id));
}
