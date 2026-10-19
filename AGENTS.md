# OpenIRC agent guide

OpenIRC is a newcomer-first Linux/macOS IRC client: Bun + TypeScript + SolidJS + OpenTUI (`@opentui/solid`, not React). MIT. Personal daily driver first; no deadline. Discord-like visual hierarchy, Slack-like channel/DM sidebar, one active conversation.

## Start here

- `docs/PLAN.md`: feature scope and confirmed product decisions.
- `docs/ARCHITECTURE.md`: boundaries, state ownership and lifecycle.
- `docs/CONTRACTS.md`: behavioral requirements; TypeScript alone is insufficient.
- `src/contracts/*.ts`: authoritative internal API shapes.
- `docs/WORKSTREAMS.md`: parallel tasks, path ownership and acceptance criteria.
- `tests/fixtures/scenario.ts`: deterministic shared sample data, not product defaults.

## Working rules

- Coordinator owns contracts, package/lockfile, root config, shared fixtures and composition root. Request changes instead of silently widening contracts.
- Claim workstreams; use separate branches/worktrees for concurrent agents. Do not commit another agent's files or race on the Git index.
- Keep contracts pure. Domain/app must not import Bun adapters, SQL, Solid or OpenTUI. UI consumes the app facade, never raw IRC/SQL.
- All user intents share typed actions; all live attempts carry allocated generation/sequence IDs. No global event bus/service locator/plugin system.
- Expected failures use safe `Result` errors; no raw credentials, IRC lines or user message bodies in diagnostics.
- Bound buffers/windows/queues. No silent message dropping, automatic uncertain-send replay, or delivery/read-receipt claims.
- Runtime validate external data. No unsafe type casts/`any` to bypass contract coordination.
- No power-user/moderation/plugin/DCC work in the initial slice. Modern features are capability-negotiated.
- Do not add dependencies without checking Bun compatibility and coordinating package/lockfile edits.
- Production OpenTUI JSX setup must follow the real Solid renderer documentation; no browser DOM assumptions.

## Validation

```sh
bun install --frozen-lockfile
bun run format
bun run check
```

Current Vitest tests are platform-neutral under Node. Future Bun socket/SQLite integration tests must run under Bun with a separate documented command. Never test against public IRC networks in CI. Add focused tests for new behavior and run all checks before integrating.

## Commits and changelog

Use Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `chore: ...`. Commit coherent verified checkpoints. Do not push/create remote repositories without user agreement.

`CHANGELOG.md` is the source of truth for user-visible changes. Append under the existing Unreleased Added/Changed/Fixed sections; no duplicate headings. Do not log every internal refactor. On release, move entries into an immutable version section and start a new Unreleased section; use the reviewed released section as release notes (`gh release create/edit --notes-file`). No release automation is required yet.

`CLAUDE.md` is a symlink to this file; keep one source of guidance.
