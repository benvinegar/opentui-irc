import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app/create-app";
import type { Result } from "../../src/contracts/common";
import {
  ALL_CONTROL_PERMISSIONS,
  DEFAULT_CONTROL_PERMISSIONS,
  type ControlPermission,
  type ControlResponse,
  type JsonObject,
} from "../../src/contracts/control";
import { isJsonObject } from "../../src/control/protocol";
import { createControlService } from "../../src/control/service";
import {
  createControlClient,
  createControlServer,
  resolveControlPaths,
} from "../../src/control/socket";
import { conversationId, messageId, networkId } from "../fixtures/scenario";
import { harness } from "../app/harness";

const cleanups: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
let sequence = 0;
function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error("Expected successful test setup result.");
  return result.value;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One sample of every AppAction (and every IRC request command) a control caller may send. */
const actions: readonly JsonObject[] = [
  { type: "network.connect", networkId },
  { type: "network.disconnect", networkId },
  { type: "network.reconnect", networkId },
  { type: "conversation.activate", conversationId },
  { type: "conversation.close", conversationId },
  { type: "conversation.join", networkId, channel: "#other", key: "env:CHANNEL_KEY" },
  { type: "conversation.query", networkId, nick: "peer" },
  { type: "conversation.mute", conversationId, muted: true },
  { type: "draft.set", conversationId, text: "draft" },
  { type: "message.send", conversationId, text: "hello", kind: "text", replyTo: messageId },
  { type: "message.react", messageId, value: "+1", remove: false },
  { type: "message.redact", messageId },
  { type: "typing.set", conversationId, active: true, paused: false },
  { type: "history.load-older", conversationId, cursor: "cursor" },
  { type: "history.latest", conversationId },
  { type: "history.reveal", messageId },
  { type: "history.delete", conversationId },
  {
    type: "view.report",
    conversationId,
    focused: true,
    atBottom: true,
    lastVisibleMessageId: messageId,
  },
  ...[
    { type: "nick", nick: "newnick" },
    { type: "away", reason: null },
    { type: "away", reason: "later" },
    { type: "whois", nick: "peer" },
    { type: "list" },
    { type: "topic", channel: "#welcome" },
    { type: "topic", channel: "#welcome", text: "topic" },
  ].map((command) => ({ type: "irc.request", networkId, command })),
];
const privileged = new Set<ControlPermission>(["read-messages", "send-messages", "destructive"]);
function needsExplicitGrant(action: JsonObject): boolean {
  const type = String(action.type);
  const command = action.command;
  const topicWrite =
    isJsonObject(command) && command.type === "topic" && command.text !== undefined;
  return /^(message|typing|draft|history|view)\./u.test(type) || topicWrite;
}

async function live(granted: readonly ControlPermission[]) {
  const config = await mkdtemp(join(tmpdir(), "openirc-control-actions-"));
  const paths = value(await resolveControlPaths(config));
  cleanups.push(() => rm(config, { recursive: true, force: true }));
  cleanups.push(() => rm(paths.directory, { recursive: true, force: true }));
  const h = harness();
  const app = value(await createApp(h.deps, signal()));
  cleanups.push(() => app.shutdown());
  const server = value(
    await createControlServer({
      configDirectory: config,
      handler: createControlService({
        app,
        settings: h.deps.settings,
        secrets: h.deps.secrets,
        permissions: granted,
      }),
    }),
  );
  cleanups.push(() => server.close());
  const client = createControlClient({ configDirectory: config });
  const dispatch = async (
    action: JsonObject,
    permissions: readonly ControlPermission[],
  ): Promise<ControlResponse> =>
    value(
      await client.request(
        {
          version: 1,
          id: `control-actions-${++sequence}`,
          method: "action.dispatch",
          params: { action, confirm: true },
          permissions,
        },
        signal(),
      ),
    );
  return { app, h, dispatch };
}
const code = (response: ControlResponse) => (response.ok ? "ok" : response.error.code);

describe("action dispatch over the real control socket", () => {
  test("every action is denied without caller intent and never reaches the app", async () => {
    const { app, h, dispatch } = await live(ALL_CONTROL_PERMISSIONS);
    const before = app.state.getSnapshot();
    for (const action of actions)
      expect(code(await dispatch(action, [])), JSON.stringify(action)).toBe("permission-denied");
    expect(app.state.getSnapshot()).toBe(before);
    expect(h.sessions).toHaveLength(0);
  });
  test("default server grants admit network/inspect/configure actions but never message or destructive ones", async () => {
    const { dispatch } = await live(DEFAULT_CONTROL_PERMISSIONS);
    for (const action of actions) {
      const result = code(await dispatch(action, ALL_CONTROL_PERMISSIONS));
      if (needsExplicitGrant(action))
        expect(result, JSON.stringify(action)).toBe("permission-denied");
      else
        expect(
          ["permission-denied", "invalid-input", "internal"],
          JSON.stringify(action),
        ).not.toContain(result);
    }
  });
  test("a full grant with matching intent admits every valid action shape", async () => {
    const { dispatch } = await live(ALL_CONTROL_PERMISSIONS);
    for (const action of actions) {
      const result = code(await dispatch(action, ALL_CONTROL_PERMISSIONS));
      expect(
        ["permission-denied", "invalid-input", "internal"],
        JSON.stringify(action),
      ).not.toContain(result);
    }
    // Intent for only the non-privileged rights still cannot reach privileged actions.
    const ordinary = ALL_CONTROL_PERMISSIONS.filter((permission) => !privileged.has(permission));
    for (const action of actions.filter(needsExplicitGrant))
      expect(code(await dispatch(action, ordinary)), JSON.stringify(action)).toBe(
        "permission-denied",
      );
  });
  test("malformed actions are rejected over the wire before dispatch", async () => {
    const { app, dispatch } = await live(ALL_CONTROL_PERMISSIONS);
    const before = app.state.getSnapshot();
    for (const action of [
      { type: "network.connect" },
      { type: "network.connect", networkId, extra: true },
      { type: "message.send", conversationId, text: "", kind: "text" },
      { type: "message.send", conversationId, text: "x", kind: "ctcp" },
      { type: "conversation.mute", conversationId, muted: "yes" },
      { type: "conversation.join", networkId, channel: "#x", key: "plaintext" },
      { type: "irc.request", networkId, command: { type: "raw", line: "QUIT" } },
      { type: "irc.request", networkId, command: { type: "away" } },
      { type: "irc.request", networkId, command: { type: "nick", nick: "bad nick" } },
      { type: "unknown.action" },
    ])
      expect(code(await dispatch(action, ALL_CONTROL_PERMISSIONS)), JSON.stringify(action)).toBe(
        "invalid-input",
      );
    expect(app.state.getSnapshot()).toBe(before);
  });
});
