import { DocsBody, DocsDescription, DocsPage, DocsTitle, MarkdownCopyButton } from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { PageFooter } from "@/components/docs/page-footer";
import { getMDXComponents } from "@/components/mdx";
import { ReleaseFacts } from "@/components/releases/release-facts";
import { ReleaseList } from "@/components/releases/release-list";
import { placeOf } from "@/lib/areas";
import { i18n } from "@/lib/i18n";
import { REPO } from "@/lib/layout.shared";
import { feedOf, isReleasePage } from "@/lib/releases";
import { type SourcePage, source } from "@/lib/source";

const TEXT: Record<string, { source: string; feed: string; fallback?: string }> = {
  en: { source: "View source", feed: "Feed" },
  es: {
    source: "Ver el código fuente",
    feed: "Feed",
    fallback: "Esta página todavía no está traducida, así que la ves en inglés.",
  },
};

/**
 * Whether a page of another language is the English page standing in for a missing translation:
 * the loader gives every language the English files it does not have, as the same objects.
 */
function isFallback(page: SourcePage, lang: string, slugs: string[]): boolean {
  if (lang === i18n.defaultLanguage) return false;
  return source.getPage(slugs, i18n.defaultLanguage)?.data === page.data;
}

/** The file of a page in the repository: `page.path` names the English file even for a translation. */
function sourceFile(page: SourcePage): string {
  const marker = "/content/";
  const at = page.absolutePath?.lastIndexOf(marker) ?? -1;
  return at === -1 ? page.path : page.absolutePath!.slice(at + marker.length);
}

/**
 * A page of the content folder, by its full slugs: the docs route passes ["docs", ...] and the
 * releases route ["releases", ...]. A release page gets its facts (date, packages, older and
 * newer) from its frontmatter, under the title.
 */
export function DocsPageView({ lang, slugs }: { lang: string; slugs: string[] }) {
  const page = source.getPage(slugs, lang);
  if (!page) notFound();

  const t = TEXT[lang] ?? TEXT.en!;
  const fallback = isFallback(page, lang, slugs) && t.fallback;
  // The English text of a fallback page says so to screen readers and translators.
  const contentLang = fallback ? i18n.defaultLanguage : undefined;
  const place = placeOf(source.getPageTree(lang), lang, page.url);
  // The three lists of releases (the pages under /releases that are not a version) offer their
  // feed next to the other page actions.
  const feed = isReleasePage(page) ? undefined : feedOf(page.url, lang);
  const MDX = page.data.body;
  return (
    <DocsPage toc={page.data.toc} full={page.data.full} breadcrumb={{ enabled: false }} slots={{ footer: PageFooter }}>
      <header className="d-head">
        {fallback ? <p className="d-fallback">{fallback}</p> : null}
        {place ? (
          <p className="d-eyebrow">
            <Link href={place.area.href}>{place.area.name}</Link>
            {place.groups.map((group) => (
              <span key={group}>
                <span aria-hidden className="d-eyebrow-sep">
                  /
                </span>
                {group}
              </span>
            ))}
          </p>
        ) : null}
        <DocsTitle lang={contentLang} className="d-title">
          {page.data.title}
        </DocsTitle>
        <DocsDescription lang={contentLang} className="d-description">
          {page.data.description}
        </DocsDescription>
        <div className="d-actions">
          <MarkdownCopyButton markdownUrl={`${page.url}.md`} className="d-action" />
          <a href={`${REPO}/blob/main/apps/docs/content/${encodeURI(sourceFile(page))}`} rel="noreferrer noopener" target="_blank" className="d-action">
            {t.source}
          </a>
          {feed ? (
            <a href={feed.href} type="application/atom+xml" className="d-action">
              {t.feed}
            </a>
          ) : null}
        </div>
      </header>
      {isReleasePage(page) ? <ReleaseFacts page={page} lang={lang} /> : null}
      <DocsBody lang={contentLang}>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            // The lists link the pages of the reader's language.
            ReleaseList: (props: ComponentProps<typeof ReleaseList>) => <ReleaseList {...props} lang={lang} />,
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

/** The slugs of one language under one section ("docs" or "releases"), for generateStaticParams. */
export function pageParams(lang: string, section: string) {
  return source
    .generateParams()
    .filter((p) => p.lang === lang && p.slug[0] === section)
    .map((p) => ({ slug: p.slug.slice(1) }));
}

export function pageMetadata(lang: string, slugs: string[]): Metadata {
  const page = source.getPage(slugs, lang);
  if (!page) notFound();
  const feed = feedOf(page.url, lang);
  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      types: {
        "text/markdown": `${page.url}.md`,
        ...(feed ? { "application/atom+xml": [{ url: feed.href, title: feed.title }] } : {}),
      },
    },
  };
}
