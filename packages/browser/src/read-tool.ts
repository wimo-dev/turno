import { sections, textOf } from "./batch.js";
import { compactSnapshot, readPart, shortenPart, snapshotYaml } from "./snapshot-compact.js";
import type { TurnoTool } from "./tools.js";
import { type ToolSchema, upstream } from "./upstream.js";

/**
 * `browser_read`: one part of the current page by ref, or the whole page as upstream writes it.
 * Snapshots are compact, and a long page's snapshot is a table of contents
 * (`snapshot-compact.ts`); this is how the model reads the rest. It takes a fresh snapshot each
 * time, so it reads the page as it is now; refs are upstream's and do not change.
 */

function readSchema(): ToolSchema {
  const z = upstream().utils.z;
  return {
    name: "browser_read",
    title: "Read part of the page",
    description: [
      "Read one part of the current page by its ref: a heading's part (up to the next heading of its level), a landmark, a list, a table or any element.",
      "Use it when a snapshot is a table of contents of a long page, or to read a part in full.",
      "Without target it reads the whole page. With full: true the part comes as the browser wrote it, every wrapper, ref and link destination included; otherwise it is compact like a snapshot.",
    ].join(" "),
    inputSchema: z.object({
      target: z.string().optional().describe("The ref of the part to read, from a snapshot or a table of contents"),
      full: z.boolean().optional().describe("Return the part uncompacted (default false)"),
    }),
    type: "readOnly",
  };
}

/** The tool. Its schema is built on first use, so importing the registry does not load the bundle. */
export function readTool(): TurnoTool {
  let schema: ToolSchema | undefined;
  return {
    get schema() {
      schema ??= readSchema();
      return schema;
    },
    async handle(ctx, params) {
      const stock = ctx.stock;
      if (!stock) throw new Error("browser_read needs the browser host");
      const target = typeof params.target === "string" ? params.target.trim() : "";
      const full = params.full === true;
      const snap = await stock.call("browser_snapshot", {}, { snapshot: true });
      if (snap.isError) return snap;
      const parts = sections(textOf(snap));
      const yaml = snapshotYaml(textOf(snap));
      if (yaml === undefined) return snap;
      let body: string;
      if (target) {
        const part = readPart(yaml, target);
        if (part === undefined)
          return {
            content: [
              {
                type: "text",
                text: `### Error\nNo element on the page has the ref ${target} now. Take a snapshot for the current refs.`,
              },
            ],
            isError: true,
          };
        body = full ? part : shortenPart(compactSnapshot(part));
      } else body = full ? yaml : compactSnapshot(yaml);
      const out: string[] = [];
      for (const title of ["Open tabs", "Page", "Modal state"]) {
        const text = parts.get(title);
        if (text) out.push(`### ${title}`, text);
      }
      out.push("### Snapshot", "```yaml", body, "```");
      return { content: [{ type: "text", text: out.join("\n") }] };
    },
  };
}
