# IRC protocol implementation

Factories:

```ts
import { createIrcCodec } from "./codec";
import { createSessionFactory } from "./session";

const codec = createIrcCodec(limits);
const sessions = createSessionFactory({ transport, secrets, clock });
```

`SessionFactoryOptions` also accepts `codecFactory`, `limits`, and `policy: Partial<SessionPolicy>`. `defaultProtocolLimits` and `defaultSessionPolicy` are exported from `session/index.ts`. Policy and codec limits are validated; defaults are bounded implementation policies, not saved user settings. Caller owns retries, autojoin, and generation allocation. A session uses the profile's first endpoint for one attempt and returns before connecting. It never reconnects or autojoins.

## Implemented

- Incremental bounded CRLF/UTF-8 codec, IRC tags, prefixes, numerics, parameter validation, byte-budgeted serialization and injection rejection.
- CAP LS 302 continuation/REQ/ACK/NAK/DEL and cap-notify `NEW` (wanted capabilities offered after registration are requested and enabled live; SASL is registration-only), optional basic-IRC timeout fallback, TLS-only credentials (including channel keys, before secret resolution), SASL PLAIN including 400-byte chunks, required-auth registration gate, alternate nicknames, PING/PONG and stale-connection detection.
- ISUPPORT casemapping/prefix/channel modes, JOIN/PART/QUIT/NICK/KICK, NAMES reconciliation with live deltas, privilege modes, topics, accounts, away state, channel/DM chat, NOTICE and CTCP ACTION.
- Bounded paced outgoing queue, UTF-8 splitting and deliberate LF-only multiline/paste fallback, written/failed/uncertain states; reliable echo only with ACKed message-tags + batch + labeled-response + echo-message. No text-equality matching. A split logical echo is aggregated without inventing one fragment's server ID.
- Serialized WHOIS and LIST with typed results, timeout quarantine and explicit directory limit errors.
- Server notices (no prefix or a dotted server source), WARN/NOTE, CTCP requests (shown, never answered), STATUSMSG targets, 432/437 alternate-nickname fallback and readable 4xx rejections. Machine-oriented informational numerics stay quiet. Behavior cases are tracked against WeeChat's suite in [`docs/IRC_TEST_MATRIX.md`](../../docs/IRC_TEST_MATRIX.md).
- Single-consumer bounded event stream with contiguous sequence numbers and reserved terminal overflow outcomes. Abort/close terminate all sleeps/queries and transport. Close sends bounded best-effort QUIT.

## Pinned modern wire protocol

