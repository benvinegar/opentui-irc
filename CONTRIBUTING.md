# Contributing to opentui-irc

Thanks for helping. opentui-irc is a small, opinionated client, so please open an issue to discuss larger changes before writing code.

## Setup

You need [Bun](https://bun.sh) 1.3.14+ and Node.js 24 (for Vitest).

```sh
git clone https://github.com/benvinegar/opentui-irc.git && cd opentui-irc
bun install --frozen-lockfile   # also installs a format/lint pre-commit hook
bun run start                   # run the client from source
```

## Before you open a pull request

```sh
bun run check   # format, lint, types, Vitest and Bun tests with a merged coverage floor
```

Optional, slower checks:

```sh
bun run test:terminal   # real pseudo-terminal startup/shutdown (Python 3)
bun run test:ergo       # interoperability against a local Ergo server (Docker)
```

CI runs `bun run check` on Linux and macOS, plus `bun run test:ergo` in a separate Linux job (GitHub's macOS runners have no Docker).

- Add focused tests for new behaviour. Name Bun-only tests `*.bun.test.ts`.
- `bun run check` runs both suites with coverage and prints a merged per-file report (`bun run coverage` alone; `bun run coverage --report` re-prints the last run). It fails if total lines, functions or branches drop below the floor in `scripts/coverage-config.ts`. The floor is a ratchet: when coverage rises, raise it to the new whole-number totals in the same PR; lower it only with a stated reason.
- oxlint fails any function with a cyclomatic complexity above 20 (`.oxlintrc.json`). Split long branches into lookup tables or named helpers instead of disabling the rule.
- Tests must use local fake servers or the loopback Ergo fixture. Never connect to public IRC networks or use real credentials.
- Use [Conventional Commits](https://www.conventionalcommits.org): `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`.
- Add user-visible changes to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- New settings and actions must also be reachable through the control API (schema, validation, permissions and tests), not only the TUI.
- Discuss new dependencies first; they must work under Bun.

## Where things live

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the module boundaries, and [docs/CONTRACTS.md](docs/CONTRACTS.md) the behaviour each module must keep. [AGENTS.md](AGENTS.md) holds the working rules for coding agents, which apply to humans too.

## Releasing

Maintainers cut releases from `main`. Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml): it runs `bun run check`, builds `openirc` on native Linux and macOS runners (x64 and arm64), and publishes the archives, `SHA256SUMS` and release notes as a GitHub release.

1. Set `"version"` in `package.json` to the new version, for example `0.1.0`.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.1.0] - YYYY-MM-DD` and review its entries; they become the release notes. Add a fresh `## [Unreleased]` section with empty `### Added`, `### Changed` and `### Fixed` headings above it.
3. Commit as `chore: release v0.1.0` and merge to `main`. Then tag that commit and push the tag:

   ```sh
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

The workflow fails if the tag does not match `package.json` or `CHANGELOG.md` has no matching version section. Versions with a hyphen (`0.2.0-rc.1`) are published as prereleases. Re-running the workflow for an existing tag updates that release's notes and assets.

## Scope

Out of scope for now: plugins/scripting, DCC, moderation suites, split panes, cloud sync and a bundled bouncer. See [docs/PLAN.md](docs/PLAN.md).

## Conduct

Be kind and assume good faith. Harassment isn't tolerated; the maintainer may remove comments or block participants who don't follow this.
