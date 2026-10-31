import { afterEach, describe, expect, it } from "vitest";
import { entityId, type Result } from "../../src/contracts/common";
import type { Message } from "../../src/contracts/model";
import { networkId, welcomeMessage } from "../fixtures/scenario";
import { connect, noFeatures, shutdownAll, value } from "./connected";
import { failure, settle, success } from "./harness";

afterEach(shutdownAll);

function code<T>(result: Result<T>) {
  return result.ok ? "ok" : result.error.code;
}

describe("action admission", () => {
  it("an already-aborted dispatch is cancelled without allocating an operation", async () => {
    const c = await connect();
    const before = c.app.operations.getSnapshot().length;
    const controller = new AbortController();
    controller.abort();
    const result = await c.app.dispatch({ type: "network.connect", networkId }, controller.signal);
    expect(code(result)).toBe("cancelled");
    expect(c.app.operations.getSnapshot()).toHaveLength(before);
  });

  it("refuses new operations while 128 deferred ones are still pending", async () => {
    const c = await connect();
    const results = [];
    for (let index = 0; index < 129; index++)
      results.push(await c.dispatch({ type: "irc.request", networkId, command: { type: "list" } }));
    expect(results.slice(0, 128).every((result) => result.ok)).toBe(true);
    expect(results[128]).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    expect(c.app.operations.getSnapshot().filter((op) => op.state === "accepted")).toHaveLength(
      128,
    );
  });

  it("unknown networks and conversations are unavailable", async () => {
    const c = await connect();
    const ghost = entityId<"network">("ghost");
    expect(code(await c.dispatch({ type: "network.connect", networkId: ghost }))).toBe(
      "unavailable",
    );
    expect(
      code(await c.dispatch({ type: "conversation.query", networkId: ghost, nick: "pal" })),
    ).toBe("unavailable");
    expect(
      code(
        await c.dispatch({ type: "conversation.activate", conversationId: entityId("missing") }),
      ),
    ).toBe("unavailable");
  });

  it("connect is idempotent while an attempt is already running", async () => {
    const c = await connect();
    value(await c.dispatch({ type: "network.connect", networkId }));
    await settle();
    expect(c.h.sessions).toHaveLength(1);
    expect(c.network().phase).toBe("ready");
  });

  it("IRC requests need a ready connection", async () => {
    const c = await connect();
    value(await c.dispatch({ type: "network.disconnect", networkId }));
    const result = await c.dispatch({
      type: "irc.request",
      networkId,
      command: { type: "whois", nick: "guide" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

describe("conversation actions", () => {
  it("status conversations cannot be closed or sent to", async () => {
    const c = await connect();
    const statusId = c.status().id;
    expect(code(await c.dispatch({ type: "conversation.close", conversationId: statusId }))).toBe(
      "invalid-input",
    );
    expect(
      code(
        await c.dispatch({
          type: "message.send",
          conversationId: statusId,
          text: "hi",
          kind: "text",
        }),
      ),
    ).toBe("invalid-input");
  });

  it("pending sends block closing and deleting history", async () => {
    const c = await connect({ capabilities: { "echo-message": null } });
    value(
      await c.dispatch({
        type: "message.send",
        conversationId: c.conversationId,
        text: "waiting",
        kind: "text",
      }),
    );
    for (const type of ["conversation.close", "history.delete"] as const)
      expect(await c.dispatch({ type, conversationId: c.conversationId })).toMatchObject({
        ok: false,
        error: { code: "unavailable", message: expect.stringContaining("pending sends") },
      });
    expect(c.find("#welcome")).toBeDefined();
  });

  it("closing the active conversation activates another open one", async () => {
    const c = await connect();
    const dm = value(await c.dispatch({ type: "conversation.query", networkId, nick: "pal" }));
    expect(c.app.state.getSnapshot().activeConversationId).toBe(dm.conversationId);
    value(await c.dispatch({ type: "conversation.close", conversationId: dm.conversationId! }));
    const snapshot = c.app.state.getSnapshot();
    expect(snapshot.conversations.some((item) => item.id === dm.conversationId)).toBe(false);
    expect(snapshot.activeConversationId).toBeDefined();
    expect(snapshot.activeConversationId).not.toBe(dm.conversationId);
    expect(c.app.timeline(dm.conversationId!).ok).toBe(false);
  });

  it.each([
    ["empty", "   "],
    ["carriage return", "a\rb"],
    ["oversized", "x".repeat(65_537)],
  ])("rejects %s message text before any network effect", async (_label, text) => {
    const c = await connect();
    const sent = c.session.commands.length;
    expect(
      code(
        await c.dispatch({
          type: "message.send",
          conversationId: c.conversationId,
          text,
          kind: "text",
        }),
      ),
    ).toBe("invalid-input");
    expect(c.session.commands).toHaveLength(sent);
  });

  it("rejects oversized drafts", async () => {
    const c = await connect();
    expect(
      code(
        await c.dispatch({
          type: "draft.set",
          conversationId: c.conversationId,
          text: "x".repeat(65_537),
        }),
      ),
    ).toBe("invalid-input");
  });
});

describe("replies", () => {
  it("a reply carries the server reference and requires a server ID in the same conversation", async () => {
    const c = await connect();
    await c.chat({ serverId: "parent" });
    const parent = c.byServerId("parent")!;
    const receipt = value(
      await c.dispatch({
        type: "message.send",
        conversationId: c.conversationId,
        text: "agreed",
        kind: "text",
        replyTo: parent.id,
      }),
    );
    expect(c.session.commands.at(-1)!.command).toEqual({
      type: "send",
      target: "#welcome",
      text: "agreed",
      kind: "text",
      replyToServerId: "parent",
    });
    expect(c.messages().find((m) => m.id === receipt.messageId)?.replyTo).toEqual({
      serverId: "parent",
      localId: parent.id,
    });
    await c.chat({ text: "no id" });
    const local = c.messages().find((m) => m.text === "no id")!;
    const dm = value(await c.dispatch({ type: "conversation.query", networkId, nick: "pal" }));
    for (const [conversationId, replyTo] of [
      [c.conversationId, local.id],
      [c.conversationId, entityId<"message">("missing")],
      [dm.conversationId!, parent.id],
    ] as const)
      expect(
        code(
          await c.dispatch({
            type: "message.send",
            conversationId,
            text: "x",
            kind: "text",
            replyTo,
          }),
        ),
      ).toBe("unsupported");
  });

  it("replies are unsupported when the network does not offer them", async () => {
    const c = await connect({ features: noFeatures });
    await c.chat({ serverId: "parent" });
    const result = await c.dispatch({
      type: "message.send",
      conversationId: c.conversationId,
      text: "x",
      kind: "text",
      replyTo: c.byServerId("parent")!.id,
    });
    expect(code(result)).toBe("unsupported");
  });
});

describe("reactions and removal", () => {
  it.each([
    ["empty", ""],
    ["too long", "x".repeat(65)],
    ["whitespace", "two words"],
    ["control", "a\u0001"],
  ])("rejects a %s reaction value", async (_label, reaction) => {
    const c = await connect();
    await c.chat({ serverId: "m" });
    const result = await c.dispatch({
      type: "message.react",
      messageId: c.byServerId("m")!.id,
      value: reaction,
      remove: false,
    });
    expect(code(result)).toBe("unsupported");
  });

  it("valid reactions are sent; removed or unidentified messages cannot be changed", async () => {
    const c = await connect();
    await c.chat({ serverId: "m" });
    const id = c.byServerId("m")!.id;
    value(await c.dispatch({ type: "message.react", messageId: id, value: "+1", remove: true }));
    expect(c.session.commands.at(-1)!.command).toEqual({
      type: "reaction",
      target: "#welcome",
      serverId: "m",
      value: "+1",
      remove: true,
    });
    expect(code(await c.dispatch({ type: "message.redact", messageId: id }))).toBe("invalid-input");
    await c.emit({ type: "redaction", target: "#welcome", serverId: "m" });
    expect(
      code(await c.dispatch({ type: "message.react", messageId: id, value: "+1", remove: false })),
    ).toBe("unsupported");
    await c.chat({ text: "no server id" });
    const local = c.messages().find((m) => m.text === "no server id")!;
    expect(code(await c.dispatch({ type: "message.redact", messageId: local.id }))).toBe(
      "unsupported",
    );
  });

  it("own messages can be removed only where redaction is supported", async () => {
    const supported = await connect();
    await supported.chat({ serverId: "own", sender: { nick: "NewComer" } });
    value(
      await supported.dispatch({
        type: "message.redact",
        messageId: supported.byServerId("own")!.id,
      }),
    );
    expect(supported.session.commands.at(-1)!.command).toEqual({
      type: "redact",
      target: "#welcome",
      serverId: "own",
    });
    const unsupported = await connect({ features: noFeatures });
    await unsupported.chat({ serverId: "own", sender: { nick: "newcomer" } });
    expect(
      code(
        await unsupported.dispatch({
          type: "message.redact",
          messageId: unsupported.byServerId("own")!.id,
        }),
      ),
    ).toBe("unsupported");
  });
});

describe("typing and history actions", () => {
  it("a paused typing stop is forwarded as paused", async () => {
    const c = await connect();
    value(
      await c.dispatch({
        type: "typing.set",
        conversationId: c.conversationId,
        active: false,
        paused: true,
      }),
    );
    expect(c.session.commands.at(-1)!.command).toEqual({
      type: "typing",
      target: "#welcome",
      active: false,
      paused: true,
    });
  });

  it("older pages pass their cursor; storage failures clear the loading flag", async () => {
    const c = await connect();
    const cursors: unknown[] = [];
    Object.assign(c.deps.history, {
      page: async (_id: unknown, options: { cursor?: unknown }) => {
        cursors.push(options.cursor);
        return success({ items: [], nextCursor: entityId("older-2") });
      },
    });
    const cursor = entityId<"cursor">("older-1");
    value(
      await c.dispatch({ type: "history.load-older", conversationId: c.conversationId, cursor }),
    );
    expect(cursors).toEqual([cursor]);
    expect(c.timeline(c.conversationId)).toMatchObject({
      olderCursor: "older-2",
      loadingOlder: false,
      atLatest: false,
    });
    Object.assign(c.deps.history, { page: async () => failure("storage") });
    const failed = await c.dispatch({
      type: "history.load-older",
      conversationId: c.conversationId,
    });
    expect(code(failed)).toBe("storage");
    expect(c.timeline(c.conversationId).loadingOlder).toBe(false);
  });

  it.each([
    ["server ID", { serverId: "oldest", serverTime: 5 }, { serverId: "oldest" }],
    ["server time", { serverTime: 1_700_000_000_500 }, { serverTime: 1_700_000_000_500 }],
    ["nothing", {}, undefined],
  ])(
    "server history before the oldest local message uses its %s",
    async (_label, oldest, before) => {
      const c = await connect();
      const message: Message = {
        ...welcomeMessage,
        id: entityId("local-oldest"),
        networkId,
        conversationId: c.conversationId,
        ...oldest,
      };
      Object.assign(c.deps.history, { page: async () => success({ items: [message] }) });
      const receipt = value(
        await c.dispatch({ type: "history.load-older", conversationId: c.conversationId }),
      );
      const command = c.session.commands.at(-1)!;
      expect(command.operationId).toBe(receipt.operationId);
      expect(command.command).toEqual({
        type: "history",
        target: "#welcome",
        limit: 100,
        ...(before ? { before } : {}),
      });
      expect(c.operation(receipt.operationId)?.state).toBe("accepted");
    },
  );

  it("status conversations never request server history", async () => {
    const c = await connect();
    const statusId = c.status().id;
    const sent = c.session.commands.length;
    const receipt = value(
      await c.dispatch({ type: "history.load-older", conversationId: statusId }),
    );
    expect(c.session.commands).toHaveLength(sent);
    expect(c.operation(receipt.operationId)?.state).toBe("completed");
  });

  it("revealing a message that is gone or belongs to no configured conversation fails safely", async () => {
    const c = await connect();
    Object.assign(c.deps.history, { context: async () => success([]) });
    expect(code(await c.dispatch({ type: "history.reveal", messageId: entityId("gone") }))).toBe(
      "unavailable",
    );
    Object.assign(c.deps.history, {
      context: async () =>
        success([
          { ...welcomeMessage, id: entityId("orphan"), conversationId: entityId("nowhere") },
        ]),
    });
    expect(code(await c.dispatch({ type: "history.reveal", messageId: entityId("orphan") }))).toBe(
      "unavailable",
    );
  });
});
