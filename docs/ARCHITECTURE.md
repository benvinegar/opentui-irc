# Architecture

Status: contract-first foundation, not a working IRC client. See [PLAN.md](PLAN.md) for product scope and [WORKSTREAMS.md](WORKSTREAMS.md) for implementation assignments.

## 1. Design rules

1. **User intent is the shared API.** Mouse, shortcuts, slash commands, and future automation dispatch the same typed actions. Do not wire UI controls directly to IRC commands.
2. **One owner for each state machine.** Transport owns a socket; session owns one IRC connection attempt; app owns retry policy and product state; UI owns focus/layout/scroll anchors.
3. **Dependency inversion without a plugin system.** Plain TypeScript ports, explicit constructor dependencies, no global registry/service locator, no global event bus.
4. **Protocol does not know about UI.** No OpenTUI, SolidJS, filesystem, or SQL imports in domain code or contracts.
5. **Snapshots are not the database.** Bound in-memory windows, queues, operations, batch buffers, and discovery results. Load older content explicitly.
6. **Unsupported is a normal state.** Feature-gate modern interactions; ordinary IRC remains useful. Do not invent acknowledgments or universal history.
7. **Secrets and raw protocol are private infrastructure.** Only semantic sanitized data crosses into application views.
8. **Make adapters replaceable, not everything abstract.** No repository per table, generic ORM wrapper, CQRS framework, or public extension ABI yet.

## 2. System map

```text
                    SolidJS + @opentui/solid
              screens / menus / composer / focus
                              |
             AppAction / AppApi / Readable snapshots
                              |
                   application coordinator
         connection supervisor / conversation registry
       unread + history merge + operation/persistence policy
           /              |             |             \
   SessionFactory   HistoryRepository SettingsRepo   effects
         |           SQLite adapter    JSONC files   notifications
   single IRC session                      |        link/clipboard*
    CAP / SASL / state                  SecretProvider
         |
   IRC codec + casemapping
         |
    TransportFactory
     Bun TCP / TLS

* Link/clipboard adapters are UI-shell dependencies, not domain behavior.
```

All arrows are in-process interfaces, not RPC or remote services. One application process, one repo, one dependency graph. Avoid worker threads until profiling gives us a reason.

## 3. Module ownership and dependency rules

| Module           | Owns                                               | May depend on                     | Must not depend on                           |
| ---------------- | -------------------------------------------------- | --------------------------------- | -------------------------------------------- |
| `contracts/`     | Shared IDs, values, actions, ports                 | Other contract files only         | Runtime libraries, adapters, UI              |
| `domain/`        | Pure conversation/unread/history/identity rules    | Contracts, pure helpers           | App, I/O, Solid/OpenTUI                      |
| `irc/`           | Wire codec, ISUPPORT/CAP/SASL, one-attempt session | Contracts, pure domain helpers    | App, storage, UI                             |
| `transport/`     | Bun socket/TLS adapter                             | Contracts, Bun                    | Domain/UI state                              |
| `storage/`       | SQLite/history/config/secret adapters              | Contracts, Bun/filesystem         | App, UI, live session                        |
| `services/`      | Commands, completion, OS effects                   | Contracts, pure helpers           | Direct socket/SQL access, UI internals       |
| `app/`           | Lifecycle, orchestration, read models              | Contracts, domain                 | Concrete adapter construction, Solid/OpenTUI |
| `ui/`            | Components, local interaction state, Solid bridge  | Contracts, Solid/OpenTUI          | SQL, sockets, wire codec, concrete storage   |
| future `main.ts` | Composition and terminal startup/shutdown          | All adapters and public factories | Product rules duplicated from app            |

Use direct imports from specific contract files. Avoid barrel exports hiding cycles. Contracts are the only shared modification hotspot; implementation agents should own disjoint directories.

Dependency enforcement starts with review and agent guidance; add automated import-boundary checks before parallel implementations land. TypeScript checks shapes, not architectural layering or runtime semantics.

