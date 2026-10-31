import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app";
import { entityId, type Result } from "../../src/contracts/common";
import type { Message } from "../../src/contracts/model";
import type { SettingsDocument } from "../../src/contracts/settings";
import type { WorkspaceState } from "../../src/contracts/storage";
import { networkId, profile, settings, welcomeMessage } from "../fixtures/scenario";
import { boot, connect, shutdownAll, signal, value } from "./connected";
import { failure, harness, settle, success } from "./harness";

afterEach(shutdownAll);

const code = (result: Result<unknown>) => (result.ok ? "ok" : result.error.code);
const withUser = (patch: Partial<SettingsDocument["user"]>): SettingsDocument => ({
  ...settings,
  user: { ...settings.user, ...patch },
});
const desktop = withUser({
  notifications: { desktop: true, previews: false, bell: false },
});

/** Holds the serialized lane on a slow workspace save until released. */
function gateWorkspace(h: ReturnType<typeof harness>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = h.deps.history.saveWorkspace;
  h.deps.history.saveWorkspace = async (...args) => {
    await gate;
    return save(...args);
  };
  return release;
}

describe("queued intents", () => {
  it("intents cancelled while queued never run", async () => {
    const c = await connect();
    const revision = c.app.settings.getSnapshot()!.revision;
    const release = gateWorkspace(c.h);
    const blocked = c.dispatch({
      type: "conversation.mute",
      conversationId: c.conversationId,
      muted: true,
    });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const queued = [
      c.app.saveSettings({ section: "tui", value: settings.tui }, revision, controllers[0]!.signal),
      c.app.reloadSettings(revision, revision, controllers[1]!.signal),
      c.app.dispatch(
        { type: "conversation.mute", conversationId: c.conversationId, muted: false },
        controllers[2]!.signal,
      ),
    ];
    for (const controller of controllers) controller.abort();
    release();
    expect(code(await blocked)).toBe("ok");
    expect((await Promise.all(queued)).map((result) => code(result))).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(c.find("#welcome")!.muted).toBe(true);
  });

  it("intents still queued at shutdown are refused, as are later calls", async () => {
    const c = await connect();
    const revision = c.app.settings.getSnapshot()!.revision;
    const release = gateWorkspace(c.h);
    const blocked = c.dispatch({
      type: "conversation.mute",
      conversationId: c.conversationId,
      muted: true,
    });
    const queued = [
      c.app.saveSettings({ section: "tui", value: settings.tui }, revision, signal()),
      c.app.reloadSettings(revision, revision, signal()),
      c.dispatch({ type: "conversation.mute", conversationId: c.conversationId, muted: false }),
    ];
    const stopped = c.app.shutdown();
    release();
    await blocked;
    expect((await Promise.all(queued)).map((result) => code(result))).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    value(await stopped);
    expect(code(await c.app.search({ text: "x", limit: 1 }, signal()))).toBe("unavailable");
    expect(code(await c.app.storeSecret("private-test-value", signal()))).toBe("unavailable");
    expect(code(await c.dispatch({ type: "network.connect", networkId }))).toBe("unavailable");
  });

  it("an operation the session reports as cancelled is recorded as cancelled", async () => {
    const c = await connect();
    c.session.executeResult = failure("cancelled");
    const result = await c.dispatch({ type: "irc.request", networkId, command: { type: "list" } });
    expect(code(result)).toBe("cancelled");
    expect(c.app.operations.getSnapshot().at(-1)).toMatchObject({ state: "cancelled" });
  });

  it("a reload cancelled while loading settings does not apply them", async () => {
    const c = await connect();
    const current = c.app.settings.getSnapshot()!;
    const controller = new AbortController();
    c.deps.settings.load = async () => {
      controller.abort();
      return success({ ...current, tui: { ...current.tui, theme: "light" } });
    };
    const result = await c.app.reloadSettings(
      current.revision,
      current.revision,
      controller.signal,
    );
    expect(code(result)).toBe("cancelled");
    expect(c.app.settings.getSnapshot()!.tui.theme).toBe(current.tui.theme);
  });
});

