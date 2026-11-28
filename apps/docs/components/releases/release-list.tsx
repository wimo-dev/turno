import { PRODUCTS, type Product } from "@/lib/release-frontmatter";
import { releasePages } from "@/lib/releases";
import { Release, ReleaseLine } from "./release-line";

/**
 * Every release page on the blue line, newest first, from the pages' frontmatter: a new release
 * file shows up here with no edit to the list.
 *
 *   <ReleaseList />                    both products, each entry named with its product
 *   <ReleaseList product="browser" />  one product
 *
 * The newest version of each product is marked. `lang` is set by the page view.
 */
export function ReleaseList({ product, lang = "en" }: { product?: Product; lang?: string }) {
  const pages = releasePages(lang, product);
  const latest = new Set((Object.keys(PRODUCTS) as Product[]).map((p) => pages.find((page) => page.data.product === p)));
  return (
    <ReleaseLine>
      {pages.map((page) => {
        const name = PRODUCTS[page.data.product].name;
        return (
          <Release
            key={page.url}
            version={page.data.version}
            date={page.data.date}
            href={page.url}
            name={name}
            latest={latest.has(page)}
            flag={product ? "Latest release" : `Latest ${name}`}
          >
            <p>{page.data.description}</p>
          </Release>
        );
      })}
    </ReleaseLine>
  );
}
