# Interactive UI stress testing

Use the real Solid/OpenTUI client in an explicitly allocated Herdr scratch pane. Unit screenshots alone do not exercise terminal input encoding, live sockets, resize/focus behavior, or the agent control connection.

## Isolation first

- Run Herdr controls only from a managed pane (`test "${HERDR_ENV:-}" = 1`). Discover the installed CLI with `herdr --skill` and `herdr pane --help`.
- Use only scratch panes you created, preserve the user's focus, and take pane IDs from creation responses. Never drive an existing user conversation.
- Launch with a fresh private directory: `bun run src/main.ts --config-dir "$run/config" --data-dir "$run/data"`. Use a mode-700 run directory, preferably under ignored `.pi/qa/`.
- Use a dedicated local fixture server and synthetic nicknames/channels/messages. The pinned Ergo setup in `scripts/smoke-ergo.ts` is the reference. Bind ports to loopback only. For restart tests, publish **explicit fixed host ports**: Docker-assigned ephemeral ports can change on restart.
- Trust only the fixture's generated certificate, using `NODE_EXTRA_CA_CERTS` when needed. Never disable TLS verification, reuse operator credentials, or resolve the user's secrets.
- Additional control launch grants and caller read/send/destructive flags are appropriate only when explicitly testing the corresponding synthetic-profile behavior. Keep normal user-client permissions unchanged.
- Before each input batch, inspect `herdr pane process-info --pane "$QA_PANE"` and verify that the foreground process is OpenIRC with the exact private config directory. Stop on a crash; never continue typing into its replacement shell.

## Keys and mouse input

Prefer logical keys:

```sh
herdr pane send-keys "$QA_PANE" f1
herdr pane send-keys "$QA_PANE" ctrl+k
herdr pane send-keys "$QA_PANE" shift+tab
```

Herdr 0.8.2 does not name Page Up/Down or End in `send-keys`. Its `send-text` passes literal bytes, so send a complete native sequence instead:

```sh
herdr pane send-text "$QA_PANE" $'\033[5~'       # Page Up
herdr pane send-text "$QA_PANE" $'\033[6~'       # Page Down
herdr pane send-text "$QA_PANE" $'\033[1;5F'     # Ctrl+End
herdr pane send-text "$QA_PANE" $'\033[200~literal paste\033[201~'
```

Do not assemble these from separate logical Escape/bracket keys: keyboard protocol negotiation can encode Escape independently and close a dialog instead.

For this client's SGR cell-coordinate mouse input, coordinates are **1-based and pane-local**. Read the current frame after layout changes. Send press and release separately, with a short interval, rather than treating concatenated automation bytes as a physical click:

```sh
herdr pane send-text "$QA_PANE" $'\033[<0;10;8M'
sleep 0.05
herdr pane send-text "$QA_PANE" $'\033[<0;10;8m'
```

## Capture real viewport artifacts

The optional Linux helper needs Python, Pillow, wcwidth and fontconfig (`fc-match`). These are QA workstation tools, not application dependencies. If necessary, install Python packages in an isolated environment under `.pi/`, not the application package/lockfile.

```sh
python3 scripts/qa/herdr_capture.py \
  --pane "$QA_PANE" --directory "$run/captures" --label help-after-paging

python3 -m unittest discover -s scripts/qa -v
```

Each capture writes `.ansi`, `.txt`, `.png` and pane/layout `.json`. Text and PNG derive from one ANSI viewport read, so incoming chat cannot produce mismatched text/image frames. The PNG rasterizes actual terminal cells, not fixture JSX or a mock UI. Font fallback can differ from the host terminal; retain the original ANSI as authoritative evidence. The rasterizer supports the QA fixture's combining/emoji sequences and bounds image allocation; it is not a general terminal emulator.

Captures may contain conversation bodies, field values and other private data. Keep the run directory private and untracked. Never publish credentials, user chat, SQLite files, generated private keys, or process core dumps.

## Campaign checklist

- **Onboarding/settings:** empty and invalid inputs, TLS endpoint, masked synthetic password, environment-reference validation, failed SASL, appearance saves, privacy/typing settings, external revision conflicts.
- **Navigation/dialogs:** Help, switcher, join, query, directory, WHOIS, search, message picker/actions, paste review, quit confirmation/cancel. Test Tab/Shift+Tab, paging, scrolling and background click/focus isolation.
- **Messaging:** channel/DM round trips, nickname-reuse warning, Unicode/combining/ZWJ/flag fixtures, long wrapping lines, literal pasted slash commands, paced multiline fallback, supported replies/reactions, explicit send states.
- **History/load:** incoming traffic while scrolled back, stable anchors, bounded mounted rows, local search/context reveal, multiple simultaneous channel joins and reconnect history. Toggle logging off → receive → on → read: unlogged bodies must not be saved merely to create a bookmark.
- **Recovery:** short/tall resizes with unsaved fields/drafts, socket loss/server restart, saved-channel rejoin, retained drafts, no automatic uncertain-send replay, repeated agent inspections without socket exhaustion.
- **Safety:** no public network traffic, clipboard writes/browser launches/desktop notifications unless explicitly part of the test, no uncertain mutation retries, no delivery-receipt claims.

Capability-gated controls must be checked both enabled and absent. If the fixture server lacks redaction or native multiline, exercise their UI branches in the renderer/integration suites and state that limitation; do not claim live interoperability. A narrow scratch pane may likewise need wider fixture-renderer coverage for the member list.

For negative observations (such as no automatic replay), check observer liveness before and after, and use positive message probes on both sides of the test. A stale counter file from an exited peer is not evidence. Record fixture failures separately and repeat the case with a healthy observer.

Run `bun run check`, then the optional production checks `bun run test:terminal` and `bun run test:ergo` before integrating a checkpoint. Save failing frames before fixes and repeat the exact key sequence afterward. Scripted navigation loops should have bounded iterations, explicit stop/failure behavior and synthetic-profile assertions.

## Native test diagnostic caveat

On the tested Bun 1.3.14/OpenTUI build, a failing assertion that inspected a live native renderable triggered SIGABRT; asserting its optional `.id` produced the ordinary useful failure instead. Prefer scalar assertions such as `expect(node?.id).toBeUndefined()` over printing entire native objects. This was observed in a fixture test, not the running client. The native abort mechanism was not symbolized; do not infer an application crash or an OOM from it. Treat any core as sensitive process memory.
