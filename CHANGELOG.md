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

### Fixed

- Page Up/Down now scroll the active dialog instead of leaving long help/settings content unreachable from the keyboard.
- Keyboard focus stays visible when tabbing through long forms or resizing short dialogs.
- Modal dialogs block background mouse actions, focus changes, and accidental composer sends.
- Servers without a message of the day no longer leave a misleading connection error after successful registration.