Specification snapshot: [ircv3/ircv3-specifications@9ff58d1342af67aff88753388f568542820c4bfe](https://github.com/ircv3/ircv3-specifications/tree/9ff58d1342af67aff88753388f568542820c4bfe). Exact spellings are exported as `modernProtocol` in `session/modern.ts`.

| Feature      | Wire format and gate                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| History      | `draft/chathistory` + `batch` + `server-time` + `message-tags`; `CHATHISTORY LATEST target * limit` or `BEFORE` with msgid/timestamp. Ratified `chathistory` batch type; `draft/chathistory-end` exhaustion hint.                                                                                     |
| Replies      | Ratified `+reply=<msgid>`; ACKed message-tags, observed valid server-provided msgid, and tag allowed by CLIENTTAGDENY. No invented reply capability.                                                                                                                                                  |
| Typing       | Ratified `+typing=active/paused/done` on TAGMSG; message-tags and permitted client tag. Outgoing updates throttled to at least 3 seconds per target; `paused` when the draft is kept, `done` when it is cleared. Incoming active/paused expire at 6/30 seconds; chat/part/quit/nick clear indicators. |
| Reactions    | `+draft/react` / `+draft/unreact` with `+reply`, on TAGMSG or alongside chat. Requires message IDs and all corresponding client tags permitted. Values bounded to 128 bytes. There is no guessed reactions capability.                                                                                |
| Read markers | `draft/read-marker` + server-time; `MARKREAD target timestamp=...`. Monotonic server updates. Caller supplies a real observed/persisted message server-time, not a wall-clock approximation. These synchronize the same user's clients, not other users' read receipts.                               |
| Redaction    | `draft/message-redaction` + message-tags; `REDACT target msgid`. Semantic updates and sanitized standard FAIL errors; no secure deletion/delivery guarantees. App must scope IDs to the target/network.                                                                                               |

Feature flags are derived from ACKed capabilities, observed message IDs and CLIENTTAGDENY, never CAP LS advertisements alone. Client tags being transportable does **not** mean every peer renders them. Modern features are rechecked at queue execution after capability changes.

History is globally serialized to avoid ambiguous responses without labels. Timed-out unlabelled queries remain quarantined until their terminator or connection close. Playback/live classification is per batch ancestry: live traffic interleaved with a history response remains live. Historical JOIN/MODE/etc. never mutate current membership; `draft/event-playback` is not requested. Batches have count, byte, depth and lifetime bounds. Unknown batch types remain ordinary batches, not fabricated history. The app owns duplicate-ID merge and persistence/privacy policy.

## Explicit limitations

- No negotiated multiline, event-playback state reconstruction, CHATHISTORY TARGETS/AROUND/AFTER/BETWEEN, vendor-specific ZNC playback adapters, WHO/WHOX, NickServ fallback, SASL EXTERNAL, proxies, endpoint fallback or automatic reconnect. WHO/WHOX need a typed command/result contract before implementation.
- Coordinator verified three real apps against official loopback-only Ergo `2.19.1-63c743a70644f0f1`, image `ghcr.io/ergochat/ergo@sha256:72db5b93b437ea0512fb79d9d4d035f0916ccba07ed736dec19e8d5b5a73f972`: registration, JOIN, msgid/echo, replies, typing, reactions and CHATHISTORY playback passed. Ergo advertised read markers; redaction and negotiated multiline were unavailable and remained disabled. The new LF fallback additionally has scripted TCP integration coverage, but is not included in that prior Ergo smoke result. soju/ZNC interoperability remains unverified. The coordinator's Docker smoke is explicit opt-in, not default CI.
- Ordinary outgoing messages are UTF-8 split. The unknown own source prefix initially reserves 128 bytes for server echo overhead; after an own user-prefix event its actual byte size is used. Multi-fragment logical messages cannot expose one reliable server ID, so replies/redaction of that aggregate are unavailable.
- Deliberate multiline input uses LF separators and sends each line as separately paced PRIVMSG/NOTICE/CTCP ACTION fragments. Slash-prefixed pasted lines remain literal text; no command parsing occurs. CR and NUL are rejected before admission. Leading, consecutive and trailing empty lines each become one single-space wire message because ordinary IRC rejects empty message bodies; a semantic notice explains this padding, and the aggregate local/server echo retains the exact original LF-containing text. No lines are silently omitted. Negotiated `draft/multiline` remains unsupported, so peers see separate messages.
- Defaults bound each logical send to 128 KiB of UTF-8 input and 256 fragments, and the entire outgoing queue to 512 fragments plus its command/byte bounds. Caps are checked before admission and rechecked if the own-prefix overhead changes before execution. Each frame additionally obeys codec byte/tag budgets. Oversized input fails explicitly rather than partially transmitting/truncating. Split/multiline echo is one conservative logical outcome without a fabricated single server ID.
- A missing echo is uncertain, not rejection. Recently written non-echo sends retain a bounded uncertainty window; old writes do not become delivery claims. No pending traffic is automatically replayed.
- Casemapping changes with active membership close visibly rather than silently merging collisions. Membership/channel limits are explicit fatal bounds, not silent truncation.

## Tests

```sh
bunx --no-install vitest run tests/irc
bun test tests/irc/session/live.bun.test.ts tests/transport/bun.bun.test.ts tests/transport/tls.bun.test.ts
```

Tests never connect to public IRC networks. The TLS fixture requires `openssl` and scopes its generated CA to a test subprocess via NODE_EXTRA_CA_CERTS; verification is never disabled.
