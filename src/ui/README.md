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

## Runtime and tests

The installed OpenTUI Solid README requires JSX preserve, `jsxImportSource: "@opentui/solid"`, and `@opentui/solid/preload`. Production gets this from the root Bun config. Bun 1.3.14 **does not apply the top-level preload to `bun test`**. The JSX-free `tests/ui/shell.bun.test.ts` wrapper registers the real compiler before dynamically loading TSX, so no hidden flags or browser conditions are needed:

```sh
bun test tests/ui/shell.bun.test.ts
bun run check
bun run tests/ui/capture.tsx
```

The capture script explicitly uses a deterministic fake facade and writes actual headless OpenTUI frame spans as `/tmp/openirc-chat.svg` and `/tmp/openirc-settings.svg` (plus text frames). It is not a real-network smoke test. SVGs can be rasterized with ImageMagick if available. No external network is used.

Tested journeys: full mouse-and-wheel TLS/SASL setup; masked password editing/paste and `storeSecret` handoff; explicit environment-reference fallback; join/DM controls; Unicode sends/completion; inert slash-command paste; drafts across conversation changes and resize; app-level return from historical windows; native anchors during incoming/prepended messages and resize; subscription cleanup. A 10k-message source mounts only the latest 300 rows. This is a hard layout bound, **not virtualization**; the local 110x36 headless test took roughly 80–120ms including setup/source publication/render, not an input-latency guarantee.

## Security and limitations

- Passwords use a dedicated focusable masked widget. Plaintext stays in UI-local signals and is handed only to `app.storeSecret`; it never enters a native input/textarea/text value, app snapshot, diagnostic, or saved settings. The field clears at handoff/disposal. JavaScript cannot guarantee memory zeroization. Vault failure is visible; an explicit environment-reference fallback never writes plaintext. If storing a credential succeeds but saving its profile fails, its unused vault entry may remain (no deletion port exists).
- Pasted composer text is literal until deliberate submission, including after conversation switches. Large/multiline/slash pastes require review and insertion first. Native cell offsets are converted through buffer prefix extraction before UTF-16 completion.
- HTTP/HTTPS opening is explicit and revalidated. Effect helpers receive argument arrays, never a shell string. Clipboard/notification unavailability is returned honestly.
- One active conversation; status, unread, pending/written/uncertain/echo states do not claim delivery or read receipts. Read reporting remains conservative without terminal-focus reports and never marks a historical window read.
- Settings support adding TLS networks, SASL, local-history toggle, and themes. Editing/removing existing profiles, server passwords, channel keys, retention editing, and keybinding remapping still require config editing. The UI does not promise all planned settings parity.
- Only parser-supported commands are advertised; no `/raw`, moderation, unsupported WHO/NAMES/clear-view aliases, or multi-action `/msg` to an unopened target.
- Supported reply/reaction controls require negotiated flags and usable server IDs. No outgoing typing/redaction UI, directory/WHOIS details panel, or real macOS/SSH/tmux validation is claimed yet.
- Native scrollbars and stable-row anchors are used, but a message evicted from the app's bounded window cannot retain its anchor. Search/reveal supplies older context. Configure app hot windows to 300 or fewer so requested older pages are not truncated by the UI cap.
