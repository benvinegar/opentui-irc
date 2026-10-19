# OpenIRC

A newcomer-friendly IRC client for Linux and macOS, built with Bun, SolidJS, and OpenTUI. Mouse-driven controls, a channel/DM sidebar, and one conversation at a time—with keyboard alternatives throughout.

**Status: early daily-driver alpha.** The real terminal client, IRC connection stack, local history, search, and settings are implemented. This is not yet the complete feature set in the product plan.

## Agent-first configuration

Tell your local coding agent to follow [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md). It can discover, plan, configure and verify OpenIRC without clicking through the TUI or rewriting files blindly:

```sh
bun run --silent ctl --help
bun run --silent ctl config schema
bun run --silent ctl config get
bun run --silent ctl config set tui.theme '"light"' --dry-run
bun run --silent ctl config set tui.theme '"light"'
```

Settings work offline or through a private Unix socket while the client is running. Network profiles can be added, edited and removed; runtime actions share the same API as the UI. JSON responses, revision checks, dry runs and explicit effect plans make changes verifiable. Secrets use references or stdin-only secure storage—never a password argument or retrieval command.

Message/draft reading, chat sending and destructive work require separate explicit server grants **and** caller intent. Default live rights are inspect/configure/network. See [control design](docs/CONTROL.md) for the local trust boundary and [the agent guide](docs/AGENT_GUIDE.md) for setup recipes.

## Run

Requires Bun **1.3.14+**. The TUI needs an interactive terminal; control commands do not.

```sh
bun install --frozen-lockfile
bun run start
```

Use **Settings → Add network**, choose a TLS server, enter a nickname, and optionally configure an existing SASL account. Connect, join a channel, or open a direct conversation from the sidebar. You can also type `/help` for commands.

Optional Libera.Chat and OFTC presets fill in server details without connecting automatically. Replies, reactions, typing, history playback, read markers, and message removal are capability-dependent; unsupported controls stay unavailable.

Passwords can be stored in the platform credential vault when available. If that service is unavailable, explicitly reference an environment variable; OpenIRC never falls back to writing plaintext passwords in settings. Account registration itself remains network-specific.

### Keyboard basics

| Shortcut            | Action                                            |
| ------------------- | ------------------------------------------------- |
| Ctrl+K              | Switch conversation                               |
| Ctrl+J              | Join channel                                      |
| Ctrl+F              | Search local history                              |
| F1                  | Help                                              |
| Tab                 | Complete in composer; navigate controls elsewhere |
| Enter / Shift+Enter | Send / newline                                    |
| Ctrl+Q              | Confirm quit                                      |

Mouse selection, scrolling, scrollbars, buttons, menus, setup, and conversation switching work without slash commands. Keyboard modifiers, clipboard integration and terminal-focus reporting vary by terminal.

## History and connections

- Local message history is **plaintext**, enabled by default with **30-day retention**. Settings can disable future logging; deleting existing history is a separate explicit action.
- Closing the client disconnects. Use an existing IRC bouncer for offline collection; OpenIRC does not run a background service.
- Nicknames can be reused. DMs are nickname-addressed, not verified-person archives; check account details before sharing private information.
- Reconnects restore open channels. Server playback and modern interactions depend on negotiated server capabilities.
- Multiline drafts use a bounded, paced ordinary-IRC fallback. Negotiated IRCv3 multiline is not implemented yet.
- Written or echoed messages are not recipient-delivery/read receipts. Uncertain sends are never automatically resent.
- No automatic link previews or media fetches; opening an external link requires confirmation.

## Configuration

JSONC, in-app settings and the agent control API are supported. All current configuration fields have discoverable schemas and validated control edits. The settings UI covers a smaller subset; use the agent CLI for profile editing/removal and advanced settings. Reserved custom-keybinding changes are explicitly unsupported rather than silently ignored.

| Data                     | Default location                                                      |
| ------------------------ | --------------------------------------------------------------------- |
| Settings, both platforms | `${XDG_CONFIG_HOME:-~/.config}/openirc/openirc.jsonc` and `tui.jsonc` |
| Linux history            | `${XDG_DATA_HOME:-~/.local/share}/openirc/history.sqlite`             |
| macOS history            | `~/Library/Application Support/OpenIRC/history.sqlite`                |

```sh
bun run start --check-config
bun run start --config-dir /path/to/config --data-dir /path/to/data
bun run start --help
```

There is no automatic project/cwd configuration discovery. Supported in-app/agent changes apply immediately where safe; plans report reconnect/restart requirements. Use `bun run --silent ctl config reload --dry-run` then `config reload` for external file edits. Settings use revision checks to detect conflicting edits. See [persistence guarantees](src/storage/README.md).

## Develop

Node.js 24 is also required for the Vitest tooling.

```sh
bun run check       # format, lint, types, unit tests, Bun integration/UI tests
bun run test        # platform-neutral tests under Node/Vitest
bun run test:bun    # Bun sockets, SQLite, production CLI and real headless OpenTUI
bun run format
```

Tests use local fake IRC servers and temporary files—not public networks or personal credentials. An optional real-server check launches a pinned official Ergo container on loopback only and cleans it up afterward:

```sh
bun run test:ergo    # requires Docker; may download the pinned official image
bun run test:terminal # requires Python 3; real production TTY startup/shutdown
```

Ergo 2.19.1 was verified for registration, JOIN, server IDs/echoes, replies, typing, reactions, and CHATHISTORY playback. Read-marker and redaction protocol tests do not establish every server/bouncer's interoperability. Installation configures a format/lint pre-commit hook. Source execution is the supported development path; standalone binaries are not packaged yet.

## Architecture and scope

- [Agent operation guide](docs/AGENT_GUIDE.md)
- [Versioned local control API](docs/CONTROL.md)
- [Implementation status and remaining work](docs/IMPLEMENTATION.md)
- [Security/privacy model](docs/SECURITY.md)
- [Product plan](docs/PLAN.md)
- [Architecture and module ownership](docs/ARCHITECTURE.md)
- [API behavioral contracts](docs/CONTRACTS.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Parallel workstreams](docs/WORKSTREAMS.md)
- [UI implementation and limitations](src/ui/README.md)
- [Agent/contributor guidance](AGENTS.md)

The UI sends typed actions and observes framework-neutral read models. IRC sessions, transport, storage and OS effects use replaceable adapters. No plugin system, moderation suite, DCC, split panes, cloud sync, or bundled bouncer is included.

Linux is exercised locally; macOS CI is configured, but real macOS/SSH/tmux manual validation remains outstanding.

## License

[MIT](LICENSE)
