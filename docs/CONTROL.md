# Agent control plane (implementation contract)

Version 1, local-only. The CLI is an adapter over the same typed AppApi used by the TUI, not a second IRC implementation. No HTTP listener, MCP dependency, detached daemon, raw IRC, shell hooks, or credential retrieval.

## Lifecycle and permissions

- A running TUI owns a private Unix socket scoped to its canonical configuration directory and user ID. A private directory (0700), socket (0600), owner checks and exclusive profile lease prevent accidental cross-profile/other-user access.
- Default server permissions: `inspect`, `configure`, `network`. Additional `read-messages`, `send-messages`, `destructive` must be explicitly granted at launch with `--control-allow`.
- Each request also declares its permissions. CLI `--allow-read`, `--allow-send`, `--allow-destructive` express caller intent; they cannot enlarge the running server's policy. This is local consent/accident prevention, not a sandbox against arbitrary code running as the same OS user.
- Offline mode supports configuration/schema/secret storage only. It never opens history or connects to IRC. An offline mutation must hold the same profile lease as the live server, so startup and offline writes cannot race.
- Never silently fall back to offline writes after a timeout/ambiguous RPC failure. An absent/dead server can be detected; a busy/unsafe/initializing profile is an error.
- No automatic mutation retries. Timeouts after submission report unknown outcome. In-process bounded request-ID replay protection may return a prior outcome; it is not durable across restart.

## Wire

One bounded NDJSON request/response per Unix connection. `src/contracts/control.ts` is authoritative. Request has version, id, method, JSON parameters and explicit permission list. All fields/JSON are validated before dispatch; unknown methods/fields fail safely. No raw credentials, frames, user input or exception stacks in errors/logs. Bound request/reply sizes, connections and timeouts; cancel before admission where possible.

## Methods

- `capabilities`: protocol version, methods/permissions, limits and config/action schemas.
- `status`: running state and sanitized metadata; never message/draft bodies.
- `config.schema`: JSON Schemas, defaults, descriptions, constraints and runtime effects for all current fields.
- `config.get`: current SettingsDocument (secret references, never resolved values).
- `config.plan` / `config.apply`: `{ edit, expectedRevision }`. `edit` is `{section, value}` or `{section, patch, unset?}`. Deep object patches preserve unspecified fields, arrays replace, null is literal; unset uses dot paths. Reject prototype keys and invalid paths. Exactly one section per atomic save. `confirm:true` required for destructive plans.
- `config.reload`: inspect disk changes (`dryRun:true`) or apply a revision-checked reload to a running app. Reload is not permission escalation; changes are planned/checked first. The app checks both the plan's live base revision and inspected disk revision inside its serial admission queue, including when an editor restores identical disk bytes.
- `networks.list`, `conversations.list`, `operations.list`: metadata only; no error bodies/message text.
- `action.dispatch`: `{action, confirm?}`; runtime-validate every existing AppAction and require its capability. All actual behavior goes through AppApi.dispatch.
- `timeline.get`: `{conversationId}`; requires read-messages, includes bounded messages/draft.
- `history.search`: SearchQuery; requires read-messages.
- `discovery.get`: `{networkId}`; WHOIS/LIST metadata from the app.
- `secrets.store`: `{value}`; configure permission, secret stdin ingress only in CLI; returns a reference, never a resolved value. No resolve/get method.
- `app.shutdown`: destructive permission + confirm; composition root shuts down app/socket/terminal cleanly after responding.

## Configuration effects

Plan before applying; expectedRevision is required on the wire. CLI may inspect current revision first for convenient one-command mutations, but final save is CAS checked. Plans report paths, immediate/reconnect/restart/unsupported effects and side effects (e.g. new autoConnect network, removing a live network, shortening retention).

Lower retention requires destructive permission/confirmation because applying it can prune history. Changes that connect/disconnect require network permission. Existing network credential/endpoint/identity changes do not silently reconnect; report affected IDs and let the agent reconnect explicitly. UI theme/density/sidebar width/member list and its width/HistServ visibility update live (widths are also saved when the user drags a column divider); mouse may require restart if no live renderer support. Reserved keybinding changes must be reported as unsupported, not falsely applied.

CLI examples will be documented alongside actual implemented commands. All structured output is versioned JSON with stable error codes and nonzero exit status on failure. No current user configuration is modified by development tests.
