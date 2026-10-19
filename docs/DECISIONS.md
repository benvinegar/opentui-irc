# Architecture decisions

These decisions are accepted for the foundation, not irrevocable commitments. Changes need a short rationale and producer/consumer impact review.

## ADR-001 — One process, modular boundaries

**Decision:** one Bun application repository, with explicit TypeScript ports between modules. No microservices, worker architecture, monorepo package split or DI container.

**Why:** a personal terminal client does not need deployment complexity. Pure domain and injected adapters are sufficient for independent development/testing.

**Tradeoff:** boundaries need review/import checks, not package-manager enforcement. A future detached mode requires a deliberate IPC/lifecycle design.

**Revisit when:** profiling proves worker isolation useful, or there is an actual second deployable frontend/service.

## ADR-002 — Framework-neutral application, Solid at the edge

**Decision:** SolidJS/OpenTUI owns rendering and local interaction. App publishes immutable read models and accepts typed intents; Solid signals are an adapter detail.

**Why:** UI agents can use a fake facade while protocol/storage agents work independently. Domain tests run without terminal initialization.

**Tradeoff:** maintain a small subscription bridge and carefully scope publication to avoid broad reactive updates.

**Revisit when:** measurements show a specific bridge cost; do not couple the whole core to Solid preemptively.

## ADR-003 — Typed semantic events, one session attempt per generation

**Decision:** no global/free-form event bus. Each session emits ordered, generation-tagged semantic events. App owns reconnection and rejects stale attempts.

**Why:** prevents reconnect races, raw protocol/secret leakage and hidden retry loops. Exhaustive unions reveal producers/consumers that need updating.

**Tradeoff:** new protocol features require coordinated type changes. This is desirable before there is a public plugin ecosystem.

**Revisit when:** adding IPC/plugins, with explicit permission/versioning design—not arbitrary payload bags.

## ADR-004 — Local-first history, existing bouncers for offline collection

**Decision:** SQLite is the initial durability adapter; app owns merge/privacy policy. Local history and negotiated server/bouncer playback are separate sources. Closing the client disconnects.

**Why:** useful continuity without accidentally building an always-on server product.

**Tradeoff:** no messages collected while closed unless the server/bouncer provides them. Message identity and playback dedupe need real interoperability tests.

**Revisit when:** daily use demonstrates a background-mode requirement.

## ADR-005 — Explicit safe errors and uncertainty

**Decision:** expected failures use safe result values; network actions expose asynchronous operation/message states. No promise of recipient delivery/read status and no automatic resend of uncertain messages.

**Why:** IRC acknowledgments differ by capability and cannot support stronger universal guarantees.

**Tradeoff:** UI must explain uncertainty and expose retry deliberately rather than showing an unconditional success tick.

## ADR-006 — Internal extensibility, not a plugin ABI

**Decision:** replaceable transport/session/history/effect adapters, plus typed action/command contribution points. Contracts are revisioned internal APIs and can evolve through integration review.

**Why:** enables parallel agents and future growth without committing to permissioning, sandboxing, compatibility and discovery systems before we need them.

**Tradeoff:** third-party plugins cannot be dropped into the first release. New features may require changes across several discriminated unions.

## ADR-007 — Boring validation tools, explicit runtime separation

**Decision:** Bun package manager/runtime; TypeScript strict checks; oxfmt/oxlint; Vitest under Node for platform-neutral tests; separate Bun integration tests once Bun-specific adapters exist. Local Git first, MIT license; no remote created automatically.

**Why:** fast repeatable foundation with truthful runtime coverage. A Node unit-test pass is not evidence that Bun TCP/SQLite works.

**Tradeoff:** development currently requires Node for Vitest as well as Bun; CI installs both. Actual terminal rendering is now implemented and smoke-tested on Linux; standalone runtime packaging remains future work.

## ADR-008 — Initial DM threads are nickname-address based

**Decision:** for this alpha, a direct conversation targets a network/nickname address, following a currently observed user's nick changes. Message sender IDs distinguish observed users, but a later owner of the same nickname can share the address's existing history. Do not describe these threads as verified-person identities. The UI displays a nickname-reuse warning and WHOIS/account details are available.

**Why:** IRC messaging is nickname-addressed and account identity is optional/network-specific. A runtime-only peer flag would not survive restarts and could create ambiguous duplicate-name histories or send from an archived thread to the wrong current user. The initial architecture's stronger prose guarantee was not supported by the durable registry and has been corrected explicitly.

**Tradeoff:** this differs from Slack's account-bound identity model. Account/nickname verification is required before sharing private information. This is a known product limitation, not a claim that nickname recycling has been eliminated.

**Revisit when:** designing durable peer/account bindings, inactive/archive send rules, routing on nick reuse, and migration of existing conversation records together. Do not bolt on guessed identity merges.
