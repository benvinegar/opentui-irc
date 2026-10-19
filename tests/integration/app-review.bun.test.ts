import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app/create-app";
import type { AppApi } from "../../src/contracts/app";
import type { Result } from "../../src/contracts/common";
import { createHistoryRepository } from "../../src/storage/history";
import { networkId, settings } from "../fixtures/scenario";
import { harness, settle } from "../app/harness";

const signal = new AbortController().signal;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const apps: AppApi[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "openirc-app-review-"));
  directories.push(directory);
  const path = join(directory, "history.sqlite");
  const history = value(await createHistoryRepository(path));
  const config = {
    ...settings,
    user: { ...settings.user, history: { ...settings.user.history, persistDrafts: true } },
  };
  const h = harness(config);
  const app = value(await createApp({ ...h.deps, history }, signal));
  apps.push(app);
  expect(app.state.getSnapshot().error).toBeUndefined();
  value(await app.dispatch({ type: "network.connect", networkId }, signal));
  await settle();
  const session = h.session(networkId);
  session.emit({
    type: "support",
    features: {
      history: true,
      replies: false,
      reactions: false,
      typing: false,
      readMarkers: false,
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
  return { app, h, session, history, conversationId, path };
}
describe("app with strict real SQLite durability", () => {
  test("registers all first-open contexts before pages/workspace, preserves live echo IDs, and does not resurrect deleted drafts", async () => {
    const { app, session, history, conversationId, path } = await setup();
    expect(app.state.getSnapshot().error).toBeUndefined();
    expect(session.commands.some((entry) => entry.command.type === "history")).toBe(true);
    value(await app.dispatch({ type: "conversation.activate", conversationId }, signal));
    const direct = value(
      await app.dispatch({ type: "conversation.query", networkId, nick: "peer" }, signal),
    );
    expect(direct.conversationId).toBeDefined();
    value(await app.dispatch({ type: "conversation.join", networkId, channel: "#new" }, signal));
    expect(app.state.getSnapshot().error).toBeUndefined();
    const sent = value(
      await app.dispatch(
        { type: "message.send", conversationId, text: "echo body", kind: "text" },
        signal,
      ),
    );
    value(await app.dispatch({ type: "history.latest", conversationId }, signal));
    expect(value(app.timeline(conversationId)).getSnapshot().messages.at(-1)?.sendState).toBe(
      "pending",
    );
    session.emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "newcomer" },
        kind: "text",
        text: "echo body",
        receivedAt: 1_700_000_002_000,
        source: "live",
        operationId: sent.operationId,
        serverId: "durable-echo",
      },
    });
    await settle();
    expect(value(await history.findByServerId(networkId, "durable-echo", signal))?.id).toBe(
      sent.messageId!,
    );
    value(
      await app.dispatch({ type: "draft.set", conversationId, text: "erase this draft" }, signal),
    );
    value(await app.dispatch({ type: "history.delete", conversationId }, signal));
    value(await app.shutdown());
    const reopened = value(await createHistoryRepository(path));
    try {
      expect(value(await reopened.loadWorkspace(signal)).drafts).toEqual([]);
      expect(value(await reopened.findByServerId(networkId, "durable-echo", signal))).toBeNull();
    } finally {
      await reopened.close();
    }
  });

  test("shortened retention removes durable bodies immediately and they remain absent after shutdown", async () => {
    const { app, h, session, history, path } = await setup();
    session.emit({
      type: "chat",
      message: {
        target: "#welcome",
        sender: { nick: "guide" },
        kind: "text",
        text: "old retained body",
        receivedAt: h.deps.clock.now() - 2 * 86400000,
        source: "live",
        serverId: "old-body",
      },
    });
    await settle();
    expect(value(await history.findByServerId(networkId, "old-body", signal))).not.toBeNull();
    const config = app.settings.getSnapshot()!;
    value(
      await app.saveSettings(
        {
          section: "user",
          value: { ...config.user, history: { ...config.user.history, retentionDays: 1 } },
        },
        config.revision,
        signal,
      ),
    );
    expect(value(await history.findByServerId(networkId, "old-body", signal))).toBeNull();
    value(await app.shutdown());
    const reopened = value(await createHistoryRepository(path));
    try {
      expect(
        value(await reopened.search({ text: "retained body", limit: 10 }, signal)).items,
      ).toEqual([]);
    } finally {
      await reopened.close();
    }
  });
});
