# Parallel implementation workstreams

This is the handoff plan, not a claim these components exist. Read [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRACTS.md](CONTRACTS.md), and the relevant `src/contracts/*.ts` first.

## Coordination rules

- One integration coordinator owns contracts, package/lockfile, root config, shared fixtures, architecture docs and composition root.
- Claim an item before editing. Prefer separate Git worktrees/branches; do not run concurrent index/commit operations in one worktree.
- Implementation agents own the paths listed below. New test files must be scoped to their component. Do not edit another workstream's files without agreement.
- Need a dependency/contract change? Request it from the coordinator with exact type/behavior/fallback. Do not install packages or edit `bun.lock` concurrently.
- Shared scenario: `tests/fixtures/scenario.ts`. Retention duration and other values in fixtures are **test data, not product defaults**.
- `bun run check` is the integration gate. Add relevant tests, record limitations and do not mark placeholders as working implementations.
- Conventional Commits. Small coherent commits; no half-implemented contract changes on main.

## Dependency graph

```text
C0 shared contracts/tooling (this foundation)
 |
 +-- T1 wire codec + identifiers --------+
 +-- T2 Bun transport ------------------+--> T5 session --> T9 real integration
 +-- T3 storage/config/secrets ----------+                 ^
 +-- T4 fake facade + UI shell ----------+--> T7 UI ------+ |
 +-- T6 pure domain + app coordinator ---+---------------+ |
 +-- T8 commands / OS effects ---------------------------+ |
                                                         |
                                           T10 modern IRCv3
```

Start T1, T2, T3, T4, T6 and pure command parsing in parallel. T5 can initially use a fake transport/codec; T6 uses a scripted fake session; T7 uses fake app. No one needs a public IRC network to start.

## T0 — foundation/integration coordinator

Owns: `src/contracts/**`, root configuration, `tests/fixtures/**`, architectural docs, future `src/main.ts`.

- Review contract change requests and maintain task dependencies.
- Add/check import boundaries; preserve strict TypeScript.
- Approve dependency choices and version pins. UI task must spike actual `@opentui/solid`, not React or browser DOM Solid.
- Decide runtime policy limits and supply validated options to factories.
- Define local dev server/bouncer fixture and Bun-runtime test command before integration.
- Keep production wiring separate from fake/demo wiring. Document exact run commands as they become real.

## T1 — codec and protocol primitives

Owns: `src/irc/codec/**`, `src/domain/irc-identifiers.ts`, `tests/irc/codec/**`.

Implement `createIrcCodec(limits: ProtocolLimits): IrcCodec`. Extend casemapping tests where needed; keep helpers pure.

Acceptance:

- CRLF framing across every byte boundary, UTF-8 boundaries, tag escaping, prefixes, params/trailing empty values, numerics/unknown commands.
- Separate command/tag/input limits; oversized and incomplete input failures without unbounded buffering.
- Serializer round-trip fixtures, CRLF/NUL injection rejection and byte-limit tests.
- No live sockets, logging message bodies, capability negotiation, or UI.

## T2 — Bun TCP/TLS transport

Owns: `src/transport/**`, `tests/transport/**`.

Implement `createBunTransport(): TransportFactory`. Introduce constructor options only through coordinator-approved contract/local option types.

Acceptance:

- Local test TCP/TLS servers; valid certificate, invalid certificate/hostname and refused connection cases.
- Abort during connect/read/write, EOF, repeated close, bounded backpressure, no orphan handles/listeners.
- Lifetime signal behavior matches the contract; no hidden reconnect.
- Run integration tests under Bun, separate from Node Vitest. No public network dependency and no globally disabled TLS verification.

## T3 — persistence, config and secret adapters

Owns: `src/storage/**`, `tests/storage/**`.

Implement independent factories for `HistoryRepository`, `SettingsRepository`, `SecretProvider`. Subdivide by adapter in separate worktrees if needed.

Acceptance:

- SQLite schema/migrations for stable conversation registry, messages, search, read positions and workspace; atomic commits and deterministic keyset pagination.
- Query-bound cursor rejection, missing context target, server-ID collision conflict, deletion/retention/search cleanup tests.
- JSONC validation, revision/CAS conflict including external-edit race, single-file atomic save and failure recovery tests.
- Environment secret resolver first; keychain proof before interactive secret saving is claimed. Unsupported secure store returns an explicit failure, never plaintext fallback.
- Temp directories/databases only in tests. Bun-runtime integration for `bun:sqlite`.
- Document schema/migration strategy and WAL/backup/privacy limitations. No logging policy invented inside repositories.

## T4 — fake app and OpenTUI/Solid spike

Owns: `tests/fakes/app/**`, `src/ui/demo/**`, `tests/ui/spike/**`.

Implement a deterministic fake `AppApi` from shared scenarios and a minimal actual Solid/OpenTUI renderer boot.

Acceptance:

- Supports subscription/dispatch receipts, switching channels/DMs, editing drafts, incoming traffic, unread/error states and feature flags.
- Controlled clock/scenarios; no random timing, real sockets or user filesystem access.
- UI can exercise disconnect/auth failure/playback and modern feature availability without changing production contracts.
- Verify JSX/renderer setup, scrollbox sticky behavior, draggable scrollbar, safe paste, selection and focus cleanup against pinned versions.
- Demonstrate resize and 10k-message source dataset using a bounded mounted window. Measure layout cost, do not call paint culling virtualization.
- Demo entrypoint explicitly fake; do not present as a working IRC client.

## T5 — single-attempt IRC session