## 4. Contract index

TypeScript in `src/contracts/` is authoritative for API shape. This document and [CONTRACTS.md](CONTRACTS.md) define behavior that types alone cannot express.

| File           | Principal exports                                                         | Implementer / consumer              |
| -------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| `common.ts`    | `Result`, `AppError`, branded IDs, `Readable`, `Clock`, `Diagnostics`     | All modules                         |
| `model.ts`     | `AppSnapshot`, `TimelineSnapshot`, `Message`, `FeatureSet`                | App produces, UI observes           |
| `app.ts`       | `AppAction`, `AppApi`, `ActionReceipt`, `OperationView`                   | App implements, UI/services consume |
| `runtime.ts`   | `CreateApp`, `AppDependencies`                                            | App factory + composition root      |
| `transport.ts` | `TransportFactory`, `ByteConnection`                                      | Bun transport + IRC session         |
| `protocol.ts`  | `IrcFrame`, `IrcCodec`, `ProtocolSupport`, `ProtocolLimits`               | Codec + session                     |
| `session.ts`   | `SessionFactory`, `IrcSession`, `SessionCommand`, `SessionEvent`          | Session + app supervisor            |
| `settings.ts`  | `NetworkProfile`, `SettingsDocument`, `SettingsChange`, repositories      | Storage + app/settings UI           |
| `storage.ts`   | `HistoryRepository`, durable conversation/workspace records, search/pages | SQLite + app                        |
| `services.ts`  | `CommandService`, `InputIntent`, `NotificationSink`, `ExternalActions`    | Services + UI/app                   |
| `discovery.ts` | Directory listings, WHOIS details and discovery read model                | Session → app → UI                  |

Contracts are **revision 1, internal and evolvable**, not semver-stable public APIs. They cover the initial vertical slice and planned modern-chat interactions. Additional settings fields, protocol queries, rich-text spans, services fallback, and provider-specific extensions should follow an explicit contract change, not be smuggled through `unknown` payloads or raw IRC escape hatches.

## 5. State and identity

### Ownership

- **Session:** negotiated capabilities, own nick/auth state, ISUPPORT, NAMES reconciliation, protocol request correlation, send queue. Emits semantic events.
- **App/domain:** network views, stable conversations/users/message identities, unread state, echo/history merge, privacy/notification policy, hot timeline windows, operation statuses.
- **Storage:** durability, schema migrations, indexes, cursor encoding, atomic writes. It does not decide whether to log a conversation.
- **UI:** focused widget, dialog stack, selection, composer cursor, scroll anchor, completion popup. Draft text is synchronized through `draft.set`; terminal editing mechanics stay local.

### Identity rules

- Opaque generated IDs are stable; names are mutable labels. Never use array positions or nick strings as message/user IDs.
- Every server message ID is scoped by network. Every user and channel lookup uses negotiated IRC casemapping, not Unicode `toLowerCase()`.
- Conversation records are persisted before their history/read positions become durable. Restore the registry on boot before history windows.
- Network status is a conversation too, but not a message target. Reject sends to status conversations.
- A direct conversation follows nick changes for a currently tracked user. Do not merge different users merely because a nickname was recycled or an account string matches.
- On casemapping changes, rebuild lookup indexes; collisions need an explicit reconciliation policy. Do not silently drop conversations.

### Read models

`AppApi.state` is lightweight sidebar/network/application state. `timeline(id)` supplies one bounded transcript/member window. `discovery(networkId)` supplies channel-browser/WHOIS data. `operations` retains a bounded recent list of asynchronous outcomes.

Snapshots are immutable by convention; publish fresh changed objects with structural sharing. Consumers must never mutate them. `getSnapshot()` preserves reference identity until a change. Subscription callbacks run after a commit; unsubscribing is idempotent. Reads do not initiate I/O.

