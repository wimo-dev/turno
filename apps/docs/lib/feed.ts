import { SITE } from "@/lib/layout.shared";
import { PRODUCTS, type Product } from "@/lib/release-frontmatter";
import { releasePages } from "@/lib/releases";

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * The Atom feed of the release pages, of one product or of both (the feed.xml routes under app/(en)/releases).
 * Built from the same frontmatter as the lists, so it never needs an edit of its own.
 */
export function releaseFeed(product?: Product): Response {
  const pages = releasePages("en", product);
  const home = product ? `/releases/${product}` : "/releases";
  const title = product ? `${PRODUCTS[product].name} releases` : "turno and turno-browser releases";
  // A feed's own date is its newest entry's, so it stays the same until a release is added.
  const updated = `${pages[0]?.data.date ?? "2026-11-16"}T00:00:00Z`;
  const entries = pages.map(
    (page) => `  <entry>
    <id>${SITE}${page.url}</id>
    <title>${escape(page.data.title)}</title>
    <link rel="alternate" type="text/html" href="${SITE}${page.url}"/>
    <updated>${page.data.date}T00:00:00Z</updated>
    <summary>${escape(page.data.description ?? "")}</summary>
  </entry>`,
  );
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${SITE}${home}</id>
  <title>${escape(title)}</title>
  <link rel="alternate" type="text/html" href="${SITE}${home}"/>
  <link rel="self" type="application/atom+xml" href="${SITE}${home}/feed.xml"/>
  <author><name>turno</name></author>
  <updated>${updated}</updated>
${entries.join("\n")}
</feed>
`;
  return new Response(xml, { headers: { "Content-Type": "application/atom+xml; charset=utf-8" } });
}
