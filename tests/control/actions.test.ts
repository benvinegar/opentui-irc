import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../../src/contracts/control";
import { actionSchema, parseAppAction, permissionsForAction } from "../../src/control/actions";
import { fields, isJson, json, opaqueId } from "../../src/control/validation";

const samples = [
  { type: "network.connect", networkId: "network" },
  { type: "network.disconnect", networkId: "network" },
  { type: "network.reconnect", networkId: "network" },
  { type: "conversation.activate", conversationId: "conversation" },
  { type: "conversation.close", conversationId: "conversation" },
  { type: "conversation.join", networkId: "network", channel: "#channel", key: "env:KEY" },
  { type: "conversation.query", networkId: "network", nick: "peer" },
  { type: "conversation.mute", conversationId: "conversation", muted: false },
  { type: "draft.set", conversationId: "conversation", text: "draft\ntext" },
  {
    type: "message.send",
    conversationId: "conversation",
    text: "a\nb",
    kind: "text",
    replyTo: "message",
  },
  { type: "message.react", messageId: "message", value: "👍", remove: false },
  { type: "message.redact", messageId: "message" },
  { type: "typing.set", conversationId: "conversation", active: true },
  { type: "typing.set", conversationId: "conversation", active: false, paused: true },
  { type: "history.load-older", conversationId: "conversation", cursor: "cursor" },
  { type: "history.latest", conversationId: "conversation" },
  { type: "history.reveal", messageId: "message" },
  { type: "history.delete", conversationId: "conversation" },
  {
    type: "view.report",
    conversationId: "conversation",
    focused: true,
    atBottom: true,
    lastVisibleMessageId: "message",
  },
  ...[
    { type: "nick", nick: "nickname" },
    { type: "away", reason: null },
    { type: "away", reason: "busy" },
    { type: "whois", nick: "peer" },
    { type: "list" },
    { type: "topic", channel: "#channel" },
    { type: "topic", channel: "#channel", text: "new topic" },
  ].map((command) => ({ type: "irc.request", networkId: "network", command })),
];
function object(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function typeMatches(value: unknown, kind: unknown): boolean {
  return kind === "null"
    ? value === null
    : kind === "object"
      ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === kind;
}
function matchesValue(value: unknown, shape: JsonObject): boolean {
  if (
    shape.type &&
    !(Array.isArray(shape.type)
      ? shape.type.some((kind: JsonValue) => typeMatches(value, kind))
      : typeMatches(value, shape.type))
  )
    return false;
  if (shape.const !== undefined && shape.const !== value) return false;
  return !(Array.isArray(shape.enum) && !shape.enum.includes(value));
}
function matchesString(value: string, shape: JsonObject): boolean {
  if (typeof shape.minLength === "number" && value.length < shape.minLength) return false;
  if (typeof shape.maxLength === "number" && value.length > shape.maxLength) return false;
  return !(typeof shape.pattern === "string" && !new RegExp(shape.pattern, "u").test(value));
}
function matchesProperties(value: object, shape: JsonObject): boolean {
  if (!object(shape.properties)) return false;
  const properties = shape.properties;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Array.isArray(shape.required) &&
    !shape.required.every((key: JsonValue) => typeof key === "string" && Object.hasOwn(value, key))
  )
    return false;
  return Object.keys(descriptors).every((key) => {
    const child = properties[key];
    return object(child) && matches(descriptors[key]?.value, child);
  });
}
/** Test interpreter for the action schema's actual assertion keywords. */
function matches(value: unknown, shape: JsonObject): boolean {
  if (Array.isArray(shape.oneOf))
    return (
      shape.oneOf.filter((item: JsonValue) => object(item) && matches(value, item)).length === 1
    );
  return (
    matchesValue(value, shape) &&
    (typeof value !== "string" || matchesString(value, shape)) &&
    (typeof value !== "object" || value === null || matchesProperties(value, shape))
  );
}

