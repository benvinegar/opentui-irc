# API behavioral contracts (revision 1)

Read alongside `src/contracts/*.ts` and [ARCHITECTURE.md](ARCHITECTURE.md). These are internal in-process interfaces; no IPC/JSON transport is implied. A task is not done merely because it implements the TypeScript shape.

## Universal conventions

- Expected failures use `Result<T, AppError>`. Convert platform errors to safe messages at adapter boundaries. Exceptions are for programming invariant violations, not bad passwords or unavailable features.
- Check abort before work. Aborted operations return `cancelled` and release resources/listeners. Never attach unbounded abort listeners per keystroke/message.
- Values crossing ports are immutable owned copies, or immutable structural shares; callers cannot retain writable views of transport buffers.
- IDs are opaque branded strings. `entityId()` validates minimal shape at trusted boundaries; it is not a random ID generator or complete input validator. Constructors/repositories validate imported data at runtime.
- Times are Unix epoch milliseconds. Durations are explicitly suffixed `Ms`; wire server-time strings are parsed in the session.
- Never treat TypeScript types as validation of config files, server bytes, URI input, or database records.
- Sanitized errors/diagnostics contain no passwords, tokens, channel keys, raw frames, user message bodies, or underlying `Error.cause` objects.
- Public text is safe plain text; remove terminal control sequences before publishing. Link schemes must be allowlisted separately; text sanitization alone is not URI validation.

## User intent and operation lifecycle

### `AppApi.dispatch(action, signal)`

- Validate context, capability, size limits, connection readiness and references before accepting.
- Before acceptance, cancellation returns `cancelled` with no intentional new side effect. Once accepted, an action belongs to the app; aborting the caller signal does not unsend network traffic or roll back committed messages.
- Success returns a unique `ActionReceipt`. For synchronous local actions, the corresponding snapshot commit is already visible before the promise resolves. For network operations, success means **accepted**, not completed.
- `operations` exposes bounded recent outcomes. Network replies/errors are correlated to operations wherever reliable protocol correlation exists. Without labels, serialize ambiguous WHOIS/LIST requests and reject/coalesce overlapping requests instead of misrouting replies.
- `OperationView.completed` means local operation handling/expected protocol exchange completed, **not** delivered-to-recipient or read. Message send states have the more specific meaning below.
- Late failures stay visible even if the user switches conversations. Do not use an unscoped global toast as the sole failure record.
- Rate-limited/unsupported actions return explicit errors; UI controls must also hide/disable unsupported features.
- Modern replies/reactions/redactions require a usable server message ID; reject actions on local-only/missing/redacted targets when unsupported by the protocol.

### Message states

| State           | Meaning                                         |
| --------------- | ----------------------------------------------- |
| `pending`       | Accepted locally; may still be queued           |
| `written`       | Accepted by local socket; no delivery guarantee |
| `echo-observed` | Server echo reliably correlated and observed    |
| `failed`        | Known local/server failure                      |
| `uncertain`     | Cannot establish outcome; never silently resend |

No text-equality echo matching. A missing echo does not prove rejection. A successful socket write does not prove acceptance by the IRC server. Aggregate split-message outcomes conservatively.

### `saveSettings(change, expectedRevision, signal)`

- Save one section at a time. A successful result means the validated file replacement completed durably according to the adapter's documented filesystem guarantees and the settings read model was updated.
- Return conflict if either settings file changed since the expected revision at the final pre-replacement check. Serialize cooperating writers with an advisory lock. Standard filesystems cannot atomically compare both arbitrary externally edited files and replace one: a non-cooperating editor can race the last check/rename. Document this residual window; never claim stronger guarantees.
- Apply settings only after successful save; reconnect-required changes must not mutate live session credentials unexpectedly.
- `storeSecret` is the explicit secret ingress, not an exception allowing secret strings elsewhere. Clear UI input after handoff; JavaScript cannot promise memory zeroization.

## Read models and visibility

- `subscribe` does not fire immediately; consumers call `getSnapshot()` initially. Callbacks run synchronously after a completed commit, without payload. Do not perform reentrant state mutations from subscription callbacks; schedule new intents.
- Unsubscribe/dispose is idempotent. No callbacks after unsubscribe returns. Listener exceptions are isolated and reported safely; an error handler must not throw.
- Subscribe only while mounted. UI subscription disposal must not disconnect a network.
- Timeline readables are app-owned. Querying one does not load from disk or request server history; use an explicit action to load older data.
- `view.report` is an observation, not a request to mark all received messages read. Validate active conversation, focus, bottom/visibility and ID membership; never regress a durable read marker.
- Terminal focus detection is best effort. If unavailable, prefer conservative unread behavior over claiming attention.