The provided `createReadModel()` is a tiny framework-neutral publication primitive, not an application store or replacement for Solid. The app must serialize writes, avoid reentrant publication, and provide a non-throwing listener-error handler. The Solid bridge creates a signal from `getSnapshot()`, subscribes, and disposes via `onCleanup`. Split subscriptions/selectors so unrelated channels do not update the active transcript.

Closing a conversation publishes its final state, removes it from the sidebar and releases its hot window. Existing readables remain inert/readable until subscribers dispose; new `timeline(id)` calls fail unavailable. Closing a DM does not delete history; closing a joined channel requests PART first. Failures must be visible and must not falsely mark a channel as parted.

## 6. Lifecycle

### Boot

1. Composition root constructs concrete adapters; opens/migrates storage.
2. `CreateApp(deps, rootSignal)` takes ownership of those dependencies for cleanup, including failed initialization.
3. Load/validate settings, conversation registry, workspace/read positions; never partially apply malformed settings.
4. Publish ready state; start eligible auto-connects. Each network gets its own abort controller and generation counter.
5. Mount UI against `AppApi`; failures before UI mount use safe plain-text stderr output.

### One network attempt

App allocates generation → `SessionFactory.open()` → consume `events` immediately → connect/register/CAP/SASL → ready → execute channel joins. Factory returns an owned session promptly; connection/auth progress arrives through events, not a blocking await-until-registered.

Session factory open may fail synchronously at setup via `Result`; transport/auth errors after session creation arrive in events. The parent abort signal remains attached for the whole attempt. The iterator must complete on disconnect, abort, or close, even when no events are pending.

App explicitly allocates a new generation on every retry/reconnect and invalidates the old one **before** asynchronous cleanup. No event from an old or unallocated future generation can mutate current state. `session-cursor.ts` supplies the pure admission guard. Sequence gaps indicate an internal loss/overflow; close the attempt visibly rather than continuing with corrupted state.

The app supervisor owns exponential backoff/jitter and retry cancellation. Do not retry authentication/certificate/configuration failures forever; require user intervention. A user disconnect disables retries for that network for the current app lifetime. Sleep/laptop resume is treated as stale connection detection and recovery, not assumed session continuity.

### Shutdown

Reject new user actions → invalidate attempts/cancel retries → close sessions with bounded best-effort QUIT → flush eligible history/workspace/config → close adapters → dispose subscriptions → restore terminal. Attempt all cleanup even if one step fails. Return a safe failure result if durability failed; do not hang forever waiting for a server.

No automatic detached service, background daemon, or bouncer startup.

## 7. Principal flows

### Send message

1. Composer deliberate submit → commands/input service if appropriate → `message.send`.
2. App validates target, connection, reply capability, content and operation budget. Record local message/operation; return receipt with stable local ID.
3. Session accepts command into bounded flood-safe queue. Codec splits by UTF-8 byte budgets, or negotiated multiline; each piece is valid wire output.
4. Socket acceptance → `written`; correlated echo → `echo-observed`. Neither is a delivery/read receipt.
5. App merges correlated echo into the same local message, preserving its ID and adopting server identity/time. Persist eligible updates atomically.
6. Disconnection after write but before reliable echo → `uncertain`, not success or automatic resend. Retry must be explicit.

If a logical message splits into several wire messages, maintain private operation→fragment mappings. Aggregate send state conservatively; one failed fragment cannot make the whole message look successful. The current contract uses one logical local message; if representing individual fragments is required by reply/history semantics, propose that contract revision before implementation.

### Incoming message / unread / notifications

Transport bytes → codec frames → session semantic event → generation/sequence gate → identity and history reducer → persistence queue + read models → notification policy → sink.

Ignore/mute/filter are different policies: ignore suppresses selected users/content; mute suppresses notifications; noise filters change presentation only. None may corrupt membership tracking. Playback is tagged and normally does not raise fresh notifications. UI sends `view.report` on active conversation/focus/scroll changes; the app validates the referenced visible message before advancing read position monotonically.

### History and search

