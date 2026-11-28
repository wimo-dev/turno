import Link from "next/link";
import type { ReactNode } from "react";
import { releaseDate, releasedPackage } from "./data";
import { PackageChip } from "./package-chip";

/**
 * Every version on one blue line, newest first: the landing's thread, with versions hanging on it
 * instead of chapters. The latest release is open (packages, a summary that names its features,
 * the way in); earlier ones are a line each. The release pages of content/releases are listed
 * from their frontmatter by ReleaseList (release-list.tsx), which draws each entry with Release.
 */
export function ReleaseLine({ children }: { children: ReactNode }) {
  return <ol className="d-line">{children}</ol>;
}

export function Release({
  version,
  date,
  href,
  packages = [],
  latest = false,
  name = "turno",
  flag = "Latest release",
  children,
}: {
  version: string;
  date: string;
  href: string;
  packages?: string[];
  latest?: boolean;
  /** The product the version belongs to, in front of the number. */
  name?: string;
  /** The label of the latest version, over its date. */
  flag?: string;
  children?: ReactNode;
}) {
  const list = packages.map(releasedPackage);
  return (
    <li className="d-line-item" data-latest={latest ? "" : undefined}>
      <span aria-hidden className="d-line-knot" />
      <p className="d-line-meta">
        {latest ? <span className="d-line-flag">{flag}</span> : null}
        <time dateTime={date}>{releaseDate(date)}</time>
      </p>
      <h2 className="d-line-version">
        <Link href={href}>
          <span className="d-line-name">{name} </span>
          {version}
        </Link>
      </h2>
      {list.length > 0 ? (
        <ul className="d-line-pkgs" aria-label="Packages">
          {list.map((pkg) => (
            <li key={pkg.name}>
              <PackageChip name={pkg.name} version={pkg.version} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="d-line-summary">{children}</div>
      <Link href={href} className={latest ? "d-line-go d-line-go-strong" : "d-line-go"}>
        Read the release notes<span className="sr-only">
          {" "}
          for {name} {version}
        </span>
        <span aria-hidden>→</span>
      </Link>
    </li>
  );
}
