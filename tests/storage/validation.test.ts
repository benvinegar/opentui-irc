import { describe, expect, test } from "vitest";
import {
  identifier,
  secretReference,
  text,
  timestamp,
  validConversation,
  validMessage,
  validReadPosition,
  validTuiSettings,
  validUserSettings,
  validWorkspace,
} from "../../src/storage/validation";
import { conversationId, networkId, settings, welcomeMessage } from "../fixtures/scenario";

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any -- test mutation helper
const clone = <T>(value: T): T => structuredClone(value);
function mutate(base: unknown, change: (draft: Json) => void): unknown {
  const draft = clone(base) as Json;
  change(draft);
  return draft;
}
const network = (draft: Json) => draft.networks[0] as Json;
const uuid = "keychain:123e4567-e89b-12d3-a456-426614174000";

describe("primitive validators", () => {
  test.each([
    ["plain", true],
    ["tab\tand\nnewline", true],
    ["emoji 🙂", true],
    ["nul\u0000", false],
    ["esc\u001b", false],
    ["c1\u0085", false],
    ["del\u007f", false],
    ["lone\ud800surrogate", false],
    [5, false],
  ])("text(%j) -> %s", (value, expected) => expect(text(value)).toBe(expected));
  test("text enforces its length bound", () => {
    expect(text("a".repeat(65536))).toBe(true);
    expect(text("a".repeat(65537))).toBe(false);
    expect(text("abc", 2)).toBe(false);
  });
  test.each([
    ["nick", true],
    ["", false],
    ["with space", false],
    ["tab\t", false],
    ["x".repeat(513), false],
    [null, false],
  ])("identifier(%j) -> %s", (value, expected) => expect(identifier(value)).toBe(expected));
  test.each([
    [0, true],
    [1_700_000_000_000, true],
    [-1, false],
    [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
    ["1", false],
  ])("timestamp(%j) -> %s", (value, expected) => expect(timestamp(value)).toBe(expected));
  test.each([
    ["env:OPENIRC_PASSWORD", true],
    ["env:_x1", true],
    [uuid, true],
    ["env:1bad", false],
    ["env:", false],
    ["env:" + "A".repeat(257), false],
    ["keychain:not-a-uuid", false],
    ["keychain:123E4567-e89b-12d3-a456-426614174000", false],
    ["file:/tmp/secret", false],
    ["hunter2", false],
    [undefined, false],
  ])("secretReference(%j) -> %s", (value, expected) =>
    expect(secretReference(value)).toBe(expected),
  );
});

describe("user settings validation", () => {
  const good = settings.user;
  test("the fixture and a SASL/autojoin-rich profile are valid", () => {
    expect(validUserSettings(good)).toBe(true);
    expect(
      validUserSettings(
        mutate(good, (d) => {
          network(d).serverPassword = "env:SERVER_PW";
          network(d).sasl = { mechanism: "PLAIN", account: "me", password: uuid, required: false };
          network(d).autoJoin = [{ channel: "#a" }, { channel: "&b", key: "env:KEY" }];
          network(d).identity.alternateNicks = ["alt1", "alt2"];
          d.history.retentionDays = null;
          d.history.excludedConversations = [
            { networkId, kind: "channel", name: "#a" },
            { networkId, kind: "status", name: "Local Network" },
          ];
        }),
      ),
    ).toBe(true);
  });
  const invalid: [string, (draft: Json) => void][] = [
    ["extra top-level key", (d) => (d.extra = 1)],
    ["wrong schema version", (d) => (d.schemaVersion = 2)],
    ["non-boolean sendTyping", (d) => (d.sendTyping = "no")],
    ["networks not an array", (d) => (d.networks = {})],
    ["more than 100 networks", (d) => (d.networks = Array.from({ length: 101 }, () => ({})))],
    ["network is not an object", (d) => (d.networks = [1])],
    ["network extra key", (d) => (network(d).extra = true)],
    ["empty network id", (d) => (network(d).id = "")],
    ["blank network name", (d) => (network(d).name = "   ")],
    ["multi-line network name", (d) => (network(d).name = "a\nb")],
    ["non-boolean autoConnect", (d) => (network(d).autoConnect = 1)],
    ["no endpoints", (d) => (network(d).endpoints = [])],
    ["17 endpoints", (d) => (network(d).endpoints = Array(17).fill(network(d).endpoints[0]))],
    ["endpoint port 0", (d) => (network(d).endpoints[0].port = 0)],
    ["endpoint port 65536", (d) => (network(d).endpoints[0].port = 65536)],
    ["fractional port", (d) => (network(d).endpoints[0].port = 6697.5)],
    ["URL-like host", (d) => (network(d).endpoints[0].host = "irc.example.org/path")],
    ["host with userinfo", (d) => (network(d).endpoints[0].host = "me@irc.example.org")],
    ["bracketed IPv6 host", (d) => (network(d).endpoints[0].host = "[::1]")],
    ["non-boolean tls", (d) => (network(d).endpoints[0].tls = "yes")],
    ["endpoint extra key", (d) => (network(d).endpoints[0].extra = 1)],
    ["identity missing", (d) => delete network(d).identity],
    ["empty nick", (d) => (network(d).identity.nick = "")],
    ["empty username", (d) => (network(d).identity.username = "")],
    ["multi-line realname", (d) => (network(d).identity.realname = "a\tb")],
    ["duplicate alternate nick", (d) => (network(d).identity.alternateNicks = ["newcomer"])],
    ["17 alternate nicks", (d) => (network(d).identity.alternateNicks = Array(17).fill("n"))],
    ["plaintext server password", (d) => (network(d).serverPassword = "hunter2")],
    ["plaintext sasl password", (d) => (network(d).sasl = sasl({ password: "hunter2" }))],
    ["unknown sasl mechanism", (d) => (network(d).sasl = sasl({ mechanism: "EXTERNAL" }))],
    ["empty sasl account", (d) => (network(d).sasl = sasl({ account: "" }))],
    ["non-boolean sasl required", (d) => (network(d).sasl = sasl({ required: 1 }))],
    ["sasl extra key", (d) => (network(d).sasl = sasl({ extra: 1 }))],
    [
      "sasl over plaintext endpoint",
      (d) => {
        network(d).sasl = sasl({});
        network(d).endpoints[0].tls = false;
      },
    ],
    ["autojoin not an array", (d) => (network(d).autoJoin = "#a")],
    ["autojoin channel without prefix", (d) => (network(d).autoJoin = [{ channel: "a" }])],
    ["autojoin channel with comma", (d) => (network(d).autoJoin = [{ channel: "#a,b" }])],
    ["autojoin plaintext key", (d) => (network(d).autoJoin = [{ channel: "#a", key: "k" }])],
    ["duplicate autojoin", (d) => (network(d).autoJoin = [{ channel: "#a" }, { channel: "#a" }])],
    ["duplicate network id", (d) => d.networks.push(clone(network(d)))],
    ["history missing", (d) => delete d.history],
    ["history extra key", (d) => (d.history.extra = 1)],
    ["history.enabled not boolean", (d) => (d.history.enabled = 1)],
    ["history.persistDrafts not boolean", (d) => (d.history.persistDrafts = 1)],
    ["retention 0 days", (d) => (d.history.retentionDays = 0)],
    ["retention too long", (d) => (d.history.retentionDays = 36501)],
    ["exclusions not an array", (d) => (d.history.excludedConversations = {})],
    [
      "exclusion for unknown network",
      (d) =>
        (d.history.excludedConversations = [{ networkId: "ghost", kind: "channel", name: "#a" }]),
    ],
    [
      "exclusion with bad kind",
      (d) => (d.history.excludedConversations = [{ networkId, kind: "group", name: "#a" }]),
    ],
    [
      "exclusion with spaced channel name",
      (d) => (d.history.excludedConversations = [{ networkId, kind: "channel", name: "a b" }]),
    ],
    [
      "duplicate exclusions",
      (d) =>
        (d.history.excludedConversations = Array(2).fill({
          networkId,
          kind: "channel",
          name: "#a",
        })),
    ],
    ["notifications missing", (d) => delete d.notifications],
    ["notifications extra key", (d) => (d.notifications.extra = true)],
    ["notifications.desktop not boolean", (d) => (d.notifications.desktop = "on")],
    ["notifications.previews not boolean", (d) => (d.notifications.previews = 0)],
    ["notifications.bell not boolean", (d) => (d.notifications.bell = null)],
  ];
  const sasl = (override: Json) => ({
    mechanism: "PLAIN",
    account: "me",
    password: uuid,
    required: false,
    ...override,
  });
  test.each(invalid)("rejects %s", (_name, change) => {
    expect(validUserSettings(mutate(good, change))).toBe(false);
  });
  test.each([null, undefined, 1, "x", [], [good]])("rejects non-object %j", (value) => {
    expect(validUserSettings(value)).toBe(false);
  });
  test("accepts an IPv6 literal endpoint", () => {
    expect(
      validUserSettings(mutate(good, (d) => (network(d).endpoints[0].host = "2001:db8::1"))),
    ).toBe(true);
  });
});

describe("TUI settings validation", () => {
  const good = settings.tui;
  test("the fixture and edge-sized values are valid", () => {
    expect(validTuiSettings(good)).toBe(true);
    expect(
      validTuiSettings(
        mutate(good, (d) => {
          d.theme = "high-contrast";
          d.density = "compact";
          d.sidebarWidth = 12;
          d.memberListWidth = 60;
          d.authorColumnWidth = 40;
          d.keybindings = { "app.quit": ["ctrl+q"], "nav.next": ["ctrl+n", "alt+n"] };
        }),
      ),
    ).toBe(true);
  });
  const invalid: [string, (draft: Json) => void][] = [
    ["extra key", (d) => (d.extra = 1)],
    ["wrong schema version", (d) => (d.schemaVersion = 0)],
    ["unknown theme", (d) => (d.theme = "solarized")],
    ["unknown density", (d) => (d.density = "tight")],
    ["non-boolean mouse", (d) => (d.mouse = 1)],
    ["non-boolean memberList", (d) => (d.memberList = "yes")],
    ["non-boolean showHistServ", (d) => (d.showHistServ = undefined)],
    ["sidebar too narrow", (d) => (d.sidebarWidth = 11)],
    ["sidebar too wide", (d) => (d.sidebarWidth = 81)],
    ["fractional sidebar", (d) => (d.sidebarWidth = 24.5)],
    ["member list too narrow", (d) => (d.memberListWidth = 11)],
    ["member list too wide", (d) => (d.memberListWidth = 61)],
    ["author column too narrow", (d) => (d.authorColumnWidth = 7)],
    ["author column too wide", (d) => (d.authorColumnWidth = 41)],
    ["author column undefined", (d) => (d.authorColumnWidth = undefined)],
    ["keybindings not an object", (d) => (d.keybindings = [])],
    ["empty action name", (d) => (d.keybindings = { "": ["a"] })],
    ["shortcuts not a list", (d) => (d.keybindings = { act: "ctrl+a" })],
    ["empty shortcut", (d) => (d.keybindings = { act: [""] })],
    [
      "more than 10 shortcuts",
      (d) => (d.keybindings = { act: Array.from({ length: 11 }, (_, i) => `k${i}`) }),
    ],
    [
      "more than 200 actions",
      (d) =>
        (d.keybindings = Object.fromEntries(
          Array.from({ length: 201 }, (_, i) => [`a${i}`, [`k${i}`]]),
        )),
    ],
    ["shortcut shared by two actions", (d) => (d.keybindings = { a: ["ctrl+x"], b: ["ctrl+x"] })],
    [
      "case-insensitive shortcut conflict",
      (d) => (d.keybindings = { a: ["Ctrl+X"], b: ["ctrl+x"] }),
    ],
  ];
  test.each(invalid)("rejects %s", (_name, change) => {
    expect(validTuiSettings(mutate(good, change))).toBe(false);
  });
  test.each([null, 3, "x", []])("rejects non-object %j", (value) => {
    expect(validTuiSettings(value)).toBe(false);
  });
});

describe("storage record validation", () => {
  const conversation = { id: conversationId, networkId, kind: "channel", name: "#welcome" };
  test("conversation records", () => {
    expect(validConversation(conversation)).toBe(true);
    expect(validConversation({ ...conversation, kind: "direct", name: "guide" })).toBe(true);
    expect(validConversation({ ...conversation, kind: "status", name: "Local Network" })).toBe(
      true,
    );
    for (const bad of [
      { ...conversation, extra: 1 },
      { ...conversation, kind: "group" },
      { ...conversation, id: "" },
      { ...conversation, networkId: "a b" },
      { ...conversation, name: "two words" },
      { ...conversation, kind: "status", name: "  " },
      null,
      [],
    ])
      expect(validConversation(bad)).toBe(false);
  });
  const message = welcomeMessage as unknown as Json;
  test("messages, including optional fields", () => {
    expect(validMessage(message)).toBe(true);
    expect(
      validMessage({
        ...message,
        serverId: "abc",
        serverTime: 5,
        sendState: "uncertain",
        replyTo: { serverId: "x", localId: "y" },
        sender: { nick: "n", userId: "u", account: "acct" },
        reactions: [{ value: "👍", count: 2, reactedBySelf: true }],
        kind: "event",
        source: "playback",
      }),
    ).toBe(true);
  });
  const badMessages: [string, Json][] = [
    ["extra key", { extra: 1 }],
    ["empty id", { id: "" }],
    ["bad conversation id", { conversationId: "a b" }],
    ["bad network id", { networkId: 1 }],
    ["bad server id", { serverId: "" }],
    ["unknown kind", { kind: "join" }],
    ["control text", { text: "a\u001bb" }],
    ["negative receivedAt", { receivedAt: -1 }],
    ["bad serverTime", { serverTime: 1.5 }],
    ["unknown source", { source: "remote" }],
    ["unknown send state", { sendState: "delivered" }],
    ["non-boolean redacted", { redacted: 0 }],
    ["sender missing", { sender: undefined }],
    ["sender extra key", { sender: { nick: "n", extra: 1 } }],
    ["empty sender nick", { sender: { nick: "" } }],
    ["bad sender userId", { sender: { nick: "n", userId: "" } }],
    ["bad sender account", { sender: { nick: "n", account: "a b" } }],
    ["non-object replyTo", { replyTo: "x" }],
    ["replyTo extra key", { replyTo: { serverId: "x", extra: 1 } }],
    ["replyTo bad serverId", { replyTo: { serverId: "" } }],
    ["replyTo bad localId", { replyTo: { serverId: "x", localId: "" } }],
    ["reactions not an array", { reactions: {} }],
    [
      "too many reactions",
      { reactions: Array(1001).fill({ value: "a", count: 1, reactedBySelf: false }) },
    ],
    ["reaction empty value", { reactions: [{ value: "", count: 1, reactedBySelf: false }] }],
    ["reaction zero count", { reactions: [{ value: "a", count: 0, reactedBySelf: false }] }],
    ["reaction bad self flag", { reactions: [{ value: "a", count: 1, reactedBySelf: 1 }] }],
    ["reaction extra key", { reactions: [{ value: "a", count: 1, reactedBySelf: true, x: 1 }] }],
  ];
  test.each(badMessages)("rejects message with %s", (_name, override) => {
    expect(validMessage({ ...message, ...override })).toBe(false);
  });
  test("rejects non-object messages", () => {
    expect(validMessage(null)).toBe(false);
    expect(validMessage("x")).toBe(false);
  });
  test("read positions", () => {
    const position = { conversationId, messageId: welcomeMessage.id, readAt: 10 };
    expect(validReadPosition(position)).toBe(true);
    for (const bad of [
      { ...position, extra: 1 },
      { ...position, conversationId: "" },
      { ...position, messageId: "a b" },
      { ...position, readAt: -5 },
      null,
    ])
      expect(validReadPosition(bad)).toBe(false);
  });
  test("workspace state", () => {
    const good = {
      activeConversationId: conversationId,
      conversationOrder: ["a", "b"],
      mutedConversations: ["a"],
      drafts: [{ conversationId: "a", text: "draft\nline" }],
    };
    expect(validWorkspace(good)).toBe(true);
    expect(validWorkspace({ conversationOrder: [], mutedConversations: [], drafts: [] })).toBe(
      true,
    );
    for (const bad of [
      { ...good, extra: 1 },
      { ...good, activeConversationId: "" },
      { ...good, conversationOrder: ["a", "a"] },
      { ...good, mutedConversations: ["a", "a"] },
      { ...good, conversationOrder: "a" },
      { ...good, drafts: {} },
      { ...good, drafts: [{ conversationId: "a", text: "x", extra: 1 }] },
      { ...good, drafts: [{ conversationId: "", text: "x" }] },
      { ...good, drafts: [{ conversationId: "a", text: "bad\u0000" }] },
      {
        ...good,
        drafts: [
          { conversationId: "a", text: "1" },
          { conversationId: "a", text: "2" },
        ],
      },
      null,
    ])
      expect(validWorkspace(bad)).toBe(false);
  });
});