describe("control action schema and parser", () => {
  it("discovers all 19 action types and all five IRC command variants", () => {
    const schema = actionSchema();
    expect(new Set(samples.map((action) => action.type)).size).toBe(19);
    expect(Array.isArray(schema.oneOf) && schema.oneOf.length).toBe(19);
    for (const sample of samples) {
      expect(parseAppAction(sample), sample.type).toEqual({ ok: true, value: sample });
      expect(matches(sample, schema), sample.type).toBe(true);
      expect(parseAppAction({ ...sample, raw: "PRIVMSG #x :body" }).ok).toBe(false);
      expect(matches({ ...sample, raw: "PRIVMSG #x :body" }, schema)).toBe(false);
      for (const key of Object.keys(sample)) {
        const incomplete = Object.fromEntries(
          Object.entries(sample).filter(([name]) => name !== key),
        );
        const parsed = parseAppAction(incomplete);
        expect(parsed.ok, `${sample.type} without ${key}`).toBe(matches(incomplete, schema));
      }
    }
  });
  it("shares accurate nickname, channel, reaction, cursor and text bounds", () => {
    const schema = actionSchema();
    const cases = [
      ...[
        "",
        "x".repeat(100),
        "x".repeat(101),
        "x".repeat(512),
        "bad nick",
        "bad,nick",
        "bad:nick",
        "bad\u009bnick",
        "bad\ud800",
      ].map((nick) => ({ type: "conversation.query", networkId: "network", nick })),
      ...["x".repeat(200), "x".repeat(201), "bad nick", "bad:nick"].flatMap((nick) =>
        ["nick", "whois"].map((type) => ({
          type: "irc.request",
          networkId: "network",
          command: { type, nick },
        })),
      ),
      ...[
        "#",
        `#${"x".repeat(199)}`,
        `#${"x".repeat(200)}`,
        "not-channel",
        "#bad channel",
        "#bad,channel",
        "#bad:channel",
        "#bad\u0001channel",
      ].flatMap((channel) => [
        { type: "conversation.join", networkId: "network", channel },
        { type: "irc.request", networkId: "network", command: { type: "topic", channel } },
      ]),
      ...["", "x".repeat(64), "x".repeat(65), "bad reaction", "\n", "\u009b"].map((value) => ({
        type: "message.react",
        messageId: "message",
        value,
        remove: false,
      })),
      ...["", "x".repeat(16384), "x".repeat(16385), "has space", "\u009b", "\ud800"].map(
        (cursor) => ({ type: "history.load-older", conversationId: "conversation", cursor }),
      ),
      ...[
        "",
        " \t\n",
        "multiline\nmessage",
        "x".repeat(65536),
        "x".repeat(65537),
        "bad\rbody",
        "\u0001ACTION CTCP\u0001",
        "nul\u0000",
      ].map((text) => ({
        type: "message.send",
        conversationId: "conversation",
        text,
        kind: "text",
      })),
      ...[
        null,
        "",
        "away",
        "x".repeat(4096),
        "x".repeat(4097),
        "bad\nreason",
        "bad\rreason",
        "nul\u0000",
      ].map((reason) => ({
        type: "irc.request",
        networkId: "network",
        command: { type: "away", reason },
      })),
      ...[
        "",
        "topic",
        "x".repeat(65536),
        "x".repeat(65537),
        "bad\ntopic",
        "bad\rtopic",
        "nul\u0000",
      ].map((text) => ({
        type: "irc.request",
        networkId: "network",
        command: { type: "topic", channel: "#channel", text },
      })),
    ];
    for (const value of cases)
      expect(parseAppAction(value).ok, JSON.stringify(value).slice(0, 200)).toBe(
        matches(value, schema),
      );
    expect(
      parseAppAction({ type: "conversation.query", networkId: "network", nick: "x".repeat(101) })
        .ok,
    ).toBe(false);
    expect(
      parseAppAction({
        type: "message.react",
        messageId: "message",
        value: "x".repeat(65),
        remove: false,
      }).ok,
    ).toBe(false);
  });
  it("requires reference grammar rather than treating arbitrary plaintext as a secret ID", () => {
    const schema = actionSchema();
    for (const key of [
      "plaintext-secret",
      "file:/password",
      "env:BAD NAME",
      "env:",
      "env:KEY\n",
      "keychain:not-a-uuid",
      "env:KEY",
      "keychain:12345678-abcd-1234-abcd-123456789abc",
    ]) {
      const value = { type: "conversation.join", networkId: "network", channel: "#private", key };
      expect(parseAppAction(value).ok).toBe(matches(value, schema));
      expect(parseAppAction(value).ok).toBe(
        key === "env:KEY" || key.startsWith("keychain:12345678"),
      );
    }
  });
  it("requires separate permissions for sends, reads, destructive actions and topic writes", () => {
    for (const sample of samples) {
      const parsed = parseAppAction(sample);
      if (!parsed.ok) throw new Error("Expected test action");
      const rights = permissionsForAction(parsed.value);
      if (
        ["draft.set", "message.send", "message.react", "typing.set", "message.redact"].includes(
          sample.type,
        )
      )
        expect(rights).toContain("send-messages");
      if (
        ["history.load-older", "history.latest", "history.reveal", "view.report"].includes(
          sample.type,
        )
      )
        expect(rights).toContain("read-messages");
      if (["message.redact", "history.delete"].includes(sample.type))
        expect(rights).toContain("destructive");
      if (parsed.value.type === "irc.request" && parsed.value.command.type === "topic")
        expect(rights.includes("send-messages")).toBe(parsed.value.command.text !== undefined);
    }
  });
});

describe("control JSON boundary", () => {
  it("rejects accessors, prototype pollution, non-JSON values and cycles without invoking getters", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get() {
        calls++;
        return "network.connect";
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const values = [
      accessor,
      cycle,
      new Date(),
      { x: NaN },
      { x: undefined },
      { x: Array(2) },
      { [Symbol("x")]: true },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      {
        type: "network.connect",
        networkId: "network",
        toJSON() {
          calls++;
          return {};
        },
      },
    ];
    for (const value of values) {
      expect(isJson(value)).toBe(false);
      expect(() => fields(value, [])).toThrow();
      expect(parseAppAction(value).ok).toBe(false);
    }
    expect(calls).toBe(0);
  });
  it("copies bounded output without executing toJSON/getters or rewriting bad runtime data", () => {
    const original = { nested: { text: "safe", optional: undefined } };
    const copy = json(original);
    original.nested.text = "changed";
    expect(copy).toEqual({ nested: { text: "safe" } });
    let calls = 0;
    for (const value of [
      new Error("private"),
      { value: Infinity },
      { value: 1n },
      {
        toJSON() {
          calls++;
          return "private";
        },
      },
      Object.defineProperty({}, "secret", {
        enumerable: true,
        get() {
          calls++;
          return "private";
        },
      }),
      { text: "x".repeat(4194305) },
      Array.from({ length: 100001 }, () => null),
    ])
      expect(() => json(value)).toThrow();
    expect(calls).toBe(0);
    expect(() => opaqueId("bad\u009b-id")).toThrow();
    expect(() => opaqueId("bad\ud800-id")).toThrow();
  });
});
