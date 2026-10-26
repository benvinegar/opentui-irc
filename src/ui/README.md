# Terminal UI integration

Production uses `startUi` from `./start.tsx` with a real `AppApi`. There are no test/fake imports in production code.

```ts
const commands = createCommandService(app); // src/services/commands.ts
const external = createExternalActions(); // src/services/effects.ts
const notifications = createNotificationSink(); // same module
const ui = await startUi({ app, commands, external, onQuit: requestShutdown });
// requestShutdown owns app.shutdown(), then ui.destroy(), then await ui.done.
```

`UiHandle` exposes `destroy(): void` and `done: Promise<void>`. The latter is the native renderer's `closed` promise (terminal restoration complete). Main owns SIGINT/SIGTERM; the renderer explicitly sets `exitSignals: []` and `exitOnCtrlC: false`. UI Ctrl+C/Ctrl+Q opens quit confirmation. Without an injected `onQuit`, the UI shuts down the app and destroys its renderer itself.

## Shell layout

The shell is deliberately quiet: a sidebar (network status dot, `#` channels, `@` direct messages, unread counts and accent mention badges), a one-line conversation header (name, topic or DM warning, member count), the transcript, a rounded composer and a single footer of contextual key hints. The footer temporarily shows status/errors instead of hints, and always shows the current nick plus a `plaintext` warning on non-TLS connections.

Secondary actions are not permanent buttons. `ctrl+k` (or `ctrl+p`) opens a filterable palette of conversations and actions: join, message someone, search, select a message, load older, mute/leave, HistServ visibility, connect/disconnect, browse channels, WHOIS, add network, settings, help and quit. ↑/↓ move through the palette and other dialog lists; Enter runs the highlighted entry.

Clicking a message opens a small menu anchored at the click (no full-screen dialog): copy, reply and react (only when the network negotiated them), open link (a submenu when there are several), about the sender, and remove-mine (still confirmed in a dialog). Each entry has a one-letter shortcut; React and multi-link open submenus that Esc backs out of. Clicking a nickname in the transcript or member list opens a person card that requests WHOIS for that nickname and shows whatever the network reports, plus Message and Copy nickname. The palette's “Select a message” opens the same menu beside the chosen message. Dragging across message text selects it and copies it on release instead of opening the menu; time, nickname, markers and reactions are not selectable, so copies contain only message text.

The sidebar and member panel (shown from 90 main-area columns) are separated by one-cell dividers. Dragging a divider resizes live and saves `tui.sidebarWidth` / `tui.memberListWidth` on release; both stay configurable through the control API. The transcript's time/author rail drags the same way and saves `tui.authorColumnWidth`; null (the default) fits the longest visible nickname. Small terminals temporarily shrink the saved sidebar width.

## Transcript layout

The transcript uses a glirc-style gutter: local 24-hour time, right-aligned nickname, a fixed full-height divider, and wrapped text on the right. The gutter fits the longest visible nickname (at most 24 cells) and shrinks on narrow windows; consecutive lines from one sender within five minutes omit the repeated time and nickname, and day changes get a separator; long nicknames are truncated only visually and remain available in message actions. Replies, reactions, unread markers and pending/failure/uncertain states stay visible. Echo-observed messages render normally rather than adding a header line; this does not imply delivery.

Nickname colors are deterministic, case-insensitive and theme-aware, not account verification or a promise that every possible nickname has a different color. Samples are contrast-tested against each theme. Top/bottom chrome has no spacer rows. The composer starts at one input line and grows to three for multiline drafts. New profiles default to comfortable density; existing density preferences are preserved. `tui.density` remains configurable through the control API (`comfortable` puts a blank line above each new sender group, while continuation lines stay tight; `compact` removes the blank lines).

## History-service visibility

`HistServ` is hidden by default in the transcript and message picker. The Show/Hide HistServ palette entry (with a hidden count) persists `tui.showHistServ`; agents can use `ctl config set tui.showHistServ true` (plan first with `--dry-run`). This is an exact, case-insensitive nickname display filter, not service/account verification or a generic NOTICE filter. It covers Ergo replay delivered as either PRIVMSG or NOTICE. All original messages remain in history, search and authorized control timeline reads. An explicit search reveal temporarily shows service entries without changing the saved default; switching conversations resets that exception.

HistServ entries do not generate chat unread counts or notifications. Visibility reports still reference the actual rendered message, not a hidden tail. If the loaded window contains only service entries, the UI explains that older chat may exist instead of implying an empty channel. Connection errors and other senders' messages/notices are unaffected. Existing schema-v1 settings files default the new flag to false in memory without a startup rewrite.

