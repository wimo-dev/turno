import { compareVersions, PRODUCTS, type Product, parseTag, type ReleaseFrontmatter } from "@/lib/release-frontmatter";
import { type SourcePage, source } from "@/lib/source";

/*
 * The release pages of content/releases, read from their frontmatter: the lists, the feeds and
 * the facts at the top of each page all come from here, so a new release is one new file.
 */

export type ReleasePage = SourcePage & { data: SourcePage["data"] & ReleaseFrontmatter };

export function isReleasePage(page: SourcePage): page is ReleasePage {
  return page.data.product !== undefined && page.data.version !== undefined && page.data.date !== undefined;
}

/** Newest first by date; on the same day, by product (turno before turno-browser), then by version. */
function newestFirst(a: ReleasePage, b: ReleasePage): number {
  return (
    b.data.date.localeCompare(a.data.date) ||
    Object.keys(PRODUCTS).indexOf(a.data.product) - Object.keys(PRODUCTS).indexOf(b.data.product) ||
    compareVersions(b.data.version, a.data.version)
  );
}

/** Every release page of one language, of one product or of both, newest first. */
export function releasePages(lang: string, product?: Product): ReleasePage[] {
  return source
    .getPages(lang)
    .filter(isReleasePage)
    .filter((page) => !product || page.data.product === product)
    .sort(newestFirst);
}

/** The release just before and just after a page in its own product, by semver. */
export function releaseNeighbors(page: ReleasePage, lang: string): { older?: ReleasePage; newer?: ReleasePage } {
  const versions = releasePages(lang, page.data.product).sort((a, b) => compareVersions(a.data.version, b.data.version));
  const at = versions.findIndex((other) => other.data.version === page.data.version);
  return { older: versions[at - 1], newer: versions[at + 1] };
}

/** The release page of a package written as its git tag (`turno-cli@0.6.1`), when it has one. */
export function releasePageOf(tag: string, lang: string): ReleasePage | undefined {
  const parsed = parseTag(tag);
  const product = (Object.keys(PRODUCTS) as Product[]).find((p) => PRODUCTS[p].package === parsed?.name);
  if (!parsed || !product) return undefined;
  return releasePages(lang, product).find((page) => page.data.version === parsed.version);
}

/** The Atom feed of a releases page: the product's own, or both on /releases. English only. */
export function feedOf(url: string, lang: string): { href: string; title: string } | undefined {
  // English URLs have no prefix; another language's start with it (/es/releases).
  const path = url.startsWith(`/${lang}/`) ? url.slice(lang.length + 1) : url;
  for (const product of Object.keys(PRODUCTS) as Product[]) {
    if (path === `/releases/${product}` || path.startsWith(`/releases/${product}/`)) {
      return { href: `/releases/${product}/feed.xml`, title: `${PRODUCTS[product].name} releases` };
    }
  }
  return path === "/releases" ? { href: "/releases/feed.xml", title: "turno and turno-browser releases" } : undefined;
}
