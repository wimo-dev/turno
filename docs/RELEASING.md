# Versions and releases

turno follows semantic versioning per package (`turno-cli`, `turno-browser`, `turno-core`,
`turno-fonts`), published to npm from CI with provenance, so every tarball links to the commit
and the workflow run that built it. What users can check is in
[SECURITY.md](../SECURITY.md#releases-and-how-to-verify-them).

## Version policy

- **0.x for now.** While the version starts with 0, a minor release (0.3 to 0.4) may break a
  command, a flag or a config key; patches never do. Every deprecation warns at run time for at
  least one minor release before it goes away, and old command names stay as aliases.
- **1.0** comes when the command tree, the config format (`config.toml`, `mcp.toml`) and the
  agent adapter interface are stable. From then on, breaking changes need a major version.
- **Node**: every line that is LTS (active or maintenance) when a release ships. Today that
  is 22, 24 and 26; `engines` says `>=22.11` (the floor of Changesets 3). CI tests all three
  on macOS and Linux. A Node line leaves the matrix, and `engines`, in the first minor release
  after its end of life.

## Every change

A change a user would notice gets a changeset in the same pull request:

```sh
pnpm changeset          # pick the packages, the bump (patch, minor, major) and write a summary
```

- **patch**: fixes, no new behavior.
- **minor**: new commands, flags or config keys; old names keep working. In 0.x, also breaking
  changes, with a changeset that says what to do.
- **major**: after 1.0, anything a user must act on: a removed command or key, a changed file
  layout. The changeset says what to do, and `turno upgrade --finish` migrates what it can.

CI fails a pull request that touches `packages/*/src` without a changeset, unless it carries
the `no-changeset` label. The title of the pull request must follow Conventional Commits,
because pull requests are squash-merged and the title becomes the commit.

## A release

Releases come from CI, never from a laptop. `.github/workflows/release.yml` runs on every push
to `main`, in four jobs:

1. **version**: with pending changesets, Changesets opens or updates the pull request
   "chore(release): version packages", which bumps versions, writes each `CHANGELOG.md` and
   (through `scripts/sync-server-json.mjs`) the version in `packages/browser/server.json`.
   It cannot publish. A pull request opened with the workflow token starts no workflows, so
   close and reopen it to run `ci` before merging.
2. **build** (after that pull request is merged): `pnpm check`, `pnpm pack:check`, then
   `scripts/release-plan.mjs` packs every public package whose version is not on npm yet and
   writes a CycloneDX SBOM per package. The tarballs go up as a workflow artifact. This job
   has no `id-token` and no secrets.
3. **publish**: in the protected `npm` environment, downloads the tarballs, attests them
   (`actions/attest-build-provenance`) and runs `npm publish <tarball> --provenance` for each,
   dependencies first: `release-plan.mjs` lists a package after the workspace packages it
   depends on (turno-core before turno-browser and turno-cli), and the job stops at
   the first failure, so a dependent is never published without its dependency. It does not check out the repository, install anything or use a cache,
   so no project or dependency code runs where the publish token lives.
4. **tag**: creates the `name@version` git tags and GitHub releases, with the SBOM attached.
   Each release's notes are its package's `CHANGELOG.md` section for that version, under a
   link to the release page of turno's version on the site (or to the list of releases when
   that version has no page).

### The release pages

Every version of turno-cli and of turno-browser gets a page on the site that tells what is new
and how to use it: `apps/docs/content/releases/<product>/<x-y-z>.mdx`, where `<product>` is
`cli` or `browser` and the file is named after the version with dashes
(`browser/0-11-0.mdx`). That one file is the whole change: the lists of releases, the feeds, the
sidebar (newest first by semver) and the older and newer links all read its frontmatter, and the
build fails when a field is wrong or the file name does not match the version:

```yaml
---
title: turno-browser 0.11.0
description: One plain sentence that names the main change.
product: browser            # "browser" | "cli"
version: 0.11.0             # x.y.z
date: 2026-11-28            # YYYY-MM-DD
with: ["turno-cli@0.6.2"]   # optional: other packages published in the same release, as git tags
---
```

The page shows the date, the package with its GitHub release and changelog, the packages in
`with` (linking their own page when they have one) and the older and newer versions by itself.
Write it from the pending changesets while the "version packages" pull request is open, and copy
the shape of the newest page of that product, in this order:

1. A paragraph with the headline features in bold, each linked to the docs page that explains it.
   When the version only follows the other product, say so in one sentence and link its page.
2. `## Upgrade` with `<Upgrade>`; its children are what to run after upgrading, when there is
   something (`<Upgrade />` when there is not).
3. `## Highlights`: one `<Highlight area="Gateway" title="..." href="/docs/..." more="...">` per
   headline feature, with two or three lines and a short code block (comments under about 30
   characters, so it fits beside the text). `area` is CLI, Gateway, Browser, Accounts or Docs.
4. One `##` per area (CLI, Gateway, Accounts, Security, Browser), then `## Fixes`,
   `## Changed behavior` for anything that can break a script, and `## Links`. These are plain
   Markdown lists, one item per change: `- **The thing**: what changed.`

Browser highlights and changes go on the turno-browser page, the rest on the turno-cli page.
Merge the pages just before merging the version pull request, so the site and the GitHub
releases go live together.

The gate is the `npm` environment: the publish job waits until a required reviewer approves
the deployment on GitHub. The trusted publishers allow `npm publish`, so an approved run
publishes directly (with provenance). Unticking "Allow npm publish" on npmjs.com would make
every version wait as a staged version for a second approval there, with 2FA.

