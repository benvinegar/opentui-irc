# OpenIRC

A newcomer-friendly IRC client for Linux and macOS, built with Bun, SolidJS, and OpenTUI.

**Status:** architecture and typed contracts only. There is no runnable IRC client yet.

The planned interface combines Discord-like styling with Slack-like channel/DM navigation, mouse-driven controls, and keyboard alternatives. Modern IRCv3 features are negotiated with the server rather than assumed.

## Develop

Requires Bun 1.3.14+ and Node.js 24 for the current Vitest tooling.

```sh
bun install --frozen-lockfile
bun run check
```

Use `bun run format` before committing. Installation configures a format/lint pre-commit hook. Production Solid/OpenTUI dependencies and startup commands will be added with the real terminal spike, not a placeholder executable.

## Architecture and implementation

- [Product plan](docs/PLAN.md)
- [Architecture and module ownership](docs/ARCHITECTURE.md)
- [API behavioral contracts](docs/CONTRACTS.md)
- [Architecture decision records](docs/DECISIONS.md)
- [Parallel implementation workstreams](docs/WORKSTREAMS.md)
- [Typed contracts](src/contracts/)
- [Agent/contributor guidance](AGENTS.md)

Future adapters implement explicit TypeScript ports; the UI dispatches typed user actions and observes framework-neutral read models. No plugin framework or background bouncer is included.

## License

[MIT](LICENSE)
