import { DocsPageView, pageMetadata, pageParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

// content/releases is served here: the loader's slugs start with "releases".
export default async function Page({ params }: PageProps<"/es/releases/[[...slug]]">) {
  const { slug = [] } = await params;
  return <DocsPageView lang="es" slugs={["releases", ...slug]} />;
}

export function generateStaticParams() {
  return pageParams("es", "releases");
}

export async function generateMetadata({ params }: PageProps<"/es/releases/[[...slug]]">) {
  const { slug = [] } = await params;
  return pageMetadata("es", ["releases", ...slug]);
}
