import type * as PageTree from "fumadocs-core/page-tree";
import type { ReactNode } from "react";
import { localePath } from "@/lib/layout.shared";
import type { SidebarProduct } from "@/lib/products";

/**
 * The areas of the site, each a folder of the page tree with its own home. The root folders of
 * content/docs are `(docs)` (a folder group, so its pages keep their URLs), `browser`
 * (turno-browser's own docs), `reference` and `troubleshooting`; content/releases is one more,
 * with a folder per product. The sidebar lists the areas of the product the page is about.
 */
export type AreaId = "docs" | "reference" | "troubleshooting" | "releases" | "browser" | "browser-releases" | "whats-new";

const PATHS: Record<AreaId, string> = {
  docs: "/docs",
  reference: "/docs/reference",
  troubleshooting: "/docs/troubleshooting",
  releases: "/releases/cli",
  browser: "/docs/browser",
  "browser-releases": "/releases/browser",
  "whats-new": "/releases",
};

/** The areas each product's sidebar lists, in order; the combined releases page lists both products' releases. */
const SIDEBARS: Record<SidebarProduct, AreaId[]> = {
  turno: ["docs", "reference", "troubleshooting", "releases"],
  browser: ["browser", "browser-releases", "troubleshooting"],
  releases: ["whats-new", "releases", "browser-releases"],
};

/**
 * Where a page sits, for the label over its title: the first area whose folder holds it. The
 * product folders of releases come before the releases root, and turno-browser's docs come last,
 * since its sidebar also links pages of other areas (environment variables, what's new).
 */
const PLACE_ORDER: AreaId[] = ["docs", "reference", "troubleshooting", "releases", "browser-releases", "whats-new", "browser"];

/**
 * Two names per area: the short one inside a product's own list, where the product is clear,
 * and the full one where both products meet (the combined list, the label over a title).
 */
const NAMES: Record<string, { short: Record<AreaId, string>; full: Record<AreaId, string> }> = {
  en: {
    short: {
      docs: "Docs",
      reference: "Reference",
      troubleshooting: "Troubleshooting",
      releases: "Releases",
      browser: "Docs",
      "browser-releases": "Releases",
      "whats-new": "What's new",
    },
    full: {
      docs: "Docs",
      reference: "Reference",
      troubleshooting: "Troubleshooting",
      releases: "turno releases",
      browser: "turno-browser",
      "browser-releases": "turno-browser releases",
      "whats-new": "What's new",
    },
  },
  es: {
    short: {
      docs: "Documentación",
      reference: "Referencia",
      troubleshooting: "Solución de problemas",
      releases: "Versiones",
      browser: "Documentación",
      "browser-releases": "Versiones",
      "whats-new": "Novedades",
    },
    full: {
      docs: "Documentación",
      reference: "Referencia",
      troubleshooting: "Solución de problemas",
      releases: "Versiones de turno",
      browser: "turno-browser",
      "browser-releases": "Versiones de turno-browser",
      "whats-new": "Novedades",
    },
  },
};

export interface AreaLink {
  id: AreaId;
  href: string;
  name: string;
  /** How many pages the area holds, shown next to its name. */
  count: number;
}

/** The area lists of every product, for the sidebar to pick from by the current path. */
export type AreaLists = Record<SidebarProduct, AreaLink[]>;

/**
 * The pages of an area. A link to another area (turno-browser's sidebar links the environment
 * variables and what's new) is not one of them; a page file always is.
 */
function countPages(nodes: PageTree.Node[], href: string): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "page") n += node.external || (!node.$ref && !node.url.startsWith(href)) ? 0 : 1;
    else if (node.type === "folder") n += (node.index ? 1 : 0) + countPages(node.children, href);
  }
  return n;
}

/** The folder that holds an area: the one whose index, or first page, is the area's home. */
function areaFolder(nodes: PageTree.Node[], href: string): PageTree.Folder | undefined {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    const first = node.index ?? node.children.find((child) => child.type === "page");
    if (first?.type === "page" && first.url === href) return node;
    const inner = areaFolder(node.children, href);
    if (inner) return inner;
  }
  return undefined;
}

function areaLink(tree: PageTree.Root, lang: string, id: AreaId, names: Record<AreaId, string>): AreaLink {
  const href = localePath(lang, PATHS[id]);
  const folder = areaFolder(tree.children, href);
  // A root folder lists its home among its children; a product folder of releases holds it as its index.
  return { id, href, name: names[id], count: folder ? (folder.index ? 1 : 0) + countPages(folder.children, href) : 0 };
}

export function areaLists(tree: PageTree.Root, lang: string): AreaLists {
  const names = NAMES[lang] ?? NAMES.en!;
  const list = (product: SidebarProduct, kind: "short" | "full") => SIDEBARS[product].map((id) => areaLink(tree, lang, id, names[kind]));
  return { turno: list("turno", "short"), browser: list("browser", "short"), releases: list("releases", "full") };
}

export interface PagePlace {
  /** The area the page belongs to, with a link to its home. */
  area: { name: string; href: string };
  /** The sidebar groups above the page inside its area: folders, then the nearest separator. */
  groups: string[];
}

/** Where a page sits in the sidebar, for the label over its title. */
export function placeOf(tree: PageTree.Root, lang: string, url: string): PagePlace | undefined {
  const names = (NAMES[lang] ?? NAMES.en!).full;
  for (const id of PLACE_ORDER) {
    const href = localePath(lang, PATHS[id]);
    const folder = areaFolder(tree.children, href);
    if (!folder) continue;
    const groups = folder.index?.url === url ? [] : groupsTo(folder.children, url);
    if (groups) return { area: { name: names[id], href }, groups };
  }
  return undefined;
}

/** The folder names and the last separator on the way to `url`, or undefined when it is not there. */
function groupsTo(nodes: PageTree.Node[], url: string): string[] | undefined {
  let separator: ReactNode;
  for (const node of nodes) {
    if (node.type === "separator") separator = node.name;
    else if (node.type === "page" && node.url === url) return typeof separator === "string" ? [separator] : [];
    else if (node.type === "folder") {
      if (node.index?.url === url) return typeof node.name === "string" ? [node.name] : [];
      const inner = groupsTo(node.children, url);
      if (inner) return typeof node.name === "string" ? [node.name, ...inner] : inner;
    }
  }
  return undefined;
}
