# OpenIRC — product and implementation plan

Status: product direction confirmed; implementation details and milestone cut remain provisional. Personal daily driver first, no deadline. Project name: **OpenIRC**. License: **MIT**.

## 1. Product definition

A full-screen IRC client built with **Bun, TypeScript, SolidJS, and OpenTUI**. Familiar IRC behavior with discoverable controls, mouse interaction, scrollbars, reusable UI components, and excellent keyboard navigation.

**The promise:** connect securely, find channels, follow conversations, talk comfortably, and recover gracefully when connections fail—without learning a terminal-client configuration language first.

The primary audience is **newcomers**. Design mouse-driven, discoverable workflows first while keeping keyboard alternatives. Visual direction: Discord-like within terminal constraints; navigation: Slack-like sidebar with channels and direct conversations, one active conversation at a time.

“Common 80%” means coverage of everyday workflows, **not** implementing 80% of competing clients' features. This is a product hypothesis based on capability comparison, not measured user-frequency data. Validate it with users before treating the cut as final.

### Proposed boundaries

- Standalone local client; works over SSH and in tmux where supported.
- Multiple simultaneous IRC networks, channels, and private conversations.
- Compatible with existing bouncers; no bundled bouncer or background service in v1.
- Keyboard-complete; mouse is an enhancement, never a requirement.
- Supported platforms: Linux and macOS. Windows/WSL are outside the initial scope.
- UTF-8 first. Legacy encodings are deferred.
- IRC semantics first; do not imply end-to-end encryption, guaranteed delivery, universal history, or Slack-style features that servers do not support.

## 2. OSS comparison: what to borrow

This is a capability/positioning map from official project documentation, not an exhaustive tested compatibility matrix. Features can be built in, optional, scripted, or server-dependent; absence from a row is not a claim that a client lacks something.

| Client | Documented strengths | Implication for OpenIRC |
|---|---|---|
| [WeeChat][weechat] | Multi-server IRC, TLS, SASL, proxy, nick lists, anti-flood, mouse, split windows, dynamic filtering, incremental search, logging and extensibility, relay, DCC | Match daily IRC reliability and navigation. Adopt mouse/filter/search ergonomics. Defer relay, plugins, and DCC. |
| [Irssi][irssi] / [manual][irssi-manual] | Modular text client; rich theming and scripting; window-oriented workflow and IRC command help | Keep fast keyboard operation, commands, and predictable conversation switching. Avoid making scripts necessary for basic usability. |
| [HexChat][hexchat] | Approachable customizable GUI; multiple networks, auto-connect/join/identify, SASL, proxies, scripting, spellcheck, DCC | Borrow easy network setup and sensible defaults. Use as a historical usability reference: its maintainer announced the final release in February 2024. |
| [Halloy][halloy] | Modern desktop client; configurable panes, themes, shortcuts, notifications; extensive IRCv3 capabilities including history, account tracking, read markers, replies, and reactions | Use as a modern interaction/protocol reference, but do not copy its whole extension surface into v1. |
| [The Lounge][lounge] | Self-hosted web client; always-connected service, multi-device continuity, push notifications, previews, uploads, IRCv3 | Borrow continuity and readable conversation UX. Use existing bouncers for offline collection rather than building a server product. |

### Scope conclusions

1. Multiple networks, secure authentication, channels/DMs, nick completion, unread/highlight state, logs, and reconnects are foundational.
2. Strong commands and discoverable forms/menus should share the same action layer.
3. History is two features: local persistence and optional server/bouncer playback. Neither means a standalone closed client receives messages.
4. Modern IRCv3 support is a product priority, negotiated feature by feature rather than an all-or-nothing badge. Bring replies, reactions, typing, and continuity into the modern-driver milestone where supported.
5. Extensibility, remote relays, DCC, media systems, and exotic configuration dominate the long tail; leave them outside the first release.
6. Mouse and scrollbars alone are not unique: WeeChat already has mouse support. The differentiator is coherent, approachable interaction throughout the client.

## 3. Feature inventory

### Priority legend

- **A — Alpha:** minimum genuinely usable client, not a throwaway protocol demo.
- **V — v1:** included in the proposed common-80% release, after alpha.
- **L — Later:** plausible follow-up; explicitly outside the v1 commitment.
- **X — Out:** do not build without new product evidence.

