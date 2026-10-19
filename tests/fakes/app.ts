import type { AppAction, AppApi, OperationView } from "../../src/contracts/app";
import {
  entityId,
  type Readable,
  type Result,
  type ConversationId,
  type NetworkId,
} from "../../src/contracts/common";
import type { AppSnapshot, Message, TimelineSnapshot } from "../../src/contracts/model";
import type { DiscoverySnapshot } from "../../src/contracts/discovery";
import type { SettingsDocument } from "../../src/contracts/settings";
import { appSnapshot, settings as initialSettings, timelineSnapshot } from "../fixtures/scenario";

function model<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
    get subscribers() {
      return listeners.size;
    },
  };
}
const unavailable = <T>(): Result<T> => ({
  ok: false,
  error: {
    code: "unavailable",
    message: "Not available in this deterministic test scenario.",
    retryable: false,
  },
});

/** Explicit test facade. Production never imports this module. No timers, I/O, or random IDs. */
export function createFakeApp(initial: AppSnapshot = appSnapshot) {
  const state = model(initial);
  const settings = model<SettingsDocument | null>(initialSettings);
  const operations = model<readonly OperationView[]>([]);
  const timelines = new Map<ConversationId, ReturnType<typeof model<TimelineSnapshot>>>();
  for (const item of initial.conversations)
    timelines.set(
      item.id,
      model({
        ...timelineSnapshot,
        conversationId: item.id,
        messages: item.id === timelineSnapshot.conversationId ? timelineSnapshot.messages : [],
      }),
    );
  const discoveries = new Map<NetworkId, ReturnType<typeof model<DiscoverySnapshot>>>();
  for (const network of initial.networks)
    discoveries.set(
      network.id,
      model<DiscoverySnapshot>({
        networkId: network.id,
        directory: { state: "idle", items: [], truncated: false },
        user: { state: "idle" },
      }),
    );
  const actions: AppAction[] = [];
  let sequence = 0;
  const receipt = () => {
    const id = entityId<"operation">(`fake-operation-${++sequence}`);
    operations.publish([...operations.getSnapshot().slice(-19), { id, state: "completed" }]);
    return { ok: true as const, value: { operationId: id } };
  };
  const app: AppApi = {
    state,
    settings,
    operations,
    timeline(id) {
      const value = timelines.get(id);
      return value ? { ok: true, value } : unavailable<Readable<TimelineSnapshot>>();
    },
    discovery(id) {
      const value = discoveries.get(id);
      return value ? { ok: true, value } : unavailable<Readable<DiscoverySnapshot>>();
    },
    async dispatch(action, signal) {
      if (signal.aborted)
        return { ok: false, error: { code: "cancelled", message: "Cancelled.", retryable: false } };
      actions.push(action);
      if (action.type === "irc.request") {
        const discovery = discoveries.get(action.networkId);
        if (discovery && action.command.type === "list")
          discovery.publish({
            ...discovery.getSnapshot(),
            directory: { state: "loading", items: [], truncated: false },
          });
        if (discovery && action.command.type === "whois")
          discovery.publish({ ...discovery.getSnapshot(), user: { state: "loading" } });
      }
      if (action.type === "message.redact") {
        for (const timeline of timelines.values())
          timeline.publish({
            ...timeline.getSnapshot(),
            messages: timeline
              .getSnapshot()
              .messages.map((message) =>
                message.id === action.messageId
                  ? { ...message, redacted: true, text: "", reactions: [] }
                  : message,
              ),
          });
      }
      if (action.type === "conversation.activate")
        state.publish({
          ...state.getSnapshot(),
          activeConversationId: action.conversationId,
          revision: state.getSnapshot().revision + 1,
        });
      if (action.type === "draft.set") {
        const timeline = timelines.get(action.conversationId);
        if (timeline) timeline.publish({ ...timeline.getSnapshot(), draft: action.text });
      }
      if (action.type === "message.send") {
        const timeline = timelines.get(action.conversationId);
        if (!timeline) return unavailable();
        timeline.publish({
          ...timeline.getSnapshot(),
          messages: [
            ...timeline.getSnapshot().messages.slice(-299),
            {
              ...timelineSnapshot.messages[0]!,
              id: entityId<"message">(`fake-message-${sequence + 1}`),
              text: action.text,
              kind: action.kind,
              source: "local",
              sendState: "written",
              conversationId: action.conversationId,
            },
          ],
        });
      }
      if (action.type === "network.connect" || action.type === "network.disconnect")
        state.publish({
          ...state.getSnapshot(),
          networks: state.getSnapshot().networks.map((network) =>
            network.id === action.networkId
              ? {
                  ...network,
                  phase: action.type === "network.connect" ? "ready" : "disconnected",
                }
              : network,
          ),
        });
      if (action.type === "conversation.mute")
        state.publish({
          ...state.getSnapshot(),
          conversations: state
            .getSnapshot()
            .conversations.map((item) =>
              item.id === action.conversationId ? { ...item, muted: action.muted } : item,
            ),
        });
      if (action.type === "conversation.join" || action.type === "conversation.query") {
        const id = entityId<"conversation">(`fake-conversation-${sequence + 1}`);
        const conversation = {
          id,
          networkId: action.networkId,
          name: action.type === "conversation.join" ? action.channel : action.nick,
          kind: action.type === "conversation.join" ? ("channel" as const) : ("direct" as const),
          topic: "",
          joined: true,
          unreadCount: 0,
          mentionCount: 0,
          muted: false,
        };
        timelines.set(
          id,
          model({ ...timelineSnapshot, conversationId: id, messages: [], draft: "" }),
        );
        state.publish({
          ...state.getSnapshot(),
          conversations: [...state.getSnapshot().conversations, conversation],
          activeConversationId: id,
        });
      }
      if (action.type === "history.reveal") {
        const message = [...timelines.values()]
          .flatMap((item) => item.getSnapshot().messages)
          .find((item) => item.id === action.messageId);
        if (message)
          state.publish({ ...state.getSnapshot(), activeConversationId: message.conversationId });
      }
      return receipt();
    },
    async saveSettings(change, expectedRevision) {
      const current = settings.getSnapshot();
      if (!current || current.revision !== expectedRevision)
        return {
          ok: false,
          error: { code: "conflict", message: "Settings changed externally.", retryable: false },
        };
      const revision = entityId<"config-revision">(`fake-revision-${++sequence}`);
      settings.publish(
        change.section === "user"
          ? { ...current, revision, user: change.value }
          : { ...current, revision, tui: change.value },
      );
      return { ok: true, value: entityId<"operation">(`fake-settings-${sequence}`) };
    },
    async reloadSettings(expectedRevision) {
      if (settings.getSnapshot()?.revision !== expectedRevision)
        return {
          ok: false,
          error: { code: "conflict", message: "Settings changed externally.", retryable: false },
        };
      return { ok: true, value: entityId<"operation">(`fake-reload-${++sequence}`) };
    },
    async search(query) {
      return {
        ok: true,
        value: {
          items: [...timelines.values()]
            .flatMap((item) => item.getSnapshot().messages)
            .filter((item) => item.text.includes(query.text))
            .slice(0, query.limit),
        },
      };
    },
    async storeSecret() {
      return {
        ok: false,
        error: {
          code: "unsupported",
          message: "Secure storage unavailable in test facade.",
          retryable: false,
        },
      };
    },
    async shutdown() {
      return { ok: true, value: undefined };
    },
  };
  return {
    app,
    state,
    settings,
    operations,
    timelines,
    discoveries,
    actions,
    incoming(message: Message) {
      const timeline = timelines.get(message.conversationId);
      if (timeline)
        timeline.publish({
          ...timeline.getSnapshot(),
          messages: [...timeline.getSnapshot().messages.slice(-299), message],
        });
    },
    setDraft(id: ConversationId, draft: string) {
      const timeline = timelines.get(id);
      if (timeline) timeline.publish({ ...timeline.getSnapshot(), draft });
    },
  };
}
