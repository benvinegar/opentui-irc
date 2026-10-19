import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app";
import type { AppApi } from "../../src/contracts/app";
import { entityId, type ConversationId, type Result } from "../../src/contracts/common";
import type { Message } from "../../src/contracts/model";
import type { SettingsDocument } from "../../src/contracts/settings";
import { networkId, settings } from "../fixtures/scenario";
import { failure, harness, settle, success } from "./harness";

const signal = () => new AbortController().signal;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const apps: AppApi[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
});
async function setup(
  config: SettingsDocument = settings,
  configure?: (h: ReturnType<typeof harness>) => void,
) {
  const h = harness(config);
  configure?.(h);
  const app = value(await createApp(h.deps, signal()));
  apps.push(app);
  value(await app.dispatch({ type: "network.connect", networkId }, signal()));
  await settle();
  const session = h.session(networkId);
  session.emit({
    type: "support",
    features: {
      history: false,
      replies: false,
      reactions: false,
      typing: false,
      readMarkers: true,
      redaction: false,
      multiline: false,
    },
    support: {
      casemapping: "rfc1459",
      channelTypes: "#&",
      prefixModes: "ov",
      prefixSymbols: "@+",
      channelModeGroups: ["b", "k", "l", "imnt"],
      capabilities: { "echo-message": null },
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
  const conversationId = app.state
    .getSnapshot()
    .conversations.find((c) => c.name === "#welcome")!.id;
  value(await app.dispatch({ type: "conversation.activate", conversationId }, signal()));
  const emit = async (serverId: string, time: number, target = "#welcome", nick = "guide") => {
    session.emit({
      type: "chat",
      message: {
        target,
        sender: { nick },
        kind: "text",
        text: `newcomer: ${serverId}`,
        receivedAt: time,
        serverTime: time,
        serverId,
        source: "live",
      },
    });
    await settle();
  };
  return { h, app, session, conversationId, emit };
}
function timeline(app: AppApi, id: ConversationId) {
  return value(app.timeline(id)).getSnapshot();
}
function sidebar(app: AppApi, id: ConversationId) {
  return app.state.getSnapshot().conversations.find((c) => c.id === id)!;
}

describe("app persistence/lifecycle review regressions", () => {
  it("registers first-run status, autojoin, and new query/join metadata before querying pages", async () => {
    const { app, h } = await setup(settings, (h) => {
      const page = h.deps.history.page;
      h.deps.history.page = async (id, options, signal) =>
        h.records.has(id)
          ? page(id, options, signal)
          : failure("unavailable", "Conversation is not registered.");
      const save = h.deps.history.saveWorkspace;
      h.deps.history.saveWorkspace = async (workspace, signal) =>
        workspace.conversationOrder.every((id) => h.records.has(id))
          ? save(workspace, signal)
          : failure("unavailable");
    });
    expect(app.state.getSnapshot().error).toBeUndefined();
    value(await app.dispatch({ type: "conversation.query", networkId, nick: "peer" }, signal()));
    value(
      await app.dispatch({ type: "conversation.join", networkId, channel: "#fresh" }, signal()),
    );
    expect(app.state.getSnapshot().error).toBeUndefined();
    expect([...h.records.values()].map((c) => c.name)).toEqual(
      expect.arrayContaining(["Local test network", "#welcome", "peer", "#fresh"]),
    );
  });

  it("does not turn an active pending send uncertain when returning to latest", async () => {
    const { app, conversationId } = await setup();
    const sent = value(
      await app.dispatch(
        { type: "message.send", conversationId, text: "sending", kind: "text" },
        signal(),
      ),
    );
    value(await app.dispatch({ type: "history.latest", conversationId }, signal()));
    expect(
      timeline(app, conversationId).messages.find((m) => m.id === sent.messageId)?.sendState,
    ).toBe("pending");
  });

  it("deduplicates live IDs held in recent cache while an older window is shown without logging", async () => {
    const config = {
      ...settings,
      user: { ...settings.user, history: { ...settings.user.history, enabled: false } },
    };
    const { app, h, conversationId, emit } = await setup(config);
    await emit("old", 10);
    const old = timeline(app, conversationId).messages[0]!;
    h.deps.history.context = async () => success([old]);
    value(await app.dispatch({ type: "history.reveal", messageId: old.id }, signal()));
    await emit("new", 20);
    await emit("new", 20);
    value(await app.dispatch({ type: "history.latest", conversationId }, signal()));
    expect(timeline(app, conversationId).messages.filter((m) => m.serverId === "new")).toHaveLength(
      1,
    );
    expect(sidebar(app, conversationId).unreadCount).toBe(2);
  });

  it("does not mark received messages read until a new visible-message report", async () => {
    const { app, h, conversationId, emit } = await setup();
    value(
      await app.dispatch(
        { type: "view.report", conversationId, focused: true, atBottom: true },
        signal(),
      ),
    );
    await emit("not-yet-rendered", 10);
    expect(sidebar(app, conversationId).unreadCount).toBe(1);
    expect(h.readPositions.has(conversationId)).toBe(false);
    const message = timeline(app, conversationId).messages[0]!;
    value(
      await app.dispatch(
        {
          type: "view.report",
          conversationId,
          focused: true,
          atBottom: true,
          lastVisibleMessageId: message.id,
        },
        signal(),
      ),
    );
    expect(sidebar(app, conversationId).unreadCount).toBe(0);
  });

  it("remote partial read markers preserve newer unread and never echo a marker back", async () => {
    const { app, session, conversationId, emit } = await setup();
    await emit("first", 10);
    await emit("second", 20);
    session.emit({ type: "read-marker", target: "#welcome", serverTime: 10 });
    await settle();
    expect(sidebar(app, conversationId).unreadCount).toBe(1);
    expect(sidebar(app, conversationId).mentionCount).toBe(1);
    expect(timeline(app, conversationId).firstUnreadId).toBe(
      timeline(app, conversationId).messages[1]?.id,
    );
    expect(session.commands.filter((entry) => entry.command.type === "mark-read")).toEqual([]);
  });

  it("keeps closed DM readables inert after incoming traffic reopens the stable conversation", async () => {
    const { app, emit } = await setup();
    await emit("dm-first", 10, "newcomer", "peer");
    const dm = app.state.getSnapshot().conversations.find((c) => c.kind === "direct")!;
    const old = value(app.timeline(dm.id));
    let changes = 0;
    old.subscribe(() => {
      changes++;
    });
    value(await app.dispatch({ type: "conversation.close", conversationId: dm.id }, signal()));
    const atClose = old.getSnapshot();
    const countAtClose = changes;
    await emit("dm-next", 20, "newcomer", "peer");
    expect(app.state.getSnapshot().conversations.find((c) => c.kind === "direct")?.id).toBe(dm.id);
    expect(value(app.timeline(dm.id))).not.toBe(old);
    expect(old.getSnapshot()).toBe(atClose);
    expect(changes).toBe(countAtClose);
    expect(timeline(app, dm.id).messages.some((m) => m.serverId === "dm-next")).toBe(true);
  });

  it("local history deletion clears a persisted draft instead of resurrecting it on shutdown", async () => {
    const config = {
      ...settings,
      user: { ...settings.user, history: { ...settings.user.history, persistDrafts: true } },
    };
    const { app, h, conversationId } = await setup(config);
    value(
      await app.dispatch(
        { type: "draft.set", conversationId, text: "delete this draft" },
        signal(),
      ),
    );
    value(await app.dispatch({ type: "history.delete", conversationId }, signal()));
    expect(timeline(app, conversationId).draft).toBe("");
    await app.shutdown();
    expect(h.workspace.drafts).toEqual([]);
  });

  it("does not claim durable shutdown after losing an incoming write", async () => {
    const { app, h, emit } = await setup();
    const original = h.deps.history.commit;
    h.deps.history.commit = async () => failure("storage");
    await emit("failed-write", 10);
    h.deps.history.commit = original;
    const result = await app.shutdown();
    expect(result.ok ? null : result.error.code).toBe("storage");
    expect(h.closed).toBe(1);
  });

  it("fails boot if the durable conversation registry cannot be committed", async () => {
    const h = harness();
    h.deps.history.commit = async () => failure("storage");
    const result = await createApp(h.deps, signal());
    if (result.ok) apps.push(result.value);
    expect(result.ok ? null : result.error.code).toBe("storage");
    expect(h.closed).toBe(1);
  });

  it("root abort during slow boot closes history once only after initialization unwinds", async () => {
    const h = harness();
    let release!: (value: Result<SettingsDocument>) => void;
    h.deps.settings.load = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const loadConversations = vi.spyOn(h.deps.history, "loadConversations");
    const controller = new AbortController();
    const starting = createApp(h.deps, controller.signal);
    controller.abort();
    await settle();
    expect(h.closed).toBe(0);
    release(success(settings));
    const result = await starting;
    expect(result.ok ? null : result.error.code).toBe("cancelled");
    expect(loadConversations).not.toHaveBeenCalled();
    expect(h.closed).toBe(1);
  });

  it("late channel traffic does not reopen a closed channel or notify old subscribers", async () => {
    const { app, conversationId, emit } = await setup();
    const old = value(app.timeline(conversationId));
    value(await app.dispatch({ type: "conversation.close", conversationId }, signal()));
    const snapshot = old.getSnapshot();
    await emit("part-in-flight", 10);
    expect(app.timeline(conversationId).ok).toBe(false);
    expect(old.getSnapshot()).toBe(snapshot);
  });

  it("does not rejoin an explicitly closed autojoin channel on reconnect", async () => {
    const { app, h, conversationId } = await setup();
    value(await app.dispatch({ type: "conversation.close", conversationId }, signal()));
    value(await app.dispatch({ type: "network.reconnect", networkId }, signal()));
    await settle();
    const next = h.session(networkId);
    next.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await settle();
    expect(next.commands.filter((entry) => entry.command.type === "join")).toEqual([]);
  });

  it("preserves stable local ID when an echo arrives after local history navigation", async () => {
    const { app, session, conversationId } = await setup();
    const sent = value(
      await app.dispatch(
        { type: "message.send", conversationId, text: "echo", kind: "text" },
        signal(),
      ),
    );
    value(await app.dispatch({ type: "history.latest", conversationId }, signal()));
    session.emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "newcomer" },
        text: "echo",
        kind: "text",
        receivedAt: 100,
        serverId: "echo",
        operationId: sent.operationId,
        source: "live",
      },
    });
    await settle();
    const messages = timeline(app, conversationId).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(sent.messageId);
    expect(messages[0]?.sendState).toBe("echo-observed");
  });

  it("does not overwrite another conversation when a scoped server identity collides", async () => {
    const { app, h, conversationId, emit } = await setup();
    await emit("scoped", 10);
    const original = timeline(app, conversationId).messages[0]!;
    await emit("scoped", 20, "newcomer", "peer");
    expect(h.messages.get(original.id)?.conversationId).toBe(conversationId);
    expect(app.state.getSnapshot().error?.code).toBe("conflict");
  });
  it("prunes during long running sessions, adopts retention edits immediately and cancels maintenance on shutdown", async () => {
    const { app, h, conversationId } = await setup();
    const prune = vi.spyOn(h.deps.history, "prune");
    const now = h.deps.clock.now();
    h.messages.set("old", storedMessage("old", conversationId, now));
    h.advance(31 * 86400000);
    await settle();
    expect(h.messages.has("old")).toBe(false);
    expect(prune).toHaveBeenCalledTimes(1);
    h.messages.set(
      "recent",
      storedMessage("recent", conversationId, h.deps.clock.now() - 2 * 86400000),
    );
    const config = app.settings.getSnapshot()!;
    value(
      await app.saveSettings(
        {
          section: "user",
          value: { ...config.user, history: { ...config.user.history, retentionDays: 1 } },
        },
        config.revision,
        signal(),
      ),
    );
    expect(h.messages.has("recent")).toBe(false);
    expect(prune).toHaveBeenCalledTimes(2);
    await app.shutdown();
    h.advance(10 * 86400000);
    await settle();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("restores unread state from loaded durable messages after its saved read position", async () => {
    const h = harness();
    const id = entityId<"conversation">("stored-channel");
    h.records.set(id, { id, networkId, kind: "channel", name: "#stored" });
    const read = storedMessage("a", id, h.deps.clock.now() - 200);
    const unread = storedMessage("b", id, h.deps.clock.now() - 100);
    h.messages.set(read.id, read);
    h.messages.set(unread.id, unread);
    h.readPositions.set(id, { conversationId: id, messageId: read.id, readAt: read.receivedAt });
    value(
      await h.deps.history.saveWorkspace(
        { activeConversationId: id, conversationOrder: [id], mutedConversations: [], drafts: [] },
        signal(),
      ),
    );
    const app = value(await createApp(h.deps, signal()));
    apps.push(app);
    expect(sidebar(app, id).unreadCount).toBe(1);
    expect(timeline(app, id).firstUnreadId).toBe(unread.id);
    value(await app.dispatch({ type: "history.latest", conversationId: id }, signal()));
    expect(sidebar(app, id).unreadCount).toBe(1);
  });

  it("preserves status identity when a network is renamed", async () => {
    const { app, h, session } = await setup();
    const statusId = app.state.getSnapshot().conversations.find((c) => c.kind === "status")!.id;
    const config = app.settings.getSnapshot()!;
    value(
      await app.saveSettings(
        {
          section: "user",
          value: {
            ...config.user,
            networks: config.user.networks.map((p) => ({ ...p, name: "Renamed Network" })),
          },
        },
        config.revision,
        signal(),
      ),
    );
    session.emit({ type: "notice", text: "status after rename" });
    await settle();
    const statuses = app.state.getSnapshot().conversations.filter((c) => c.kind === "status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.id).toBe(statusId);
    expect(h.records.get(statusId)?.name).toBe("Renamed Network");
  });

  it("bounds queued user intents while storage is slow without accepting overflow", async () => {
    const { app, h, conversationId } = await setup();
    let release!: () => void;
    const save = h.deps.history.saveWorkspace;
    h.deps.history.saveWorkspace = async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return save(...args);
    };
    const blocked = app.dispatch({ type: "conversation.activate", conversationId }, signal());
    await settle();
    const queued = Array.from({ length: 255 }, (_, index) =>
      app.dispatch({ type: "draft.set", conversationId, text: `${index}` }, signal()),
    );
    const overflow = await app.dispatch(
      { type: "draft.set", conversationId, text: "overflow" },
      signal(),
    );
    expect(overflow.ok ? null : overflow.error.code).toBe("rate-limited");
    release();
    value(await blocked);
    h.deps.history.saveWorkspace = save;
    await Promise.all(queued);
    expect(timeline(app, conversationId).draft).toBe("254");
  });
});

function storedMessage(id: string, conversationId: ConversationId, time: number): Message {
  return {
    id: entityId(id),
    conversationId,
    networkId,
    sender: { nick: "guide" },
    kind: "text",
    text: id,
    receivedAt: time,
    source: "live",
    reactions: [],
    redacted: false,
  };
}