### Connections and identity

| ID | Feature | Priority |
|---|---|---|
| NET-01 | Saved network profiles: name, host/port, TLS, nick/alternate nick, username, real name, server password | A |
| NET-02 | Multiple concurrent networks; network-specific status/error buffer | A |
| NET-03 | Direct TCP/TLS, hostname/certificate verification, IPv4/IPv6; explicit warning for plaintext | A |
| NET-04 | SASL PLAIN over TLS; visible authentication status and actionable failures | A |
| NET-05 | Require-auth option; do not autojoin protected channels before authentication succeeds | A |
| NET-06 | Auto-connect, autojoin with channel keys, reconnect with exponential backoff/jitter and cancel | A |
| NET-07 | Registration timeout, keepalive PING/PONG, stale connection detection, connection states | A |
| NET-08 | Nick collision fallback and user-directed nickname changes | A |
| NET-09 | Flood-safe outgoing queue; visible disconnect/send failures; never silently replay uncertain sends | A |
| NET-10 | SASL EXTERNAL and TLS client certificates | L |
| NET-11 | NickServ identify fallback with secret redaction and safe timing; network-specific, not universal | V |
| NET-12 | Ordered fallback server endpoints; manual reconnect/disconnect; optional rejoin after kick | V |
| NET-13 | Existing ZNC/soju-style bouncer connection profiles; server-time/playback handling | V |
| NET-14 | SOCKS5 proxy and credentials, including remote DNS behavior; show unsupported combinations clearly | L |
| NET-15 | IRC/IRCS URI handling with confirmation; never auto-execute commands from a URI | V |
| NET-16 | Lag/status indicator and sanitized protocol diagnostics | V |
| NET-17 | HTTP CONNECT proxy, SCRAM authentication, legacy encodings | L |
| NET-18 | Bundled bouncer, detached daemon, remote-client protocol, multi-device service | X |

### Channels, people, and ordinary IRC

| ID | Feature | Priority |
|---|---|---|
| IRC-01 | Join/part channels, channel keys, channel tabs/buffers, channel-specific errors | A |
| IRC-02 | Channel messages, private messages, NOTICE, CTCP ACTION (`/me`) | A |
| IRC-03 | Channel topic display; user list with privilege prefixes and stable nick colors | A |
| IRC-04 | Correct JOIN/PART/QUIT/NICK/KICK/MODE/TOPIC state updates | A |
| IRC-05 | NAMES, WHOIS, WHO; readable user information panel and server replies | A |
| IRC-06 | Away/back state and away replies; own nick/account/connection status | A |
| IRC-07 | Handle invites, join errors, bans, full/keyed/invite-only channels intelligibly | A |
| IRC-08 | Channel browser: LIST results, incremental rendering, search/filter, join action | V |
| IRC-09 | Topic editor, channel info and mode display | V |
| IRC-10 | Basic moderation: kick, ban/unban, kickban, op/deop, voice/devoice, invite; permission-aware controls | L |
| IRC-11 | Ban-list viewer/editor and server-advertised mode interpretation; avoid assuming quiet/extban syntax | L |
| IRC-12 | Ignore/mute by nick/hostmask and account where available; distinguish local ignore from server bans | V |
| IRC-13 | Favorites/autojoin manager; channel/user quick actions | V |
| IRC-14 | Rate-limited CTCP PING/VERSION handling with privacy controls; no arbitrary CTCP execution | V |
| IRC-15 | MONITOR-based online watch list, with honest unsupported-network fallback | L |
| IRC-16 | Full IRC operator administration and network-services management UI | X |
| IRC-17 | DCC chat, DCC/SEND/XDCC file transfer, automatic file acceptance | X |

### Composer and commands

