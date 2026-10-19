import { afterEach, describe, expect, it } from "vitest";
import type { AppApi } from "../../src/contracts/app";
import { entityId, type ConversationId, type Result } from "../../src/contracts/common";
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
async function setup(config = settings) {
  const h = harness(config);
  const app = value(await createApp(h.deps, signal()));
  apps.push(app);
  return { ...h, app, harness: h };
}
async function connected(config = settings) {
  const h = await setup(config);
  value(await h.app.dispatch({ type: "network.connect", networkId }, signal()));
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
  const conversation = h.app.state.getSnapshot().conversations.find((c) => c.name === "#welcome")!;
  value(
    await h.app.dispatch(
      { type: "conversation.activate", conversationId: conversation.id },
      signal(),
    ),
  );
  return { ...h, session, conversationId: conversation.id };
}
const chat = (
  text: string,
  serverId: string,
  source: "live" | "playback" = "live",
): SessionPayload => ({
  type: "chat",
  message: {
    target: "#welcome",
    sender: { nick: "guide" },
    kind: "text",
    text,
    receivedAt: 1_700_000_002_000,
    serverId,
    source,
  },
});
function timeline(app: AppApi, id: ConversationId) {
  return value(app.timeline(id)).getSnapshot();
}

const historySupport: SessionPayload = {
  type: "support",
  features: { ...appSnapshot.networks[0]!.features, history: true },
  support: {
    casemapping: "rfc1459",
    channelTypes: "#&",
    prefixModes: "ov",
    prefixSymbols: "@+",
    channelModeGroups: ["b", "k", "l", "imnt"],
    capabilities: { "draft/chathistory": null, batch: null, "server-time": null },
  },
};
describe("application coordinator", () => {
  it("serializes automatic history for joined channels and advances after completion or failure", async () => {
    const h = await connected();
    h.session.emit(historySupport);
    for (const channel of ["#one", "#two", "#three"])
      h.session.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    await settle();
    const requests = () => h.session.commands.filter((entry) => entry.command.type === "history");
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.command).toMatchObject({ target: "#one" });
    h.session.emit({
      type: "history-complete",
      operationId: entityId<"operation">("unrelated"),
      target: "#one",
      hasMore: false,
    });
    await settle();
    expect(requests()).toHaveLength(1);
    h.session.emit({
      type: "history-complete",
      operationId: entityId<"operation">(requests()[0]!.operationId),
      target: "#one",
      hasMore: false,
    });
    await settle();
    expect(requests()).toHaveLength(2);
    expect(requests()[1]?.command).toMatchObject({ target: "#two" });
    h.session.emit({
      type: "error",
      operationId: entityId<"operation">(requests()[1]!.operationId),
      error: { code: "unavailable", message: "Synthetic history timeout", retryable: true },
    });
    await settle();
    expect(requests()).toHaveLength(3);
    expect(requests()[2]?.command).toMatchObject({ target: "#three" });
  });
  it("automatic history waits for manual history and skips channels closed while queued", async () => {
    const h = await connected();
    h.session.emit(historySupport);
    await settle();
    const manual = value(
      await h.app.dispatch(
        { type: "history.load-older", conversationId: h.conversationId },
        signal(),
      ),
    );
    for (const channel of ["#closed", "#next"])
      h.session.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    await settle();
    const requests = () => h.session.commands.filter((entry) => entry.command.type === "history");
    expect(requests()).toHaveLength(1);
    const closed = h.app.state.getSnapshot().conversations.find((c) => c.name === "#closed")!;
    value(
      await h.app.dispatch({ type: "conversation.close", conversationId: closed.id }, signal()),
    );
    h.session.emit({
      type: "history-complete",
      operationId: manual.operationId,
      target: "#welcome",
      hasMore: false,
    });
    await settle();
    expect(requests()).toHaveLength(2);
    expect(requests()[1]?.command).toMatchObject({ target: "#next" });
  });
  it("a replacement session discards the old history queue and ignores its completions", async () => {
    const h = await connected();
    h.session.emit(historySupport);
    for (const channel of ["#first", "#queued"])
      h.session.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    await settle();
    const old = h.session.commands.find((entry) => entry.command.type === "history")!;
    value(await h.app.dispatch({ type: "network.reconnect", networkId }, signal()));
    await settle();
    const next = h.harness.session(networkId);
    expect(next).not.toBe(h.session);
    next.emit(historySupport);
    next.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    for (const channel of ["#queued", "#third"])
      next.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    await settle();
    const requests = () => next.commands.filter((entry) => entry.command.type === "history");
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.command).toMatchObject({ target: "#queued" });
    next.emit(
      {
        type: "history-complete",
        operationId: entityId<"operation">(old.operationId),
        target: "#first",
        hasMore: false,
      },
      { generation: h.session.identity.generation },
    );
    await settle();
    expect(requests()).toHaveLength(1);
    value(await h.app.dispatch({ type: "network.disconnect", networkId }, signal()));
    expect(requests()).toHaveLength(1);
  });
  it("boots without network effects and cleans up once", async () => {
    const h = await setup();
    expect(h.sessions).toHaveLength(0);
    expect(h.app.state.getSnapshot().boot).toBe("ready");
    expect(h.app.state.getSnapshot().conversations[0]?.kind).toBe("status");
    await h.app.shutdown();
    await h.app.shutdown();
    expect(h.harness.closed).toBe(1);
    expect((await h.app.dispatch({ type: "network.connect", networkId }, signal())).ok).toBe(false);
  });
  it("creates a pending message, merges reliable echo and never duplicates it", async () => {
    const h = await connected();
    const sent = value(
      await h.app.dispatch(
        { type: "message.send", conversationId: h.conversationId, text: "hello", kind: "text" },
        signal(),
      ),
    );
    expect(timeline(h.app, h.conversationId).messages.at(-1)?.sendState).toBe("pending");
    h.session.emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "newcomer" },
        text: "hello",
        kind: "text",
        receivedAt: 1_700_000_002_000,
        source: "live",
        operationId: sent.operationId,
        serverId: "echo-1",
      },
    });
    await settle();
    const messages = timeline(h.app, h.conversationId).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe(sent.messageId);
    expect(messages[0]?.sendState).toBe("echo-observed");
    expect(h.app.operations.getSnapshot().find((o) => o.id === sent.operationId)?.state).toBe(
      "completed",
    );
  });
  it("preserves same-text messages, deduplicates server identity and strips escapes", async () => {
    const h = await connected();
    h.session.emit(chat("newcomer: \u001b[31mhello\u001b[0m", "a"));
    h.session.emit(chat("newcomer: hello", "a"));
    h.session.emit(chat("newcomer: hello", "b"));
    await settle();
    expect(timeline(h.app, h.conversationId).messages.map((m) => m.text)).toEqual([
      "newcomer: hello",
      "newcomer: hello",
    ]);
    expect(
      h.app.state.getSnapshot().conversations.find((c) => c.id === h.conversationId)?.mentionCount,
    ).toBe(2);
    const last = timeline(h.app, h.conversationId).messages.at(-1)!;
    value(
      await h.app.dispatch(
        {
          type: "view.report",
          conversationId: h.conversationId,
          focused: true,
          atBottom: false,
          lastVisibleMessageId: last.id,
        },
        signal(),
      ),
    );
    expect(
      h.app.state.getSnapshot().conversations.find((c) => c.id === h.conversationId)?.unreadCount,
    ).toBe(2);
    value(
      await h.app.dispatch(
        {
          type: "view.report",
          conversationId: h.conversationId,
          focused: true,
          atBottom: true,
          lastVisibleMessageId: last.id,
        },
        signal(),
      ),
    );
    expect(
      h.app.state.getSnapshot().conversations.find((c) => c.id === h.conversationId)?.unreadCount,
    ).toBe(0);
  });
  it("filters excluded bodies and drafts before persistence", async () => {
    const config = {
      ...settings,
      user: {
        ...settings.user,
        history: {
          ...settings.user.history,
          persistDrafts: true,
          excludedConversations: [{ networkId, kind: "channel" as const, name: "#welcome" }],
        },
      },
    };
    const h = await connected(config);
    h.session.emit(chat("private secret", "private"));
    await settle();
    value(
      await h.app.dispatch(
        { type: "draft.set", conversationId: h.conversationId, text: "private draft" },
        signal(),
      ),
    );
    await h.app.shutdown();
    expect([...h.messages.values()].some((m) => m.text.includes("private"))).toBe(false);
    expect(h.harness.workspace.drafts).toEqual([]);
  });
  it("rejects sends when offline and unsupported modern actions", async () => {
    const h = await connected();
    h.session.emit(chat("plain IRC", "plain"));
    await settle();
    const message = timeline(h.app, h.conversationId).messages[0]!;
    const reaction = await h.app.dispatch(
      { type: "message.react", messageId: message.id, value: "👍", remove: false },
      signal(),
    );
    expect(reaction.ok).toBe(false);
    value(await h.app.dispatch({ type: "network.disconnect", networkId }, signal()));
    expect(
      (
        await h.app.dispatch(
          { type: "message.send", conversationId: h.conversationId, text: "offline", kind: "text" },
          signal(),
        )
      ).ok,
    ).toBe(false);
  });
  it("makes unresolved sends uncertain and does not retry after manual disconnect", async () => {
    const h = await connected();
    const sent = value(
      await h.app.dispatch(
        {
          type: "message.send",
          conversationId: h.conversationId,
          text: "maybe sent",
          kind: "text",
        },
        signal(),
      ),
    );
    h.session.emit({ type: "send-state", operationId: sent.operationId, state: "written" });
    await settle();
    value(await h.app.dispatch({ type: "network.disconnect", networkId }, signal()));
    expect(timeline(h.app, h.conversationId).messages.at(-1)?.sendState).toBe("uncertain");
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(1);
  });
  it("retries transient EOF but not authentication failures", async () => {
    const h = await connected();
    await h.session.close();
    await settle();
    expect(h.app.state.getSnapshot().networks[0]?.phase).toBe("reconnecting");
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(2);
    const next = h.harness.session(networkId);
    next.emit({
      type: "error",
      error: { code: "authentication", message: "Sign in failed", retryable: false },
    });
    await next.close();
    await settle();
    h.advance(60000);
    await settle();
    expect(h.sessions).toHaveLength(2);
    expect(h.app.state.getSnapshot().networks[0]?.phase).toBe("disconnected");
  });
  it("rejects stale generation events on a replacement session", async () => {
    const h = await connected();
    value(await h.app.dispatch({ type: "network.reconnect", networkId }, signal()));
    await settle();
    const next = h.harness.session(networkId);
    next.emit(chat("stale", "stale"), { generation: 1 });
    await settle();
    expect(timeline(h.app, h.conversationId).messages.some((m) => m.text === "stale")).toBe(false);
  });
  it("keeps historical windows stable during live traffic and returns to latest explicitly", async () => {
    const h = await connected();
    h.session.emit(chat("older message", "old"));
    await settle();
    const old = timeline(h.app, h.conversationId).messages[0]!;
    value(await h.app.dispatch({ type: "history.reveal", messageId: old.id }, signal()));
    expect(timeline(h.app, h.conversationId).atLatest).toBe(false);
    h.session.emit(chat("new live message", "new"));
    await settle();
    expect(timeline(h.app, h.conversationId).messages).toHaveLength(1);
    value(
      await h.app.dispatch({ type: "history.latest", conversationId: h.conversationId }, signal()),
    );
    expect(timeline(h.app, h.conversationId).atLatest).toBe(true);
    expect(timeline(h.app, h.conversationId).messages).toHaveLength(2);
  });
  it("does not publish a sidebar update for repeated view reports or identical drafts", async () => {
    const h = await connected();
    let changes = 0;
    const stop = h.app.state.subscribe(() => {
      changes++;
    });
    const ops = h.app.operations.getSnapshot();
    value(
      await h.app.dispatch(
        { type: "view.report", conversationId: h.conversationId, focused: true, atBottom: true },
        signal(),
      ),
    );
    value(
      await h.app.dispatch(
        { type: "draft.set", conversationId: h.conversationId, text: "draft" },
        signal(),
      ),
    );
    const before = timeline(h.app, h.conversationId);
    value(
      await h.app.dispatch(
        { type: "draft.set", conversationId: h.conversationId, text: "draft" },
        signal(),
      ),
    );
    expect(timeline(h.app, h.conversationId)).toBe(before);
    expect(changes).toBe(0);
    expect(h.app.operations.getSnapshot()).toBe(ops);
    stop();
  });
  it("does not reopen a closed channel when its PART acknowledgment arrives", async () => {
    const h = await connected();
    value(
      await h.app.dispatch(
        { type: "conversation.close", conversationId: h.conversationId },
        signal(),
      ),
    );
    h.session.emit({
      type: "membership",
      channel: "#welcome",
      change: { kind: "remove", nick: "newcomer", reason: "left" },
    });
    await settle();
    expect(h.app.state.getSnapshot().conversations.some((c) => c.id === h.conversationId)).toBe(
      false,
    );
  });
  it("keeps nickname-addressed DM history while distinguishing recycled sender identities", async () => {
    const h = await connected();
    const direct = (serverId: string): SessionPayload => ({
      type: "chat",
      message: {
        target: "newcomer",
        sender: { nick: "peer" },
        kind: "text",
        text: "hello",
        receivedAt: 1_700_000_002_000,
        serverId,
        source: "live",
      },
    });
    h.session.emit(direct("first-peer"));
    await settle();
    const first = h.app.state
      .getSnapshot()
      .conversations.find((c) => c.kind === "direct" && c.name === "peer")!;
    h.session.emit({ type: "quit", nick: "peer", reason: "left" });
    h.session.emit(direct("recycled-peer"));
    await settle();
    const second = h.app.state
      .getSnapshot()
      .conversations.find((c) => c.kind === "direct" && c.name === "peer")!;
    const messages = timeline(h.app, second.id).messages;
    expect(second.id).toBe(first.id); // ADR-008: address history, not a verified-person archive.
    expect(messages).toHaveLength(2);
    expect(messages[0]?.sender.userId).not.toBe(messages[1]?.sender.userId);
  });
  it("reloads externally changed settings only after revision inspection", async () => {
    const h = await setup();
    const before = h.app.settings.getSnapshot()!;
    const external = value(
      await h.deps.settings.save(
        { section: "tui", value: { ...before.tui, theme: "light" } },
        before.revision,
        signal(),
      ),
    );
    expect(h.app.settings.getSnapshot()?.tui.theme).toBe("dark");
    const stale = await h.app.reloadSettings(before.revision, before.revision, signal());
    expect(stale.ok).toBe(false);
    expect(h.app.settings.getSnapshot()?.tui.theme).toBe("dark");
    value(await h.app.reloadSettings(external.revision, before.revision, signal()));
    expect(h.app.settings.getSnapshot()?.revision).toBe(external.revision);
    expect(h.app.settings.getSnapshot()?.tui.theme).toBe("light");
  });
  it("surfaces optimistic settings conflicts without applying changes", async () => {
    const h = await setup();
    const original = h.app.settings.getSnapshot()!;
    const changed = { ...original.tui, theme: "light" as const };
    expect(
      (await h.app.saveSettings({ section: "tui", value: changed }, original.revision, signal()))
        .ok,
    ).toBe(true);
    const conflict = await h.app.saveSettings(
      { section: "tui", value: original.tui },
      original.revision,
      signal(),
    );
    expect(conflict.ok).toBe(false);
    expect(h.app.settings.getSnapshot()?.tui.theme).toBe("light");
  });
  it("fails cancelled boot without leaking history handles", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect((await createApp(h.deps, controller.signal)).ok).toBe(false);
    expect(h.closed).toBe(1);
  });
});
