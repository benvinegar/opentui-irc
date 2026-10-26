// Client-to-server command admission and execution: validation, wire output, bounds and
// failure reporting for every SessionCommand type, plus session-open argument checks.
import { afterEach, describe, expect, test } from "vitest";
import { entityId } from "../../../src/contracts/common";
import type { SessionCommand } from "../../../src/contracts/session";
import type { NetworkProfile } from "../../../src/contracts/settings";
import { createSessionFactory } from "../../../src/irc/session";
import {
  clock,
  closeSessions,
  harness,
  networkId,
  of,
  op,
  profile,
  ready,
  receive,
  secrets,
  signal,
  until,
} from "./harness";
import type { Fixture } from "./harness";

afterEach(closeSessions);

const run = (fixture: Fixture, command: SessionCommand, id: string) =>
  fixture.session.execute(command, op(id), signal());
const codeOf = (result: Awaited<ReturnType<typeof run>>) => (result.ok ? "ok" : result.error.code);
const wire = (fixture: Fixture, command: string) =>
  fixture.written.filter((frame) => frame.command === command).map((frame) => frame.params);
const secretKey = entityId<"secret-ref">("env:KEY");

describe("command admission", () => {
  test("nothing is accepted before registration completes", async () => {
    // Answers CAP so the attempt is mid-registration, but never sends 001.
    const fixture = await harness({
      onWrite(frame, send) {
        if (frame.command === "CAP" && frame.params[0] === "LS") send(":s CAP * LS :");
        return { ok: true, value: undefined };
      },
    });
    await until(() => fixture.written.some((frame) => frame.command === "USER"));
    expect(codeOf(await run(fixture, { type: "join", channel: "#room" }, "early"))).toBe(
      "unavailable",
    );
  });

  test.each<[string, SessionCommand, string]>([
    ["join without a channel prefix", { type: "join", channel: "room" }, "invalid-input"],
    ["join with a space in the name", { type: "join", channel: "#a b" }, "invalid-input"],
    [
      "part with a line break in the reason",
      { type: "part", channel: "#a", reason: "x\ny" },
      "invalid-input",
    ],
    [
      "topic with a line break",
      { type: "topic", channel: "#a", text: "x\r\nQUIT" },
      "invalid-input",
    ],
    ["topic on a non-channel", { type: "topic", channel: "nick", text: "x" }, "invalid-input"],
    ["nick with a space", { type: "nick", nick: "bad nick" }, "invalid-input"],
    ["away reason with NUL", { type: "away", reason: "x\0" }, "invalid-input"],
    ["whois with a comma list", { type: "whois", nick: "a,b" }, "invalid-input"],
    ["empty message", { type: "send", target: "#a", text: "", kind: "text" }, "invalid-input"],
    ["wildcard target", { type: "send", target: "*", text: "x", kind: "text" }, "invalid-input"],
    ["CR in text", { type: "send", target: "#a", text: "x\ry", kind: "text" }, "invalid-input"],
    [
      "raw CTCP delimiter in text",
      { type: "send", target: "#a", text: "\x01VERSION\x01", kind: "text" },
      "invalid-input",
    ],
    [
      "reply without observed message ids",
      { type: "send", target: "#a", text: "x", kind: "text", replyToServerId: "id" },
      "unsupported",
    ],
  ])("rejects %s without writing", async (_name, command, code) => {
    const fixture = await ready();
    const before = fixture.written.length;
    expect(codeOf(await run(fixture, command, "bad"))).toBe(code);
    await receive(fixture);
    expect(fixture.written.slice(before).map((frame) => frame.command)).toEqual(["PONG"]);
  });

  test("each accepted command type produces its wire form", async () => {
    const fixture = await ready();
    const commands: SessionCommand[] = [
      { type: "join", channel: "#room" },
      { type: "part", channel: "#room" },
      { type: "part", channel: "#room", reason: "bye" },
      { type: "topic", channel: "#room" },
      { type: "topic", channel: "#room", text: "new topic" },
      { type: "nick", nick: "other" },
      { type: "away", reason: "lunch" },
      { type: "away", reason: null },
      { type: "list" },
    ];
    for (const [index, command] of commands.entries())
      expect(codeOf(await run(fixture, command, `ok-${index}`))).toBe("ok");
    await until(() => wire(fixture, "LIST").length === 1);
    const sent = fixture.written.filter(
      (frame) => frame.command !== "CAP" && frame.command !== "NICK" && frame.command !== "USER",
    );
    expect(sent.map((frame) => [frame.command, ...frame.params])).toEqual([
      ["JOIN", "#room"],
      ["PART", "#room"],
      ["PART", "#room", "bye"],
      ["TOPIC", "#room"],
      ["TOPIC", "#room", "new topic"],
      ["AWAY", "lunch"],
      ["AWAY"],
      ["LIST"],
    ]);
    expect(wire(fixture, "NICK").at(-1)).toEqual(["other"]);
  });

  test("a channel key is resolved privately and sent only in the JOIN", async () => {
    const fixture = await ready({
      secretProvider: {
        ...secrets,
        async resolve(ref) {
          return ref === secretKey
            ? { ok: true, value: "hunter2" }
            : { ok: false, error: { code: "unavailable", message: "x", retryable: false } };
        },
      },
    });
    expect(
      codeOf(await run(fixture, { type: "join", channel: "#vault", key: secretKey }, "keyed")),
    ).toBe("ok");
    await until(() => wire(fixture, "JOIN").length === 1);
    expect(wire(fixture, "JOIN")[0]).toEqual(["#vault", "hunter2"]);
    expect(JSON.stringify(fixture.events)).not.toContain("hunter2");
  });

  test.each([
    [
      "unresolvable",
      {
        ok: false as const,
        error: { code: "unavailable" as const, message: "no", retryable: false },
      },
    ],
    ["containing a space", { ok: true as const, value: "bad key" }],
  ])("a channel key that is %s fails the operation without joining", async (_name, outcome) => {
    const fixture = await ready({ secretProvider: { ...secrets, resolve: async () => outcome } });
    await run(fixture, { type: "join", channel: "#vault", key: secretKey }, "keyed");
    await until(() => fixture.events.some((event) => event.payload.type === "error"));
    const errors = of(
      fixture.events.map((event) => event.payload),
      "error",
    );
    expect(errors[0]).toMatchObject({
      operationId: op("keyed"),
      error: { code: "authentication" },
    });
    expect(wire(fixture, "JOIN")).toEqual([]);
    // The failure is per-operation; the session stays usable.
    expect(codeOf(await run(fixture, { type: "join", channel: "#open" }, "next"))).toBe("ok");
  });

  test("duplicate operation ids are rejected while the first is still active", async () => {
    // A long flood interval keeps the first send queued behind its own pacing.
    const fixture = await ready({ policy: { floodIntervalMs: 5000 } });
    await run(fixture, { type: "join", channel: "#a" }, "first-write");
    const send: SessionCommand = { type: "send", target: "#a", text: "x", kind: "text" };
    expect(codeOf(await run(fixture, send, "dup"))).toBe("ok");
    expect(codeOf(await run(fixture, { type: "nick", nick: "n" }, "dup"))).toBe("conflict");
    expect(codeOf(await run(fixture, { type: "whois", nick: "bob" }, "w"))).toBe("ok");
    expect(codeOf(await run(fixture, { type: "whois", nick: "bob" }, "w"))).toBe("conflict");
    expect(codeOf(await run(fixture, { type: "whois", nick: "eve" }, "w2"))).toBe("conflict");
    expect(codeOf(await run(fixture, { type: "list" }, "l"))).toBe("ok");
    expect(codeOf(await run(fixture, { type: "list" }, "l"))).toBe("conflict");
    expect(codeOf(await run(fixture, { type: "list" }, "l2"))).toBe("conflict");
  });

  test.each<[string, Parameters<typeof harness>[0], SessionCommand[], string]>([
    [
      "command count",
      { policy: { maxQueueCommands: 1, floodIntervalMs: 5000 } },
      [
        { type: "nick", nick: "a" },
        { type: "nick", nick: "b" },
      ],
      "rate-limited",
    ],
    [
      "byte budget",
      { policy: { maxQueueBytes: 100, floodIntervalMs: 5000 } },
      [
        { type: "topic", channel: "#a", text: "x".repeat(60) },
        { type: "topic", channel: "#a", text: "y".repeat(60) },
      ],
      "rate-limited",
    ],
    [
      "pending sends",
      { policy: { maxPendingSends: 1, floodIntervalMs: 5000 } },
      [
        { type: "send", target: "#a", text: "1", kind: "text" },
        { type: "send", target: "#a", text: "2", kind: "text" },
      ],
      "rate-limited",
    ],
    [
      "fragment budget",
      { policy: { maxQueueFragments: 2, floodIntervalMs: 5000 } },
      [
        { type: "send", target: "#a", text: "1\n2", kind: "text" },
        { type: "send", target: "#a", text: "3", kind: "text" },
      ],
      "rate-limited",
    ],
  ])(
    "the outgoing %s bound rejects the overflowing command explicitly",
    async (_name, options, commands, code) => {
      const fixture = await ready(options);
      // The head item is written immediately and then paces the rest; queue bounds still hold its slot
      // until it completes, so the final command is the first one over budget.
      const results: string[] = [];
      for (const [index, command] of commands.entries())
        results.push(codeOf(await run(fixture, command, `q-${index}`)));
      expect(results.at(-1)).toBe(code);
      expect(results.slice(0, -1).every((result) => result === "ok")).toBe(true);
    },
  );

  test("a failed write reports a per-operation error and later commands still run", async () => {
    const fixture = await ready({
      onWrite(frame) {
        if (frame.command === "TOPIC")
          return { ok: false, error: { code: "unavailable", message: "x", retryable: true } };
      },
    });
    await run(fixture, { type: "topic", channel: "#a", text: "t" }, "topic");
    await run(fixture, { type: "away", reason: "x" }, "away");
    await until(() => wire(fixture, "AWAY").length === 1);
    const errors = of(
      fixture.events.map((event) => event.payload),
      "error",
    );
    expect(errors).toMatchObject([{ operationId: op("topic"), error: { code: "unavailable" } }]);
  });

  test("a failed WHOIS or LIST write frees the slot for the next query", async () => {
    let failing = true;
    const fixture = await ready({
      onWrite(frame) {
        if ((frame.command === "WHOIS" || frame.command === "LIST") && failing)
          return { ok: false, error: { code: "unavailable", message: "x", retryable: true } };
      },
    });
    await run(fixture, { type: "whois", nick: "bob" }, "w1");
    await run(fixture, { type: "list" }, "l1");
    await until(
      () => fixture.events.filter((event) => event.payload.type === "error").length === 2,
    );
    failing = false;
    expect(codeOf(await run(fixture, { type: "whois", nick: "bob" }, "w2"))).toBe("ok");
    expect(codeOf(await run(fixture, { type: "list" }, "l2"))).toBe("ok");
  });

  test("a network write failure ends the session with a terminal error", async () => {
    const fixture = await ready({
      onWrite(frame) {
        if (frame.command === "AWAY")
          return { ok: false, error: { code: "network", message: "reset", retryable: true } };
      },
    });
    await run(fixture, { type: "away", reason: "x" }, "away");
    await fixture.consumption;
    expect(fixture.events.at(-1)?.payload).toMatchObject({ type: "state", phase: "disconnected" });
    expect(
      fixture.events.some(
        (event) => event.payload.type === "error" && event.payload.operationId === op("away"),
      ),
    ).toBe(true);
  });

  test("closing reports queued commands and in-flight queries as failed, not silently dropped", async () => {
    const fixture = await ready({ policy: { floodIntervalMs: 60_000 } });
    await run(fixture, { type: "nick", nick: "first" }, "head");
    await run(fixture, { type: "topic", channel: "#a", text: "queued" }, "queued");
    await run(fixture, { type: "whois", nick: "bob" }, "whois");
    await run(fixture, { type: "send", target: "#a", text: "pending", kind: "text" }, "send");
    await fixture.session.close();
    await fixture.consumption;
    const payloads = fixture.events.map((event) => event.payload);
    const failed = of(payloads, "error")
      .map((event) => event.operationId)
      .filter(Boolean);
    expect(failed).toEqual(expect.arrayContaining([op("queued"), op("whois")]));
    expect(
      of(payloads, "send-state").find((event) => event.operationId === op("send")),
    ).toMatchObject({ state: "failed" });
  });
});

