#!/usr/bin/env node
// What the page snapshot costs the model, and whether it still answers the same questions.
//
//   pnpm build && pnpm bench:snapshot                  # the local fixture pages
//   pnpm bench:snapshot --public                       # also Hacker News, a Wikipedia article,
//                                                      # a GitHub repository, a search results page
//   pnpm bench:snapshot --json --out results.json
//
// For each page it starts from one built turno-browser-mcp on a throwaway identity in a
// throwaway HOME (headless) and reads, back to back on the same page:
//
//   full      browser_read with full: true: the snapshot as upstream writes it (what every
//             snapshot was before turno-browser compacted them)
//   compact   browser_read without a target: the whole page, compact
//   returned  browser_snapshot: what the model gets (compact, or a table of contents for a
//             long page)
//
// Tokens are bytes / 4, like the evaluation suite counts them. "Refs kept" counts the
// interactive elements of the full snapshot whose ref the compact one still shows. "Answers"
// asks each page a few fixed questions, answered by the same code from the full snapshot and
// from what the model gets: on a table of contents, the code reads the part a question needs
// with browser_read by the ref the table shows, as a model would. An answer that differs is
// listed. Public pages are third-party sites that see the visit, so they run only with
// --public; their content changes, so their numbers are a snapshot of a day.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startSite } from "./lib/fixtures.mjs";
import { DEFAULT_BIN, startServer } from "./lib/server.mjs";
import { estimateTokens } from "./lib/stats.mjs";

const { values } = parseArgs({
  options: {
    public: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    bin: { type: "string" },
  },
});

const bin = values.bin ?? DEFAULT_BIN;
const snap = await import(pathToFileURL(join(dirname(bin), "..", "snapshot-compact.js")).href);

const textOf = (res) => (res?.content ?? []).map((c) => c.text ?? "").join("\n");
const yamlOf = (text) => snap.snapshotYaml(text) ?? "";

/** Names and texts of a snapshot in page order: what a reader of it sees, without refs or URLs. */
function tokens(yaml) {
  const out = [];
  const plain = (v) => {
    if (v === undefined) return undefined;
    try {
      return v.startsWith('"') ? JSON.parse(v) : v;
    } catch {
      return v;
    }
  };
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.parsed && !n.role.startsWith("/")) {
        const name = plain(n.name);
        const value = plain(n.value);
        if (name) out.push({ role: n.role, text: name });
        if (value) out.push({ role: "text", text: value });
      }
      walk(n.children);
    }
  };
  walk(snap.parseSnapshot(yaml));
  return out;
}

/** The node with this role and name, then the first link name inside each list item below it. */
function listLinks(yaml, role, name, n) {
  const find = (nodes) => {
    for (const x of nodes) {
      if (x.role === role && x.name && JSON.parse(x.name) === name) return x;
      const f = find(x.children);
      if (f) return f;
    }
  };
  const root = find(snap.parseSnapshot(yaml));
  if (!root) return undefined;
  const out = [];
  const firstLink = (nodes) => {
    for (const x of nodes) {
      if (x.role === "link" && x.name) return JSON.parse(x.name);
      const f = firstLink(x.children);
      if (f) return f;
    }
  };
  const items = (nodes) => {
    for (const x of nodes) {
      if (x.role === "listitem") {
        const l = firstLink(x.children);
        if (l) out.push(l);
      } else items(x.children);
    }
  };
  items(root.children);
  return out.slice(0, n).join(" | ");
}

const after = (toks, test, pick) => {
  const i = toks.findIndex(test);
  return i < 0 ? undefined : toks.slice(i + 1).find(pick)?.text;
};

/**
 * The pages and their questions. `part` names the heading a question needs read when the
 * snapshot is a table of contents.
 */
