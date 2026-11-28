import { DocsPageView, pageMetadata, pageParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

// content/docs is served here: the loader's slugs start with "docs".
export default async function Page({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug = [] } = await params;
  return <DocsPageView lang="en" slugs={["docs", ...slug]} />;
}

export function generateStaticParams() {
  return pageParams("en", "docs");
}

export async function generateMetadata({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug = [] } = await params;
  return pageMetadata("en", ["docs", ...slug]);
}
