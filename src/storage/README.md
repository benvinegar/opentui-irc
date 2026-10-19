# Persistence adapters

- `createHistoryRepository(path: string): Promise<Result<HistoryRepository>>` in `history.ts` opens an explicit SQLite path (`:memory:` is supported for tests).
- `createSettingsRepository(directory: string): SettingsRepository` in `settings.ts` reads only `openirc.jsonc` and `tui.jsonc` under that directory. There is no cwd discovery.
- `createSecretProvider(): SecretProvider` in `secrets.ts` resolves `env:VARIABLE` and `keychain:<uuid>` references. Variables use `[A-Za-z_][A-Za-z0-9_]{0,255}`. Keychain references are private to the `org.openirc.credentials` OS-vault service.

## First run and privacy

Missing config files produce complete schema-v1 defaults: **no networks**, history **enabled for 30 days**, no persisted drafts, no typing, and no desktop/bell/preview notifications. The application must disclose local plaintext history and retention on first run; returning defaults does not itself present that disclosure. It must schedule `prune` using the effective history policy; the adapter does not invent logging eligibility or retention jobs.

The app must filter excluded messages/drafts **before** calling these adapters. Conversation/sidebar identity can remain durable even when logging is disabled. Workspace is a separate explicit write and cannot infer user settings. `deleteConversation` removes messages, read markers, searchable bodies, and that conversation's saved draft, while retaining its identity/sidebar metadata. Pruning removes messages and associated read markers, not unrelated workspace drafts. Redaction strips durable text and reactions, retaining identity/order. Nothing promises secure filesystem erasure: SQLite free pages, WAL, backups, snapshots and remote/server copies can retain previously written material.

## SQLite schema and ordering

`PRAGMA user_version=2` is created transactionally on a new/empty database. Version 1 upgrades its server-event identity index transactionally after a consistent `VACUUM INTO` backup to `<database>.schema-v1.bak`, including committed WAL contents. The backup is created exclusively with mode 0600 before any body is written; a preexisting backup is never overwritten and blocks retry pending inspection. Backup failure leaves the old schema untouched. The retained backup contains plaintext history and is outside active retention/deletion: preserve or remove it consciously. An unknown populated unversioned database or newer version is rejected without a destructive migration. Future migrations must likewise take a consistent backup first. Database file mode is 0600; newly created parent directories use 0700. WAL, foreign keys, `synchronous=FULL`, and a bounded 1-second busy timeout are enabled. Close checkpoints WAL and closes even after a flush error; calls after close fail explicitly.

Registry/message/read commits are single SQLite transactions. Conversation ID binds network and kind; message ID binds conversation/network. Partial unique `(network_id, conversation_id, server_id)` prevents silent same-conversation collisions; `findByServerId` requires both network and conversation. A network event replayed into multiple channel histories retains distinct local occurrences, never cross-target merges. Reads validate stored JSON/columns and return owned copies. Messages are ordered by `(serverTime ?? receivedAt, localId)`; echo enrichment may change the effective time, while newer inserts do not invalidate keyset cursors in an unchanged older region. Cursors are schema/query-bound, including search filters; no OFFSET pagination. Pages cap at 500, context radius at 250, commits at 10,000 records per array and 16 MiB aggregate encoded records; workspace writes cap at 8 MiB aggregate entries. Oversized writes fail explicitly before changing durable data.

Search uses parameterized literal, case-sensitive SQLite `instr`, not SQL/FTS syntax, with indexed scope/order and no persistent auxiliary search copy. This intentionally prioritizes correctness over full-text performance: million-message substring search is not benchmarked or claimed fast. Wire server IDs identify network events; local lookup and occurrence deduplication also require the conversation. Read markers never move backwards in durable message order.

## JSONC writes and conflicts

Strict runtime validation rejects unknown settings fields (including accidental plaintext passwords), invalid security/retention policies, conflicting shortcuts, and oversized input. Config files cap at 1 MiB. JSONC permits comments/trailing commas. Leaf-level `jsonc-parser` edits preserve comments/formatting on surviving values where feasible; comments belonging to deliberately removed entries may disappear.

Revision hashes cover exact contents of **both** files, including comments and missing-file state. A save creates a 0600 exclusive `.settings.lock`, checks both fingerprints, prepares a unique 0600 temp file, flushes it, checks both fingerprints again, then atomically renames **one** settings file and fsyncs the directory. Cooperating writers serialize; a busy lock yields conflict. Failure before rename leaves the old settings file intact and attempts temp/lock cleanup. A durability error after rename is reported even though replacement may already be visible. Guarantees depend on local Linux/macOS POSIX filesystem semantics; network filesystem semantics are not claimed.

Ordinary filesystems cannot atomically compare two externally edited files and replace one. A non-cooperating editor can still race the final check/rename. After a process crash, a stale `.settings.lock` must be removed explicitly once no OpenIRC writer is active; it is not automatically stolen based on an unsafe age guess. Orphan `.settings-*.tmp` files are never loaded as config and may be removed after confirming no active writer.

## Secrets

No plaintext fallback exists. `store` uses `Bun.secrets.set` and verifies a successful readback before returning a keychain reference. Missing/locked/unusable OS-vault support returns explicit unsupported. Environment lookup never persists values. Cancelling a pending vault lookup promptly unblocks the caller and detaches the abort listener (the non-cancellable OS request may finish internally). Cancellation is checked before ingress; a secure-store write already admitted may complete and return its reference even if the caller subsequently cancels. JavaScript cannot promise credential memory zeroization.

The vault implementation is real, but Linux Secret Service/macOS Keychain availability is machine-dependent. Tests use an injected test runtime vault to verify dispatch/readback/failure, not personal keychain writes. No live OS keychain interoperability claim is made by the tests.

## Tests

```sh
bunx vitest run tests/storage
bun test tests/storage/history.bun.test.ts
```

The SQLite suite runs only under Bun. Config/secrets tests run under Node/Vitest; no public IRC networks or personal credentials are used.