| ID | Feature | Priority |
|---|---|---|
| INPUT-01 | Unicode-aware text editing, wrapping, undo/redo and familiar editing shortcuts | A |
| INPUT-02 | Per-buffer drafts and per-buffer/session input history | A |
| INPUT-03 | Tab completion for nicks, channels, and slash commands; predictable cycling | A |
| INPUT-04 | Core slash commands and contextual `/help`; literal slash escape (`//`) | A |
| INPUT-05 | Safe paste: never auto-send; preview/confirm multiline or large paste; pasted commands remain inert text | A |
| INPUT-06 | UTF-8-byte-aware message splitting respecting IRC framing/target overhead; paced multiline fallback | A |
| INPUT-07 | Failed/pending/echo-observed send states without implying delivery or read receipts | A |
| INPUT-08 | Multiline composer with clear send/newline keys and a compatible fallback for terminals lacking modifier detail | V |
| INPUT-09 | Command suggestions/argument help and searchable command palette | V |
| INPUT-10 | Simple aliases with bounded expansion; no shell execution or script engine | L |
| INPUT-11 | Basic IRC formatting insertion and preview; optional outgoing formatting | V |
| INPUT-12 | Negotiated IRCv3 multiline where supported; honor advertised limits | V |
| INPUT-13 | Spellcheck, external-editor integration, advanced snippet/template engine | L |
| INPUT-14 | Embedded shell, arbitrary executable hooks, full plugin ecosystem | X |

**Alpha command set:** `/connect`, `/disconnect`, `/reconnect`, `/join`, `/part`, `/query`, `/msg`, `/notice`, `/me`, `/nick`, `/away`, `/back`, `/whois`, `/who`, `/names`, `/topic`, `/mode`, `/invite`, `/kick`, `/close`, `/clear`, `/quit`, `/help`.

**v1 additions:** `/list`, `/ignore`, `/unignore`, `/mute`, `/unmute`, `/search`, `/set`. Moderation conveniences, aliases, and `/raw` are deferred; basic underlying IRC commands may remain available without dedicated UI. Exact syntax remains to be designed. `/clear` clears the view, not stored history; deletion must be a separate explicit operation.

### Transcript, attention, and history

| ID | Feature | Priority |
|---|---|---|
| CHAT-01 | Wrapped timestamped messages, readable system events, day separators, nick colors | A |
| CHAT-02 | Scrollback with mouse wheel, draggable scrollbar, Page Up/Down, jump to latest | A |
| CHAT-03 | Stable scroll anchor while receiving messages or resizing; never force a reader back to bottom | A |
| CHAT-04 | Unread and mention counts, first-unread marker, next unread/mention navigation | A |
| CHAT-05 | Nick-boundary-aware mention detection; DMs distinguished from ordinary activity | A |
| CHAT-06 | Safe IRC formatting renderer; strip arbitrary terminal controls, support no-color mode | A |
| CHAT-07 | URL detection and selectable/copyable messages; confirm opening external links | A |
| CHAT-08 | Durable local history with retention controls and opt-out/per-buffer exclusions | V |
| CHAT-09 | Fast local search across conversations, scoped by network/buffer/sender/time; jump to context | V |
| CHAT-10 | Reload recent history after restart, restore read positions, explicit older-history loading | V |
| CHAT-11 | Supported server/bouncer playback: ordering, provenance, IDs, deduplication, bounded pagination | V |
| CHAT-12 | Join/part/quit noise filters and collapsed bursts; filtering must not corrupt membership state | V |
| CHAT-13 | Custom highlight words, per-buffer mute/notification settings, mentions/activity view | V |
| CHAT-14 | Terminal bell/urgency; optional desktop notification adapter with focus checks and private preview controls | V |
| CHAT-15 | Plain-text export, delete local history, predictable retention cleanup | V |
| CHAT-16 | Persist drafts across restarts with an explicit privacy setting | V |
| CHAT-17 | Replies, reactions, typing indicators, synchronized read markers and redactions, negotiated with server support and pinned draft versions where applicable | V |
| CHAT-18 | Automatic URL unfurling, inline images/video, uploads/paste hosting, rich metadata/avatar system | X |

Read state must depend on the active visible conversation, scroll position, and terminal focus when detectable—not just receipt. History replay must not trigger a storm of new-message notifications. Unknown extensions should degrade to readable ordinary IRC.

### Full-screen TUI and usability

