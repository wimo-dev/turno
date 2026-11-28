"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { AreaLists } from "@/lib/areas";
import { productOf, withoutPrefix } from "@/lib/products";

/**
 * The areas of the product the page is about, at the top of the sidebar: turno's on its pages,
 * turno-browser's on its docs and releases, and both products' releases on the combined list.
 * Each area is a folder with its own sidebar, so this is how a reader moves between them; the
 * current one is filled with turno's blue, like the section rail of the landing page.
 */
export function AreaTabs({ lists, prefix, label }: { lists: AreaLists; prefix: string; label: string }) {
  const pathname = usePathname();
  const areas = lists[productOf(withoutPrefix(pathname, prefix))];
  // Areas nest (/docs holds /docs/reference), so the longest matching prefix is the current one.
  const current = areas
    .filter((area) => pathname === area.href || pathname.startsWith(`${area.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <nav aria-label={label} className="d-areas">
      {areas.map((area) => (
        <Link key={area.id} href={area.href} className="d-area" aria-current={area === current ? "true" : undefined}>
          <span className="d-area-name">{area.name}</span>
          <span className="d-area-count" aria-hidden>
            {area.count}
          </span>
        </Link>
      ))}
    </nav>
  );
}