describe("shutdown failures", () => {
  it.each([
    [
      "a session close failure",
      (c: Awaited<ReturnType<typeof connect>>) => {
        c.session.close = async () => failure("network", "Close failed");
      },
      "network",
    ],
    [
      "a throwing session close",
      (c: Awaited<ReturnType<typeof connect>>) => {
        // The harness also closes on abort (no reason); only the app's QUIT close throws.
        c.session.close = async (reason?: string) => {
          if (reason) throw new Error("private detail");
          return success(undefined);
        };
      },
      "network",
    ],
    [
      "a workspace save failure",
      (c: Awaited<ReturnType<typeof connect>>) => {
        c.deps.history.saveWorkspace = async () => failure("storage");
      },
      "storage",
    ],
    [
      "a history close failure",
      (c: Awaited<ReturnType<typeof connect>>) => {
        c.deps.history.close = async () => failure("storage");
      },
      "storage",
    ],
    [
      "a throwing history close",
      (c: Awaited<ReturnType<typeof connect>>) => {
        c.deps.history.close = async () => {
          throw new Error("private detail");
        };
      },
      "storage",
    ],
  ])("%s makes shutdown report an unclean result", async (_label, breakIt, expected) => {
    const c = await connect();
    breakIt(c);
    const result = await c.app.shutdown();
    expect(code(result)).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("private detail");
  });
});

describe("settings application", () => {
  it("removing the active network closes its conversations; adding one autoconnects it", async () => {
    const c = await connect();
    await c.emit({ type: "typing", target: "#welcome", nick: "guide", active: true });
    const before = c.app.settings.getSnapshot()!;
    value(
      await c.app.saveSettings(
        { section: "user", value: { ...before.user, networks: [] } },
        before.revision,
        signal(),
      ),
    );
    let snapshot = c.app.state.getSnapshot();
    expect(snapshot.networks).toEqual([]);
    expect(snapshot.conversations).toEqual([]);
    expect(snapshot.activeConversationId).toBeUndefined();
    expect(c.app.timeline(c.conversationId).ok).toBe(false);
    const second = {
      ...profile,
      id: entityId<"network">("second"),
      name: "Second",
      autoConnect: true,
    };
    const middle = c.app.settings.getSnapshot()!;
    value(
      await c.app.saveSettings(
        { section: "user", value: { ...middle.user, networks: [second] } },
        middle.revision,
        signal(),
      ),
    );
    await settle();
    snapshot = c.app.state.getSnapshot();
    expect(snapshot.networks).toEqual([
      expect.objectContaining({ id: second.id, phase: "connecting" }),
    ]);
    const status = snapshot.conversations.find((item) => item.kind === "status")!;
    expect(status).toMatchObject({ networkId: second.id, name: "Second" });
    expect(snapshot.activeConversationId).toBe(status.id);
    expect(c.h.sessions.at(-1)!.identity.networkId).toBe(second.id);
  });
});