| ID | Feature | Priority |
|---|---|---|
| UI-01 | Slack-like sidebar grouped by network with Channels and Direct Messages sections, unread badges and clear add/join actions; one active transcript, optional member list, topic/header, composer, status/footer | A |
| UI-02 | Click to select conversations/users; scrollable lists; visible focus and selection | A |
| UI-03 | Complete keyboard navigation, focus traversal, next/previous buffer, fuzzy quick switcher | A |
| UI-04 | Responsive layout: hide optional panels in small terminals; resize without losing drafts/anchors | A |
| UI-05 | Setup flow for network/auth/autojoin; errors explained without needing protocol knowledge | A |
| UI-06 | Help/keybinding overlay; keyboard equivalents for every essential pointer action | A |
| UI-07 | Correct terminal restoration on exit/error; sensible Ctrl+C behavior and quit confirmation when needed | A |
| UI-08 | Context/action menus for conversations, users, and messages; keyboard menu invocation | V |
| UI-09 | Toggleable/resizable side panels; saved widths, order, and active conversation | V |
| UI-10 | Theme tokens, dark/light/high-contrast presets, configurable timestamps and density | V |
| UI-11 | Remappable shortcuts with conflict detection; settings forms and config-file parity | V |
| UI-12 | Clipboard via terminal/OS integration where available; explicit copy fallback over SSH/tmux | V |
| UI-13 | Non-color unread/status cues, reduced-motion defaults, no emoji dependency, mouse-off mode | V |
| UI-14 | Multiple simultaneous transcript panes, drag-reorder, extensive layout customization | L |
| UI-15 | Full localization, independently verified screen-reader workflow | L |

Do not claim browser-style accessibility: OpenTUI does not expose a browser accessibility tree. Keyboard operation and high contrast are requirements, but do not establish screen-reader compatibility.

### Configuration, security, and distribution

| ID | Feature | Priority |
|---|---|---|
| SYS-01 | Typed validated config, documented paths, actionable config errors, safe defaults | A |
| SYS-02 | No committed secrets; credential references; restrictive file permissions and diagnostic redaction | A |
| SYS-03 | Bound memory, input sizes, batches, search results, outgoing queue and protocol timeouts | A |
| SYS-04 | Version/help CLI, clean shutdown, debug logging opt-in; no telemetry by default | A |
| SYS-05 | SQLite persistence/migrations, atomic config writes, backups before migration, recovery errors | V |
| SYS-06 | Secret retrieval from environment or platform keychain where supported; no claim of encrypted storage otherwise | V |
| SYS-07 | Config import/export with secrets excluded; sample profiles and first-run documentation | V |
| SYS-08 | Versioned releases, checksums, tested install/uninstall, target-platform smoke tests | V |
| SYS-09 | Credential/config/history threat-model documentation; no automatic network fetches for message content | V |
| SYS-10 | Selective settings reload without reconnect; reconnect-required settings explained | V |
| SYS-11 | Full-disk/app-managed history encryption and competing-client config migration tools | L |
| SYS-12 | Automatic self-updates, cloud sync, analytics backend | X |

Local history and drafts may contain private material. Deleting them locally cannot delete server/bouncer records, exported logs, filesystem snapshots, or other users' copies.

## 4. Protocol compatibility requirements

Build against [Modern IRC][modern-irc], not just historical RFC assumptions. The following are proposed implementation tiers, not a claim of current support.

### Alpha foundations

- Incremental CRLF line framing across arbitrary socket chunks; correct trailing parameters, numerics, prefixes, tags and escaping.
- Byte limits are distinct from display widths, Unicode graphemes, and JavaScript string length. Account for the separate IRCv3 tag budget.
- `005 ISUPPORT` parsing: server-advertised `CASEMAPPING`, `CHANTYPES`, `PREFIX`, `CHANMODES`, limits and related tokens. Never lowercase all identifiers with JavaScript's default behavior.
- Connection registration state machine; PING/PONG while registering; SASL success/failure; nick collisions; CAP timeout and fallback.
- `CAP LS 302`, continuation, REQ/ACK/NAK, END and `cap-notify`.
- `sasl`, `message-tags`, `server-time`, `multi-prefix`.
- Capability-aware `echo-message`: prevent duplicate local echo; represent uncertainty honestly when an echo never arrives. Without echo, local display is not proof of delivery.
- Accurate channel/user state including NAMES bursts interleaved with live events and mode changes.
- Generic readable rendering of unrecognized numerics; safe handling of unsupported capabilities.

### v1 modern baseline

