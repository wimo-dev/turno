import { createMDX } from "fumadocs-mdx/next";

/**
 * A permanent redirect, for English and for Spanish under /es, and for the Markdown of the page
 * (its address plus .md), which would otherwise fall through to the rewrite below and not be found.
 */
const moved = (from, to) =>
  ["", "/es"].flatMap((lang) => [
    { source: `${lang}${from}.md`, destination: `${lang}${to}.md`, permanent: true },
    { source: `${lang}${from}`, destination: `${lang}${to}`, permanent: true },
  ]);

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Pages that moved keep their old address.
  async redirects() {
    return [
      ...moved("/docs/browser-alternatives", "/docs/browser/alternatives"),
      ...moved("/docs/reference/turno-browser", "/docs/browser/reference/cli"),
      ...moved("/docs/releases", "/releases"),
      // Releases had one page per turno version, with both products in it. Each old address goes
      // to that version's turno-cli page, which links the turno-browser page of the same release.
      // 0.1.0 and 0.1.1 came out the same day and share the 0.1.1 page.
      ...moved("/docs/releases/v0-1-0", "/releases/cli/0-1-1"),
      ...moved("/docs/releases/v:version(\\d+-\\d+-\\d+)", "/releases/cli/:version"),
    ];
  },
  // The Markdown of each page, for agents and the "copy as Markdown" button (lib/source.ts).
  async rewrites() {
    return [{ source: "/:path*.md", destination: "/llms.mdx/:path*.md" }];
  },
};

export default createMDX()(config);
