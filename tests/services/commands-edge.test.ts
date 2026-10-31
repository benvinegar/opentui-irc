import { describe, expect, test } from "vitest";
import { entityId } from "../../src/contracts/common";
import type { AppSnapshot, ConversationView } from "../../src/contracts/model";
import { createCommandService } from "../../src/services/commands";
import { createFakeApp } from "../fakes/app";
import { appSnapshot, conversationId, networkId } from "../fixtures/scenario";

const statusId = entityId<"conversation">("fixture-status");
const directId = entityId<"conversation">("fixture-direct");
const otherNetwork = entityId<"network">("fixture-other-network");
const otherChannel = entityId<"conversation">("fixture-other-channel");
const base = appSnapshot.conversations[0]!;
const extra: ConversationView[] = [
  { ...base, id: statusId, kind: "status", name: "fixture" },
  { ...base, id: directId, kind: "direct", name: "friend", topic: "" },
  { ...base, id: otherChannel, networkId: otherNetwork, name: "#elsewhere" },
];
const snapshot: AppSnapshot = {
  ...appSnapshot,
  conversations: [...appSnapshot.conversations, ...extra],
};
const service = () => createCommandService(createFakeApp(snapshot).app);
const channel = { conversationId, networkId };
const status = { conversationId: statusId, networkId };
const direct = { conversationId: directId };

function errorOf(text: string, context: Parameters<ReturnType<typeof service>["parse"]>[1]) {
  const result = service().parse(text, context);
  return result.ok ? null : result.error.message;
}

describe("command usage errors name the expected syntax", () => {
  test.each([
    ["/query two words", "/query nickname"],
    ["/whois", "/whois nickname"],
    ["/nick has space", "/nick nickname"],
    ["/join welcome", "/join #channel"],
    ["/away", "/away reason"],
    ["/back now", "/back"],
    ["/list everything", "/list"],
    ["/msg friend", "/msg target message"],
    ["/notice", "/notice target message"],
    ["/disconnect now", "/disconnect"],
    ["/reconnect now", "/reconnect"],
    ["/part reason", "/part"],
    ["/close now", "/close"],
    ["/mute 5m", "/mute"],
    ["/unmute all", "/unmute"],
    ["/settings network", "/settings"],
  ])("%s", (text, usage) => {
    expect(errorOf(text, channel)).toBe(`Usage: ${usage}`);
  });
});

describe("command context requirements", () => {
  test("network commands need a network and conversation commands need a conversation", () => {
    expect(errorOf("/join #welcome", {})).toBe("Select a network first, or add one in Settings.");
    expect(errorOf("/part", { networkId })).toBe("Select a conversation first.");
    expect(errorOf("/whois", { conversationId: entityId("missing") })).toContain(
      "Select a network",
    );
  });

  test("the network is inferred from the selected conversation when not given", () => {
    expect(service().parse("/nick other", direct)).toMatchObject({
      ok: true,
      value: { action: { type: "irc.request", networkId, command: { type: "nick" } } },
    });
  });

  test("/me and /topic refuse conversations they cannot act on", () => {
    expect(errorOf("/me waves", status)).toBe("Usage: /me action");
    expect(errorOf("/topic", direct)).toBe("Topics belong to channels.");
    expect(errorOf("/topic new", status)).toBe("Topics belong to channels.");
    expect(service().parse("/me waves", direct)).toMatchObject({
      ok: true,
      value: { action: { conversationId: directId, kind: "action", text: "waves" } },
    });
  });

  test("/topic without text requests the current topic for the channel", () => {
    expect(service().parse("/TOPIC", channel)).toEqual({
      ok: true,
      value: {
        type: "action",
        action: {
          type: "irc.request",
          networkId,
          command: { type: "topic", channel: "#welcome" },
        },
      },
    });
  });

  test("/msg targets exact open names on this network only, never status buffers", () => {
    expect(service().parse("/msg friend hi there", channel)).toMatchObject({
      ok: true,
      value: { action: { conversationId: directId, text: "hi there" } },
    });
    const missing = "Open the target with /query or /join first, then use its displayed name.";
    expect(errorOf("/msg #elsewhere hi", channel)).toBe(missing);
    expect(errorOf("/msg fixture hi", channel)).toBe(missing);
    expect(errorOf("/msg FRIEND hi", channel)).toBe(missing);
  });

  test("plain text needs a channel or direct conversation", () => {
    const message = "Choose a channel or direct conversation before sending.";
    expect(errorOf("hello", status)).toBe(message);
    expect(errorOf("hello", {})).toBe(message);
    expect(errorOf("hello", { conversationId: entityId("missing"), networkId })).toBe(message);
  });
});

describe("input boundary", () => {
  test("rejects oversized input, bare slashes and whitespace-only text", () => {
    expect(errorOf("x".repeat(32_769), channel)).toContain("too long");
    expect(errorOf("/", channel)).toBe("Type /help to see available commands.");
    expect(errorOf("   ", channel)).toBe("Write a message first.");
    expect(errorOf("/unknown", channel)).toContain("Unknown command");
  });

  test("multiline literal text is one message; tabs are allowed", () => {
    expect(service().parse("line one\nline\ttwo", channel)).toMatchObject({
      ok: true,
      value: { action: { text: "line one\nline\ttwo" } },
    });
  });

  test("help lists every command, and lookups ignore case and a leading slash", () => {
    const commands = service();
    expect(commands.parse("/help", {})).toEqual({ ok: true, value: { type: "help" } });
    expect(commands.help().map((entry) => entry.name)).toContain("quit");
    expect(commands.help("/JOIN")).toEqual([
      { name: "join", usage: "/join #channel", description: expect.any(String) },
    ]);
  });
});

describe("completion", () => {
  test("rejects cursors outside the text or between surrogate halves", () => {
    const commands = service();
    expect(commands.complete("abc", -1, channel)).toEqual([]);
    expect(commands.complete("abc", 4, channel)).toEqual([]);
    expect(commands.complete("abc", 1.5, channel)).toEqual([]);
    expect(commands.complete("a😀b", 2, channel)).toEqual([]);
  });

  test("nicks at the start get an address suffix, channels do not; other networks excluded", () => {
    const fake = createFakeApp(snapshot);
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      members: [
        { id: entityId<"user">("e"), nick: "Eve", away: false, prefixes: [] },
        { id: entityId<"user">("e2"), nick: "eve2", away: false, prefixes: [] },
      ],
    });
    const commands = createCommandService(fake.app);
    expect(commands.complete("ev", 2, channel).map((item) => item.insertText)).toEqual([
      "Eve: ",
      "eve2: ",
    ]);
    expect(commands.complete("hi ev", 5, channel).map((item) => item.insertText)).toEqual([
      "Eve",
      "eve2",
    ]);
    expect(commands.complete("#", 1, channel).map((item) => item.insertText)).toEqual(["#welcome"]);
  });

  test("a conversation without a timeline still completes channel names", () => {
    const fake = createFakeApp(snapshot);
    fake.timelines.delete(directId);
    const commands = createCommandService(fake.app);
    expect(commands.complete("#w", 2, direct)).toEqual([
      { label: "#welcome", insertText: "#welcome", replace: { start: 0, end: 2 } },
    ]);
    expect(commands.complete("zz", 2, {})).toEqual([]);
  });
});