describe("startup restoration", () => {
  const record = (id: string, name: string, network = networkId) => ({
    id: entityId<"conversation">(id),
    networkId: network,
    kind: "channel" as const,
    name,
  });

  it("restores workspace order, mutes, drafts and fallback activity, and autoconnects", async () => {
    const config = withUser({
      networks: [{ ...profile, autoConnect: true, autoJoin: [] }],
      history: { ...settings.user.history, persistDrafts: true },
    });
    const workspace: WorkspaceState = {
      activeConversationId: entityId("c"),
      conversationOrder: [entityId("b"), entityId("a"), entityId("x")],
      mutedConversations: [entityId("b")],
      drafts: [
        { conversationId: entityId("a"), text: "draft a" },
        { conversationId: entityId("missing"), text: "orphan" },
      ],
    };
    const c = await boot({
      config,
      configure: (h) => {
        for (const item of [
          record("a", "#a"),
          record("c", "#c"),
          record("x", "#x", entityId("removed")),
          record("b", "#b"),
        ])
          h.records.set(item.id, item);
        h.deps.history.loadWorkspace = async () => success(workspace);
      },
    });
    const snapshot = c.app.state.getSnapshot();
    expect(snapshot.conversations.map((item) => item.name)).toEqual(["#b", "#a", profile.name]);
    expect(snapshot.activeConversationId).toBe("b");
    expect(snapshot.conversations.find((item) => item.name === "#b")!.muted).toBe(true);
    expect(c.timeline(entityId("a")).draft).toBe("draft a");
    expect(c.app.timeline(entityId("c")).ok).toBe(false);
    await settle();
    expect(c.h.sessions).toHaveLength(1);
  });

  it("restored pending sends become uncertain and an older-page cursor is kept", async () => {
    const pendingMessage: Message = {
      ...welcomeMessage,
      id: entityId("p"),
      networkId,
      conversationId: entityId("a"),
      sendState: "pending",
    };
    const c = await boot({
      configure: (h) => {
        h.records.set(entityId("a"), record("a", "#a"));
        h.deps.history.loadWorkspace = async () =>
          success({
            activeConversationId: entityId("a"),
            conversationOrder: [entityId("a")],
            mutedConversations: [],
            drafts: [],
          });
        h.deps.history.page = async () =>
          success({
            items: [pendingMessage, { ...pendingMessage, id: entityId("w"), sendState: "written" }],
            nextCursor: entityId("older"),
          });
      },
    });
    const restored = c.timeline(entityId("a"));
    expect(restored.messages.map((message) => message.sendState)).toEqual([
      "uncertain",
      "uncertain",
    ]);
    expect(restored.olderCursor).toBe("older");
  });

  it("a root abort after startup shuts the app down once", async () => {
    const h = harness(settings);
    const controller = new AbortController();
    const app = value(await createApp(h.deps, controller.signal));
    controller.abort();
    await settle();
    expect(h.closed).toBe(1);
    expect(code(await app.dispatch({ type: "network.connect", networkId }, signal()))).toBe(
      "unavailable",
    );
    value(await app.shutdown());
    expect(h.closed).toBe(1);
  });
});

describe("durability failures", () => {
  it("pruning failures are surfaced at boot and during maintenance, then at shutdown", async () => {
    const c = await boot({
      configure: (h) => {
        h.deps.history.prune = async () => failure("storage", "Disk full");
      },
    });
    expect(c.app.state.getSnapshot().error).toMatchObject({ code: "storage" });
    const recorded = c.h.diagnostics.length;
    let published = 0;
    c.app.state.subscribe(() => published++);
    c.h.advance(86_400_000);
    await settle();
    expect(c.h.diagnostics.length).toBeGreaterThan(recorded);
    expect(published).toBeGreaterThan(0);
    expect(code(await c.app.shutdown())).toBe("storage");
  });

  it("workspace and registry write failures are reported without failing the user's action", async () => {
    const c = await connect();
    c.deps.history.saveWorkspace = async () => failure("storage", "Workspace write failed");
    value(
      await c.dispatch({
        type: "conversation.mute",
        conversationId: c.conversationId,
        muted: true,
      }),
    );
    expect(c.app.state.getSnapshot().error).toMatchObject({ code: "storage" });
    c.deps.history.commit = async () => failure("storage", "Registry write failed");
    const opened = value(await c.dispatch({ type: "conversation.query", networkId, nick: "pal" }));
    expect(c.app.state.getSnapshot().activeConversationId).toBe(opened.conversationId);
    expect(code(await c.app.shutdown())).toBe("storage");
  });

  it("a page read failure is reported while activation still succeeds", async () => {
    const c = await connect();
    const dm = value(await c.dispatch({ type: "conversation.query", networkId, nick: "pal" }));
    value(await c.dispatch({ type: "history.delete", conversationId: dm.conversationId! }));
    value(await c.dispatch({ type: "conversation.activate", conversationId: c.conversationId }));
    c.deps.history.page = async () => failure("storage", "Read failed");
    value(await c.dispatch({ type: "history.latest", conversationId: dm.conversationId! }));
    expect(c.app.state.getSnapshot().error).toMatchObject({ code: "storage" });
  });
});

