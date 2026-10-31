import { afterEach, describe, expect, it, vi } from "vitest";
import { entityId } from "../../src/contracts/common";
import type { IrcSession, SessionIdentity } from "../../src/contracts/session";
import type { Message } from "../../src/contracts/model";
import { networkId, settings, welcomeMessage } from "../fixtures/scenario";
import { allFeatures, boot, connect, protocol, shutdownAll, value } from "./connected";
import { FakeSession, failure, settle, success } from "./harness";

afterEach(shutdownAll);

const stored = (overrides: Partial<Message>): Message => ({
  ...welcomeMessage,
  networkId,
  source: "playback",
  ...overrides,
});

describe("incoming chat enrichment", () => {
  it("keeps account and reply references, and a redacted message stays empty on replay", async () => {
    const c = await connect();
    await c.chat({
      serverId: "s1",
      sender: { nick: "guide", account: "guide-account" },
      replyToServerId: "s0",
      serverTime: 1_700_000_002_500,
      text: "original",
    });
    expect(c.byServerId("s1")).toMatchObject({
      sender: { nick: "guide", account: "guide-account" },
      replyTo: { serverId: "s0" },
      serverTime: 1_700_000_002_500,
      text: "original",
    });
    await c.emit({ type: "redaction", target: "#welcome", serverId: "s1" });
    expect(c.byServerId("s1")).toMatchObject({ redacted: true, text: "", reactions: [] });
    await c.chat({ serverId: "s1", text: "replayed body", source: "playback" });
    expect(c.messages().filter((message) => message.serverId === "s1")).toEqual([
      expect.objectContaining({ redacted: true, text: "" }),
    ]);
    expect(c.h.messages.get(c.byServerId("s1")!.id)?.text).toBe("");
  });

  it("redactions and read markers for unknown targets or messages change nothing", async () => {
    const c = await connect();
    await c.chat({ serverId: "keep", text: "newcomer: still here", serverTime: 1_700_000_003_000 });
    const before = c.messages();
    const unread = c.find("#welcome")!.unreadCount;
    await c.emit({ type: "redaction", target: "#nowhere", serverId: "keep" });
    await c.emit({ type: "redaction", target: "#welcome", serverId: "missing" });
    await c.emit({ type: "read-marker", target: "#nowhere", serverTime: 1_800_000_000_000 });
    await c.emit({ type: "read-marker", target: "#welcome", serverTime: 1_600_000_000_000 });
    expect(c.messages()).toEqual(before);
    expect(unread).toBe(1);
    expect(c.find("#welcome")!.unreadCount).toBe(1);
    expect(c.network().phase).toBe("ready");
  });

  it("routes channel traffic with built-in channel prefixes before server support arrives", async () => {
    const c = await connect({ withoutSupport: true });
    await c.chat({ target: "&local", serverId: "amp", text: "hi" });
    await c.chat({ target: "newcomer", sender: { nick: "Pal" }, serverId: "dm", text: "psst" });
    expect(c.find("&local")).toMatchObject({ kind: "channel" });
    expect(c.find("Pal")).toMatchObject({ kind: "direct", unreadCount: 1, mentionCount: 1 });
  });

  it.each([
    ["chat", { type: "chat" as const }],
    ["reaction", { type: "reaction" as const }],
  ])(
    "a durable %s identity from another conversation is a conflict that stops the session",
    async (_label, kind) => {
      const c = await connect();
      const statusId = c.status().id;
      Object.assign(c.deps.history, {
        findByServerId: async () =>
          success(stored({ id: entityId("foreign"), conversationId: statusId, serverId: "dup" })),
      });
      if (kind.type === "chat") await c.chat({ serverId: "dup" });
      else
        await c.emit({
          type: "reaction",
          target: "#welcome",
          serverId: "dup",
          nick: "guide",
          value: "+1",
          remove: false,
        });
      expect(c.app.state.getSnapshot().error).toMatchObject({ code: "conflict" });
      expect(c.network()).toMatchObject({ phase: "disconnected", lastError: { code: "conflict" } });
      c.h.advance(60_000);
      await settle();
      expect(c.h.sessions).toHaveLength(1);
    },
  );
});