- `account-notify`, `account-tag`, `extended-join`, `away-notify`, `chghost`, `userhost-in-names`.
- `batch`, message IDs (`msgid` tags), `labeled-response`, standard replies; bounded batch lifetime/size.
- `CHATHISTORY` where supported, with batch/server-time/message-ID dependencies and pagination limits.
- WHOX where advertised for user details; `UTF8ONLY` handling.
- Modern messaging: replies, reactions, typing, synchronized read markers, redactions, and multiline, where available. Gate UI actions by negotiated support; do not fabricate delivery/read guarantees.
- Replies need not imply full threaded conversations. Use a compact quoted-message context and jump-to-original initially.
- Typing must be transient, rate-limited, and configurable. Reactions/redactions/read markers must tolerate missing history and unsupported peers.
- Test actual ZNC and soju behavior; do not assume every playback mechanism is standardized. Vendor-specific playback adapters require explicit scope and tests.

### Later / deliberate non-goals

- `MONITOR`, STS, `setname`, network-discovery extensions, and moderation-focused `invite-notify`.
- Several history and richer-message extensions remain drafts/work-in-progress in the IRCv3 index. Pin implemented versions and capability strings, test real servers, and document fallback behavior.
- Prefer direct TLS; do not implement deprecated STARTTLS as the default security path.
- Do not request capabilities merely because they exist: negotiate only what we handle correctly.

## 5. Technical architecture

Start as one application repository, with clear module boundaries; no monorepo/package explosion until useful.

```text
src/
  irc/          Parser/serializer, capability negotiation, connection state machine
  transport/    Bun sockets/TLS, optional proxy, timeouts, send queue
  domain/       Networks, conversations, users, messages, unread state; reducers/events
  commands/     Typed command registry, validation, completion, shared UI actions
  storage/      SQLite, migrations, history queries, config, secret references
  services/     Search, notifications, history merge, link/clipboard adapters
  ui/           SolidJS/OpenTUI components, focus, themes, layout, screens
  app/          Bootstrap, lifecycle, dependency wiring
```

### Key choices

- Keep transport/protocol/domain independent of OpenTUI and SolidJS so tests do not require a terminal.
- Typed events update normalized domain state; SolidJS signals/stores expose fine-grained reactive slices. A message in one channel should not update every buffer.
- Separate conversation identity from display names; scope users/messages to network and use IRC casemapping rules.
- Separate stored messages from transient UI state and incoming protocol records. Store provenance/timestamps/IDs needed to merge history safely.
- SQLite through Bun is the initial persistence candidate. Paginate history; keep bounded hot windows rather than mounting the database in the UI.
- Give sending, reconnecting, and playback explicit state machines. Cancellation and connection-generation IDs prevent stale callbacks mutating a new connection.
- Use a maintained IRC library only if it passes a Bun/TLS/IRCv3/state-behavior spike. Otherwise implement a small tested protocol core; decide before building UI on its API.
- No raw HTML/browser assumptions; compose OpenTUI renderables through `@opentui/solid`.

### OpenTUI-specific opportunities and risks

Verified in current documentation:

- [`<scrollbox>`][scrollbox] manages scrollbars, sticky-edge scrolling and viewport culling.
- [`<textarea>`][textarea] supports multiline editing, wrapping, selections, undo/redo and custom bindings.
- [Interaction APIs][interaction] expose mouse routing, focus, selection and test input helpers.

Application work still required:

- Scrollbox paint culling **is not full virtualization**: offscreen children still incur layout costs. Benchmark long histories and use a bounded/windowed message model.
- Preserve anchors when prepending history or rewrapping text. Sticky-bottom alone does not solve these cases.
- Implement focus traversal, modal focus traps/restoration, shortcut precedence and context-menu behavior. Core does not provide automatic Tab traversal.
- Reconcile selection/copy, link clicks, drag handles, and scrollbars; mouse events are not browser click events.
- Validate CJK, combining characters, emoji, terminal cell widths, clipboard behavior and tmux/SSH input before promising parity.
- Pin OpenTUI versions during early development; distinguish documented framework behavior from our tested application guarantees.

## 6. Build sequence and acceptance gates

### Phase 0 — de-risk the stack and freeze the cut

- Minimal Bun + SolidJS/OpenTUI app: transcript, scrollbars, composer, selection, dialog, focus traversal.
- Real TLS connection/auth spike against a local test IRC server.
- Evaluate IRC dependency vs custom core; validate Bun runtime and distribution requirements.
- Test scroll anchoring, 10k-message dataset with bounded UI window, resize and Unicode.
- Test intended terminal/platform matrix; decide clipboard, notification and secret adapters.
- Confirm v1 scope and document tradeoffs. No calendar estimate until these risks are measured.