describe("modern command admission through the session", () => {
  const modernCaps =
    "message-tags server-time batch labeled-response echo-message draft/chathistory draft/read-marker draft/message-redaction";
  test.each<[string, SessionCommand]>([
    ["history", { type: "history", target: "#a", limit: 10 }],
    ["typing", { type: "typing", target: "#a", active: true }],
    ["reaction", { type: "reaction", target: "#a", serverId: "m", value: "x", remove: false }],
    ["redaction", { type: "redact", target: "#a", serverId: "m" }],
    ["read markers", { type: "mark-read", target: "#a", serverTime: 1_700_000_000_000 }],
  ])("%s is unsupported when its capability was not negotiated", async (_name, command) => {
    const fixture = await ready();
    expect(codeOf(await run(fixture, command, "m"))).toBe("unsupported");
  });

  test("a feature withdrawn by CAP DEL after admission fails at execution instead of writing", async () => {
    const fixture = await ready({
      capabilities: modernCaps,
      policy: { floodIntervalMs: 200 },
    });
    await run(fixture, { type: "nick", nick: "head" }, "head");
    expect(
      codeOf(
        await run(
          fixture,
          { type: "mark-read", target: "#a", serverTime: 1_700_000_000_000 },
          "mark",
        ),
      ),
    ).toBe("ok");
    fixture.send(":s CAP me DEL :draft/read-marker");
    await until(() => fixture.events.some((event) => event.payload.type === "error"));
    expect(wire(fixture, "MARKREAD")).toEqual([]);
    expect(
      of(
        fixture.events.map((event) => event.payload),
        "error",
      )[0],
    ).toMatchObject({
      operationId: op("mark"),
      error: { code: "unsupported" },
    });
  });

  test("history, typing, reaction, redaction and read-marker commands are written with labels", async () => {
    const fixture = await ready({ capabilities: modernCaps });
    fixture.send("@msgid=m1 :alice!u@h PRIVMSG #a :hello");
    await until(() =>
      fixture.events.some(
        (event) => event.payload.type === "support" && event.payload.features.reactions,
      ),
    );
    const commands: SessionCommand[] = [
      { type: "history", target: "#a", limit: 5 },
      { type: "typing", target: "#a", active: true },
      { type: "reaction", target: "#a", serverId: "m1", value: "+1", remove: false },
      { type: "reaction", target: "#a", serverId: "m1", value: "+1", remove: true },
      { type: "redact", target: "#a", serverId: "m1" },
      { type: "mark-read", target: "#a", serverTime: Date.UTC(2026, 0, 1) },
    ];
    for (const [index, command] of commands.entries())
      expect(codeOf(await run(fixture, command, `modern-${index}`))).toBe("ok");
    await until(() => wire(fixture, "MARKREAD").length === 1);
    const sent = fixture.written.filter((frame) =>
      ["CHATHISTORY", "TAGMSG", "REDACT", "MARKREAD"].includes(frame.command),
    );
    expect(sent.map((frame) => frame.command)).toEqual([
      "CHATHISTORY",
      "TAGMSG",
      "TAGMSG",
      "TAGMSG",
      "REDACT",
      "MARKREAD",
    ]);
    expect(sent[0]?.params).toEqual(["LATEST", "#a", "*", "5"]);
    expect(sent[1]?.tags["+typing"]).toBe("active");
    expect(sent[3]?.tags).toMatchObject({ "+reply": "m1", "+draft/unreact": "+1" });
    expect(sent[5]?.params).toEqual(["#a", "timestamp=2026-01-01T00:00:00.000Z"]);
    expect(sent.every((frame) => frame.tags.label?.startsWith("oi-modern-"))).toBe(true);
  });
});

