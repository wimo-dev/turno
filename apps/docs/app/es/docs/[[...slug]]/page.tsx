import { DocsPageView, pageMetadata, pageParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

// content/docs is served here: the loader's slugs start with "docs".
export default async function Page({ params }: PageProps<"/es/docs/[[...slug]]">) {
  const { slug = [] } = await params;
  return <DocsPageView lang="es" slugs={["docs", ...slug]} />;
}

export function generateStaticParams() {
  return pageParams("es", "docs");
}

export async function generateMetadata({ params }: PageProps<"/es/docs/[[...slug]]">) {
  const { slug = [] } = await params;
  return pageMetadata("es", ["docs", ...slug]);
}
