import { afterEach, describe, expect, it } from "vitest";
import type { AppAction, AppApi } from "../../src/contracts/app";
import {
  entityId,
  type ConversationId,
  type NetworkId,
  type OperationId,
  type Result,
} from "../../src/contracts/common";
import type { SessionPayload } from "../../src/contracts/session";
import { createApp } from "../../src/app/create-app";
import { appSnapshot, networkId, settings } from "../fixtures/scenario";
import { harness, settle } from "./harness";

const signal = () => new AbortController().signal;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const apps: AppApi[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
});
async function connected() {
  const h = harness(settings);
  const app = value(await createApp(h.deps, signal()));
  apps.push(app);
  value(await app.dispatch({ type: "network.connect", networkId }, signal()));
  await settle();
  const session = h.session(networkId);
  session.emit({
    type: "support",
    features: appSnapshot.networks[0]!.features,
    support: {
      casemapping: "rfc1459",
      channelTypes: "#&",
      prefixModes: "ov",
      prefixSymbols: "@+",
      channelModeGroups: ["b", "k", "l", "imnt"],
      capabilities: {},
    },
  });
  session.emit({
    type: "state",
    phase: "ready",
    nick: "newcomer",
    secure: true,
    authenticated: false,
  });
  session.emit({
    type: "membership",
    channel: "#welcome",
    change: { kind: "join", nick: "newcomer", prefixes: [] },
  });
  await settle();
  const view = (name: string) => app.state.getSnapshot().conversations.find((c) => c.name === name);
  const conversationId = view("#welcome")!.id;
  const nicks = (id: ConversationId = conversationId) =>
    value(app.timeline(id))
      .getSnapshot()
      .members.map((m) => m.nick)
      .sort();
  const emit = async (payload: SessionPayload) => {
    session.emit(payload);
    await settle();
  };
  const join = (nick: string, channel = "#welcome") =>
    emit({ type: "membership", channel, change: { kind: "join", nick, prefixes: [] } });
  const statusText = () => {
    const status = app.state
      .getSnapshot()
      .conversations.find((c) => c.kind === "status" && c.networkId === networkId);
    return status
      ? value(app.timeline(status.id))
          .getSnapshot()
          .messages.map((m) => m.text)
      : [];
  };
  return { ...h, app, session, conversationId, view, nicks, emit, join, statusText };
}

