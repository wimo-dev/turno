import { DocsPageView, pageMetadata, pageParams } from "@/components/routes/docs-page";

export const dynamicParams = false;

// content/releases is served here: the loader's slugs start with "releases".
export default async function Page({ params }: PageProps<"/releases/[[...slug]]">) {
  const { slug = [] } = await params;
  return <DocsPageView lang="en" slugs={["releases", ...slug]} />;
}

export function generateStaticParams() {
  return pageParams("en", "releases");
}

export async function generateMetadata({ params }: PageProps<"/releases/[[...slug]]">) {
  const { slug = [] } = await params;
  return pageMetadata("en", ["releases", ...slug]);
}