describe("typing indicators", () => {
  it("unknown targets open a DM, refreshes do not duplicate and inactive clears", async () => {
    const c = await connect();
    await c.emit({ type: "typing", target: "Friend", nick: "Friend", active: true });
    const dm = c.find("Friend")!;
    expect(dm.kind).toBe("direct");
    expect(c.timeline(dm.id).typing).toHaveLength(1);
    await c.emit({ type: "typing", target: "#welcome", nick: "guide", active: true });
    await c.emit({ type: "typing", target: "#welcome", nick: "guide", active: true });
    expect(c.timeline(c.conversationId).typing).toHaveLength(1);
    await c.emit({ type: "typing", target: "#welcome", nick: "guide", active: false });
    expect(c.timeline(c.conversationId).typing).toEqual([]);
    c.h.advance(10_000);
    await settle();
    expect(c.timeline(dm.id).typing).toEqual([]);
  });
});

describe("reactions", () => {
  const react = (nick: string, reaction: string, remove = false, serverId = "r1") => ({
    type: "reaction" as const,
    target: "#welcome",
    serverId,
    nick,
    value: reaction,
    remove,
  });

  it("tracks actors, own reactions and removals; unknown removals and targets are ignored", async () => {
    const c = await connect();
    await c.chat({ serverId: "r1" });
    await c.emit(react("guide", "+1"));
    await c.emit(react("newcomer", "+1"));
    expect(c.byServerId("r1")!.reactions).toEqual([{ value: "+1", count: 2, reactedBySelf: true }]);
    await c.emit(react("guide", "+1", true));
    expect(c.byServerId("r1")!.reactions).toEqual([{ value: "+1", count: 1, reactedBySelf: true }]);
    await c.emit(react("newcomer", "+1", true));
    expect(c.byServerId("r1")!.reactions).toEqual([]);
    await c.emit(react("guide", "party", true));
    await c.emit({ ...react("guide", "x"), target: "#nowhere" });
    await c.emit(react("guide", "x", false, "missing"));
    expect(c.byServerId("r1")!.reactions).toEqual([]);
    await c.emit({ type: "redaction", target: "#welcome", serverId: "r1" });
    await c.emit(react("guide", "late"));
    expect(c.byServerId("r1")).toMatchObject({ redacted: true, reactions: [] });
  });

  it("caps distinct reaction values per message and reports the limit", async () => {
    const c = await connect();
    await c.chat({ serverId: "r1" });
    for (let index = 0; index <= 128; index++) await c.emit(react("guide", `v${index}`));
    expect(c.byServerId("r1")!.reactions).toHaveLength(128);
    expect(c.byServerId("r1")!.reactions.some((entry) => entry.value === "v128")).toBe(false);
    expect(c.app.state.getSnapshot().error).toMatchObject({ code: "rate-limited" });
    expect(c.network().phase).toBe("ready");
  });

  it("adjusts durable aggregates only for our own delta and tolerates lookup failures", async () => {
    const c = await connect();
    const old = stored({
      id: entityId("durable"),
      conversationId: c.conversationId,
      serverId: "old",
      reactions: [
        { value: "heart", count: 2, reactedBySelf: false },
        { value: "+1", count: 1, reactedBySelf: true },
      ],
    });
    Object.assign(c.deps.history, { findByServerId: async () => success(old) });
    await c.emit(react("newcomer", "heart", false, "old"));
    const after = c.h.messages.get("durable");
    expect(after?.reactions).toEqual([
      { value: "heart", count: 3, reactedBySelf: true },
      { value: "+1", count: 1, reactedBySelf: true },
    ]);
    await c.emit(react("newcomer", "+1", true, "old"));
    expect(c.h.messages.get("durable")?.reactions).toEqual([
      { value: "heart", count: 3, reactedBySelf: true },
    ]);
    Object.assign(c.deps.history, { findByServerId: async () => failure("storage") });
    await c.emit(react("guide", "+1", false, "elsewhere"));
    expect(c.network().phase).toBe("ready");
  });
});