**Gate:** real sent/received messages; usable keyboard and mouse; no terminal corruption; measured rendering behavior; recorded architecture decisions.

### Phase 1 — daily-chat alpha

- Implement all A features: secure connections, essential protocol/state, multi-network shell, channels/DMs, commands, completion, safe paste, scrollback and unread state.
- Add protocol fixtures and fake-server tests alongside implementation, not afterward.

**Gate:** a user can configure two networks, authenticate, join channels, exchange DMs, find unread messages, resize/scroll, lose/recover the connection, and quit cleanly. Authentication failures cannot silently become unauthenticated channel joins.

### Phase 2 — continuity and discovery

- Local history/retention/search, restored read positions, playback merge, filters, highlights and notifications.
- Channel browser, favorites, user/channel details and bouncer compatibility.

**Gate:** restart preserves expected history/read state; playback does not duplicate messages or spam notifications; search opens surrounding context; offline gaps are clearly explained.

### Phase 3 — modern personal daily driver

- Negotiated replies, reactions, typing, multiline, synchronized read markers and redactions. Use a modern local server/bouncer test environment to exercise these; plain IRC remains fully usable.
- Settings UI/config parity, themes/remapping, menus, clipboard and export; polish Discord-like visual hierarchy and Slack-like sidebar behavior.
- No moderation tooling, plugins, aliases, proxy/client-certificate work, or split panes in this milestone unless actual daily use demonstrates a need.
- Close remaining V features or explicitly revise the scope rather than silently omitting them.

**Gate:** newcomer workflows work with mouse or keyboard; supported modern features work end to end; unsupported features are explained or hidden without breaking chat; config and UI edits agree.

### Phase 4 — release hardening

- Multi-server interoperability, hostile-input/security review, migrations, packaging, documentation, soak/performance testing.
- Accessibility/keyboard review and real SSH/tmux testing on declared supported terminals.

**Gate:** reproducible release artifact(s), install/upgrade smoke tests, documented limitations, no known message-loss/credential-leak/terminal-injection defects.

## 7. Test and quality plan

### Automated

- Parser/serializer fixtures: partial chunks, escaped tags, unusual prefixes/numerics, malformed and oversized input, UTF-8 byte boundaries.
- State tests: casemapping, NAMES/live-event races, nick changes, modes, reconnect generations, CAP/SASL sequences, failed sends.
- History tests: dedupe scope, ordering, echo reconciliation, missing IDs, overlapping pages, partial batches, read state, retention and migrations.
- Fake server integration: registration/auth failures, disconnects, timeouts, ping floods, rate limiting, unsupported capabilities.
- Local real-server integration: modern server (e.g. Ergo), a second server implementation (e.g. InspIRCd), plus soju/ZNC test profiles.
- OpenTUI headless interaction/frame tests: focus, completion, paste preview, modals, mouse/keyboard navigation, resize, unread markers and scroll anchors.
- Security regressions: terminal escape injection, CRLF command injection, malicious URLs, secret logging, unsafe history/export paths.

### Manual release matrix

- Supported Linux/macOS terminals; SSH and tmux; minimum usable geometry and very small windows.
- Mouse on/off, clipboard absent, limited key modifiers, 256-color/no-color modes.
- CJK/emoji/combining text; text selection spanning wrapped messages.
- Busy channel while searching or reading old messages; reconnect and replay while composing.
- Screen-reader exploration before making accessibility claims.

### Proposed measurable budgets (validate in Phase 0)

- Input-to-visible-update p95 under 50 ms on a declared baseline machine.
- Conversation switching p95 under 100 ms with hot history.
- Local indexed search first page under 500 ms for a one-million-message test corpus.
- Sustained 100 messages/second synthetic traffic without blocking input or unbounded growth; batch UI/persistence work.
- Flat memory after hot-buffer caps are reached during a multi-hour soak; measure and set a numeric memory budget after the spike.

These are engineering targets, not current performance claims.

## 8. What “80% done” should mean

Validate complete journeys, not isolated checkboxes:

1. **Newcomer:** add network → authenticate → find/join channel → talk without learning slash commands.
2. **Daily user:** connect several networks → switch with keyboard/mouse → complete nicks → follow mentions → search old conversations.
3. **Laptop user:** suspend/network loss → reconnect → restore channels → recover available history without duplicate messages.
4. **Bouncer user:** connect to existing bouncer → receive playback → preserve timestamps/read state → avoid notification floods.
5. **Modern-chat user:** react/reply where supported → navigate to context → see typing and restored read positions without implying universal support or read receipts.
6. **Remote terminal user:** SSH/tmux → navigate entirely by keyboard → paste safely → copy with available fallback → exit cleanly.
7. **Privacy-conscious user:** disable logs/previews, reference secrets safely, inspect retention, remove local history.

Run these with users of at least a terminal IRC client and a GUI IRC client. Track missing steps and task completion; change the cut based on evidence, not feature-count parity.

## 9. Confirmed product decisions

1. **Audience:** newcomers; make everyday actions discoverable and mouse-driven, with keyboard parity.
2. **Platforms:** Linux/macOS.
3. **Connection lifecycle:** closing the app disconnects; use existing bouncers/tmux for continuity.
4. **Navigation:** one active conversation, Slack-like sidebar listing channels/DMs, fast switching; no split panes initially.
5. **History:** enabled with first-run disclosure, configurable retention and per-conversation exclusions. Exact default retention duration remains an implementation decision.
6. **Configuration:** in-app settings plus editable files, inspired by OpenCode. No file editing required for ordinary setup.
7. **Modern messaging:** Modern IRC plus current applicable IRCv3 extensions, including modern Slack-like interactions where supported. No single numbered “latest IRC” version exists.
8. **Power-user scope:** avoid for now; moderation, DCC, plugins, scripting, aliases and advanced connection tooling are deferred.
9. **Visual direction:** Discord-like hierarchy and styling adapted to terminal cells, not a dense traditional IRC layout.
10. **Delivery:** personal daily driver first, proof through real use, no deadline. Public-release polish is a later gate, not a prerequisite for trying the app.
11. **Identity:** OpenIRC, MIT license.

### Configuration design inspiration

OpenCode's [configuration documentation](https://opencode.ai/docs/config/) describes JSON/JSONC, schema validation, explicit precedence, and separate application/TUI settings. Adopt those principles rather than copying project-scoped coding-agent configuration into a chat client.

Proposed OpenIRC behavior:

- User-scoped `openirc.jsonc` for networks/preferences and `tui.jsonc` for appearance/keybindings, under a documented platform-appropriate config directory.
- Built-in defaults → user config → explicit CLI overrides. Do not automatically trust config from the working directory.
- Schema-backed validation/completion; in-app settings write the same user configuration atomically, preserve comments where feasible, and detect conflicting external edits.
- Clearly show effective values and reconnect-required changes; safe appearance settings apply live.
- Keep secrets behind references; histories, credentials and ephemeral window state do not belong in exportable settings.

“OpenCode2” is treated as the current OpenCode configuration/TUI reference; verify the exact intended build before copying detailed interactions.

## Sources

Official pages reviewed for this plan. The capability map is grounded in these sources; priorities and architecture are our recommendations. Source contents can change; pin specification revisions during implementation.

[weechat]: https://weechat.org/about/features/
[irssi]: https://irssi.org/
[irssi-manual]: https://irssi.org/documentation/manual/
[hexchat]: https://hexchat.github.io/
[halloy]: https://halloy.chat/
[lounge]: https://thelounge.chat/
[modern-irc]: https://modern.ircdocs.horse/
[scrollbox]: https://opentui.com/docs/components/scrollbox/
[textarea]: https://opentui.com/docs/components/textarea/
[interaction]: https://opentui.com/docs/core-concepts/interaction

- [WeeChat feature inventory][weechat]
- [Irssi overview][irssi], [manual][irssi-manual] and [IRC command reference](https://irssi.org/documentation/help/cat_IRC%20Commands/)
- [HexChat feature overview][hexchat] and [final release announcement](https://hexchat.github.io/news/2.16.2.html)
- [Halloy overview and supported IRCv3 capabilities][halloy]
- [The Lounge overview][lounge]
- [Modern IRC client protocol][modern-irc]
- [IRCv3 specification index, including draft/deprecated status](https://ircv3.net/irc/)
- OpenTUI [ScrollBox][scrollbox], [Textarea][textarea], and [interaction/focus/selection][interaction]
