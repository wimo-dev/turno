import Link from "next/link";
import { PRODUCTS } from "@/lib/release-frontmatter";
import { type ReleasePage, releaseNeighbors, releasePageOf } from "@/lib/releases";
import { releaseDate, releasedPackage } from "./data";
import { PackageChip } from "./package-chip";

/**
 * The facts of a release page, under its title, all from the frontmatter: the day, the package
 * with its GitHub release and changelog, the packages published with it (linking their own page
 * when they have one), and the older and newer versions of the same product by semver. The page
 * view renders it, so the MDX starts with the text.
 */
export function ReleaseFacts({ page, lang }: { page: ReleasePage; lang: string }) {
  const { product, version, date } = page.data;
  const pkg = releasedPackage(`${PRODUCTS[product].package}@${version}`);
  const siblings = (page.data.with ?? []).map((tag) => ({ pkg: releasedPackage(tag), page: releasePageOf(tag, lang) }));
  const { older, newer } = releaseNeighbors(page, lang);

  return (
    <div className="d-rel">
      <dl className="d-rel-facts">
        <div className="d-rel-fact">
          <dt>Released</dt>
          <dd>
            <time dateTime={date}>{releaseDate(date)}</time>
          </dd>
        </div>
        <div className="d-rel-fact">
          <dt>Package</dt>
          <dd>
            <ul className="d-rel-pkgs">
              <li className="d-rel-pkg">
                <PackageChip name={pkg.name} version={pkg.version} />
                <ExternalLinks release={pkg.release} changelog={pkg.changelog} />
              </li>
            </ul>
          </dd>
        </div>
        {siblings.length > 0 ? (
          <div className="d-rel-fact d-rel-fact-wide">
            <dt>Released together with</dt>
            <dd>
              <ul className="d-rel-pkgs">
                {siblings.map((sibling) => (
                  <li key={sibling.pkg.name} className="d-rel-pkg">
                    <PackageChip name={sibling.pkg.name} version={sibling.pkg.version} />
                    {sibling.page ? (
                      <span className="d-rel-pkg-links">
                        <Link href={sibling.page.url}>Release notes</Link>
                      </span>
                    ) : (
                      <ExternalLinks release={sibling.pkg.release} changelog={sibling.pkg.changelog} />
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
      <nav aria-label="Other versions" className="d-rel-nav">
        {older ? (
          <Link href={older.url} className="d-rel-step">
            <span aria-hidden>←</span>
            <span className="d-rel-step-dir">Older</span>
            <span className="d-rel-step-name">{older.data.title}</span>
          </Link>
        ) : (
          <span className="d-rel-step d-rel-step-none">
            <span className="d-rel-step-dir">The first release</span>
          </span>
        )}
        {newer ? (
          <Link href={newer.url} className="d-rel-step">
            <span className="d-rel-step-dir">Newer</span>
            <span className="d-rel-step-name">{newer.data.title}</span>
            <span aria-hidden>→</span>
          </Link>
        ) : (
          <span className="d-rel-step d-rel-step-none">
            <span className="d-rel-step-dir">The latest release</span>
          </span>
        )}
      </nav>
    </div>
  );
}

function ExternalLinks({ release, changelog }: { release: string; changelog: string }) {
  return (
    <span className="d-rel-pkg-links">
      <a href={release} rel="noreferrer noopener">
        GitHub release<span aria-hidden> ↗</span>
      </a>
      <a href={changelog} rel="noreferrer noopener">
        Changelog<span aria-hidden> ↗</span>
      </a>
    </span>
  );
}