describe("connection attempts", () => {
  it("a sequence gap abandons the attempt without applying later events", async () => {
    const c = await connect();
    c.session.emit({ type: "notice", text: "stale generation" }, { generation: 99 });
    await c.emit({ type: "notice", text: "after the gap" });
    expect(c.statusText()).not.toContain("after the gap");
    expect(c.statusText()).not.toContain("stale generation");
    expect(c.network().lastError).toMatchObject({
      code: "internal",
      message: expect.stringContaining("Reconnect"),
    });
    value(await c.dispatch({ type: "network.reconnect", networkId }));
    await settle();
    expect(c.h.sessions).toHaveLength(2);
    expect(c.network().phase).toBe("connecting");
  });

  /** Abandons the first attempt either by a sequence gap or by a non-terminal handler failure. */
  const abandon = async (how: "sequence gap" | "handler failure") => {
    const c = await connect();
    if (how === "sequence gap") {
      // The stale event consumes a sequence number, so the next event reveals the gap.
      c.session.emit({ type: "notice", text: "stale generation" }, { generation: 99 });
      await c.emit({ type: "notice", text: "after the gap" });
    } else {
      Object.assign(c.deps.history, {
        findByServerId: async () => {
          throw new Error("private storage detail");
        },
      });
      await c.chat({ serverId: "boom" });
    }
    return c;
  };
  const readyAgain = async (c: Awaited<ReturnType<typeof connect>>) => {
    const next = c.h.session(networkId);
    next.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await settle();
    return next;
  };

  it.each(["sequence gap", "handler failure"] as const)(
    "after a %s the app retries with backoff under a new generation and reconnects",
    async (how) => {
      const c = await abandon(how);
      expect(c.network()).toMatchObject({ phase: "reconnecting", lastError: { code: "internal" } });
      expect(JSON.stringify(c.app.state.getSnapshot())).not.toContain("private storage detail");
      c.h.advance(1_000);
      await settle();
      expect(c.h.sessions).toHaveLength(1);
      c.h.advance(1_000);
      await settle();
      expect(c.h.sessions).toHaveLength(2);
      expect(c.h.session(networkId).identity.generation).toBe(2);
      const next = await readyAgain(c);
      expect(c.network().phase).toBe("ready");
      // Late events from the abandoned generation cannot touch the new attempt.
      c.session.emit({ type: "notice", text: "from the old generation" });
      next.emit({ type: "notice", text: "from the new generation" });
      await settle();
      expect(c.statusText()).toContain("from the new generation");
      expect(c.statusText()).not.toContain("from the old generation");
    },
  );

  it("an abandoned attempt never replays a written send on retry", async () => {
    const c = await connect({ capabilities: { "echo-message": null } });
    const sent = value(
      await c.dispatch({
        type: "message.send",
        conversationId: c.conversationId,
        text: "once only",
        kind: "text",
      }),
    );
    await c.emit({ type: "send-state", operationId: sent.operationId, state: "written" });
    c.session.emit({ type: "notice", text: "gap" }, { generation: 99 });
    await c.emit({ type: "notice", text: "after the gap" });
    c.h.advance(2_000);
    await settle();
    const next = await readyAgain(c);
    expect(c.messages().find((m) => m.id === sent.messageId)?.sendState).toBe("uncertain");
    expect(c.session.commands.map((entry) => entry.command.type)).toContain("send");
    expect(next.commands.map((entry) => entry.command.type)).not.toContain("send");
  });

  it.each([
    [
      "a user disconnect",
      (c: Awaited<ReturnType<typeof connect>>) =>
        c.dispatch({ type: "network.disconnect", networkId }),
    ],
    ["shutdown", (c: Awaited<ReturnType<typeof connect>>) => c.app.shutdown()],
  ])("%s during the backoff cancels the pending retry", async (_label, stop) => {
    const c = await abandon("sequence gap");
    expect(c.network().phase).toBe("reconnecting");
    await stop(c);
    await settle();
    c.h.advance(60_000);
    await settle();
    expect(c.h.sessions).toHaveLength(1);
  });

  it("a manual reconnect during the backoff supersedes the pending retry", async () => {
    const c = await abandon("sequence gap");
    value(await c.dispatch({ type: "network.reconnect", networkId }));
    await settle();
    expect(c.h.sessions).toHaveLength(2);
    c.h.advance(60_000);
    await settle();
    expect(c.h.sessions).toHaveLength(2);
  });

  it("a dropped link fails unwritten sends and makes written ones uncertain", async () => {
    const c = await connect({ capabilities: { "echo-message": null } });
    const send = (text: string) =>
      c.dispatch({ type: "message.send", conversationId: c.conversationId, text, kind: "text" });
    const first = value(await send("one"));
    const second = value(await send("two"));
    await c.emit({ type: "send-state", operationId: second.operationId, state: "written" });
    await c.session.close();
    await settle();
    const state = (id: unknown) => c.messages().find((message) => message.id === id)?.sendState;
    expect(state(first.messageId)).toBe("failed");
    expect(state(second.messageId)).toBe("uncertain");
    expect(c.operation(first.operationId)?.state).toBe("failed");
    expect(c.operation(second.operationId)).toMatchObject({
      state: "failed",
      error: { code: "network" },
    });
    expect(c.network().phase).toBe("reconnecting");
  });

  it("a session factory that throws is reported safely and retried with backoff", async () => {
    let opens = 0;
    const c = await boot({
      configure: (h) =>
        Object.assign(h.deps.sessions, {
          open: async () => {
            opens++;
            throw new Error("private socket detail");
          },
        }),
    });
    value(await c.dispatch({ type: "network.connect", networkId }));
    await settle();
    const network = c.app.state.getSnapshot().networks[0]!;
    expect(network).toMatchObject({ phase: "reconnecting", lastError: { code: "network" } });
    expect(JSON.stringify(c.app.state.getSnapshot())).not.toContain("private socket detail");
    c.h.advance(1_000);
    await settle();
    expect(opens).toBe(1);
    c.h.advance(1_000);
    await settle();
    expect(opens).toBe(2);
  });

  it("a terminal open failure stops without retrying", async () => {
    const c = await boot({
      configure: (h) =>
        Object.assign(h.deps.sessions, {
          open: async () => failure("tls", "Certificate rejected"),
        }),
    });
    value(await c.dispatch({ type: "network.connect", networkId }));
    await settle();
    expect(c.app.state.getSnapshot().networks[0]).toMatchObject({
      phase: "disconnected",
      lastError: { code: "tls" },
    });
  });

  it("a session that opens after being superseded is closed and ignored", async () => {
    const opened: { identity: SessionIdentity; resolve: (session: IrcSession) => void }[] = [];
    const c = await boot({
      configure: (h) =>
        Object.assign(h.deps.sessions, {
          open: (_profile: unknown, identity: SessionIdentity) =>
            new Promise((resolve) =>
              opened.push({ identity, resolve: (session) => resolve(success(session)) }),
            ),
        }),
    });
    value(await c.dispatch({ type: "network.connect", networkId }));
    value(await c.dispatch({ type: "network.reconnect", networkId }));
    await settle();
    expect(opened.map((entry) => entry.identity.generation)).toEqual([1, 2]);
    const stale = new FakeSession(opened[0]!.identity);
    const close = vi.spyOn(stale, "close");
    opened[0]!.resolve(stale);
    await settle();
    expect(close).toHaveBeenCalled();
    expect(c.app.state.getSnapshot().networks[0]!.phase).toBe("connecting");
  });

  it("a failed close during disconnect is reported while the network still goes offline", async () => {
    const c = await connect();
    Object.assign(c.session, { close: async () => failure("network", "Close failed") });
    value(await c.dispatch({ type: "network.disconnect", networkId }));
    expect(c.network()).toMatchObject({ phase: "disconnected", lastError: { code: "network" } });
  });

  it("autojoin keys and explicit join keys are sent on join and remembered for rejoin", async () => {
    const key = entityId<"secret-ref">("env:CHANNEL_KEY");
    const config = structuredClone(settings);
    const profile = config.user.networks[0]!;
    Object.assign(profile, { autoJoin: [{ channel: "#secret", key }] });
    const c = await connect({ config });
    const joins = () =>
      c.session.commands.filter((entry) => entry.command.type === "join").map((e) => e.command);
    expect(joins()).toContainEqual({ type: "join", channel: "#secret", key });
    value(await c.dispatch({ type: "conversation.join", networkId, channel: "#vault", key }));
    expect(joins()).toContainEqual({ type: "join", channel: "#vault", key });
    value(await c.dispatch({ type: "network.reconnect", networkId }));
    await settle();
    const next = c.h.session(networkId);
    next.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await settle();
    const rejoined = next.commands.map((entry) => entry.command);
    expect(rejoined).toContainEqual({ type: "join", channel: "#vault", key });
    expect(rejoined).toContainEqual({ type: "join", channel: "#secret", key });
    expect(rejoined).toContainEqual({ type: "join", channel: "#welcome" });
  });

  it("failed automatic joins are reported without stopping the session", async () => {
    const c = await boot();
    value(await c.dispatch({ type: "network.connect", networkId }));
    await settle();
    const session = c.h.session(networkId);
    session.executeResult = failure("rate-limited", "Slow down");
    session.emit({
      type: "state",
      phase: "ready",
      nick: "newcomer",
      secure: true,
      authenticated: false,
    });
    await settle();
    const network = c.app.state.getSnapshot().networks[0]!;
    expect(network).toMatchObject({ phase: "ready", lastError: { code: "rate-limited" } });
  });
});

