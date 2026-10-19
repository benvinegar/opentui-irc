import { describe, expect, test } from "vitest";
import { createCommandService } from "../../src/services/commands";
import { createFakeApp } from "../fakes/app";
import { conversationId, networkId } from "../fixtures/scenario";
import { entityId } from "../../src/contracts/common";

const context = { conversationId, networkId };
describe("typed command service", () => {
  test("plain text and literal slash send exactly one typed action without effects", () => {
    const fake = createFakeApp();
    const commands = createCommandService(fake.app);
    expect(commands.parse("hello", context)).toEqual({
      ok: true,
      value: {
        type: "action",
        action: { type: "message.send", conversationId, text: "hello", kind: "text" },
      },
    });
    expect(commands.parse("//quit", context)).toMatchObject({
      ok: true,
      value: { action: { text: "/quit" } },
    });
    expect(fake.actions).toHaveLength(0);
  });
  test.each([
    ["/join #welcome", "conversation.join"],
    ["/query friend", "conversation.query"],
    ["/connect", "network.connect"],
    ["/disconnect", "network.disconnect"],
    ["/reconnect", "network.reconnect"],
    ["/part", "conversation.close"],
    ["/close", "conversation.close"],
    ["/mute", "conversation.mute"],
    ["/unmute", "conversation.mute"],
    ["/me waves", "message.send"],
    ["/nick newcomer_", "irc.request"],
    ["/away lunch", "irc.request"],
    ["/back", "irc.request"],
    ["/whois friend", "irc.request"],
    ["/topic", "irc.request"],
    ["/topic A new topic", "irc.request"],
    ["/list", "irc.request"],
  ])("%s maps to %s", (text, type) => {
    expect(createCommandService(createFakeApp().app).parse(text, context)).toMatchObject({
      ok: true,
      value: { type: "action", action: { type } },
    });
  });
  test("messages target an open conversation, with explicit errors for unavailable targets", () => {
    const commands = createCommandService(createFakeApp().app);
    expect(commands.parse("/msg #welcome hi", context)).toMatchObject({
      ok: true,
      value: { action: { conversationId, text: "hi", kind: "text" } },
    });
    expect(commands.parse("/notice #welcome hi", context)).toMatchObject({
      ok: true,
      value: { action: { kind: "notice" } },
    });
    expect(commands.parse("/msg unknown hi", context)).toMatchObject({ ok: false });
  });
  test.each([
    "/raw PRIVMSG x :hi",
    "/join",
    "/nick",
    "/connect extra",
    "/join #one\n/quit",
    "/me",
    "/quit extra",
    "\u001b[2J",
    "",
  ])("rejects unsafe or invalid input %j", (text) => {
    expect(createCommandService(createFakeApp().app).parse(text, context)).toMatchObject({
      ok: false,
      error: { code: "invalid-input" },
    });
  });
  test("help/settings/quit work without a network; unsupported commands are not advertised", () => {
    const commands = createCommandService(createFakeApp().app);
    expect(commands.parse("/help join", {})).toEqual({
      ok: true,
      value: { type: "help", command: "join" },
    });
    expect(commands.parse("/settings", {})).toEqual({ ok: true, value: { type: "settings" } });
    expect(commands.parse("/quit", {})).toEqual({ ok: true, value: { type: "quit" } });
    expect(commands.help("who")).toEqual([]);
    expect(commands.help("join")).toHaveLength(1);
  });
  test("completion offsets use UTF-16 after CJK and emoji, not cells/code points", () => {
    const fake = createFakeApp();
    const model = fake.timelines.get(conversationId)!;
    model.publish({
      ...model.getSnapshot(),
      members: [{ id: entityId<"user">("alice"), nick: "Alice", away: false, prefixes: [] }],
    });
    const commands = createCommandService(fake.app);
    const text = "世界 😀 Al";
    expect(commands.complete(text, text.length, context)).toEqual([
      {
        label: "Alice",
        insertText: "Alice",
        replace: { start: text.length - 2, end: text.length },
      },
    ]);
    expect(commands.complete("😀", 1, context)).toEqual([]);
    expect(commands.complete("/jo", 3, context)[0]).toMatchObject({
      insertText: "/join ",
      replace: { start: 0, end: 3 },
    });
    expect(commands.complete("#we", 3, context)[0]?.insertText).toBe("#welcome");
  });
});
