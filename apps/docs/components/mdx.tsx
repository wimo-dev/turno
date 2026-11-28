import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { Callout, Card, Cards } from "@/components/docs/cards";
import { FindingFilter } from "@/components/docs/finding-filter";
import { FolderTree } from "@/components/diagrams/folder-tree";
import { GatewayDiagram } from "@/components/diagrams/gateway";
import { ScopeTree } from "@/components/diagrams/scope-tree";
import { StatusLine } from "@/components/diagrams/status-line";
import { Install } from "@/components/install";
import { Recording } from "@/components/recording";
import { Highlight } from "@/components/releases/highlight";
import { ReleaseList } from "@/components/releases/release-list";
import { Upgrade } from "@/components/releases/upgrade";

const MdxImage = defaultMdxComponents.img;

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    // The site has a handful of images, so they load with the page: a lazy one stays blank in
    // print and in full-page captures until it is scrolled to.
    img: (props: ComponentProps<typeof MdxImage>) => <MdxImage {...props} loading="eager" />,
    // Cards and callouts in the site's own look (components/docs/cards.tsx), same props.
    Card,
    Cards,
    Callout,
    FindingFilter,
    Tab,
    Tabs,
    Step,
    Steps,
    Install,
    Recording,
    GatewayDiagram,
    FolderTree,
    StatusLine,
    ScopeTree,
    // Release pages (content/releases; docs/RELEASING.md).
    ReleaseList,
    Highlight,
    Upgrade,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
