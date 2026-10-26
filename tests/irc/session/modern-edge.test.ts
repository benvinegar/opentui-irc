// ModernSession edge cases: admission validation, CLIENTTAGDENY/ISUPPORT variants, batch and
// label bookkeeping, failures, timeouts and shutdown reporting.
import { describe, expect, test } from "vitest";
import type { IrcFrame } from "../../../src/contracts/protocol";
import type { SessionCommand } from "../../../src/contracts/session";
import { allCaps, fixture, frame, op } from "./modern-fixture";

const time = Date.UTC(2026, 0, 1);
const stamp = "timestamp=2026-01-01T00:00:00.000Z";
const opIds = (events: object[]) =>
  events.map((event) => (event as { operationId?: string }).operationId);

describe("modern admission", () => {
  /** A session that has observed a server message ID, so replies and reactions are usable. */
  const observed = (caps = allCaps, policy = {}) => {
    const f = fixture(caps, policy);
    f.modern.observeChat(frame("PRIVMSG", ["#room", "hi"], { msgid: "id" }), "alice", "#room");
    return f;
  };
  test.each<[string, SessionCommand]>([
    ["history limit zero", { type: "history", target: "#r", limit: 0 }],
    ["history fractional limit", { type: "history", target: "#r", limit: 1.5 }],
    ["history over the policy maximum", { type: "history", target: "#r", limit: 101 }],
    ["history target with a space", { type: "history", target: "#a b", limit: 5 }],
    [
      "history msgid reference with a space",
      { type: "history", target: "#r", limit: 5, before: { serverId: "a b" } },
    ],
    [
      "history timestamp beyond year 9999",
      { type: "history", target: "#r", limit: 5, before: { serverTime: 1e20 } },
    ],
    ["typing target with a comma", { type: "typing", target: "#a,#b", active: true }],
    [
      "reaction with an invalid message id",
      { type: "reaction", target: "#r", serverId: ":bad", value: "x", remove: false },
    ],
    [
      "reaction with an empty value",
      { type: "reaction", target: "#r", serverId: "id", value: "", remove: false },
    ],
    [
      "reaction over 128 bytes",
      { type: "reaction", target: "#r", serverId: "id", value: "x".repeat(129), remove: false },
    ],
    [
      "reaction containing a control character",
      { type: "reaction", target: "#r", serverId: "id", value: "a\x1bb", remove: false },
    ],
    [
      "reaction to a bad target",
      { type: "reaction", target: "a b", serverId: "id", value: "x", remove: false },
    ],
    ["redaction of a bad id", { type: "redact", target: "#r", serverId: "a b" }],
    ["redaction in a bad target", { type: "redact", target: "a b", serverId: "id" }],
    ["read marker with a bad target", { type: "mark-read", target: "a b", serverTime: time }],
    ["read marker with a bad time", { type: "mark-read", target: "#r", serverTime: Number.NaN }],
  ])("rejects %s", (_name, command) => {
    const f = observed();
    const result = f.modern.admit(command, op("bad"));
    expect(!result.ok && result.error.code).toBe("invalid-input");
    // Rejected admission must not leave the operation occupying history or label state.
    expect(f.modern.hasOperation(op("bad"))).toBe(false);
  });

  test("every modern command is unsupported without its capability", () => {
    const f = fixture(["message-tags"]);
    for (const command of [
      { type: "history", target: "#r", limit: 5 },
      { type: "reaction", target: "#r", serverId: "id", value: "x", remove: false },
      { type: "redact", target: "#r", serverId: "id" },
      { type: "mark-read", target: "#r", serverTime: time },
    ] as const) {
      const result = f.modern.admit(command, op("m"));
      expect(!result.ok && result.error.code).toBe("unsupported");
    }
  });

  test("outgoing typing is limited per target (case-insensitively) and in total", () => {
    const f = observed(allCaps, { maxTypingEntries: 1 });
    const typing = (target: string) => ({ type: "typing" as const, target, active: true });
    expect(f.modern.admit(typing("#Room"), op("a")).ok).toBe(true);
    const same = f.modern.admit(typing("#room"), op("b"));
    expect(!same.ok && same.error.code).toBe("rate-limited");
    const other = f.modern.admit(typing("#other"), op("c"));
    expect(!other.ok && other.error.message).toBe("Too many typing targets.");
  });

  const allowed = { typing: true, replies: true, reactions: true };
  const denied = { typing: false, replies: false, reactions: false };
  test.each<[string, string[], typeof allowed]>([
    ["no deny list", [], allowed],
    ["an empty deny list", ["CLIENTTAGDENY="], allowed],
    ["deny everything", ["CLIENTTAGDENY=*"], denied],
    ["deny everything except typing", ["CLIENTTAGDENY=*,-typing"], { ...denied, typing: true }],
    [
      "deny everything except what reactions need",
      ["CLIENTTAGDENY=*,-reply,-draft/react,-draft/unreact"],
      { typing: false, replies: true, reactions: true },
    ],
    [
      "deny two named tags",
      ["CLIENTTAGDENY=typing,draft/react"],
      { typing: false, replies: true, reactions: false },
    ],
    ["a later -CLIENTTAGDENY removes the list", ["CLIENTTAGDENY=*", "-CLIENTTAGDENY"], allowed],
    // Malformed lists fail closed: every client tag stays denied.
    ["duplicate entries", ["CLIENTTAGDENY=typing,typing"], denied],
    ["negation without a leading *", ["CLIENTTAGDENY=-typing"], denied],
    ["a misplaced *", ["CLIENTTAGDENY=typing,*"], denied],
    ["an illegal tag name", ["CLIENTTAGDENY=ty$pe"], denied],
  ])("CLIENTTAGDENY: %s", (_name, tokens, expected) => {
    const f = observed();
    f.modern.isupport(tokens);
    const features = f.modern.features();
    expect({
      typing: features.typing,
      replies: features.replies,
      reactions: features.reactions,
    }).toEqual(expected);
  });

  test.each<[string, number, boolean]>([
    ["CHATHISTORY=0", 100, true],
    ["CHATHISTORY=0", 101, false],
    ["CHATHISTORY=5000", 101, false],
    ["CHATHISTORY=50", 50, true],
    ["CHATHISTORY=50", 51, false],
    ["CHATHISTORY=abc", 100, true],
    ["CHATHISTORY=-1", 100, true],
  ])("%s: a limit of %i is accepted: %s", (token, limit, accepted) => {
    const f = observed();
    f.modern.isupport([token]);
    expect(f.modern.admit({ type: "history", target: "#r", limit }, op("h")).ok).toBe(accepted);
  });

  test.each<[string, { serverId: string } | { serverTime: number }]>([
    ["MSGREFTYPES=", { serverId: "id" }],
    ["MSGREFTYPES=", { serverTime: time }],
    ["MSGREFTYPES=timestamp", { serverId: "id" }],
    ["MSGREFTYPES=msgid", { serverTime: time }],
    ["MSGREFTYPES=nonsense,msgid", { serverTime: time }],
  ])("%s refuses the unsupported reference kind %j", (token, before) => {
    const f = observed();
    f.modern.isupport([token]);
    const result = f.modern.admit({ type: "history", target: "#r", limit: 5, before }, op("h"));
    expect(!result.ok && result.error.code).toBe("invalid-input");
  });
});