describe("server identifier rules", () => {
  async function asciiSession() {
    const c = await connect();
    await c.emit({
      type: "support",
      features: allFeatures,
      support: { ...protocol(), casemapping: "ascii" },
    });
    return c;
  }
  it("a casemapping change that merges two known users is a conflict", async () => {
    const c = await asciiSession();
    for (const nick of ["nick[", "nick{"])
      await c.emit({
        type: "membership",
        channel: "#welcome",
        change: { kind: "join", nick, prefixes: [] },
      });
    await c.emit({ type: "support", features: allFeatures, support: protocol() });
    expect(c.network()).toMatchObject({ phase: "disconnected", lastError: { code: "conflict" } });
  });
  it("a casemapping change that merges two conversations is a conflict", async () => {
    const c = await asciiSession();
    for (const nick of ["pal[", "pal{"])
      value(await c.dispatch({ type: "conversation.query", networkId, nick }));
    await c.emit({ type: "support", features: allFeatures, support: protocol() });
    expect(c.network()).toMatchObject({ phase: "disconnected", lastError: { code: "conflict" } });
  });
});

describe("automatic history", () => {
  it("failed history requests are reported; transport failures stop draining the queue", async () => {
    const c = await connect();
    const historyTargets = () =>
      c.session.commands
        .filter((entry) => entry.command.type === "history")
        .map((entry) => ("target" in entry.command ? entry.command.target : ""));
    const first = c.session.commands.find((entry) => entry.command.type === "history")!;
    expect(historyTargets()).toEqual(["#welcome"]);
    for (const channel of ["#a", "#b"])
      await c.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    c.session.executeResult = failure("internal", "Refused");
    await c.emit({
      type: "history-complete",
      operationId: entityId("unrelated"),
      target: "#welcome",
      hasMore: false,
    });
    expect(historyTargets()).toEqual(["#welcome"]);
    await c.emit({
      type: "history-complete",
      operationId: entityId<"operation">(first.operationId),
      target: "#welcome",
      hasMore: false,
    });
    expect(historyTargets()).toEqual(["#welcome", "#a", "#b"]);
    expect(c.network().lastError).toMatchObject({ code: "internal" });
    c.session.executeResult = failure("network", "Gone");
    for (const channel of ["#c", "#d"])
      await c.emit({
        type: "membership",
        channel,
        change: { kind: "join", nick: "newcomer", prefixes: [] },
      });
    expect(historyTargets()).toEqual(["#welcome", "#a", "#b", "#c", "#d"]);
    expect(c.network().lastError).toMatchObject({ code: "network" });
  });

  it("a network error for the running history request does not start the next one", async () => {
    const c = await connect();
    const first = c.session.commands.find((entry) => entry.command.type === "history")!;
    await c.emit({
      type: "membership",
      channel: "#next",
      change: { kind: "join", nick: "newcomer", prefixes: [] },
    });
    await c.emit({
      type: "error",
      operationId: entityId<"operation">(first.operationId),
      error: { code: "network", message: "History timed out", retryable: true },
    });
    expect(c.session.commands.filter((entry) => entry.command.type === "history")).toHaveLength(1);
    expect(c.statusText()).toContain("History timed out");
  });
});

describe("channel directory", () => {
  it("caps listings at 5000 items and marks the directory truncated", async () => {
    const c = await connect();
    const receipt = value(
      await c.dispatch({ type: "irc.request", networkId, command: { type: "list" } }),
    );
    for (let index = 0; index < 5001; index++)
      await c.emit({
        type: "directory-item",
        operationId: receipt.operationId,
        item: { channel: `#c${index}`, userCount: 1, topic: "" },
      });
    const directory = value(c.app.discovery(networkId)).getSnapshot().directory;
    expect(directory.items).toHaveLength(5000);
    expect(directory.truncated).toBe(true);
  });
});