## Session and transport lifecycle

### `TransportFactory.connect()` / `ByteConnection`

- Validate hostname/port/timeout; TLS verifies certificates and hostname. No silent downgrade or global “accept invalid certificate” switch.
- Signal lifetime includes the open connection. On abort: close socket, unblock reads/writes, remove handlers.
- `incoming` has one consumer. Chunk boundaries are arbitrary; buffers must remain valid after yielding.
- EOF completes the iterator. Transport read errors may reject iterator advancement; the session catches and converts them to safe error/state events before ending its own stream.
- `write` observes backpressure and bounded pending bytes. Success means local socket acceptance only.
- `close` is idempotent and attempts all cleanup even after errors. It must unblock consumers and pending writes.

### `IrcCodec`

- One codec per connection; partial CRLF and UTF-8 state never leak across attempts.
- Enforce separately configured command/tag budgets and total pending input bounds before unbounded allocation.
- Preserve unknown tags/numerics internally; validate malformed tag escapes/parameters deliberately. Emit a safe error, not raw attacker-controlled text in diagnostics.
- Serializer rejects CR/LF/NUL injection; it does not split/truncate outgoing messages silently. Session constructs valid split frames using actual byte overhead/negotiated limits.
- `finish` reports incomplete terminal input instead of inventing a final complete line.

### `SessionFactory.open()` / `IrcSession`

- Factory receives dependencies (transport, codec factory, secret provider, clock, policy) through its implementation constructor, not global imports.
- One session = one attempt. Open returns session before registration completes, so consumers can observe progress and errors. Start consuming events immediately; do not wait for `ready` to attach.
- Only the app retries. Session may try the selected transport endpoint according to the attempt plan; it must not spawn an invisible retry loop.
- Events carry network ID, allocated generation and contiguous sequence starting at 1. Do not multiplex two attempts into one stream.
- Events are semantic and sanitized. Strip raw credentials and arbitrary raw IRC control data. Expose only handled feature flags; preserve raw CAP state privately for diagnostics without secret values.
- Authentication-required profiles must never emit usable `ready` or autojoin until authentication succeeds.
- Event buffers are bounded. On overflow, preserve a terminal error/state outcome using reserved capacity, close the attempt, then end the stream. Never silently drop chat or state deltas.
- `execute` success means queue admission. Cancellation before admission returns cancelled; after admission, session execution is app-owned. Queue drain emits `send-state` or correlated completion/error. Close marks unwritten sends failed and potentially written sends uncertain.
- `execute` validates negotiated feature availability and content again, even if app already validated it. App and session are independently testable trust boundaries.
- Session must reconcile NAMES bursts with interleaved live events before emitting consistent membership changes. Do not replace newer state with a stale full list.
- Iterator completion terminates the attempt even if no final state event could be delivered. App transitions to disconnected and chooses retry policy using safe recorded context.
- `close` cancels timers/batches/queries and completes the iterator. Best-effort QUIT uses a timeout; never hang shutdown.

## History, workspace and privacy

### Atomicity and identity

- `commit` atomically writes conversation records, messages and read positions. Validate network/conversation foreign keys. Identical message-ID upserts are idempotent.
- Only the app writes; it serializes merge operations. Repository does not invent echo correlations.
- Wire server IDs are network-scoped event identifiers, not local occurrence primary keys. Enforce `(networkId, conversationId, serverId)` uniqueness when an ID exists: a shared event can occur in several channel histories. Preserve local ID on echo enrichment and repeated playback within that conversation. A collision with another local row in the same conversation requires explicit merging; never merge occurrences, reactions, or redactions across targets.
- Durable message order uses server time when available, otherwise receive time, plus deterministic stable tie-break metadata. Cursor/keyset pagination must not use OFFSET for large history. Newly received messages must not invalidate an older-page cursor and cause duplicates/skips in an unchanged older region.
- Loading persisted pending/written messages after crash must not restart sends. App converts unresolved operations to uncertain as appropriate.

### Queries

