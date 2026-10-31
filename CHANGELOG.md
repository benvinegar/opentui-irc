# Changelog

## [Unreleased]

### Added

- Public repository at `benvinegar/opentui-irc` with contributing and security-reporting guides.
- `openirc` command: `bun link` installs it from a checkout, and `bun run build` produces a standalone `dist/openirc` executable. `openirc help` and other control commands work through it.
- Runnable SolidJS/OpenTUI IRC client with a channel/DM sidebar, mouse and keyboard navigation, safe composer/paste handling, search, discovery, and settings.
- Verified TLS/SASL connections, multiple networks, automatic reconnects, paced sending and explicit uncertain-send states.
- Capability-gated IRCv3 history, replies, reactions, typing, read markers, and message removal, plus ordinary-IRC multiline fallback.
- SQLite history and retention, JSONC settings, masked credential entry and secure-vault/environment references.
- Optional Libera.Chat/OFTC setup presets, channel browsing, WHOIS details, and explicit link/clipboard actions.
- Contract-first architecture, component handoffs, local integration/UI tests, and opt-in real Ergo interoperability checks.

- Agent-first JSON control CLI with complete setting schemas, defaults, dry-run plans, revision-checked offline/live changes, profile management, and live external-file reload.
- Private Unix control socket and exclusive profile ownership; separate explicit permissions for message reads, sends and destructive work, stdin-only secret ingress, and bounded request replay protection.

### Changed

- The project is now called opentui-irc. The `openirc` command, config and data locations are unchanged; `opentui-irc` also works as a command.
- Features a server offers after you connect (IRCv3 `cap-notify`, for example chat history on a bouncer) are now enabled without reconnecting.
- Typing indicators follow IRCv3 more closely: stepping away from a kept draft sends "paused" rather than "done", so others see you paused instead of finished.
- Calmer, keyboard-first layout: the top bar, per-network buttons, conversation toolbar, Send button and duplicate hint rows are gone. Secondary actions live in a `ctrl+k` palette; one footer shows contextual keys, status and a plaintext-connection warning.
- Comfortable density, now the default for new profiles, puts a blank line above each new sender group; follow-up lines from the same sender stay together.
- Clicking a message opens a small menu at the click instead of a full-screen dialog (copy, reply, react with a choice of emoji, open links, remove mine), with one-letter shortcuts. Clicking a nickname shows a WHOIS-backed person card with Message and Copy nickname.
- Dragging across message text copies the selection on release; a plain click still opens the message menu.
- Text that doesn't fit (sidebar names, nicknames, topics, member names, status messages) ends with a one-cell "…" instead of a mid-string "...", keeping more of the name visible.
- Sidebar shows connection status dots, `#`/`@` prefixes and unread/mention badges; the header is one line with the topic and member count; wide windows show a sorted member panel.
- Consecutive messages from one sender are grouped, day changes get separators, and the nickname gutter fits the visible nicknames.
- Dialogs are rounded and titled, list their actions compactly, support ↑/↓ navigation and focus their primary action; help is a key/command table; search results show conversation and time.
- The first-run screen is shorter and leads with "Set up a network".
- Sidebar, member list and transcript author column widths can be dragged with the mouse and are saved (`tui.sidebarWidth`, new `tui.memberListWidth` and `tui.authorColumnWidth`; a null author width fits the longest visible nickname).

- HistServ messages are hidden by default, with a persistent Show/Hide toggle. History, search and authorized control reads retain them; ordinary notices and connection errors stay visible.

- Compact, glirc-style transcript with aligned 24-hour timestamps/nicknames, a full-height divider, wrapped message text and stable theme-aware nickname colors.
- Removed empty top/bottom chrome rows; the composer starts at one line and grows for multiline drafts. New profiles default to compact message spacing.

### Fixed

- Upgrading an older history database no longer fails on macOS when creating its backup.
- A network that showed "reconnecting" after an internal connection error now actually reconnects after a short wait instead of staying stuck until you reconnect by hand.
- The server's message of the day and user counts now show their text instead of "IRC server response 372.".
- Releasing a dialog press or divider drag no longer opens the message underneath.
- A rejected or temporarily unavailable nickname (432/437) during sign-in now tries your alternate nicknames, and running out of nicknames stops with a clear error instead of hanging until the registration timeout.
- Server notices without a sender (`NOTICE AUTH`) no longer drop the connection, and notices from the server itself appear as status text instead of a conversation with the server.
- `/me` actions without a closing marker, empty actions and messages with stray control characters are shown instead of silently dropped. CTCP requests are still never answered, but now appear as a status notice.
- Messages sent only to channel operators or voiced users (`@#channel`) appear in that channel.
- Messages to a nickname that is not online now say so (401) instead of failing silently; more server rejections have readable explanations, and WARN/NOTE standard replies are shown.
- Being kicked from or leaving a channel clears its member list instead of still showing the old members.
- An optional SASL login no longer disconnects from servers that finish registration before capability negotiation ends.
- A message with an invalid sender or target (such as a comma in a nickname) is skipped with a notice instead of disconnecting.
- When someone changes to a nickname you already have a DM with, that DM continues and the old one keeps its name, instead of two DMs with the same name.
- Channel member lists for channels you haven't joined (`/names #elsewhere`) no longer count as joined channels.
- Joining a channel no longer adds "IRC server response 333."-style lines for topic setter, creation time and channel modes; login and displayed-host replies read as sentences.

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