describe("session events: membership, nick and quit", () => {
  it("being kicked or parting leaves a visible, not-joined channel with an empty member list", async () => {
    const h = await connected();
    await h.join("guide");
    await h.join("other");
    expect(h.nicks()).toEqual(["guide", "newcomer", "other"]);
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "remove", nick: "newcomer", reason: "kicked by guide" },
    });
    expect(h.view("#welcome")).toMatchObject({ joined: false });
    expect(h.nicks()).toEqual([]);
  });
  it("rejoining after removal restores joined state", async () => {
    const h = await connected();
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "remove", nick: "newcomer", reason: "" },
    });
    await h.join("newcomer");
    expect(h.view("#welcome")).toMatchObject({ joined: true });
    expect(h.nicks()).toEqual(["newcomer"]);
  });
  it("another member leaving only removes that member", async () => {
    const h = await connected();
    await h.join("guide");
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "remove", nick: "GUIDE", reason: "bye" },
    });
    expect(h.nicks()).toEqual(["newcomer"]);
    expect(h.view("#welcome")).toMatchObject({ joined: true });
  });
  it("prefix changes update the member without duplicating it", async () => {
    const h = await connected();
    await h.join("guide");
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "prefixes", nick: "guide", prefixes: ["@"] },
    });
    const members = value(h.app.timeline(h.conversationId)).getSnapshot().members;
    expect(members.filter((m) => m.nick === "guide")).toEqual([
      expect.objectContaining({ prefixes: ["@"] }),
    ]);
  });
  it("own and other nick changes update members everywhere and direct conversations", async () => {
    const h = await connected();
    await h.join("guide");
    await h.join("guide", "#other");
    await h.emit({
      type: "chat",
      message: {
        target: "newcomer",
        sender: { nick: "guide" },
        kind: "text",
        text: "psst",
        receivedAt: 1_700_000_002_000,
        source: "live",
      },
    });
    expect(h.view("guide")).toMatchObject({ kind: "direct" });
    await h.emit({ type: "nick", previous: "guide", next: "mentor" });
    expect(h.nicks()).toEqual(["mentor", "newcomer"]);
    expect(h.nicks(h.view("#other")!.id)).toEqual(["mentor"]);
    expect(h.view("guide")).toBeUndefined();
    expect(h.view("mentor")).toMatchObject({ kind: "direct" });
    await h.emit({ type: "nick", previous: "newcomer", next: "student" });
    expect(h.app.state.getSnapshot().networks[0]?.nick).toBe("student");
    expect(h.nicks()).toEqual(["mentor", "student"]);
  });
  it("renaming onto a nickname that already has a DM keeps one conversation per name", async () => {
    const h = await connected();
    const dm = (nick: string, text: string) =>
      h.emit({
        type: "chat",
        message: {
          target: "newcomer",
          sender: { nick },
          kind: "text",
          text,
          receivedAt: 1_700_000_002_000,
          source: "live",
        },
      });
    await dm("guide", "from guide");
    await dm("mentor", "from mentor");
    const mentor = h.view("mentor")!.id;
    await h.emit({ type: "nick", previous: "guide", next: "Mentor" });
    const names = h.app.state
      .getSnapshot()
      .conversations.filter((c) => c.kind === "direct")
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["guide", "mentor"]);
    // New messages from the renamed person land in the existing conversation.
    await dm("Mentor", "after rename");
    expect(
      value(h.app.timeline(mentor))
        .getSnapshot()
        .messages.map((m) => m.text),
    ).toContain("after rename");
  });
  it("quit removes the user from every channel and clears their typing state", async () => {
    const h = await connected();
    await h.join("guide");
    await h.join("guide", "#other");
    await h.emit({ type: "typing", target: "#welcome", nick: "guide", active: true });
    await h.emit({ type: "quit", nick: "guide", reason: "Ping timeout" });
    expect(h.nicks()).toEqual(["newcomer"]);
    expect(h.nicks(h.view("#other")!.id)).toEqual([]);
    expect(value(h.app.timeline(h.conversationId)).getSnapshot().typing).toEqual([]);
    // A later unknown quit is harmless.
    await h.emit({ type: "quit", nick: "ghost", reason: "" });
    expect(h.nicks()).toEqual(["newcomer"]);
  });
  it("away and account changes reach members while keeping prefixes", async () => {
    const h = await connected();
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "join", nick: "guide", prefixes: ["@"] },
    });
    await h.emit({ type: "away", nick: "guide", away: true });
    await h.emit({ type: "account", nick: "guide", account: "gd" });
    const guide = value(h.app.timeline(h.conversationId))
      .getSnapshot()
      .members.find((m) => m.nick === "guide")!;
    expect(guide).toMatchObject({ away: true, account: "gd", prefixes: ["@"] });
    await h.emit({ type: "account", nick: "guide", account: null });
    const cleared = value(h.app.timeline(h.conversationId))
      .getSnapshot()
      .members.find((m) => m.nick === "guide")!;
    expect(cleared.account).toBeUndefined();
  });
  it("topic updates the conversation and creates unknown channels", async () => {
    const h = await connected();
    await h.emit({ type: "topic", channel: "#welcome", text: "Be kind\u001b[31m" });
    expect(h.view("#welcome")?.topic).toBe("Be kind");
    await h.emit({ type: "topic", channel: "#new", text: "fresh" });
    expect(h.view("#new")?.topic).toBe("fresh");
  });
});

describe("session events: notices and errors", () => {
  it("server notices are shown in the network status conversation", async () => {
    const h = await connected();
    await h.emit({ type: "notice", text: "*** Looking up your hostname\u0007" });
    expect(h.statusText()).toEqual(["*** Looking up your hostname"]);
  });
  it("errors without an operation are reported and land in the status conversation", async () => {
    const h = await connected();
    await h.emit({
      type: "error",
      error: { code: "invalid-input", message: "No such nick/channel", retryable: false },
    });
    expect(h.statusText()).toContain("No such nick/channel");
    expect(h.app.state.getSnapshot().networks[0]?.lastError?.message).toBe("No such nick/channel");
  });
  // The session reports server rejections as "unavailable" and always ends a dropped link
  // with a "network" error, so the error just before disconnecting decides whether to retry.
  it("a rejected command followed by a dropped link still reconnects", async () => {
    const h = await connected();
    await h.emit({
      type: "error",
      error: { code: "unavailable", message: "No such nickname or channel.", retryable: true },
    });
    await h.emit({
      type: "error",
      error: { code: "network", message: "Server closed the connection.", retryable: true },
    });
    await h.session.close();
    await settle();
    expect(h.app.state.getSnapshot().networks[0]?.phase).toBe("reconnecting");
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(2);
  });
  it("a terminal nickname conflict stops instead of retrying forever", async () => {
    const h = await connected();
    await h.emit({
      type: "error",
      error: {
        code: "conflict",
        message: "Every configured nickname was rejected.",
        retryable: false,
      },
    });
    await h.session.close();
    await settle();
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(1);
    expect(h.app.state.getSnapshot().networks[0]?.phase).toBe("disconnected");
  });
  it("an authentication error still stops reconnecting", async () => {
    const h = await connected();
    await h.emit({
      type: "error",
      error: { code: "authentication", message: "Sign in failed", retryable: false },
    });
    await h.session.close();
    await settle();
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(1);
    expect(h.app.state.getSnapshot().networks[0]?.phase).toBe("disconnected");
  });
  it("an operation-scoped error fails the matching send visibly", async () => {
    const h = await connected();
    value(
      await h.app.dispatch(
        {
          type: "message.send",
          conversationId: h.conversationId,
          text: "hello",
          kind: "text",
        },
        signal(),
      ),
    );
    const sent = h.session.commands.find((c) => c.command.type === "send")!;
    await h.emit({
      type: "error",
      operationId: sent.operationId as OperationId,
      error: { code: "unavailable", message: "Cannot send to channel", retryable: false },
    });
    const messages = value(h.app.timeline(h.conversationId)).getSnapshot().messages;
    expect(messages.find((m) => m.text === "hello")?.sendState).toBe("failed");
    expect(h.statusText()).toContain("Cannot send to channel");
  });
});

