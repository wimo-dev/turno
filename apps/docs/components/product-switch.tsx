"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { productOf, withoutPrefix } from "@/lib/products";

const LABEL: Record<string, string> = { en: "Tools", es: "Herramientas" };

/**
 * The two tools of the toolkit, next to the logo: turno and turno-browser. The current one is
 * the tool the page is about: turno-browser on its own page, in its docs and in its releases,
 * turno elsewhere.
 */
export function ProductSwitch({ lang, home, browser }: { lang: string; home: string; browser: string }) {
  const pathname = usePathname();
  const prefix = home === "/" ? "" : home;
  const onBrowser = pathname === browser || pathname.startsWith(`${browser}/`) || productOf(withoutPrefix(pathname, prefix)) === "browser";
  return (
    <nav aria-label={LABEL[lang] ?? LABEL.en} className="d-products">
      {/* No prefetch: the other tool's page would preload styles this page never uses. */}
      <Link href={home} prefetch={false} className="d-product" aria-current={onBrowser ? undefined : "true"}>
        turno
      </Link>
      <Link href={browser} prefetch={false} className="d-product" aria-current={onBrowser ? "true" : undefined}>
        turno-browser
      </Link>
    </nav>
  );
}
