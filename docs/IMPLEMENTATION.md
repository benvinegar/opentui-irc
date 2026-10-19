# Implementation status

OpenIRC is a runnable early daily-driver alpha, not completion of every A/V item in [PLAN.md](PLAN.md). Start with `bun install --frozen-lockfile && bun run start`.

## Implemented components

| Component      | Current implementation                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition    | Real Bun entrypoint, explicit adapter wiring, CLI paths/help/config validation, signal/terminal cleanup                                                                             |
| Application    | Serialized intents/events, multi-network lifecycle/reconnect, generations, conversations/DMs, drafts, unread/mentions, operations, bounded hot windows, persistence policy          |
| Protocol       | Bounded codec, CAP/ISUPPORT, SASL PLAIN, registration/keepalive, membership/NAMES races, chat/ACTION/NOTICE, WHOIS/LIST, paced UTF-8/multiline fallback, honest echo/uncertainty    |
| Modern IRCv3   | Negotiated history/batches, server IDs, replies, reactions, typing, read-marker and redaction support; exact wire gates/versions in [IRC documentation](../src/irc/README.md)       |
| Transport      | Real Bun TCP/TLS, certificate/hostname verification, backpressure, connection/read/write cancellation and cleanup                                                                   |
| Persistence    | Real SQLite registry/messages/read positions/workspace, migrations, cursors/search/context, retention/deletion; JSONC validation/revision-safe writes; environment/OS-vault secrets |
| UI             | Actual Solid/OpenTUI renderer; one transcript, network/channel/DM sidebar, scrollbars/anchors, mouse/keyboard focus, composer/completion/paste review, search/reveal, help/menus    |
| Newcomer setup | TLS network form, optional Libera.Chat/OFTC presets, SASL with masked password/vault handoff or explicit environment fallback, history disclosure/toggle and themes                 |
| Discovery      | Channel-directory filtering/join, WHOIS details, start DM, message actions and capability-aware modern controls                                                                     |
| OS effects     | Explicit safe link opening/copy, opt-in desktop notifications with platform helper fallbacks                                                                                        |

There are no production imports from fake/test implementations. Fakes exist for deterministic UI/unit development only.

## Validation actually performed

| Check                        | Evidence / limits                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types/lint/format            | `bun run check`                                                                                                                                                             |
| Pure unit/contract tests     | Vitest under Node: domain/app/services/codec/session/config/secret policies, typed boundaries                                                                               |
| Bun integration              | Real SQLite files, TCP/TLS fixtures, CLI, full core/server composition, real headless OpenTUI interactions                                                                  |
| Real UI + core + persistence | Mouse setup → real JSONC save → connect via fake session → DM → native composer → real app → SQLite search                                                                  |
| Linux real-terminal smoke    | Production entrypoint in a pseudo-terminal, first screen renders, SIGTERM exits 0 and restores terminal                                                                     |
| Real IRC server              | `bun run test:ergo`: official pinned Ergo 2.19.1 container, loopback only, three real apps; registration/JOIN, msgid/echo, replies, typing, reactions, CHATHISTORY playback |
| macOS                        | CI job configured, not run in this local session; real manual validation outstanding                                                                                        |
| Credential vault             | Dispatch/readback/failure tested with injected vault; actual user's Secret Service/Keychain not exercised                                                                   |
| Other bouncers/servers       | Scripted interoperability fixtures, not a real soju/ZNC/multi-ircd matrix                                                                                                   |

No public IRC networks, personal credentials, account registration, or personal configuration were used for tests. The Ergo script uses temporary state and removes its container/database afterward. It is opt-in, not a dependency of the normal validation suite.

## Important remaining work

- Expand real server/bouncer coverage, including same-account read-marker synchronization, server redaction and reconnect/playback edge cases.
- Design durable peer/account-bound DM archives. Current threads are nickname-address based (with a visible reuse warning), not verified-person histories. Persisted reaction aggregates also lack authoritative actor membership; unknown restored actor deltas are handled conservatively rather than guessed.
- Native macOS, SSH, tmux, clipboard and OS-vault smoke validation with real users.
- Editing/removing existing network profiles through forms; retention controls, broader settings parity, external-file reload without restart, and configurable keybindings.
- Full local search performance/indexing work: current literal substring search prioritizes correctness, not million-message latency guarantees.
- Rich IRC formatting annotations, customizable highlight/noise/ignore policies, broader notification controls and other remaining planned v1 polish.
- Negotiated IRCv3 multiline, additional history query shapes, vendor-specific ZNC playback, WHO/WHOX and network-specific services fallback.
- Standalone packaging/install/upgrade artifacts, migration backups for future schema versions, performance/soak benchmarks and security review.

Deliberately out of the initial product cut: moderation tooling, plugins/scripting, DCC/XDCC, split panes, cloud sync, automatic media fetching and a bundled bouncer/background service.

## Read the adapter guarantees

- [Architecture](ARCHITECTURE.md) and [contracts](CONTRACTS.md)
- [IRC feature gates and limitations](../src/irc/README.md)
- [Transport guarantees](../src/transport/README.md)
- [Persistence/security limitations](../src/storage/README.md)
- [UI coverage and limitations](../src/ui/README.md)
- [Security/privacy model](SECURITY.md)
