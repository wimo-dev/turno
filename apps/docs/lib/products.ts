/**
 * Which product a page is about, from its path without the language prefix: turno-browser for its
 * docs and its releases, both on the combined list of releases, turno elsewhere. Shared by the
 * area list of the sidebar and the product switch, which are client components, so it imports
 * nothing.
 */
export type SidebarProduct = "turno" | "browser" | "releases";

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export function productOf(path: string): SidebarProduct {
  if (under(path, "/docs/browser") || under(path, "/releases/browser")) return "browser";
  if (path === "/releases") return "releases";
  return "turno";
}

/** A pathname without its language prefix ("" for English, "/es" for Spanish). */
export function withoutPrefix(pathname: string, prefix: string): string {
  return prefix && under(pathname, prefix) ? pathname.slice(prefix.length) || "/" : pathname;
}
