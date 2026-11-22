# Contributing to turno

Thanks for helping. turno is maintained by one person, so the process below exists to keep
review time for the changes that matter. Read [GOVERNANCE.md](GOVERNANCE.md) for how decisions
are made and [AI_POLICY.md](AI_POLICY.md) if you use AI tools.

## What is welcome

- **Bug reports** with the issue form: version, OS, Node, which package, which agent.
- **Fixes** for an open, confirmed bug: open the pull request and link the issue.
- **Docs**: typos, unclear steps, missing examples. No issue needed.
- **Features, new agents, new commands, config keys**: open an issue first and wait until it
  is labeled `accepted`. Large changes (a new agent adapter, a change to the config format, the
  security model, or anything that breaks a command) go through an `rfc` issue (see
  [GOVERNANCE.md](GOVERNANCE.md)). A pull request for a feature without an accepted issue may be closed
  without review; that is about time, not about the idea.

## Set up

Requirements: Node 22.11 or newer, pnpm (the version in `package.json` `packageManager`;
`corepack enable` picks it up), macOS or Linux.

```sh
pnpm install
pnpm hooks              # commit-msg hook: Conventional Commits, no attribution trailers
git config blame.ignoreRevsFile .git-blame-ignore-revs   # blame skips formatting-only commits
pnpm build
pnpm test               # unit and integration tests, with a sandbox HOME
pnpm format             # format the code with Biome (pnpm check fails on unformatted code)
pnpm check              # typecheck, lint and format check (Biome, knip), tests, repository text rules, dependency licenses
```

Tests never touch your real setup: they run with a temporary `HOME` (see
`packages/turno/test/helpers`). Keep it that way in new tests. A Chrome that a test or an
experiment starts outside Playwright goes through `spawnChrome` in
`packages/browser/test/helpers/chrome.ts`, or passes `--use-mock-keychain --password-store=basic`
itself, so macOS never shows a Keychain dialog for it. The end-to-end tests drive the
real agents (a signed-in `claude`, Codex, Cursor) when they are installed; set
`TURNO_SKIP_E2E=1` to skip them. The Cursor one needs the network, so `pnpm check` skips it and
`pnpm test:e2e` runs it.

The four packages:

| Package | Path | What |
|---|---|---|
| `turno` | `packages/turno` | the CLI, the MCP gateway (`mcpd`), the status line, the accounts bridge |
| `turno-browser` | `packages/browser` | the persistent-profile browser MCP server (a separate package, not installed with `turno-cli`) |
| `turno-core` | `packages/core` | what both share: paths, the secret store (Keychain, Secret Service), process helpers; `pnpm build` builds it first |
| `turno-fonts` | `packages/fonts` | the status line font (not installed with `turno-cli`: `turno ui install` downloads the same files and checks their SHA-256) |

The documentation site is a fourth workspace project, `apps/docs` (private, never published):

```sh
pnpm build && pnpm docs:dev   # preview at http://localhost:3000
pnpm docs:generate            # rewrite the reference and troubleshooting pages from the code
pnpm docs:check               # what the docs workflow runs: generated pages, build, links
pnpm docs:tapes               # re-render the text recordings (needs vhs, ttyd and ffmpeg)
```

## Rules for changes

- **Tests first** for behavior changes. Integration tests for the gateway use the fixture
  server in `packages/turno/test/fixtures/`.
- **English** in code, comments, CLI output and docs. No em dash character anywhere
  (`pnpm check` fails on one).
- **Agents**: a new agent is one adapter file in `packages/turno/src/agents/` plus tests;
  commands read adapter fields instead of branching on the agent id
  ([docs/agents.md](docs/agents.md)).
- **Commands**: new commands go in `cli/registry.ts`; renamed commands keep the old name as an
  alias. Read commands take `--json`, write commands take `--dry-run`, and every write to a
  user file goes through `core/journal.ts` so `turno undo` can revert it.
- **Changesets**: a change a user would notice adds one (`pnpm changeset`). CI asks for it when
  a pull request touches `packages/*/src`. See [docs/RELEASING.md](docs/RELEASING.md).
- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) in English
  (`feat(mcpd): ...`, `fix(cli): ...`). Pull requests are squash-merged, so the pull request
  title must follow the same format.
- **Sign-off**: add `Signed-off-by: Your Name <you@example.com>` (`git commit -s`) to certify
  the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change
  or have the right to submit it under the project license (Apache-2.0).
- **No attribution trailers** for tools: no `Co-Authored-By` for AI assistants, no "Generated
  with" lines. The commit hook rejects them. AI use is declared in the pull request template
  instead (see [AI_POLICY.md](AI_POLICY.md)).
- **No personal data**: no real emails, account names, tokens or paths under a real home in
  code, tests or fixtures. Use `work`, `personal`, `alice@example.com`.

## Reporting security issues

Never in a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone in the project's spaces follows the [Code of Conduct](CODE_OF_CONDUCT.md).