describe("modern frames", () => {
  test.each<[string, IrcFrame]>([
    ["a message in an unknown batch", frame("PRIVMSG", ["#r", "x"], { batch: "nope" })],
    ["a BATCH with no reference", frame("BATCH", [])],
    ["a malformed batch reference", frame("BATCH", ["+bad id", "custom"])],
    ["a batch reference without a sign", frame("BATCH", ["plain", "custom"])],
    ["a batch with no type", frame("BATCH", ["+one"])],
    ["ending an unknown batch", frame("BATCH", ["-nope"])],
    ["a chathistory batch without a target", frame("BATCH", ["+one", "chathistory"])],
    ["a chathistory batch with a malformed target", frame("BATCH", ["+one", "chathistory", "a b"])],
  ])("%s is fatal", (_name, input) => {
    const f = fixture();
    f.modern.handle(input, "s");
    expect(f.errors).toHaveLength(1);
  });

  test("batches nested deeper than the bound are fatal", () => {
    const f = fixture(allCaps, { maxBatchDepth: 1 });
    f.modern.handle(frame("BATCH", ["+one", "custom"]), "s");
    f.modern.handle(frame("BATCH", ["+two", "custom"], { batch: "one" }), "s");
    expect(f.errors).toHaveLength(1);
  });

  test("an unnegotiated batch is fatal", () => {
    const f = fixture(["message-tags"]);
    f.modern.handle(frame("BATCH", ["+one", "custom"]), "s");
    expect(f.errors).toHaveLength(1);
  });

  test("a duplicate batch reference and ending a batch that still has children are fatal", () => {
    const f = fixture();
    f.modern.handle(frame("BATCH", ["+one", "custom"]), "s");
    f.modern.handle(frame("BATCH", ["+one", "custom"]), "s");
    expect(f.errors).toHaveLength(1);
    const g = fixture();
    g.modern.handle(frame("BATCH", ["+outer", "custom"]), "s");
    g.modern.handle(frame("BATCH", ["+inner", "custom"], { batch: "outer" }), "s");
    g.modern.handle(frame("BATCH", ["-outer"]), "s");
    expect(g.errors).toHaveLength(1);
  });

  test("unknown batch types stay ordinary live traffic and are not treated as history", () => {
    const f = fixture();
    f.modern.handle(frame("BATCH", ["+net", "netsplit", "a.example", "b.example"]), "s");
    const joined = frame("JOIN", ["#r"], { batch: "net" });
    // Not intercepted: the caller still applies live membership changes.
    expect(f.modern.handle(joined, "alice")).toBe(false);
    expect(f.modern.playback(joined)).toBe(false);
    f.modern.handle(frame("BATCH", ["-net"]), "s");
    expect(f.errors).toEqual([]);
    expect(f.events).toEqual([]);
  });

  test("labeled-response batches settle their operation when they end", async () => {
    const f = fixture();
    const command = { type: "redact" as const, target: "#r", serverId: "id" };
    f.modern.admit(command, op("redact"));
    await f.modern.perform(command, op("redact"), f.write);
    const label = f.writes[0]!.tags.label!;
    expect(f.modern.hasOperation(op("redact"))).toBe(true);
    f.modern.handle(frame("BATCH", ["+lr", "labeled-response"], { label }), "s");
    f.modern.handle(frame("BATCH", ["-lr"]), "s");
    expect(f.modern.hasOperation(op("redact"))).toBe(false);
  });

  test("ACK settles a labeled operation without any event", async () => {
    const f = fixture();
    const command = { type: "mark-read" as const, target: "#r", serverTime: time };
    f.modern.admit(command, op("mark"));
    await f.modern.perform(command, op("mark"), f.write);
    const label = f.writes[0]!.tags.label!;
    expect(f.modern.handle(frame("ACK", [], { label }), "s")).toBe(true);
    expect(f.modern.hasOperation(op("mark"))).toBe(false);
    expect(f.events).toEqual([]);
  });

  test.each<[string, string[], boolean]>([
    ["messages but no end marker", ["m1", "m2"], true],
    ["no messages", [], false],
  ])("history completion with %s reports hasMore: %s", async (_name, ids, hasMore) => {
    const f = fixture();
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    await f.modern.perform(command, op("h"), f.write);
    const label = f.writes[0]!.tags.label!;
    f.modern.handle(frame("BATCH", ["+p", "chathistory", "#r"], { label }), "s");
    for (const id of ids)
      f.modern.handle(frame("PRIVMSG", ["#r", "x"], { batch: "p", msgid: id }), "a");
    // Context lines accompany a reference point and are not part of the requested page.
    f.modern.handle(
      frame("PRIVMSG", ["#r", "ctx"], { batch: "p", "draft/chathistory-context": null }),
      "a",
    );
    f.modern.handle(frame("BATCH", ["-p"]), "s");
    expect(f.events.at(-1)).toMatchObject({ type: "history-complete", hasMore });
    expect(f.modern.hasOperation(op("h"))).toBe(false);
  });

  test("a request that expired is not reported complete when its batch finally ends", async () => {
    const f = fixture();
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    await f.modern.perform(command, op("h"), f.write);
    const label = f.writes[0]!.tags.label!;
    f.modern.handle(frame("BATCH", ["+p", "chathistory", "#r"], { label }), "s");
    f.modern.handle(frame("FAIL", ["CHATHISTORY", "MESSAGE_ERROR"], { label }), "s");
    const count = f.events.length;
    f.modern.handle(frame("BATCH", ["-p"]), "s");
    expect(f.events).toHaveLength(count);
    expect(f.modern.admit(command, op("again")).ok).toBe(true);
  });

  test("a labeled FAIL ends a pending history request with a per-operation error", async () => {
    const f = fixture();
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    await f.modern.perform(command, op("h"), f.write);
    const label = f.writes[0]!.tags.label!;
    const failure = frame("FAIL", ["CHATHISTORY", "MESSAGE_ERROR"], { label });
    expect(f.modern.handle(failure, "s")).toBe(true);
    expect(f.events).toEqual([
      {
        type: "error",
        operationId: op("h"),
        error: expect.objectContaining({ code: "unavailable" }),
      },
    ]);
    expect(f.modern.admit(command, op("again")).ok).toBe(true);
  });

  test("a numeric carrying a pending label is a failure of that operation", async () => {
    const f = fixture();
    const command = { type: "redact" as const, target: "#r", serverId: "id" };
    f.modern.admit(command, op("r"));
    await f.modern.perform(command, op("r"), f.write);
    const label = f.writes[0]!.tags.label!;
    expect(f.modern.handle(frame("421", ["me", "REDACT", "Unknown"], { label }), "s")).toBe(true);
    expect(opIds(f.events)).toEqual([op("r")]);
  });

  test("an unlabeled FAIL is attributed to history only when it names CHATHISTORY", async () => {
    const f = fixture(allCaps.filter((cap) => cap !== "labeled-response"));
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    await f.modern.perform(command, op("h"), f.write);
    f.modern.handle(frame("FAIL", ["REDACT", "REDACT_FORBIDDEN", "#r", "id"]), "s");
    expect(f.events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "Server rejected an IRC operation." },
    });
    expect(f.events.at(-1)).not.toHaveProperty("operationId");
    // The history request is unaffected by an unrelated failure.
    expect(f.modern.admit(command, op("overlap")).ok).toBe(false);
    f.modern.handle(frame("BATCH", ["+p", "chathistory", "#r"]), "s");
    f.modern.handle(frame("FAIL", ["CHATHISTORY", "MESSAGE_ERROR"]), "s");
    expect(f.events.at(-1)).toMatchObject({ operationId: op("h") });
    // With its batch already open the query only expires; the terminator still arrives.
    expect(f.modern.admit(command, op("still")).ok).toBe(false);
    f.modern.handle(frame("BATCH", ["-p"]), "s");
    expect(f.modern.admit(command, op("free")).ok).toBe(true);
  });

  test("unobserved redaction and read-marker outcomes time out as visible errors", async () => {
    const f = fixture();
    for (const [name, command] of [
      ["redact", { type: "redact" as const, target: "#r", serverId: "id" }],
      ["mark", { type: "mark-read" as const, target: "#r", serverTime: time }],
      ["typing", { type: "typing" as const, target: "#r", active: true }],
    ] as const) {
      f.modern.admit(command, op(name));
      await f.modern.perform(command, op(name), f.write);
    }
    f.time(101_000);
    f.modern.tick(101_000);
    // Typing is fire-and-forget; only operations whose result matters are reported.
    expect(opIds(f.events)).toEqual([op("redact"), op("mark")]);
    expect(f.modern.hasOperation(op("typing"))).toBe(false);
  });

  test.each<[string, number, boolean]>([
    ["active", 5999, true],
    ["active", 6000, false],
    ["paused", 29_999, true],
    ["paused", 30_000, false],
  ])("a %s indicator at +%ims is still shown: %s", (value, elapsed, shown) => {
    const f = fixture();
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": value }), "alice");
    f.time(100_000 + elapsed);
    f.modern.tick(100_000 + elapsed);
    expect(f.events.at(-1)).toMatchObject({ type: "typing", active: shown });
  });

  test("typing from ourselves or with unknown values is ignored; too many senders is fatal", () => {
    const f = fixture(allCaps, { maxTypingEntries: 1 });
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "active" }), "me");
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "composing" }), "alice");
    f.modern.handle(frame("TAGMSG", ["#r"]), "alice");
    expect(f.events).toEqual([]);
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "active" }), "alice");
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "done" }), "alice");
    expect(f.events.map((event) => (event as { active?: boolean }).active)).toEqual([true, false]);
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "active" }), "alice");
    f.modern.handle(frame("TAGMSG", ["#r"], { "+typing": "active" }), "bob");
    expect(f.errors).toHaveLength(1);
  });

  test.each<[string, Record<string, string | null>]>([
    ["react and unreact together", { "+reply": "id", "+draft/react": "x", "+draft/unreact": "x" }],
    ["no message reference", { "+draft/react": "x" }],
    ["an invalid message reference", { "+reply": ":bad", "+draft/react": "x" }],
    ["an oversized value", { "+reply": "id", "+draft/react": "x".repeat(129) }],
    ["an empty value", { "+reply": "id", "+draft/react": "" }],
    ["a value of only control characters", { "+reply": "id", "+draft/react": "\x1b\x07" }],
  ])("reaction tags with %s are ignored", (_name, tags) => {
    const f = fixture();
    f.modern.handle(frame("TAGMSG", ["#r"], tags), "alice");
    expect(f.events).toEqual([]);
  });

  test("malformed or unnegotiated markers and redactions are ignored, not fatal", () => {
    const f = fixture();
    for (const value of [
      "timestamp=2026-01-01",
      "timestamp=2026-02-30T00:00:00.000Z",
      "other=1",
      "timestamp=garbage",
    ])
      f.modern.handle(frame("MARKREAD", ["#r", value]), "s");
    f.modern.handle(frame("MARKREAD", ["a b", stamp]), "s");
    f.modern.handle(frame("MARKREAD", ["#r"]), "s");
    f.modern.handle(frame("REDACT", ["#r", "a b"]), "s");
    f.modern.handle(frame("REDACT", ["#r"]), "s");
    const bare = fixture(["message-tags"]);
    bare.modern.handle(frame("MARKREAD", ["#r", stamp]), "s");
    bare.modern.handle(frame("REDACT", ["#r", "id"]), "s");
    expect([...f.events, ...bare.events, ...f.errors, ...bare.errors]).toEqual([]);
  });

  test("the read-marker table is bounded", () => {
    const f = fixture(allCaps, { maxModernOperations: 1 });
    f.modern.handle(frame("MARKREAD", ["#a", stamp]), "s");
    f.modern.handle(frame("MARKREAD", ["#a", "timestamp=2026-01-02T00:00:00.000Z"]), "s");
    expect(f.errors).toEqual([]);
    f.modern.handle(frame("MARKREAD", ["#b", stamp]), "s");
    expect(f.errors).toHaveLength(1);
  });

  test("nested batch contents count against every ancestor's size bound", () => {
    const f = fixture(allCaps, { maxBatchMessages: 3 });
    f.modern.handle(frame("BATCH", ["+outer", "custom"]), "s");
    f.modern.handle(frame("BATCH", ["+inner", "custom"], { batch: "outer" }), "s");
    f.modern.handle(frame("PRIVMSG", ["#r", "1"], { batch: "inner" }), "a");
    f.modern.handle(frame("PRIVMSG", ["#r", "2"], { batch: "inner" }), "a");
    // The nested BATCH line and two messages already make three in outer; one more exceeds it.
    expect(f.errors).toHaveLength(0);
    f.modern.handle(frame("PRIVMSG", ["#r", "3"], { batch: "inner" }), "a");
    expect(f.errors).toHaveLength(1);
  });
});