describe("user actions and discovery", () => {
  const dispatch = (h: Awaited<ReturnType<typeof connected>>, action: AppAction) =>
    h.app.dispatch(action, signal());
  it("validates join/query input and activates the new conversation", async () => {
    const h = await connected();
    for (const channel of ["welcome", "#bad name", "#a,b", `#${"x".repeat(201)}`])
      expect(await dispatch(h, { type: "conversation.join", networkId, channel })).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    for (const nick of ["", "two words", "a,b"])
      expect(await dispatch(h, { type: "conversation.query", networkId, nick })).toMatchObject({
        ok: false,
        error: { code: "invalid-input" },
      });
    value(await dispatch(h, { type: "conversation.join", networkId, channel: "#new" }));
    expect(h.session.commands.at(-1)?.command).toEqual({ type: "join", channel: "#new" });
    expect(h.app.state.getSnapshot().activeConversationId).toBe(h.view("#new")!.id);
    value(await dispatch(h, { type: "conversation.query", networkId, nick: "friend" }));
    expect(h.view("friend")).toMatchObject({ kind: "direct" });
  });
  it("closing a joined channel parts it, but a kicked channel closes without a PART", async () => {
    const h = await connected();
    await h.join("guide", "#kicked");
    await h.join("newcomer", "#kicked");
    await h.emit({
      type: "membership",
      channel: "#kicked",
      change: { kind: "remove", nick: "newcomer", reason: "kicked" },
    });
    const parts = () => h.session.commands.filter((c) => c.command.type === "part");
    value(await dispatch(h, { type: "conversation.close", conversationId: h.view("#kicked")!.id }));
    expect(parts()).toHaveLength(0);
    value(await dispatch(h, { type: "conversation.close", conversationId: h.conversationId }));
    expect(parts()).toHaveLength(1);
    expect(h.view("#welcome")).toBeUndefined();
  });
  it("rejects sending to a channel after being removed from it", async () => {
    const h = await connected();
    await h.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "remove", nick: "newcomer", reason: "kicked" },
    });
    expect(
      await dispatch(h, {
        type: "message.send",
        conversationId: h.conversationId,
        text: "hi",
        kind: "text",
      }),
    ).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("mutes a conversation and keeps drafts bounded", async () => {
    const h = await connected();
    value(
      await dispatch(h, {
        type: "conversation.mute",
        conversationId: h.conversationId,
        muted: true,
      }),
    );
    expect(h.view("#welcome")?.muted).toBe(true);
    value(await dispatch(h, { type: "draft.set", conversationId: h.conversationId, text: "wip" }));
    expect(value(h.app.timeline(h.conversationId)).getSnapshot().draft).toBe("wip");
    expect(
      await dispatch(h, {
        type: "draft.set",
        conversationId: h.conversationId,
        text: "x".repeat(100_000),
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
  it("LIST fills the directory, ignores stale operations and reports failures", async () => {
    const h = await connected();
    const read = value(h.app.discovery(networkId));
    value(await dispatch(h, { type: "irc.request", networkId, command: { type: "list" } }));
    const op = h.session.commands.at(-1)!.operationId as OperationId;
    expect(read.getSnapshot().directory.state).toBe("loading");
    await h.emit({
      type: "directory-item",
      operationId: "stale" as OperationId,
      item: { channel: "#stale", userCount: 1, topic: "" },
    });
    await h.emit({
      type: "directory-item",
      operationId: op,
      item: { channel: "#fun\u001b", userCount: 42, topic: "hi\u0007" },
    });
    await h.emit({ type: "directory-complete", operationId: op });
    expect(read.getSnapshot().directory).toMatchObject({
      state: "ready",
      items: [{ channel: "#fun", userCount: 42, topic: "hi" }],
    });
    value(await dispatch(h, { type: "irc.request", networkId, command: { type: "list" } }));
    const second = h.session.commands.at(-1)!.operationId as OperationId;
    await h.emit({
      type: "error",
      operationId: second,
      error: { code: "rate-limited", message: "LIST throttled", retryable: true },
    });
    expect(read.getSnapshot().directory).toMatchObject({
      state: "failed",
      error: { message: "LIST throttled" },
    });
  });
  it("WHOIS publishes details for the latest request only and reports failure", async () => {
    const h = await connected();
    const read = value(h.app.discovery(networkId));
    const whois = (nick: string) =>
      dispatch(h, { type: "irc.request", networkId, command: { type: "whois", nick } });
    const lastOperation = () => h.session.commands.at(-1)!.operationId as OperationId;
    value(await whois("a"));
    const first = lastOperation();
    value(await whois("b"));
    const second = lastOperation();
    await h.emit({
      type: "user-details",
      operationId: first,
      details: { nick: "a", channels: [] },
    });
    expect(read.getSnapshot().user.state).toBe("loading");
    await h.emit({
      type: "user-details",
      operationId: second,
      details: { nick: "b", channels: ["#welcome"] },
    });
    expect(read.getSnapshot().user).toMatchObject({ state: "ready", details: { nick: "b" } });
    value(await whois("c"));
    await h.emit({
      type: "error",
      operationId: lastOperation(),
      error: { code: "invalid-input", message: "No such nick", retryable: false },
    });
    expect(read.getSnapshot().user).toMatchObject({ state: "failed" });
    expect(h.app.discovery("missing" as NetworkId)).toMatchObject({ ok: false });
  });
  it("timeline of an unknown conversation is unavailable", async () => {
    const h = await connected();
    expect(h.app.timeline("nope" as ConversationId)).toMatchObject({ ok: false });
  });
  it("typing indicators expire on their own", async () => {
    const h = await connected();
    await h.join("guide");
    await h.emit({ type: "typing", target: "#welcome", nick: "guide", active: true });
    expect(value(h.app.timeline(h.conversationId)).getSnapshot().typing).toHaveLength(1);
    h.advance(11_000);
    await settle();
    expect(value(h.app.timeline(h.conversationId)).getSnapshot().typing).toEqual([]);
  });
  it("an unresolved echo-message send becomes uncertain after a timeout", async () => {
    const h = await connected();
    // Re-announce support with echo-message so a written send awaits its echo.
    await h.emit({
      type: "support",
      features: appSnapshot.networks[0]!.features,
      support: {
        casemapping: "rfc1459",
        channelTypes: "#&",
        prefixModes: "ov",
        prefixSymbols: "@+",
        channelModeGroups: ["b", "k", "l", "imnt"],
        capabilities: { "echo-message": null },
      },
    });
    value(
      await dispatch(h, {
        type: "message.send",
        conversationId: h.conversationId,
        text: "anyone?",
        kind: "text",
      }),
    );
    const op = h.session.commands.find((c) => c.command.type === "send")!.operationId;
    await h.emit({ type: "send-state", operationId: op as OperationId, state: "written" });
    const state = () =>
      value(h.app.timeline(h.conversationId))
        .getSnapshot()
        .messages.find((m) => m.text === "anyone?")?.sendState;
    expect(state()).toBe("written");
    h.advance(31_000);
    await settle();
    expect(state()).toBe("uncertain");
  });
  it("failed desktop notifications are reported without breaking chat", async () => {
    const h = await connected();
    h.deps.notifications.notify = async () => ({
      ok: false,
      error: { code: "unavailable", message: "no daemon", retryable: false },
    });
    await h.emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "guide" },
        kind: "text",
        text: "hey newcomer",
        receivedAt: 1_700_000_002_000,
        source: "live",
      },
    });
    h.advance(5_000);
    await settle();
    expect(value(h.app.timeline(h.conversationId)).getSnapshot().messages).toHaveLength(1);
  });
  it("refuses SASL profiles over plaintext endpoints", async () => {
    const h = await connected();
    const user = h.app.settings.getSnapshot()!.user;
    const network = user.networks[0]!;
    const result = await h.app.saveSettings(
      {
        section: "user",
        value: {
          ...user,
          networks: [
            {
              ...network,
              endpoints: [{ host: "irc.example.org", port: 6667, tls: false }],
              sasl: {
                mechanism: "PLAIN",
                account: "me",
                password: entityId<"secret-ref">("env:PW"),
                required: true,
              },
            },
          ],
        },
      },
      h.app.settings.getSnapshot()!.revision,
      signal(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });
});
