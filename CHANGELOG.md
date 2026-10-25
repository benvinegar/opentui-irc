# Changelog

## [Unreleased]

### Added

- Runnable SolidJS/OpenTUI IRC client with a channel/DM sidebar, mouse and keyboard navigation, safe composer/paste handling, search, discovery, and settings.
- Verified TLS/SASL connections, multiple networks, automatic reconnects, paced sending and explicit uncertain-send states.
- Capability-gated IRCv3 history, replies, reactions, typing, read markers, and message removal, plus ordinary-IRC multiline fallback.
- SQLite history and retention, JSONC settings, masked credential entry and secure-vault/environment references.
- Optional Libera.Chat/OFTC setup presets, channel browsing, WHOIS details, and explicit link/clipboard actions.
- Contract-first architecture, component handoffs, local integration/UI tests, and opt-in real Ergo interoperability checks.

- Agent-first JSON control CLI with complete setting schemas, defaults, dry-run plans, revision-checked offline/live changes, profile management, and live external-file reload.
- Private Unix control socket and exclusive profile ownership; separate explicit permissions for message reads, sends and destructive work, stdin-only secret ingress, and bounded request replay protection.

### Changed

- Compact, glirc-style transcript with aligned 24-hour timestamps/nicknames, a full-height divider, wrapped message text and stable theme-aware nickname colors.
- Removed empty top/bottom chrome rows; the composer starts at one line and grows for multiline drafts. New profiles default to compact message spacing.

### Fixed

- Page Up/Down now scroll the active dialog instead of leaving long help/settings content unreachable from the keyboard.
- Keyboard focus stays visible when tabbing through long forms or resizing short dialogs.
- Modal dialogs block background mouse actions, focus changes, and accidental composer sends.
- Servers without a message of the day no longer leave a misleading connection error after successful registration.
- Conditional credential fields retain their visual Tab order; new dialogs no longer inherit stale acceptance messages.
- Disconnected and connecting networks no longer claim an active plaintext or TLS connection.
- Repeated agent status polling no longer exhausts control-socket slots with disconnected liveness probes.
- Multi-channel joins/reconnects serialize automatic history requests instead of producing avoidable history-busy errors.
- Saving appearance/history preferences closes the revision-bound form, avoiding false revision conflicts on subsequent changes.
- Shared events replayed into multiple channel histories retain separate local occurrences instead of disconnecting or cross-merging messages/reactions/removals. Existing history upgrades retain a private `.schema-v1.bak` snapshot outside active retention/deletion.
- Re-enabling logging keeps read markers for unlogged messages in memory instead of creating invalid durable bookmarks or retroactively saving message bodies.
- Typing, reply and member hints reserve their own rows in short transcripts. Dialog/blur/opt-out cleanup respects IRCv3 pacing instead of producing rate-limit errors; slash-command input is not advertised.