function pages(site) {
  const local = [
    {
      id: "form",
      url: `${site.url}/form`,
      questions: [
        { q: "the submit button", a: (y) => tokens(y).find((t) => t.role === "button")?.text },
        {
          q: "the plan choices",
          a: (y) =>
            tokens(y)
              .filter((t) => t.role === "option")
              .map((t) => t.text)
              .join(", "),
        },
      ],
    },
    {
      id: "catalog",
      url: `${site.url}/catalog`,
      questions: [
        {
          q: "the price of Product 287",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.text === "Product 287",
              (t) => /^\$/.test(t.text),
            ),
        },
        { q: "rows", a: (y) => String(tokens(y).filter((t) => /^Product \d+$/.test(t.text)).length) },
      ],
    },
    {
      id: "clicks",
      url: `${site.url}/clicks`,
      questions: [
        {
          q: "buttons",
          a: (y) =>
            tokens(y)
              .filter((t) => t.role === "button")
              .map((t) => t.text)
              .join(", "),
        },
      ],
    },
  ];
  const pub = [
    {
      id: "hacker-news",
      url: "https://news.ycombinator.com/",
      questions: [
        ...[1, 2, 3, 4, 5].map((n) => ({
          q: `story ${n}`,
          a: (y) =>
            after(
              tokens(y),
              (t) => t.text === `${n}.`,
              (t) => t.role === "link" && t.text !== "upvote",
            ),
        })),
        { q: "points of story 1", a: (y) => tokens(y).find((t) => /^\d+ points by/.test(t.text))?.text },
      ],
    },
    {
      id: "wikipedia-article",
      url: "https://en.wikipedia.org/wiki/Python_(programming_language)",
      questions: [
        {
          q: "designed by",
          part: "Python (programming language)",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.text === "Designed by",
              (t) => t.role === "link",
            ),
        },
        {
          q: "first sentence of History",
          part: "History",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.role === "heading" && t.text === "History",
              (t) => t.text.length > 40,
            ),
        },
        {
          q: "first sentence of Typing",
          part: "Typing",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.role === "heading" && t.text === "Typing",
              (t) => t.text.length > 40,
            ),
        },
      ],
    },
    {
      id: "github-repo",
      url: "https://github.com/microsoft/playwright",
      questions: [
        { q: "stars", a: (y) => tokens(y).find((t) => /^Star \(/.test(t.text))?.text },
        {
          q: "first entry",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.text === "Last commit date",
              (t) => t.role === "link",
            ),
        },
        {
          q: "about",
          a: (y) =>
            after(
              tokens(y),
              (t) => t.role === "heading" && t.text === "About",
              (t) => t.text.length > 20,
            ),
        },
      ],
    },
    {
      id: "search-results",
      // DuckDuckGo and Mojeek answer a headless throwaway identity with a challenge or a 403.
      url: "https://en.wikipedia.org/w/index.php?search=browser+automation&fulltext=1&ns0=1",
      questions: [{ q: "top 5 results", a: (y) => listLinks(y, "generic", "Search results", 5) }],
    },
  ];
  return values.public ? [...local, ...pub] : local;
}

/** The ref of the heading with this name in a table of contents. */
function headingRef(toc, name) {
  const re = new RegExp(
    `heading ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[level=\\d\\] \\[ref=(\\w+)\\]`,
  );
  return re.exec(toc)?.[1];
}

const site = await startSite();
const server = await startServer({ name: "default", ...(values.bin ? { bin: values.bin } : {}) });
const rows = [];
try {
  for (const page of pages(site)) {
    const call = async (name, args = {}) => {
      const res = await server.client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
      if (res.isError) throw new Error(`${page.id}: ${name} failed: ${textOf(res).slice(0, 300)}`);
      return textOf(res);
    };
    await call("browser_navigate", { url: page.url });
    const full = yamlOf(await call("browser_read", { full: true }));
    const compact = yamlOf(await call("browser_read"));
    const returned = yamlOf(await call("browser_snapshot"));
    const toc = returned.startsWith("# This page is long");
    const wanted = snap.interactiveRefs(full);
    const kept = new Set(snap.interactiveRefs(compact));
    const answers = [];
    let reads = 0;
    let readTokens = 0;
    for (const q of page.questions) {
      const expected = q.a(full);
      let view = returned;
      if (toc && q.part) {
        const ref = headingRef(returned, q.part);
        if (ref) {
          view = yamlOf(await call("browser_read", { target: ref }));
          reads++;
          readTokens += estimateTokens(Buffer.byteLength(view));
        }
      }
      const got = q.a(view);
      answers.push({ q: q.q, same: expected !== undefined && got === expected, expected, got });
    }
    rows.push({
      page: page.id,
      fullTokens: estimateTokens(Buffer.byteLength(full)),
      compactTokens: estimateTokens(Buffer.byteLength(compact)),
      returnedTokens: estimateTokens(Buffer.byteLength(returned)),
      toc,
      reads,
      readTokens,
      interactive: wanted.length,
      refsKept: wanted.filter((r) => kept.has(r)).length,
      answers,
    });
  }
} finally {
  await server.stop();
  await site.close();
}

const report = { kind: "turno-browser-snapshot", at: new Date().toISOString(), public: values.public, rows };
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  const fmt = (n) => n.toLocaleString("en-US");
  const pct = (a, b) => `${Math.round((1 - a / b) * 100)}%`;
  const table = [["PAGE", "FULL", "COMPACT", "RETURNED", "LESS", "REFS KEPT", "ANSWERS SAME"]];
  for (const r of rows)
    table.push([
      r.page,
      fmt(r.fullTokens),
      `${fmt(r.compactTokens)} (-${pct(r.compactTokens, r.fullTokens)})`,
      `${fmt(r.returnedTokens)}${r.toc ? " (contents)" : ""}`,
      `-${pct(r.returnedTokens, r.fullTokens)}`,
      `${r.refsKept}/${r.interactive}`,
      `${r.answers.filter((a) => a.same).length}/${r.answers.length}${r.reads ? ` (${r.reads} part reads, ${fmt(r.readTokens)} tokens)` : ""}`,
    ]);
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => String(r[i]).length)));
  console.log(
    table
      .map((r) =>
        r
          .map((c, i) => String(c).padEnd(widths[i]))
          .join("  ")
          .trimEnd(),
      )
      .join("\n"),
  );
  for (const r of rows)
    for (const a of r.answers.filter((x) => !x.same))
      console.log(
        `\n${r.page}, ${a.q}: full says ${JSON.stringify(a.expected)}, the model's view says ${JSON.stringify(a.got)}`,
      );
}
process.exit(rows.every((r) => r.refsKept === r.interactive && r.answers.every((a) => a.same)) ? 0 : 1);