describe("notifications", () => {
  const mention = (serverId: string) => ({
    serverId,
    text: `newcomer: ${serverId}`,
    serverTime: 1_700_000_003_000,
  });

  it("an unsupported desktop sink is silent rather than an error", async () => {
    const c = await connect({
      config: desktop,
      configure: (h) => {
        h.deps.notifications.notify = vi.fn(async () => failure("unsupported"));
      },
    });
    await c.chat(mention("one"));
    expect(c.deps.notifications.notify).toHaveBeenCalledTimes(1);
    expect(c.app.state.getSnapshot().error).toBeUndefined();
  });

  it("a throwing sink is reported as unavailable", async () => {
    const c = await connect({
      config: desktop,
      configure: (h) => {
        h.deps.notifications.notify = vi.fn(async () => {
          throw new Error("private detail");
        });
      },
    });
    await c.chat(mention("one"));
    expect(c.app.state.getSnapshot().error).toMatchObject({ code: "unavailable" });
  });

  it("a notification waiting for its slot is dropped if the conversation is muted meanwhile", async () => {
    const c = await connect({ config: desktop });
    await c.chat(mention("one"));
    await c.chat(mention("two"));
    expect(c.notifications).toHaveLength(1);
    value(
      await c.dispatch({
        type: "conversation.mute",
        conversationId: c.conversationId,
        muted: true,
      }),
    );
    c.h.advance(2_000);
    await settle();
    expect(c.notifications).toHaveLength(1);
    expect(c.find("#welcome")!.unreadCount).toBe(2);
  });
});

describe("unread bookkeeping", () => {
  it("more than a window of unread messages keeps exact counts and clears on reading", async () => {
    const c = await connect();
    for (let index = 0; index < 305; index++)
      await c.chat({
        serverId: `u${index}`,
        serverTime: 1_700_000_010_000 + index * 10,
        text: index % 2 ? "newcomer: ping" : "chatter",
      });
    expect(c.find("#welcome")).toMatchObject({ unreadCount: 305, mentionCount: 152 });
    const last = c.messages().at(-1)!;
    expect(last.serverId).toBe("u304");
    value(
      await c.dispatch({
        type: "view.report",
        conversationId: c.conversationId,
        focused: true,
        atBottom: true,
        lastVisibleMessageId: last.id,
      }),
    );
    expect(c.find("#welcome")).toMatchObject({ unreadCount: 0, mentionCount: 0 });
    expect(c.timeline(c.conversationId).firstUnreadId).toBeUndefined();
  });

  it("inactive conversations give up their hot windows beyond the global message cap", async () => {
    const c = await connect();
    for (let channel = 0; channel < 17; channel++)
      for (let index = 0; index < 300; index++)
        c.session.emit({
          type: "chat",
          message: {
            target: `#h${channel}`,
            sender: { nick: "guide" },
            kind: "text",
            text: `m${index}`,
            receivedAt: 1_700_000_010_000 + index,
            source: "live",
          },
        });
    for (let round = 0; round < 2_000 && !c.find("#h16"); round++) await settle();
    for (let round = 0; round < 200; round++) await settle();
    const sizes = Array.from({ length: 17 }, (_, channel) => {
      const id = c.find(`#h${channel}`)!.id;
      return c.timeline(id).messages.length;
    });
    expect(sizes[16]).toBe(300);
    expect(sizes[0]).toBe(0);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(5_000);
  });
});