describe("opening a session", () => {
  const open = (
    overrides: Partial<NetworkProfile>,
    generation = 1,
    abort = new AbortController().signal,
  ) => {
    const factory = createSessionFactory({
      transport: {
        async connect() {
          return { ok: false, error: { code: "network", message: "offline", retryable: true } };
        },
      },
      secrets,
      clock,
    });
    return factory.open({ ...profile, ...overrides }, { networkId, generation }, abort);
  };
  const code = async (promise: ReturnType<typeof open>) => {
    const result = await promise;
    return result.ok ? "ok" : result.error.code;
  };

  test.each<[string, Partial<NetworkProfile>, number, string]>([
    ["a mismatched network id", { id: entityId<"network">("other") }, 1, "invalid-input"],
    ["generation zero", {}, 0, "invalid-input"],
    ["a fractional generation", {}, 1.5, "invalid-input"],
    ["no endpoints", { endpoints: [] }, 1, "invalid-input"],
    [
      "a nickname with a space",
      { identity: { ...profile.identity, nick: "a b" } },
      1,
      "invalid-input",
    ],
    [
      "a username with a space",
      { identity: { ...profile.identity, username: "a b" } },
      1,
      "invalid-input",
    ],
    [
      "an invalid alternate nickname",
      { identity: { ...profile.identity, alternateNicks: ["ok", "no no"] } },
      1,
      "invalid-input",
    ],
    [
      "a realname with a line break",
      { identity: { ...profile.identity, realname: "a\nb" } },
      1,
      "invalid-input",
    ],
    [
      "an empty SASL account",
      { sasl: { mechanism: "PLAIN", account: "", password: secretKey, required: false } },
      1,
      "invalid-input",
    ],
    [
      "a SASL account with a line break",
      { sasl: { mechanism: "PLAIN", account: "a\nb", password: secretKey, required: false } },
      1,
      "invalid-input",
    ],
    [
      "an unsupported SASL mechanism",
      {
        sasl: {
          mechanism: "EXTERNAL" as "PLAIN",
          account: "a",
          password: secretKey,
          required: false,
        },
      },
      1,
      "invalid-input",
    ],
    [
      "a server password over plaintext",
      {
        serverPassword: secretKey,
        endpoints: [{ host: "x.invalid", port: 6667, tls: false }],
      },
      1,
      "authentication",
    ],
    [
      "SASL over plaintext",
      {
        sasl: { mechanism: "PLAIN", account: "a", password: secretKey, required: false },
        endpoints: [{ host: "x.invalid", port: 6667, tls: false }],
      },
      1,
      "authentication",
    ],
    [
      "a complete profile with auto-join and SASL",
      {
        autoJoin: [{ channel: "#a" }],
        sasl: { mechanism: "PLAIN", account: "a", password: secretKey, required: false },
      },
      1,
      "ok",
    ],
  ])("%s", async (_name, overrides, generation, expected) => {
    expect(await code(open(overrides, generation))).toBe(expected);
  });

  test("an already-cancelled signal is refused before any attempt starts", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(await code(open({}, 1, abort.signal))).toBe("cancelled");
  });

  test("the session never aliases the caller's profile after open", async () => {
    const mutable = {
      ...profile,
      identity: { ...profile.identity, alternateNicks: ["me_"] },
    };
    let seen: string | undefined;
    const factory = createSessionFactory({
      transport: {
        async connect(endpoint) {
          seen = endpoint.host;
          return { ok: false, error: { code: "network", message: "offline", retryable: true } };
        },
      },
      secrets,
      clock,
    });
    const opened = await factory.open(
      { ...mutable, endpoints: [{ host: "first.invalid", port: 6697, tls: true }] },
      { networkId, generation: 1 },
      signal(),
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) for await (const event of opened.value.events) void event;
    expect(seen).toBe("first.invalid");
  });

  test.each<[string, Record<string, number>]>([
    ["zero timeout", { connectTimeoutMs: 0 }],
    ["fractional value", { keepaliveMs: 1.5 }],
    ["absurdly large value", { maxEvents: 1_000_000_000 }],
    ["negative flood interval", { floodIntervalMs: -1 }],
    ["stale timeout not above keepalive", { keepaliveMs: 100, staleTimeoutMs: 100 }],
  ])("rejects an invalid policy: %s", (_name, policy) => {
    expect(() =>
      createSessionFactory({
        transport: {
          connect: async () => ({
            ok: false,
            error: { code: "network", message: "x", retryable: true },
          }),
        },
        secrets,
        clock,
        policy,
      }),
    ).toThrow(TypeError);
  });
});
