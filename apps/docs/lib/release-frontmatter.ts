import { pageSchema } from "fumadocs-core/source/schema";

/*
 * The frontmatter of the pages in content/releases, checked when each file is compiled, so a
 * wrong value fails the build with the file and the field. lib/source.ts evaluates this module
 * at build time outside Next, so it imports packages and relative files only, never `@/`.
 */

/** The two products with release pages: the folder name, the name a reader knows, the package. */
export const PRODUCTS = {
  cli: { name: "turno", package: "turno-cli" },
  browser: { name: "turno-browser", package: "turno-browser" },
} as const;

export type Product = keyof typeof PRODUCTS;

/** The folder of each published package in the repository, for its CHANGELOG.md. */
export const PACKAGE_DIRS: Record<string, string> = {
  "turno-cli": "turno",
  "turno-browser": "browser",
  "turno-fonts": "fonts",
  "turno-core": "core",
};

export interface ReleaseFrontmatter {
  product: Product;
  /** x.y.z, the version of the product's package. */
  version: string;
  /** YYYY-MM-DD, the day the version was published. */
  date: string;
  /** Other packages published in the same release, as git tags: `turno-cli@0.6.2`. */
  with?: string[];
}

type BasePage = NonNullable<(typeof pageSchema)["~standard"]["types"]>["output"];

/** Every page's frontmatter: release pages also carry the release fields. */
type PageFrontmatter = BasePage & Partial<ReleaseFrontmatter>;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** "0.10.0" to [0, 10, 0], or undefined when it is not x.y.z. */
export function parseVersion(version: string): [number, number, number] | undefined {
  const m = SEMVER.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Semver order, so 0.10.0 comes after 0.9.0 (a string comparison would put it first). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A package as a git tag: `turno-cli@0.6.2`. */
export function parseTag(tag: string): { name: string; version: string } | undefined {
  const at = tag.lastIndexOf("@");
  const name = tag.slice(0, at);
  const version = tag.slice(at + 1);
  if (at <= 0 || !(name in PACKAGE_DIRS) || !parseVersion(version)) return undefined;
  return { name, version };
}

// The shape of a Standard Schema (standardschema.dev), which fumadocs-mdx validates with. Written
// out here so the site needs no schema library of its own.
type Issue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> };
type Result<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: ReadonlyArray<Issue> };
interface Schema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<T> | Promise<Result<T>>;
    readonly types?: { readonly input: unknown; readonly output: T };
  };
}

/** Index pages of content/releases: the combined list and one list per product. */
const INDEX_PAGES = new Set(["index", ...Object.keys(PRODUCTS).map((product) => `${product}/index`)]);

/** The issues of a release page's frontmatter, against the file it is in (`browser/0-11-0`). */
function releaseIssues(data: Record<string, unknown>, file: string): Issue[] {
  const issues: Issue[] = [];
  const fail = (field: string, message: string) => issues.push({ message, path: [field] });
  const [folder, name] = file.split("/");
  const { product, version, date, description } = data;

  if (typeof description !== "string" || !description.trim()) fail("description", "is required: one sentence that names the main change");
  if (!(typeof product === "string" && product in PRODUCTS)) fail("product", `must be one of ${Object.keys(PRODUCTS).join(", ")}`);
  else if (product !== folder) fail("product", `is "${product}" but the page is in content/releases/${folder}`);
  if (typeof version !== "string" || !parseVersion(version)) fail("version", "must be x.y.z, like 0.11.0");
  else if (name !== version.replaceAll(".", "-")) fail("version", `is ${version}, so the file must be named ${version.replaceAll(".", "-")}.mdx`);
  if (typeof date !== "string" || !isDay(date)) fail("date", "must be a day written YYYY-MM-DD, like 2026-11-28");
  if (data.with !== undefined) {
    if (!Array.isArray(data.with)) fail("with", 'must be a list of git tags, like ["turno-cli@0.6.2"]');
    else
      for (const tag of data.with)
        if (typeof tag !== "string" || !parseTag(tag))
          fail("with", `"${String(tag)}" is not <package>@<x.y.z> for a published package (${Object.keys(PACKAGE_DIRS).join(", ")})`);
  }
  return issues;
}

function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

/**
 * The page schema of the whole content folder: Fumadocs' own, plus the release fields on the
 * version pages of content/releases. Those must be named after their version
 * (`browser/0-11-0.mdx`, or `browser/0-11-0.es.mdx` for a translation).
 */
export function pageFrontmatterSchema(ctx: { path: string }): Schema<PageFrontmatter> {
  const path = ctx.path.replaceAll("\\", "/");
  const at = path.lastIndexOf("/content/releases/");
  // The file inside content/releases without its extension or language: "browser/0-11-0".
  const file = at === -1 ? undefined : path.slice(at + "/content/releases/".length).replace(/(\.[a-z]{2})?\.mdx?$/, "");

  return {
    "~standard": {
      version: 1,
      vendor: "turno-docs",
      async validate(value) {
        const base = await pageSchema["~standard"].validate(value);
        if (base.issues) return { issues: base.issues };
        const page: PageFrontmatter = base.value;
        if (file === undefined || INDEX_PAGES.has(file)) return { value: page };
        // A YAML parser may read an unquoted date as a Date; the pages want the day as written.
        const raw = { ...(value as Record<string, unknown>) };
        if (raw.date instanceof Date) raw.date = raw.date.toISOString().slice(0, 10);
        if (!/^[a-z]+\/[^/]+$/.test(file)) {
          return { issues: [{ message: `a release page lives in content/releases/<product>/<x-y-z>.mdx, not content/releases/${file}` }] };
        }
        const issues = releaseIssues(raw, file);
        if (issues.length) return { issues };
        const release: ReleaseFrontmatter = {
          product: raw.product as Product,
          version: raw.version as string,
          date: raw.date as string,
          ...(raw.with ? { with: raw.with as string[] } : {}),
        };
        return { value: { ...page, ...release } };
      },
    },
  };
}
