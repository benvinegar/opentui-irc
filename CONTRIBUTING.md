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
bun run check   # format, lint, types, Vitest and Bun integration/UI tests
```

Optional, slower checks:

```sh
bun run test:terminal   # real pseudo-terminal startup/shutdown (Python 3)
bun run test:ergo       # interoperability against a local Ergo server (Docker)
```

- Add focused tests for new behaviour. Name Bun-only tests `*.bun.test.ts`.
- Tests must use local fake servers or the loopback Ergo fixture. Never connect to public IRC networks or use real credentials.
- Use [Conventional Commits](https://www.conventionalcommits.org): `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`.
- Add user-visible changes to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- New settings and actions must also be reachable through the control API (schema, validation, permissions and tests), not only the TUI.
- Discuss new dependencies first; they must work under Bun.

## Where things live

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the module boundaries, and [docs/CONTRACTS.md](docs/CONTRACTS.md) the behaviour each module must keep. [AGENTS.md](AGENTS.md) holds the working rules for coding agents, which apply to humans too.

## Scope

Out of scope for now: plugins/scripting, DCC, moderation suites, split panes, cloud sync and a bundled bouncer. See [docs/PLAN.md](docs/PLAN.md).

## Conduct

Be kind and assume good faith. Harassment isn't tolerated; the maintainer may remove comments or block participants who don't follow this.