Read local history first. Request server/bouncer history only when negotiated and needed; absence is normal. Merge by scoped server IDs and reliable operation correlation, not heuristic timestamp/text dedupe. If no reliable identity exists, avoid dropping legitimate repeated messages.

`HistoryRepository.page()` returns a chronological page and opaque cursor to older items. Search returns newest matches first with deterministic ties. `history.reveal` loads context and activates the relevant conversation; UI scrolls to the stable message ID. Prepending and resize anchoring are UI responsibilities with domain-provided stable IDs.

Read positions and persisted metadata survive restarts; transient typing state, retries, and pending protocol operations do not. Restore previously pending sends as uncertain, never auto-replay them.

### Settings and secrets

Settings UI edits a section, then submits expected revision via `saveSettings()`. App validates semantics, repository validates schema and compares both file fingerprints/revision before replacing one file atomically. External edits cause `conflict`, never silent overwrites. Apply safe appearance values live; explain network reconnect requirements. Do not write two files as if the filesystem offers a cross-file atomic transaction.

Only `storeSecret()` accepts secret strings from secure UI input. It returns a reference; failures are visible. Passwords are never put in settings, read models, domain events or diagnostics. Initially allow environment references; secure interactive storage requires a functioning keychain adapter or an explicit unsupported result. Do not silently fall back to plaintext.

## 8. Extensibility seams

| Future need                        | Existing seam / deliberate future change                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Proxy or alternative transport     | Implement `TransportFactory`; evolve connection options when needed                                                 |
| Another IRC implementation/library | Implement `SessionFactory`, preserve semantic events                                                                |
| New modern-chat capability         | Extend semantic feature/action/event types with dependency and fallback tests                                       |
| Alternate history backend          | Implement `HistoryRepository`; preserve ordering/CAS/idempotency semantics                                          |
| Notifications/platform clipboard   | Replace injected effect adapters                                                                                    |
| New command/menu/shortcut          | Map into existing action or propose a typed new action                                                              |
| GUI/web frontend                   | Consume app ports; serialization/IPC would require a new adapter, not assumed today                                 |
| Plugins                            | Later introduce narrow permissioned contribution APIs around actions/commands; never expose arbitrary app internals |
| Detached/bouncer mode              | Separate future lifecycle/protocol design; not accidentally embedded in current UI                                  |

Avoid generic `event: string, payload: unknown` extensibility. Exhaustive discriminated unions make contract changes reviewable across all producers/consumers.

## 9. Testing strategy

- Unit tests: pure reducers, identifiers, unread policy, history merge, casemapping.
- Port conformance tests: shared behavior across fake/real implementations, especially abort/close/idempotence/cursors/conflicts.
- Protocol fixtures + scripted fake server: TCP chunking, CAP/SASL, echo and race conditions.
- Integration: Bun transport and SQLite under Bun; real IRC servers/bouncers locally, never public-network credentials in CI.
- UI: fake `AppApi`, shared `tests/fixtures/scenario.ts`, OpenTUI input/frame tests. Do not require a real IRC network to build components.
- End to end: compose adapters and run newcomer journeys in a real terminal on Linux/macOS.

Current tests run in Vitest's Node environment and cover platform-neutral foundation only. Bun-specific adapters will need a separate Bun-runtime integration command/job; do not import `bun:sqlite` into Node Vitest and pretend it is tested.

## 10. Decisions deliberately left open

- IRC library vs custom session: contracts permit both; evaluate against the Phase 0 spike.
- Exact modern IRCv3 capability strings/draft versions: pin after interoperability spike, not guessed here.
- Exact runtime budgets (queue size, timeline window, pending operations, history limits): centralize validated policy in app/session options before implementation; test overflow behavior.
- Retention default and secure credential backend: choose explicitly before personal credentials are used.
- Formatting annotations and legacy services fallback need additional typed contracts if implemented.
- Packaging/build entrypoint: add only when the real OpenTUI/Solid boot spike exists. There is no runnable terminal client yet.
