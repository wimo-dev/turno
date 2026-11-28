import type { ReactNode } from "react";
import { DocsLayoutView } from "@/components/routes/layouts";

export default function Layout({ children }: { children: ReactNode }) {
  return <DocsLayoutView lang="en">{children}</DocsLayoutView>;
}