- Page limits/radius validated and capped. Invalid/foreign-query cursors return invalid-input; corrupt/obsolete schema cursors fail safely.
- `page` returns chronological items plus an older-page cursor; an absent cursor means exhausted local history. Do not conflate local exhaustion with server history availability.
- Search is literal user text, parameterized—not raw SQL/FTS syntax. Escaping FTS reserved syntax belongs to the adapter.
- Search pages are newest-first with a stable tie-break; `context` is chronological and includes the target when found. Missing target returns unavailable rather than empty ambiguous success.
- Redacted messages retain identity/order but have bodies/attachments removed from durable search data. Reactions/redactions with missing originals must not fabricate a complete original message.

### Retention and exclusions

- App decides logging eligibility **before** queuing persistence; storage should never first write excluded plaintext then delete it later.
- Conversation metadata and messages are distinct: disabling message logging may still preserve sidebar preferences, but must not preserve excluded drafts/bodies through workspace/search/export.
- On changing exclusions/history-enabled settings, explain whether existing history is retained; deletion is explicit, not silently implied.
- `deleteConversation` deletes local messages/search/read positions, not the network's records or the app's conversation identity. Avoid filesystem-level “secure deletion” promises for SQLite/WAL/backups.
- `prune` removes bodies and associated search/read references according to policy; return the count of messages removed. Do not prune newly queued messages incorrectly during concurrent flushes.
- `close` flushes pending writes, closes handles, and returns a safe failure if durability failed.

## Configuration

- Runtime schema validation is required; `schemaVersion: 1` is not a validator.
- `SettingsDocument.revision` covers both persisted files. UI receives persisted settings; eventual CLI overrides must be tracked separately so saving does not accidentally persist temporary flags.
- Validate nonempty unique network IDs, endpoint ports, SASL/TLS policy, retention bounds, shortcut conflicts, panel widths and channel/key references.
- JSONC parsing/writes preserve comments where feasible. Until comment-preserving writes exist, show a clear warning or use a confirmed explicit rewrite rather than silently removing comments.
- Atomic single-file replacement uses temp file + appropriate permissions + rename, with flush/recovery guarantees documented per platform. Detect same-process and observable external edit conflicts; tests must cover an edit during save preparation, not just load-time checks. The final non-cooperating-writer check/rename race cannot be eliminated with ordinary file replacement.
- No automatic cwd/project config loading. No secrets in exported settings; references may themselves be sensitive and should be reviewed/redacted on export.

## OS effects and command service

- Command parser produces typed intents only; it never sends to IRC, executes shell commands or accesses persistence.
- Completion offsets are UTF-16 string indices. UI explicitly converts from OpenTUI editing-buffer coordinates; never use display-cell offsets as JS string offsets.
- Pasted content stays inert until deliberate submission. Multiline/paste confirmation must not parse each pasted line as a command.
- Notification sink receives already-filtered payloads. Desktop unavailable returns unsupported/unavailable and never breaks chat; any terminal-bell fallback is chosen by app policy.
- External URL actions revalidate an explicit scheme allowlist (initially http/https), avoid shell interpolation and honor cancellation. Clipboard absence has a visible fallback; do not silently claim copy succeeded.

## Agent control adapter

`src/contracts/control.ts` defines version-1 JSON envelopes and permission vocabulary. See CONTROL.md for private socket/lease lifecycle, request/reply limits, offline routing and confirmation rules. The CLI dispatches existing typed AppActions and saves through AppApi while live; it never serializes raw sockets/IRC/SQL or wraps the whole application object.

Control `config.plan` is side-effect-free. Apply pins an expected revision; new connections/removals and destructive retention changes require their declared rights. Reload pins an inspected disk revision and shares the application's settings reconciliation. Caller flags express intent and are intersected with immutable launch grants. No read/sending/deletion authority is implied merely by configuration access.

Metadata responses exclude message/draft text and raw error bodies. Message reads/writes and history deletion require explicit separate rights. Resolved credentials are never returned; CLI secret strings enter only via bounded stdin. Mutation replay caches are bounded and process-local, never a guarantee across restart or permission to blindly retry an unknown outcome.

## Contract changes

1. Propose the producer/consumer change, fallback and migration implications.
2. Coordinator owns edits to `src/contracts/` and records the decision.
3. Update fixtures, behavioral docs, conformance tests and all impacted tasks in one integration change.
4. Do not widen a typed contract to `any`, free-form event names, raw protocol strings or arbitrary property bags to avoid coordination.