Owns: `src/irc/session/**`, `tests/irc/session/**`.

Implement injected `SessionFactory`; dependencies include transport, codec factory, secret provider, clock and validated policy. No application/UI/storage imports.

Acceptance:

- Registration/CAP 302/SASL PLAIN/TLS-safe auth, PING/PONG, ISUPPORT and basic feature derivation.
- Event sequence/generation correctness; prompt factory return; close/abort terminates iterator and all timers.
- NAMES/live membership races, nickname/away/account/topic updates, usable state only after required auth.
- Flood-safe queue; outgoing splitting; operation correlation, write/echo/failure/uncertain states without text-based dedupe.
- Typed LIST/WHOIS results; serialize ambiguous requests when labels unavailable.
- Scripted fake-server tests cover connect/auth failures, disconnect during send, unknown numerics and bounded overflow.
- No reconnect loop and no general-purpose raw-command UI escape hatch.

## T6 — domain and application coordinator

Owns: `src/domain/**` except the T1-owned `irc-identifiers.ts`, `src/app/**`, `tests/domain/**`, `tests/app/**`.

Implement `CreateApp` and pure reducers against injected ports; preserve provided session cursor/read-model semantics.

Acceptance:

- Serialized action/event processing; immutable scoped read models; stable conversation/user/message identity with negotiated casemapping.
- Boot restore, multi-network supervisor/generations, cancelled retries, manual disconnect and shutdown failure handling.
- Read/unread/highlight policy with view reports, mutes, playback, focus and monotonically advancing markers.
- Local send/echo/history merge with stable IDs and no heuristic message loss; no automatic resend after restart/disconnect.
- Privacy filter before persistence; logging-disabled and excluded drafts never enter persistence/search.
- Bounded hot timelines/operations, explicit history load/reveal/search and external settings conflicts.
- Tests use fake ports; failures cannot be hidden by switching active conversation. No Bun/SQLite/Solid imports.

## T7 — newcomer UI components

Owns: `src/ui/**` except `src/ui/demo/**`, `tests/ui/**` except spike tests.

Depends on T4 spike/renderer configuration. Consume `AppApi`, `CommandService`, `ExternalActions`; no direct protocol/storage access.

Component splits:

1. Sidebar/header: network-grouped Channels/DMs, unread badges, active state, add/join controls.
2. Transcript: safe rendering, anchor-preserving scroll/load/reveal, first unread, message actions, member panel.
3. Composer: editor bridge, draft sync, completion, input history, paste confirmation, reply target and send failures.
4. Onboarding/settings: network/auth form, secure secret handoff, validation, connection errors, settings revision conflicts.
5. Shell/focus: dialogs/context menus, keyboard equivalents, focus restoration, responsive panels/themes, terminal cleanup.

Acceptance:

- One active conversation; Discord-like hierarchy without dense IRC-only controls.
- Essential tasks possible with mouse alone and with keyboard alone.
- Safe paste never autoexecutes commands; CJK/emoji editing and completion offsets verified.
- No forced jump to bottom while reading; no lost draft on switch/resize; no secrets in snapshots/screenshots/fixtures.
- Capability-dependent replies/reactions/typing are clear and graceful when unavailable.
- Headless input/frame tests plus real terminal smoke tests on Linux/macOS; document limitations.

## T8 — commands, completion and OS effects

Owns: `src/services/**`, `tests/services/**`.

Implement `CommandService` using app read models; `NotificationSink` and `ExternalActions` via injected OS adapters. May split parser and adapters into separate tasks.

Acceptance:

- Typed intent output, contextual help, `//` literal slash, actionable invalid/unknown-command errors, UTF-16 completion offsets.
- Plain text sends map to `message.send`; parser has no hidden socket/storage side effects.
- Only currently supported commands are advertised. Coordinate new intents for planned commands absent from revision 1 rather than faking raw IRC access.
- URL scheme allowlist and no shell interpolation; clipboard failure fallback; notifications degrade safely when unavailable.
- No aliases/plugins/moderation implementation in the first slice.

## T9 — real vertical slice integration

Owns: composition root and local test environment, by coordinator or explicitly delegated integrator.

After T2/T3/T5/T6/T7 are ready:

- Wire Bun transport, codec/session, repositories, app and real Solid renderer.
- Implement explicit startup/error/abort/terminal teardown paths; no fake ports in production entrypoint.
- Local modern test server: configure/authenticate → join → send/receive → DM → unread → reconnect → restart/history → search/reveal.
- Add Linux/macOS integration checks and truthful README dev/run commands.
- Only then connect personal accounts with history/credential behavior reviewed.

## T10 — modern IRCv3 milestone

Owns: explicitly assigned per-layer files, integrated through coordinator-approved contracts.

- Pin current extension/draft versions, actual advertised capability names, dependencies and limits against a local modern IRC server + bouncer.
- History/batches, replies, reactions, typing, multiline, read markers and redaction; define interoperability fallback per feature.
- Test playback/live interleaving, overlapping pages, duplicate echoes, missing originals, stale typing and redacted search content.
- Propose message-fragment/formatting contract revisions if required by real protocol behavior before spreading assumptions through UI.
- No claim that all networks or other clients support these features.

## Recommended integration checkpoints

1. Foundation contracts, docs, test tooling (current work).
2. Pure codec/domain + fake app + working terminal UI spike.
3. Real local-server chat with no persistence.
4. Durable daily-driver loop with reconnect/history/search.
5. Modern interactions and personal-use polish.
6. Public-release hardening, if/when desired.