## Runtime and tests

The installed OpenTUI Solid README requires JSX preserve, `jsxImportSource: "@opentui/solid"`, and `@opentui/solid/preload`. Production gets this from the root Bun config. Bun 1.3.14 **does not apply the top-level preload to `bun test`**. The JSX-free `tests/ui/shell.bun.test.ts` wrapper registers the real compiler before dynamically loading TSX, so no hidden flags or browser conditions are needed:

```sh
bun test tests/ui/shell.bun.test.ts
bun run check
bun run tests/ui/capture.tsx
```

The capture script explicitly uses a deterministic fake facade and writes actual headless OpenTUI frame spans as `/tmp/openirc-chat.svg` and `/tmp/openirc-settings.svg` (plus text frames). It is not a real-network smoke test. SVGs can be rasterized with ImageMagick if available. No external network is used.

Tested journeys: full mouse-and-wheel TLS/SASL setup; masked password editing/paste and `storeSecret` handoff; explicit environment-reference fallback; optional Libera.Chat/OFTC presets without automatic save/connect; join/DM controls; live channel-directory filtering and bounded results; WHOIS details/errors and starting a DM; negotiated/opt-in typing and idle/blur stops; confirmation-gated own-message removal; Unicode sends/completion; inert slash-command paste; drafts across conversation changes and resize; app-level return from historical windows; native anchors during incoming/prepended messages and resize; subscription cleanup. A 10k-message source mounts only the latest 300 rows. This is a hard layout bound, **not virtualization**; the local 110x36 headless test took roughly 80–120ms including setup/source publication/render, not an input-latency guarantee.

## Security and limitations

- Passwords use a dedicated focusable masked widget. Plaintext stays in UI-local signals and is handed only to `app.storeSecret`; it never enters a native input/textarea/text value, app snapshot, diagnostic, or saved settings. The field clears at handoff/disposal. JavaScript cannot guarantee memory zeroization. Vault failure is visible; an explicit environment-reference fallback never writes plaintext. If storing a credential succeeds but saving its profile fails, its unused vault entry may remain (no deletion port exists).
- Pasted composer text is literal until deliberate submission, including after conversation switches. Large/multiline/slash pastes require review and insertion first. Native cell offsets are converted through buffer prefix extraction before UTF-16 completion.
- HTTP/HTTPS opening is explicit and revalidated. Effect helpers receive argument arrays, never a shell string. Clipboard/notification unavailability is returned honestly.
- One active conversation; status, unread, pending/written/uncertain/echo states do not claim delivery or read receipts. Read reporting remains conservative without terminal-focus reports and never marks a historical window read.
- Settings support adding TLS networks, SASL, local-history/typing toggles, optional network presets, and themes. Presets only fill fields, clear any previously entered account credentials, and never save or connect automatically. Editing/removing existing profiles, server passwords, channel keys, retention editing, and keybinding remapping still require config editing. The UI does not promise all planned settings parity.
- Only parser-supported commands are advertised; no `/raw`, moderation, unsupported WHO/NAMES/clear-view aliases, or multi-action `/msg` to an unopened target.
- Replies/reactions require negotiated flags and usable server IDs. Own-message removal additionally requires current-nick/local-origin ownership, a live supported network, and a separate explicit confirmation; the app revalidates intent. Other clients/logs may retain copies. The "Select a message…" palette entry provides keyboard access to these actions.
- Typing emits only after user edits, with opt-in `sendTyping`, negotiated support, a ready conversation, and composer focus. Restored drafts and slash-command input never announce activity (deliberately literal drafts remain messages). All notifications, including `done`, observe the four-second UI cooldown and the session's strict three-second wire guard. Idle is six seconds; blur/dialog/switch/clear schedules cleanup, including after opt-out. Accepted chat replaces redundant cleanup. A 16-target cache bounds pending timers; overflow suppresses optional presence, never messages. Teardown cancels timers; normal shutdown sends QUIT and peers also expire transient state. No read/delivery guarantee is implied.
- Channel-directory and WHOIS views subscribe only while mounted, remain pinned to the requested network, and expose loading/failure/truncation explicitly. Directory rendering is capped to 100 filtered rows; refine the local filter to find remaining retained entries. No real macOS/SSH/tmux validation is claimed yet.
- Native scrollbars and stable-row anchors are used, but a message evicted from the app's bounded window cannot retain its anchor. Search/reveal supplies older context. Configure app hot windows to 300 or fewer so requested older pages are not truncated by the UI cap.
