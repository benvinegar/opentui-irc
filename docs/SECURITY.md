# Security and privacy model

OpenIRC is an early personal-use client, not a security-audited release. The test suite verifies specific behaviors; it does not establish complete security or platform compatibility.

## Trust boundaries

- IRC servers, peers, message tags, nicknames, topics, playback and error text are untrusted input. Protocol framing and user text have separate validation/sanitization paths.
- TCP/TLS data stays inside transport/session infrastructure. The UI receives semantic plain-text records, not raw IRC lines or terminal escape sequences.
- User settings and SQLite records are runtime-validated. TypeScript declarations are not validation of external data.
- OS effects use argument arrays, not shell interpolation. Network text cannot invoke commands, upload files, fetch media or execute scripts.
- URL opening is user-initiated, restricted to HTTP/HTTPS and revalidated by the adapter. A browser visit can disclose IP address, cookies and referrer/browser metadata; OpenIRC cannot control the browser.

## Transport and credentials

Use verified TLS. Plain TCP is possible through explicit file configuration for local/legacy environments; it is visibly insecure and has no protection against interception. There is no automatic TLS downgrade or invalid-certificate bypass. TLS protects the client/server link, **not end-to-end message confidentiality**: servers, bouncers and recipients can access messages.

SASL PLAIN is allowed only on verified TLS. Server passwords and channel keys are secrets, not ordinary settings values. Credentials enter via a masked UI-local password field or environment reference and resolve privately in the session. Diagnostics/read models must never contain resolved credentials or raw authentication lines.

The OS-vault adapter uses Bun's Secret Service/macOS Keychain integration and verifies a readback before reporting success. Desktop-session/vault availability varies. If unavailable, use an explicit environment reference; there is no plaintext-file fallback. Environment variables can be exposed to child processes and local process inspection according to OS permissions. Avoid putting literal passwords in command arguments or shell history.

The UI clears password entry at handoff/disposal, but JavaScript cannot guarantee zeroization. If a credential was stored successfully and a later settings write failed, an unused vault record can remain; automatic vault-entry deletion is not currently implemented.

## Local history and filesystem

History is local **plaintext SQLite**, enabled for 30 days by default. New private directories/files use restrictive permissions. This is access control, not encryption. Database/WAL files, filesystem snapshots, backups, crash dumps and an account with access to your user can expose message bodies and metadata.

- Logging exclusions are checked before persistence, including saved drafts.
- Disabling logging prevents future message-body writes; it does not implicitly erase old history.
- Local deletion cannot remove server/bouncer/recipient copies or guarantee forensic erasure from SQLite/filesystem storage.
- Configuration contains credential references, not their resolved values. References, hostnames, nicknames, channel names and database paths can themselves be sensitive.
- Settings do not automatically load from the working directory. Bun's own runtime/environment-file behavior is separate from OpenIRC configuration; use trusted launch environments.
- Normal filesystem operations cannot fully eliminate a race with an arbitrary non-cooperating editor. Saves detect revisions, serialize cooperating writers and atomically replace one file; see [adapter guarantees](../src/storage/README.md).

## Attention and external effects

Desktop notifications and previews are opt-in by default. Preview-off notifications can still expose sender/channel names. Mutes, terminal focus and playback filtering are app policies; focus detection varies by terminal, so unread behavior is conservative.

Clipboard content is handed to the desktop clipboard only on explicit copy. Other local software can access clipboard contents depending on the OS. Link previews, inline media downloading, telemetry, plugins, DCC/file transfer, arbitrary hooks and shell execution are not part of the client.

## Failure behavior

Queues, incoming buffers, batches and hot history windows are bounded. Overflow must produce a visible error/connection termination, not silently lose state. Partial sends and missing echoes are represented as uncertain; reconnect/restart does not automatically resend them. No state is a recipient delivery/read guarantee.

Do not share raw databases, full config files, passwords, tokens, raw IRC traces or screenshots containing private conversations when reporting problems. Prefer safe error codes and minimal synthetic reproductions. A public repository/security-reporting channel has not been created for this project yet.