describe("modern execution", () => {
  test("a feature withdrawn after admission fails at execution and frees history", async () => {
    const f = fixture();
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    f.capabilities.delete("draft/chathistory");
    const result = await f.modern.perform(command, op("h"), f.write);
    expect(!result.ok && result.error.code).toBe("unsupported");
    expect(f.writes).toEqual([]);
    expect(f.modern.hasOperation(op("h"))).toBe(false);
  });

  test("validateFrame refuses every modern frame whose feature is gone and throttles typing", async () => {
    const f = fixture(["message-tags"]);
    const refused = (tags: Record<string, string | null>, command = "TAGMSG") => {
      const result = f.modern.validateFrame(frame(command, ["#r"], tags));
      return !result.ok && result.error.code;
    };
    expect(refused({}, "CHATHISTORY")).toBe("unsupported");
    expect(refused({}, "REDACT")).toBe("unsupported");
    expect(refused({}, "MARKREAD")).toBe("unsupported");
    // Replies and reactions need an observed server message ID; typing only needs message-tags.
    expect(refused({ "+reply": "id" })).toBe("unsupported");
    expect(refused({ "+draft/react": "x" })).toBe("unsupported");
    expect(refused({ "+typing": "active" })).toBe(false);
    const command = { type: "typing" as const, target: "#r", active: true };
    expect((await f.modern.perform(command, op("t1"), f.write)).ok).toBe(true);
    expect(refused({ "+typing": "active" })).toBe("rate-limited");
    const again = await f.modern.perform(command, op("t2"), f.write);
    expect(!again.ok && again.error.code).toBe("rate-limited");
    f.time(103_000);
    expect(refused({ "+typing": "active" })).toBe(false);
  });

  test("a failed write releases the label and history slot", async () => {
    const f = fixture();
    const command = { type: "history" as const, target: "#r", limit: 5 };
    f.modern.admit(command, op("h"));
    const result = await f.modern.perform(command, op("h"), async () => ({
      ok: false,
      error: { code: "network", message: "x", retryable: true },
    }));
    expect(result.ok).toBe(false);
    expect(f.modern.hasOperation(op("h"))).toBe(false);
    expect(f.modern.admit(command, op("h2")).ok).toBe(true);
  });

  test("too many unsettled labeled operations rejects the next one explicitly", async () => {
    const f = fixture(allCaps, { maxModernOperations: 1 });
    const redact = (id: string) => ({ type: "redact" as const, target: "#r", serverId: id });
    expect((await f.modern.perform(redact("a"), op("a"), f.write)).ok).toBe(true);
    const second = await f.modern.perform(redact("b"), op("b"), f.write);
    expect(!second.ok && second.error.code).toBe("rate-limited");
    expect(f.writes).toHaveLength(1);
  });

  test("without labeled-response commands are written untagged and cannot be correlated", async () => {
    const f = fixture(allCaps.filter((cap) => cap !== "labeled-response"));
    await f.modern.perform({ type: "mark-read", target: "#r", serverTime: time }, op("m"), f.write);
    expect(f.writes[0]?.tags).toEqual({});
    expect(f.modern.hasOperation(op("m"))).toBe(false);
  });

  test("commands this layer does not own are refused rather than guessed", async () => {
    const f = fixture();
    const result = await f.modern.perform({ type: "list" }, op("l"), f.write);
    expect(!result.ok && result.error.code).toBe("unsupported");
  });

  test("closing reports each unsettled operation once, or nothing when the caller already did", async () => {
    const build = async () => {
      const f = fixture();
      const history = { type: "history" as const, target: "#r", limit: 5 };
      f.modern.admit(history, op("h"));
      await f.modern.perform(history, op("h"), f.write);
      const redact = { type: "redact" as const, target: "#r", serverId: "id" };
      await f.modern.perform(redact, op("r"), f.write);
      return f;
    };
    const loud = await build();
    loud.modern.close(true);
    expect(opIds(loud.events)).toEqual([op("h"), op("r")]);
    expect(loud.modern.hasOperation(op("h"))).toBe(false);
    const quiet = await build();
    quiet.modern.close(false);
    expect(quiet.events).toEqual([]);
  });
});