After a `turno-browser` release, publish its MCP Registry entry by hand from a clean checkout:
`mcp-publisher login github --token "$(gh auth token)"` (the interactive login cannot read
organization roles, and the namespace `io.github.wimo-dev` needs an organization owner), then
`mcp-publisher publish packages/browser/server.json` and `mcp-publisher logout`.

`pnpm pack:check` runs the tarball check locally. Prereleases: `pnpm changeset pre enter next`,
then releases go to the `next` dist-tag (`turno upgrade --channel next` follows them);
`pnpm changeset pre exit` ends it.

## A new package

npmjs.com offers the trusted publisher settings only for a package that already exists, so the
first version of a new package (turno-core) is published by the owner, by hand, and
the workflow takes over from the second. Until that is done, a release that includes the new
package fails in the publish job at that package, before any package that depends on it.

For turno-core, when the "chore(release): version packages" pull request first bumps it (to
0.1.0), before merging that pull request:

1. From a clean checkout of the pull request branch (`changeset-release/main`), signed in with
   `npm login`:

   ```sh
   pnpm install --frozen-lockfile && pnpm build
   cd packages/core && pnpm publish --access public --no-git-checks --provenance=false
   ```

   turno-core has no dependencies, so there is no shrinkwrap to write. This first version has
   no provenance; every later one does.
2. On npmjs.com, package `turno-core`, Settings:
   - Trusted publisher: GitHub Actions, organization `wimo-dev`, repository `turno`, workflow
     `release.yml`, environment `npm` (the same as the other packages).
   - Publishing access: "Require two-factor authentication and disallow tokens".
3. Check that it worked: `npm view turno-core@0.1.0 version`.
4. Merge the pull request. The build job skips turno-core (already on npm) and the publish job
   publishes turno-browser and turno-cli, whose shrinkwraps lock turno-core at 0.1.0.

Releases after that need nothing by hand. The same steps apply to any other new package.

## Supply chain

- Workflows: `permissions: {}` at the top and the minimum per job, every action pinned to a
  full commit SHA (Dependabot keeps them current), `persist-credentials: false`, no
  `pull_request_target`, no cache in the release workflow. Harden-Runner blocks every host
  outside each release job's allow list and audits the other workflows. When a
  release job fails with a blocked connection, see "Egress allow lists" below.
  `zizmor.yml` lints the workflows on every change to `.github/`; `scorecard.yml` runs the
  OpenSSF Scorecard weekly.
- Dependencies: pnpm waits three days before installing a newly published version
  (`minimumReleaseAge`), refuses a version that lost its provenance (`trustPolicy:
  no-downgrade`) and refuses an unsupported Node (`engineStrict`). Dependabot opens one grouped
  pull request a week per ecosystem, with a three-day cooldown. `scripts/licenses.mjs` fails on
  licenses outside the allow list; the dependency review action does the same for pull requests.
- Security fixes: the changeset names the GHSA and CVE (SECURITY.md, "Fixes and releases"),
  so the release notes list every vulnerability a release fixes.
- Commits: `pnpm hooks` installs a `commit-msg` hook that enforces Conventional Commits and
  rejects attribution trailers and the em dash.

## Egress allow lists

Each job of `release.yml` lists the hosts it may reach under `allowed-endpoints`. A host
outside the list is blocked, and the step that needed it fails (a timeout or `ECONNREFUSED`,
often a pnpm `ERR_PNPM_META_FETCH_FAIL`). To check a run, open the "View security insights"
link that Harden-Runner prints in the job log: its Network events tab lists every connection,
blocked ones marked. To add a host, append `host:443` to that job's list in a pull request.
To go back to observing only, change that job's `egress-policy: block` to `audit`; the list can
stay. The allow lists only apply on `main`, so a change shows up on the first push after merge.

## Before the first publish

1. Done on 2026-11-16: the name (`turno`, trademark risk accepted by the owner), the GitHub
   repository `wimo-dev/turno`, `repository`, `homepage` and `bugs` in each package.json,
   no `private` flag, changelogs for 0.1.0.
2. Repository settings: private vulnerability reporting, Discussions (with an "Español"
   category), secret scanning with push protection, the open pull request limit, the "require
   actions pinned to a SHA" policy, and branch protection on `main` (pull request, passing
   `ci`, no force push).
3. First publish, by the owner from a clean checkout (trusted publishing needs the packages to
   exist first):

   ```sh
   npm login
   pnpm install --frozen-lockfile && pnpm check && pnpm pack:check
   for p in fonts browser turno; do (cd packages/$p && pnpm publish --access public --no-git-checks --provenance=false); done
   ```

4. On npmjs.com, for each package: a trusted publisher pointing at `release.yml` and the `npm`
   environment, "require 2FA and disallow tokens", a passkey on the account, no tokens left.
   Create the `npm` environment in the repository settings, limited to `main`, with the owner
   as required reviewer. From then on every release goes through the workflow with provenance.
5. Name the backup administrator in `GOVERNANCE.md`.

## How users update

`turno upgrade` updates with the tool that installed turno (npm, pnpm, yarn, bun, volta) or
pulls and rebuilds a git checkout, then `turno upgrade --finish` rewrites the launchers and
shows the changelog since the previous version. `turno upgrade --check` only asks the
registry. Interactive commands mention a new version at most once a day. The check sends only
the package name, and it is off in CI, outside a terminal, with `update_check = false` in
config.toml, or with any of `TURNO_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1` or
`DO_NOT_TRACK=1`.
