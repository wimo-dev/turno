import type * as PageTree from "fumadocs-core/page-tree";
import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { defineDocs } from "fumadocs-mdx/macro";
import { i18n } from "@/lib/i18n";
import { compareVersions, pageFrontmatterSchema } from "./release-frontmatter";

/**
 * One collection for the whole content folder: content/docs is served under /docs and
 * content/releases under /releases, so the site has one page tree, one search index and one
 * llms.txt. The schema adds the release fields on content/releases (lib/release-frontmatter.ts).
 */
const content = defineDocs({
  dir: "content",
  docs: {
    schema: pageFrontmatterSchema,
    // The processed Markdown of each page feeds llms.txt and the "copy as Markdown" button.
    postprocess: { includeProcessedMarkdown: true },
  },
});

export const source = loader({
  baseUrl: "/",
  source: content.toFumadocsSource(),
  i18n,
  plugins: ({ typedPlugin }) => [
    lucideIconsPlugin(),
    // The versions of a product folder, newest first by semver: a new release page is one new
    // file, with no meta.json to keep in order. Under the product's folder, the number is the name.
    typedPlugin({
      name: "release-order",
      transformPageTree: {
        folder(node) {
          const versionOf = (child: PageTree.Node) => {
            const file = child.type === "page" && child.$ref ? this.storage.read(child.$ref) : undefined;
            return file?.format === "page" ? file.data.version : undefined;
          };
          if (!node.children.some(versionOf)) return node;
          const children = node.children
            .map((child) => {
              const version = versionOf(child);
              return version ? { ...child, name: version } : child;
            })
            .sort((a, b) => compareVersions(versionOf(b) ?? "0.0.0", versionOf(a) ?? "0.0.0"));
          return { ...node, children };
        },
      },
    }),
  ],
});

export type SourcePage = NonNullable<ReturnType<typeof source.getPage>>;

/** llms.txt, llms-full.txt and one Markdown file per page (app/llms.*). */
export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${page.data.description ?? ""}
${page.data.date ? `\nReleased ${page.data.date}.\n` : ""}
${await page.data.getText("processed")}`,
});
