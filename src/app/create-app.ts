/* eslint-disable no-control-regex -- Reject protocol injection controls at user-input boundaries. */
import type { ActionReceipt, AppAction, AppApi, OperationView } from "../contracts/app";
import type {
  AppError,
  ConversationId,
  MessageId,
  NetworkId,
  OperationId,
  Result,
  UserId,
} from "../contracts/common";
import type { DiscoverySnapshot } from "../contracts/discovery";
import type {
  AppSnapshot,
  ConversationView,
  FeatureSet,
  Message,
  NetworkView,
  TimelineSnapshot,
  UserView,
} from "../contracts/model";
import type { ProtocolSupport } from "../contracts/protocol";
import type { CreateApp } from "../contracts/runtime";
import type { IrcSession, SessionCommand, SessionEvent } from "../contracts/session";
import type { NetworkProfile, SettingsDocument } from "../contracts/settings";
import type { ConversationRecord, ReadPosition } from "../contracts/storage";
import { foldIdentifier } from "../domain/irc-identifiers";
import { mergeWindow, mentionsNick, plainText } from "../domain/message-policy";
import { admitSessionEvent, startSessionCursor } from "../domain/session-cursor";
import type { SessionCursor } from "../domain/session-cursor";
import { createReadModel } from "./read-model";
import type { ReadModel } from "./read-model";

const FEATURES: FeatureSet = {
  history: false,
  replies: false,
  reactions: false,
  typing: false,
  readMarkers: false,
  redaction: false,
  multiline: false,
};
const WINDOW = 500;
const MAX_HOT_MESSAGES = 5000;
const MAX_CONVERSATIONS = 1000;
const MAX_MEMBERS = 10000;
const MAX_OPERATIONS = 256;
const PAGE_SIZE = 100;
const MAX_INPUT = 65536;
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const error = (code: AppError["code"], message: string, retryable = false): AppError => ({
  code,
  message,
  retryable,
});
class Rejected extends Error {
  constructor(readonly detail: AppError) {
    super(detail.message);
  }
}
function reject(code: AppError["code"], message: string): never {
  throw new Rejected(error(code, message));
}
function requireResult<T>(result: Result<T>): T {
  if (!result.ok) throw new Rejected(result.error);
  return result.value;
}

interface Conversation {
  view: ConversationView;
  readonly model: ReadModel<TimelineSnapshot>;
  loaded: boolean;
  closed: boolean;
  recent: readonly Message[];
}
interface Attempt {
  readonly generation: number;
  readonly controller: AbortController;
  cursor: SessionCursor;
  session?: IrcSession;
  error?: AppError;
}

/** Creates an owned, framework-independent application. All mutations share one serialized lane. */
export const createApp: CreateApp = async (deps, rootSignal) => {
  const lifetime = new AbortController();
  let stopping = false;
  let shutdownPromise: Promise<Result<void>> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let revision = 0;
  let active: ConversationId | undefined;
  let lastError: AppError | undefined;
  let boot: AppSnapshot["boot"] = "loading";
  let settings: SettingsDocument;
  const networks = new Map<NetworkId, NetworkView>();
  const conversations = new Map<ConversationId, Conversation>();
  const attempts = new Map<NetworkId, Attempt>();
  const generations = new Map<NetworkId, number>();
  const retryCounts = new Map<NetworkId, number>();
  const support = new Map<NetworkId, ProtocolSupport>();
  const readPositions = new Map<ConversationId, ReadPosition>();
  const users = new Map<NetworkId, Map<string, UserView>>();
  const discoveries = new Map<NetworkId, ReadModel<DiscoverySnapshot>>();
  const pending = new Map<
    OperationId,
    { conversationId: ConversationId; messageId: MessageId; message: Message }
  >();
  const visibility = new Map<ConversationId, { focused: boolean; atBottom: boolean }>();
  const reactions = new Map<MessageId, Map<string, Set<UserId>>>();
  const typingControllers = new Map<string, AbortController>();
  const modelError = () => deps.diagnostics.record({ level: "error", code: "read-model-listener" });
  const state = createReadModel<AppSnapshot>(
    { revision, boot, networks: [], conversations: [] },
    modelError,
  );
  const settingsModel = createReadModel<SettingsDocument | null>(null, modelError);
  const operations = createReadModel<readonly OperationView[]>([], modelError);

  const serial = <T>(work: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
  const safeError = (cause: unknown): AppError =>
    cause instanceof Rejected ? cause.detail : error("internal", "An internal operation failed.");
  const report = (detail: AppError, networkId?: NetworkId) => {
    lastError = detail;
    if (networkId) {
      const network = networks.get(networkId);
      if (network) networks.set(networkId, { ...network, lastError: detail });
    }
    deps.diagnostics.record({
      level: "error",
      code: detail.code,
      ...(networkId ? { networkId } : {}),
    });
  };
  const publish = () =>
    state.publish({
      revision: ++revision,
      boot,
      networks: [...networks.values()],
      conversations: [...conversations.values()].filter((c) => !c.closed).map((c) => c.view),
      ...(active ? { activeConversationId: active } : {}),
      ...(lastError ? { error: lastError } : {}),
    });
  const operation = (id: OperationId, status: OperationView["state"], detail?: AppError) => {
    const previous = operations.readable.getSnapshot().filter((entry) => entry.id !== id);
    // Never evict an in-flight operation. Admission is capped separately.
    const next: OperationView[] = [
      ...previous,
      { id, state: status, ...(detail ? { error: detail } : {}) },
    ];
    while (next.length > MAX_OPERATIONS) {
      const index = next.findIndex((entry) => entry.state !== "accepted");
      if (index === -1) break;
      next.splice(index, 1);
    }
    operations.publish(next);
  };
  const newOperation = (): OperationId => {
    if (
      operations.readable.getSnapshot().filter((entry) => entry.state === "accepted").length >=
      MAX_OPERATIONS / 2
    )
      reject("rate-limited", "Too many operations are still pending.");
    const id = deps.ids.next<"operation">();
    operation(id, "accepted");
    return id;
  };
  const profile = (id: NetworkId): NetworkProfile => {
    const value = settings.user.networks.find((network) => network.id === id);
    if (!value) reject("unavailable", "Network no longer exists.");
    return value;
  };
  const mapping = (id: NetworkId) => support.get(id)?.casemapping ?? "rfc1459";
  const same = (id: NetworkId, left: string, right: string) =>
    foldIdentifier(left, mapping(id)) === foldIdentifier(right, mapping(id));
  const findConversation = (networkId: NetworkId, name: string, kind?: ConversationView["kind"]) =>
    [...conversations.values()].find(
      (c) =>
        c.view.networkId === networkId &&
        (!kind || c.view.kind === kind) &&
        same(networkId, c.view.name, name),
    );
  const getConversation = (id: ConversationId) => {
    const value = conversations.get(id);
    if (!value || value.closed) reject("unavailable", "Conversation is not open.");
    return value;
  };
  const timeline = (c: Conversation) => c.model.readable.getSnapshot();
  const updateTimeline = (c: Conversation, patch: Partial<TimelineSnapshot>) =>
    c.model.publish({ ...timeline(c), ...patch });
  const createConversation = (record: ConversationRecord): Conversation => {
    if (conversations.size >= MAX_CONVERSATIONS)
      reject("rate-limited", "Conversation limit reached.");
    const c: Conversation = {
      view: { ...record, topic: "", joined: false, unreadCount: 0, mentionCount: 0, muted: false },
      model: createReadModel<TimelineSnapshot>(
        {
          conversationId: record.id,
          messages: [],
          members: [],
          typing: [],
          loadingOlder: false,
          draft: "",
        },
        modelError,
      ),
      loaded: false,
      closed: false,
      recent: [],
    };
    conversations.set(record.id, c);
    return c;
  };
  const ensureConversation = (
    networkId: NetworkId,
    kind: ConversationView["kind"],
    name: string,
  ): Conversation => {
    let c = findConversation(networkId, name, kind);
    if (!c)
      c = createConversation({
        id: deps.ids.next<"conversation">(),
        networkId,
        kind,
        name: plainText(name),
      });
    c.closed = false;
    return c;
  };
  const canPersist = (c: Conversation) =>
    settings.user.history.enabled &&
    !settings.user.history.excludedConversations.some(
      (rule) =>
        rule.networkId === c.view.networkId &&
        rule.kind === c.view.kind &&
        same(c.view.networkId, rule.name, c.view.name),
    );
  const record = (c: Conversation): ConversationRecord => ({
    id: c.view.id,
    networkId: c.view.networkId,
    kind: c.view.kind,
    name: c.view.name,
  });
  const persist = async (
    messages: readonly Message[] = [],
    positions: readonly ReadPosition[] = [],
  ) => {
    const result = await deps.history.commit(
      {
        conversations: [...conversations.values()].map(record),
        messages: messages.filter((message) => {
          const c = conversations.get(message.conversationId);
          return c && canPersist(c);
        }),
        readPositions: positions.filter((position) => {
          const c = conversations.get(position.conversationId);
          return c && canPersist(c);
        }),
      },
      lifetime.signal,
    );
    if (!result.ok) {
      report(result.error);
      publish();
    }
    return result;
  };
  const saveWorkspace = async () => {
    const result = await deps.history.saveWorkspace(
      {
        ...(active ? { activeConversationId: active } : {}),
        conversationOrder: [...conversations.values()]
          .filter((c) => !c.closed)
          .map((c) => c.view.id),
        mutedConversations: [...conversations.values()]
          .filter((c) => c.view.muted)
          .map((c) => c.view.id),
        drafts: settings.user.history.persistDrafts
          ? [...conversations.values()]
              .filter((c) => canPersist(c) && !!timeline(c).draft)
              .map((c) => ({ conversationId: c.view.id, text: timeline(c).draft }))
          : [],
      },
      lifetime.signal,
    );
    if (!result.ok) report(result.error);
    return result;
  };
  const capHotWindows = () => {
    let total = [...conversations.values()].reduce(
      (count, c) =>
        count +
        c.recent.length +
        (timeline(c).atLatest === false ? timeline(c).messages.length : 0),
      0,
    );
    for (const c of conversations.values()) {
      if (total <= MAX_HOT_MESSAGES) break;
      if (
        c.view.id === active ||
        (pending.size && [...pending.values()].some((entry) => entry.conversationId === c.view.id))
      )
        continue;
      total -= c.recent.length + (timeline(c).atLatest === false ? timeline(c).messages.length : 0);
      c.recent = [];
      updateTimeline(c, { messages: [], atLatest: true });
      c.loaded = false;
    }
  };
  const putMessages = (c: Conversation, messages: readonly Message[]) => {
    c.recent = mergeWindow(c.recent, messages, WINDOW);
    const replacements = new Map(messages.map((message) => [message.id, message]));
    updateTimeline(c, {
      messages:
        timeline(c).atLatest === false
          ? timeline(c).messages.map((message) => replacements.get(message.id) ?? message)
          : c.recent,
    });
    capHotWindows();
    if (reactions.size > MAX_HOT_MESSAGES) {
      const retained = new Set(
        [...conversations.values()].flatMap((value) =>
          [...value.recent, ...timeline(value).messages].map((message) => message.id),
        ),
      );
      for (const id of reactions.keys()) if (!retained.has(id)) reactions.delete(id);
    }
  };
  const loadRecent = async (c: Conversation) => {
    if (c.loaded) return;
    const result = await deps.history.page(c.view.id, { limit: PAGE_SIZE }, lifetime.signal);
    if (!result.ok) {
      report(result.error);
      return;
    }
    const restored = result.value.items.map((message) =>
      message.sendState === "pending" || message.sendState === "written"
        ? { ...message, sendState: "uncertain" as const }
        : message,
    );
    putMessages(c, restored);
    const { olderCursor: _older, ...base } = timeline(c);
    c.model.publish({
      ...base,
      messages: c.recent,
      atLatest: true,
      ...(result.value.nextCursor ? { olderCursor: result.value.nextCursor } : {}),
    });
    c.loaded = true;
  };
  const discovery = (networkId: NetworkId) => {
    let value = discoveries.get(networkId);
    if (!value) {
      value = createReadModel<DiscoverySnapshot>(
        {
          networkId,
          directory: { state: "idle", items: [], truncated: false },
          user: { state: "idle" },
        },
        modelError,
      );
      discoveries.set(networkId, value);
    }
    return value;
  };
  const user = (networkId: NetworkId, nick: string): UserView => {
    let directory = users.get(networkId);
    if (!directory) {
      directory = new Map();
      users.set(networkId, directory);
    }
    const key = foldIdentifier(nick, mapping(networkId));
    let value = directory.get(key);
    if (!value) {
      if (directory.size >= MAX_MEMBERS) reject("rate-limited", "Network member limit exceeded.");
      value = { id: deps.ids.next<"user">(), nick: plainText(nick), away: false, prefixes: [] };
      directory.set(key, value);
    }
    return value;
  };
  const findMessage = (id: MessageId): { c: Conversation; message: Message } | undefined => {
    for (const c of conversations.values()) {
      const message = timeline(c).messages.find((item) => item.id === id);
      if (message) return { c, message };
    }
    return undefined;
  };
  const execute = async (
    networkId: NetworkId,
    command: SessionCommand,
    id: OperationId,
  ): Promise<void> => {
    const attempt = attempts.get(networkId);
    if (!attempt?.session || networks.get(networkId)?.phase !== "ready")
      reject("unavailable", "Connect to this network first.");
    requireResult(await attempt.session.execute(command, id, attempt.controller.signal));
  };
  const updateSend = async (
    id: OperationId,
    sendState: NonNullable<Message["sendState"]>,
    detail?: AppError,
  ) => {
    const entry = pending.get(id);
    if (!entry) return;
    const c = conversations.get(entry.conversationId);
    const found = findMessage(entry.messageId) ?? (c ? { c, message: entry.message } : undefined);
    if (found) {
      const message = { ...found.message, sendState };
      entry.message = message;
      putMessages(found.c, [message]);
      await persist([message]);
    }
    if (sendState === "failed" || sendState === "uncertain" || sendState === "echo-observed") {
      pending.delete(id);
      operation(
        id,
        sendState === "failed" || sendState === "uncertain" ? "failed" : "completed",
        detail ??
          (sendState === "uncertain"
            ? error("network", "Send outcome is uncertain. It will not be resent automatically.")
            : undefined),
      );
    } else if (sendState === "written") {
      const networkId = found?.message.networkId;
      if (networkId && support.get(networkId)?.capabilities["echo-message"] === undefined) {
        pending.delete(id);
        operation(id, "completed");
      } else {
        const attempt = networkId && attempts.get(networkId);
        if (attempt)
          void deps.clock
            .sleep(30000, attempt.controller.signal)
            .then(() =>
              serial(async () => {
                if (pending.has(id)) await updateSend(id, "uncertain");
              }),
            )
            .catch(() => {});
      }
    }
  };
  const markRead = async (c: Conversation, lastId: MessageId) => {
    const message = timeline(c).messages.find((entry) => entry.id === lastId);
    if (!message) return;
    const previous = readPositions.get(c.view.id);
    const readAt = message.serverTime ?? message.receivedAt;
    if (
      previous &&
      (previous.readAt > readAt || (previous.messageId === message.id && c.view.unreadCount === 0))
    )
      return;
    const position = { conversationId: c.view.id, messageId: message.id, readAt };
    readPositions.set(c.view.id, position);
    c.view = { ...c.view, unreadCount: 0, mentionCount: 0 };
    const { firstUnreadId: _unread, ...rest } = timeline(c);
    c.model.publish(rest);
    await persist([], [position]);
    const network = networks.get(c.view.networkId);
    if (network?.features.readMarkers && message.serverTime !== undefined) {
      const id = deps.ids.next<"operation">();
      try {
        await execute(
          c.view.networkId,
          { type: "mark-read", target: c.view.name, serverTime: message.serverTime },
          id,
        );
      } catch {
        /* Local reading must work without server sync. */
      }
    }
  };
  const statusMessage = async (networkId: NetworkId, text: string) => {
    const c = ensureConversation(networkId, "status", profile(networkId).name);
    const message: Message = {
      id: deps.ids.next<"message">(),
      conversationId: c.view.id,
      networkId,
      sender: { nick: "OpenIRC" },
      kind: "event",
      text: plainText(text),
      receivedAt: deps.clock.now(),
      source: "local",
      reactions: [],
      redacted: false,
    };
    putMessages(c, [message]);
    await persist([message]);
  };

  const handleEvent = async (event: SessionEvent) => {
    const attempt = attempts.get(event.networkId);
    if (!attempt) return;
    const admission = admitSessionEvent(attempt.cursor, event);
    if (!admission.accepted) {
      if (admission.reason === "sequence-gap") {
        attempt.error = error(
          "internal",
          "Connection events were interrupted. Reconnect to recover.",
        );
        report(attempt.error, event.networkId);
        attempt.controller.abort();
        void attempt.session?.close();
      }
      return;
    }
    attempt.cursor = admission.cursor;
    const payload = event.payload;
    const networkId = event.networkId;
    const network = networks.get(networkId);
    if (!network) return;
    switch (payload.type) {
      case "state": {
        networks.set(networkId, {
          ...network,
          phase: payload.phase,
          nick: plainText(payload.nick),
          secure: payload.secure,
          authenticated: payload.authenticated,
        });
        if (payload.phase === "ready" && network.phase !== "ready") {
          retryCounts.set(networkId, 0);
          for (const join of profile(networkId).autoJoin) {
            const c = ensureConversation(networkId, "channel", join.channel);
            const id = deps.ids.next<"operation">();
            const result = await attempt.session!.execute(
              { type: "join", channel: c.view.name, ...(join.key ? { key: join.key } : {}) },
              id,
              attempt.controller.signal,
            );
            if (!result.ok) report(result.error, networkId);
          }
        }
        break;
      }
      case "support": {
        support.set(networkId, payload.support);
        networks.set(networkId, { ...network, features: payload.features });
        const directory = users.get(networkId);
        if (directory) {
          const next = new Map<string, UserView>();
          for (const value of directory.values()) {
            const key = foldIdentifier(value.nick, payload.support.casemapping);
            if (next.has(key) && next.get(key)!.id !== value.id)
              reject("conflict", "Server identifier rules produced a user collision.");
            next.set(key, value);
          }
          users.set(networkId, next);
        }
        const seen = new Set<string>();
        for (const c of conversations.values())
          if (c.view.networkId === networkId) {
            const key = `${c.view.kind}:${foldIdentifier(c.view.name, payload.support.casemapping)}`;
            if (seen.has(key))
              reject("conflict", "Server identifier rules produced a conversation collision.");
            seen.add(key);
          }
        break;
      }
      case "chat": {
        const incoming = payload.message;
        const isChannel = (support.get(networkId)?.channelTypes ?? "#&").includes(
          incoming.target[0] ?? "",
        );
        const own = same(networkId, incoming.sender.nick, network.nick);
        const name = isChannel || own ? incoming.target : incoming.sender.nick;
        const c = ensureConversation(networkId, isChannel ? "channel" : "direct", name);
        const local = incoming.operationId ? pending.get(incoming.operationId) : undefined;
        let existing = local && (findMessage(local.messageId)?.message ?? local.message);
        if (!existing && incoming.serverId) {
          existing = timeline(c).messages.find(
            (message) => message.networkId === networkId && message.serverId === incoming.serverId,
          );
          if (!existing) {
            const stored = await deps.history.findByServerId(
              networkId,
              incoming.serverId,
              lifetime.signal,
            );
            if (stored.ok) existing = stored.value ?? undefined;
            else report(stored.error);
          }
        }
        const sender = user(networkId, incoming.sender.nick);
        const message: Message = {
          ...existing,
          id: existing?.id ?? deps.ids.next<"message">(),
          conversationId: c.view.id,
          networkId,
          sender: {
            nick: sender.nick,
            userId: sender.id,
            ...(incoming.sender.account ? { account: incoming.sender.account } : {}),
          },
          kind: incoming.kind,
          text: existing?.redacted ? "" : plainText(incoming.text),
          receivedAt: existing?.receivedAt ?? incoming.receivedAt,
          ...(incoming.serverTime !== undefined ? { serverTime: incoming.serverTime } : {}),
          ...(incoming.serverId ? { serverId: incoming.serverId } : {}),
          ...(incoming.replyToServerId ? { replyTo: { serverId: incoming.replyToServerId } } : {}),
          source: incoming.source,
          reactions: existing?.reactions ?? [],
          redacted: existing?.redacted ?? false,
          ...(local ? { sendState: "echo-observed" as const } : {}),
        };
        putMessages(c, [message]);
        await persist([message]);
        if (local && incoming.operationId) {
          pending.delete(incoming.operationId);
          operation(incoming.operationId, "completed");
        }
        const visible = visibility.get(c.view.id);
        const seen =
          active === c.view.id &&
          visible?.focused &&
          visible.atBottom &&
          timeline(c).atLatest !== false;
        const isNew =
          !existing &&
          !own &&
          (incoming.source === "live" ||
            (readPositions.has(c.view.id) &&
              (incoming.serverTime ?? incoming.receivedAt) > readPositions.get(c.view.id)!.readAt));
        if (seen) await markRead(c, message.id);
        else if (isNew) {
          const mention =
            c.view.kind === "direct" ||
            mentionsNick(message.text, network.nick, mapping(networkId));
          c.view = {
            ...c.view,
            unreadCount: c.view.unreadCount + 1,
            mentionCount: c.view.mentionCount + (mention ? 1 : 0),
          };
          if (!timeline(c).firstUnreadId) updateTimeline(c, { firstUnreadId: message.id });
          if (
            mention &&
            !c.view.muted &&
            incoming.source === "live" &&
            settings.user.notifications.desktop
          ) {
            const result = await deps.notifications.notify({
              title: `${message.sender.nick} · ${c.view.name}`,
              conversationId: c.view.id,
              ...(settings.user.notifications.previews ? { body: message.text.slice(0, 240) } : {}),
            });
            if (!result.ok && result.error.code !== "unsupported") report(result.error);
          }
        }
        break;
      }
      case "membership": {
        const c =
          findConversation(networkId, payload.channel, "channel") ??
          ensureConversation(networkId, "channel", payload.channel);
        if (payload.change.kind === "join" && same(networkId, payload.change.nick, network.nick))
          c.closed = false;
        const member = user(networkId, payload.change.nick);
        const remaining = timeline(c).members.filter((value) => value.id !== member.id);
        if (payload.change.kind !== "remove") {
          if (remaining.length >= MAX_MEMBERS)
            reject("rate-limited", "Channel member limit exceeded.");
          remaining.push({ ...member, prefixes: payload.change.prefixes });
        }
        updateTimeline(c, { members: remaining });
        if (same(networkId, payload.change.nick, network.nick))
          c.view = { ...c.view, joined: payload.change.kind !== "remove" };
        break;
      }
      case "topic": {
        const c =
          findConversation(networkId, payload.channel, "channel") ??
          ensureConversation(networkId, "channel", payload.channel);
        c.view = { ...c.view, topic: plainText(payload.text) };
        break;
      }
      case "nick": {
        const old = user(networkId, payload.previous);
        const renamed = { ...old, nick: plainText(payload.next) };
        const directory = users.get(networkId)!;
        directory.delete(foldIdentifier(payload.previous, mapping(networkId)));
        directory.set(foldIdentifier(payload.next, mapping(networkId)), renamed);
        for (const c of conversations.values())
          if (c.view.networkId === networkId) {
            updateTimeline(c, {
              members: timeline(c).members.map((member) =>
                member.id === old.id ? { ...member, nick: renamed.nick } : member,
              ),
            });
            if (c.view.kind === "direct" && same(networkId, c.view.name, payload.previous))
              c.view = { ...c.view, name: renamed.nick };
          }
        if (same(networkId, network.nick, payload.previous))
          networks.set(networkId, { ...network, nick: renamed.nick });
        await persist();
        break;
      }
      case "quit": {
        const value = users.get(networkId)?.get(foldIdentifier(payload.nick, mapping(networkId)));
        if (value)
          for (const c of conversations.values())
            if (c.view.networkId === networkId)
              updateTimeline(c, {
                members: timeline(c).members.filter((member) => member.id !== value.id),
                typing: timeline(c).typing.filter((id) => id !== value.id),
              });
        users.get(networkId)?.delete(foldIdentifier(payload.nick, mapping(networkId)));
        break;
      }
      case "away":
      case "account": {
        const previous = user(networkId, payload.nick);
        let value: UserView;
        if (payload.type === "away") value = { ...previous, away: payload.away };
        else {
          const { account: _account, ...rest } = previous;
          value = { ...rest, ...(payload.account ? { account: plainText(payload.account) } : {}) };
        }
        users.get(networkId)!.set(foldIdentifier(payload.nick, mapping(networkId)), value);
        for (const c of conversations.values())
          if (c.view.networkId === networkId)
            updateTimeline(c, {
              members: timeline(c).members.map((member) =>
                member.id === value.id ? { ...value, prefixes: member.prefixes } : member,
              ),
            });
        break;
      }
      case "send-state":
        await updateSend(payload.operationId, payload.state, payload.error);
        break;
      case "error": {
        if (!payload.operationId) attempt.error = payload.error;
        report(payload.error, networkId);
        if (payload.operationId) {
          operation(payload.operationId, "failed", payload.error);
          await updateSend(payload.operationId, "failed", payload.error);
          const read = discovery(networkId);
          const current = read.readable.getSnapshot();
          read.publish({
            ...current,
            ...(current.directory.operationId === payload.operationId
              ? {
                  directory: {
                    ...current.directory,
                    state: "failed" as const,
                    error: payload.error,
                  },
                }
              : {}),
            ...(current.user.operationId === payload.operationId
              ? { user: { ...current.user, state: "failed" as const, error: payload.error } }
              : {}),
          });
        }
        await statusMessage(networkId, payload.error.message);
        break;
      }
      case "notice":
        await statusMessage(networkId, payload.text);
        break;
      case "directory-item": {
        const read = discovery(networkId);
        const current = read.readable.getSnapshot();
        if (current.directory.operationId !== payload.operationId) break;
        const items = current.directory.items;
        read.publish({
          ...current,
          directory: {
            ...current.directory,
            items:
              items.length < 5000
                ? [
                    ...items,
                    {
                      ...payload.item,
                      channel: plainText(payload.item.channel),
                      topic: plainText(payload.item.topic),
                    },
                  ]
                : items,
            truncated: items.length >= 5000,
          },
        });
        break;
      }
      case "directory-complete": {
        const read = discovery(networkId);
        const current = read.readable.getSnapshot();
        if (current.directory.operationId === payload.operationId)
          read.publish({ ...current, directory: { ...current.directory, state: "ready" } });
        operation(payload.operationId, "completed");
        break;
      }
      case "user-details": {
        const read = discovery(networkId);
        const current = read.readable.getSnapshot();
        if (current.user.operationId === payload.operationId)
          read.publish({
            ...current,
            user: { state: "ready", operationId: payload.operationId, details: payload.details },
          });
        operation(payload.operationId, "completed");
        break;
      }
      case "history-complete":
        operation(payload.operationId, "completed");
        break;
      case "typing": {
        const c =
          findConversation(networkId, payload.target) ??
          ensureConversation(networkId, "direct", payload.nick);
        const value = user(networkId, payload.nick);
        const key = `${c.view.id}:${value.id}`;
        typingControllers.get(key)?.abort();
        typingControllers.delete(key);
        updateTimeline(c, {
          typing: payload.active
            ? [...new Set([...timeline(c).typing, value.id])]
            : timeline(c).typing.filter((id) => id !== value.id),
        });
        if (payload.active) {
          const controller = new AbortController();
          typingControllers.set(key, controller);
          void deps.clock
            .sleep(10000, controller.signal)
            .then(() =>
              serial(() => {
                if (typingControllers.get(key) !== controller) return;
                typingControllers.delete(key);
                updateTimeline(c, { typing: timeline(c).typing.filter((id) => id !== value.id) });
              }),
            )
            .catch(() => {});
        }
        break;
      }
      case "reaction":
      case "redaction": {
        const c = findConversation(networkId, payload.target);
        if (!c) break;
        let message = timeline(c).messages.find((m) => m.serverId === payload.serverId);
        if (!message) {
          const found = await deps.history.findByServerId(
            networkId,
            payload.serverId,
            lifetime.signal,
          );
          if (found.ok) message = found.value ?? undefined;
        }
        if (!message) break;
        if (payload.type === "redaction") {
          message = { ...message, redacted: true, text: "", reactions: [] };
          reactions.delete(message.id);
        } else if (!message.redacted) {
          let grouped = reactions.get(message.id);
          if (!grouped) {
            grouped = new Map();
            reactions.set(message.id, grouped);
          }
          const value = user(networkId, payload.nick);
          let members = grouped.get(payload.value);
          if (!members) {
            members = new Set();
            grouped.set(payload.value, members);
          }
          if (payload.remove) members.delete(value.id);
          else members.add(value.id);
          message = {
            ...message,
            reactions: [...grouped]
              .filter(([, set]) => set.size)
              .map(([reaction, set]) => ({
                value: plainText(reaction),
                count: set.size,
                reactedBySelf: [...set].some(
                  (id) =>
                    users.get(networkId)?.get(foldIdentifier(network.nick, mapping(networkId)))
                      ?.id === id,
                ),
              })),
          };
        }
        putMessages(c, [message]);
        await persist([message]);
        break;
      }
      case "read-marker": {
        const c = findConversation(networkId, payload.target);
        const message =
          c &&
          timeline(c)
            .messages.filter((m) => (m.serverTime ?? m.receivedAt) <= payload.serverTime)
            .at(-1);
        if (c && message) await markRead(c, message.id);
        break;
      }
    }
    publish();
  };

  const finishAttempt = async (networkId: NetworkId, attempt: Attempt) => {
    if (attempts.get(networkId) !== attempt || stopping) return;
    for (const [id, entry] of pending)
      if (conversations.get(entry.conversationId)?.view.networkId === networkId) {
        const found = findMessage(entry.messageId);
        await updateSend(
          id,
          found?.message.sendState === "pending" ? "failed" : "uncertain",
          attempt.error,
        );
      }
    for (const c of conversations.values())
      if (c.view.networkId === networkId) {
        c.view = { ...c.view, joined: false };
        updateTimeline(c, { members: [], typing: [] });
      }
    users.delete(networkId);
    const view = networks.get(networkId)!;
    networks.set(networkId, {
      ...view,
      phase: "disconnected",
      authenticated: false,
      features: FEATURES,
    });
    if (
      attempt.error &&
      ["authentication", "tls", "invalid-input", "unsupported", "conflict"].includes(
        attempt.error.code,
      )
    ) {
      publish();
      return;
    }
    const count = (retryCounts.get(networkId) ?? 0) + 1;
    retryCounts.set(networkId, count);
    const delay =
      Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)) + ((attempt.generation * 137) % 500);
    networks.set(networkId, { ...networks.get(networkId)!, phase: "reconnecting" });
    publish();
    void deps.clock
      .sleep(delay, attempt.controller.signal)
      .then(() =>
        serial(() => {
          if (attempts.get(networkId) === attempt && !stopping) startNetwork(networkId);
        }),
      )
      .catch(() => {});
  };
  const startNetwork = (networkId: NetworkId) => {
    const p = profile(networkId);
    const old = attempts.get(networkId);
    old?.controller.abort();
    if (old?.session) void old.session.close();
    const generation = (generations.get(networkId) ?? 0) + 1;
    generations.set(networkId, generation);
    const identity = { networkId, generation };
    const attempt: Attempt = {
      generation,
      controller: new AbortController(),
      cursor: startSessionCursor(identity),
    };
    attempts.set(networkId, attempt);
    support.delete(networkId);
    const { lastError: _last, ...view } = networks.get(networkId)!;
    networks.set(networkId, {
      ...view,
      phase: "connecting",
      secure: false,
      authenticated: false,
      features: FEATURES,
    });
    publish();
    void (async () => {
      let opened: Result<IrcSession>;
      try {
        opened = await deps.sessions.open(p, identity, attempt.controller.signal);
      } catch {
        opened = { ok: false, error: error("network", "Unable to start the connection.", true) };
      }
      if (attempts.get(networkId) !== attempt || stopping || attempt.controller.signal.aborted) {
        if (opened.ok) await opened.value.close();
        return;
      }
      if (!opened.ok) {
        attempt.error = opened.error;
        await serial(async () => {
          report(opened.error, networkId);
          await finishAttempt(networkId, attempt);
        });
        return;
      }
      attempt.session = opened.value;
      try {
        for await (const event of opened.value.events) {
          if (stopping) break;
          await serial(async () => {
            try {
              await handleEvent(event);
            } catch (cause) {
              attempt.error = safeError(cause);
              report(attempt.error, networkId);
              attempt.controller.abort();
              void opened.value.close();
              publish();
            }
          });
        }
      } catch {
        attempt.error = error("network", "Connection ended unexpectedly.", true);
      }
      await serial(() => finishAttempt(networkId, attempt));
    })();
  };
  const disconnect = async (networkId: NetworkId) => {
    const attempt = attempts.get(networkId);
    attempts.delete(networkId);
    attempt?.controller.abort();
    if (attempt?.session) {
      const result = await attempt.session.close("Leaving OpenIRC");
      if (!result.ok) report(result.error, networkId);
    }
    for (const [id, entry] of pending)
      if (conversations.get(entry.conversationId)?.view.networkId === networkId)
        await updateSend(id, "uncertain");
    const network = networks.get(networkId);
    if (network)
      networks.set(networkId, {
        ...network,
        phase: "disconnected",
        authenticated: false,
        features: FEATURES,
      });
    for (const c of conversations.values())
      if (c.view.networkId === networkId) {
        c.view = { ...c.view, joined: false };
        updateTimeline(c, { members: [], typing: [] });
      }
    users.delete(networkId);
    publish();
  };

  const dispatch = async (action: AppAction, signal: AbortSignal): Promise<Result<ActionReceipt>> =>
    serial(async () => {
      let id: OperationId | undefined;
      const ephemeral =
        action.type === "draft.set" ||
        action.type === "view.report" ||
        action.type === "typing.set";
      let publishAfter = !ephemeral;
      try {
        if (stopping) reject("unavailable", "OpenIRC is shutting down.");
        if (signal.aborted) reject("cancelled", "Operation cancelled.");
        id = ephemeral ? deps.ids.next<"operation">() : newOperation();
        let result: Omit<ActionReceipt, "operationId"> = {};
        let deferred = false;
        switch (action.type) {
          case "network.connect":
            profile(action.networkId);
            if (
              !attempts.has(action.networkId) ||
              networks.get(action.networkId)?.phase === "disconnected"
            )
              startNetwork(action.networkId);
            break;
          case "network.disconnect":
            profile(action.networkId);
            await disconnect(action.networkId);
            break;
          case "network.reconnect":
            profile(action.networkId);
            await disconnect(action.networkId);
            startNetwork(action.networkId);
            break;
          case "conversation.join": {
            if (!/^[#&+!][^\s,\r\n\u0000]+$/u.test(action.channel) || action.channel.length > 200)
              reject("invalid-input", "Enter a valid channel name, such as #welcome.");
            await execute(
              action.networkId,
              { type: "join", channel: action.channel, ...(action.key ? { key: action.key } : {}) },
              id,
            );
            const c = ensureConversation(action.networkId, "channel", action.channel);
            active = c.view.id;
            result = { conversationId: c.view.id };
            await loadRecent(c);
            await persist();
            await saveWorkspace();
            break;
          }
          case "conversation.query": {
            profile(action.networkId);
            if (!action.nick || /[\s,\r\n\u0000]/u.test(action.nick) || action.nick.length > 100)
              reject("invalid-input", "Enter a valid nickname.");
            const c = ensureConversation(action.networkId, "direct", action.nick);
            active = c.view.id;
            result = { conversationId: c.view.id };
            await loadRecent(c);
            await persist();
            await saveWorkspace();
            break;
          }
          case "conversation.activate": {
            const c = getConversation(action.conversationId);
            active = c.view.id;
            await loadRecent(c);
            result = { conversationId: c.view.id };
            await saveWorkspace();
            break;
          }
          case "conversation.close": {
            const c = getConversation(action.conversationId);
            if ([...pending.values()].some((entry) => entry.conversationId === c.view.id))
              reject("unavailable", "Wait for pending sends before closing this conversation.");
            if (c.view.kind === "status")
              reject(
                "invalid-input",
                "Network status stays available while the network is configured.",
              );
            if (c.view.kind === "channel" && c.view.joined)
              await execute(c.view.networkId, { type: "part", channel: c.view.name }, id);
            c.closed = true;
            c.recent = [];
            c.view = { ...c.view, joined: false };
            updateTimeline(c, { messages: [], members: [], typing: [] });
            c.loaded = false;
            if (active === c.view.id)
              active = [...conversations.values()].find((value) => !value.closed)?.view.id;
            await saveWorkspace();
            break;
          }
          case "conversation.mute": {
            const c = getConversation(action.conversationId);
            c.view = { ...c.view, muted: action.muted };
            await saveWorkspace();
            break;
          }
          case "draft.set": {
            const c = getConversation(action.conversationId);
            if (action.text.length > MAX_INPUT) reject("invalid-input", "Draft is too large.");
            if (timeline(c).draft !== action.text) updateTimeline(c, { draft: action.text });
            break;
          }
          case "message.send": {
            const c = getConversation(action.conversationId);
            if (c.view.kind === "status")
              reject("invalid-input", "Choose a channel or direct conversation to send a message.");
            if (
              !action.text.trim() ||
              action.text.length > MAX_INPUT ||
              /[\r\u0000]/u.test(action.text)
            )
              reject(
                "invalid-input",
                "Message is empty, too large, or contains unsupported control characters.",
              );
            if (c.view.kind === "channel" && !c.view.joined)
              reject("unavailable", "Join this channel before sending.");
            const network = networks.get(c.view.networkId)!;
            let replyTo: Message["replyTo"];
            if (action.replyTo) {
              const original = findMessage(action.replyTo);
              if (!network.features.replies || !original?.message.serverId || original.c !== c)
                reject("unsupported", "Replies are unavailable for this message.");
              replyTo = { serverId: original.message.serverId, localId: original.message.id };
            }
            if (!attempts.get(c.view.networkId)?.session || network.phase !== "ready")
              reject("unavailable", "Connect to this network before sending.");
            const message: Message = {
              id: deps.ids.next<"message">(),
              conversationId: c.view.id,
              networkId: c.view.networkId,
              sender: { nick: network.nick },
              kind: action.kind,
              text: plainText(action.text),
              receivedAt: deps.clock.now(),
              source: "local",
              sendState: "pending",
              reactions: [],
              redacted: false,
              ...(replyTo ? { replyTo } : {}),
            };
            updateTimeline(c, { atLatest: true, messages: c.recent });
            putMessages(c, [message]);
            pending.set(id, { conversationId: c.view.id, messageId: message.id, message });
            await persist([message]);
            try {
              await execute(
                c.view.networkId,
                {
                  type: "send",
                  target: c.view.name,
                  text: action.text,
                  kind: action.kind,
                  ...(replyTo ? { replyToServerId: replyTo.serverId } : {}),
                },
                id,
              );
            } catch (cause) {
              await updateSend(id, "failed", safeError(cause));
              throw cause;
            }
            updateTimeline(c, { draft: "" });
            result = { conversationId: c.view.id, messageId: message.id };
            deferred = true;
            break;
          }
          case "irc.request": {
            const read = discovery(action.networkId);
            const current = read.readable.getSnapshot();
            if (action.command.type === "list")
              read.publish({
                ...current,
                directory: { state: "loading", operationId: id, items: [], truncated: false },
              });
            if (action.command.type === "whois")
              read.publish({ ...current, user: { state: "loading", operationId: id } });
            await execute(action.networkId, action.command, id);
            deferred = action.command.type === "list" || action.command.type === "whois";
            break;
          }
          case "message.react":
          case "message.redact": {
            const found = findMessage(action.messageId);
            if (!found?.message.serverId || found.message.redacted)
              reject("unsupported", "This message cannot be changed.");
            const network = networks.get(found.message.networkId)!;
            if (action.type === "message.react") {
              if (
                !network.features.reactions ||
                !action.value ||
                action.value.length > 64 ||
                /[\s\u0000-\u001f]/u.test(action.value)
              )
                reject("unsupported", "Reactions are unavailable or invalid.");
              await execute(
                network.id,
                {
                  type: "reaction",
                  target: found.c.view.name,
                  serverId: found.message.serverId,
                  value: action.value,
                  remove: action.remove,
                },
                id,
              );
            } else {
              if (!network.features.redaction)
                reject("unsupported", "Message removal is unavailable on this network.");
              if (!same(network.id, found.message.sender.nick, network.nick))
                reject("invalid-input", "Only your own messages can be removed here.");
              await execute(
                network.id,
                { type: "redact", target: found.c.view.name, serverId: found.message.serverId },
                id,
              );
            }
            break;
          }
          case "typing.set": {
            const c = getConversation(action.conversationId);
            if (settings.user.sendTyping && networks.get(c.view.networkId)?.features.typing)
              await execute(
                c.view.networkId,
                { type: "typing", target: c.view.name, active: action.active },
                id,
              );
            break;
          }
          case "history.load-older": {
            const c = getConversation(action.conversationId);
            updateTimeline(c, { loadingOlder: true });
            try {
              const page = requireResult(
                await deps.history.page(
                  c.view.id,
                  { limit: PAGE_SIZE, ...(action.cursor ? { cursor: action.cursor } : {}) },
                  lifetime.signal,
                ),
              );
              // A history window shifts toward the requested older page rather than discarding it at the hot cap.
              const combined = mergeWindow(
                page.items,
                timeline(c).messages,
                Number.MAX_SAFE_INTEGER,
              );
              const first = page.items[0];
              const offset = first ? combined.findIndex((message) => message.id === first.id) : 0;
              const { olderCursor: _older, ...base } = timeline(c);
              c.model.publish({
                ...base,
                messages: combined.slice(Math.max(0, offset), Math.max(0, offset) + WINDOW),
                ...(page.nextCursor ? { olderCursor: page.nextCursor } : {}),
                loadingOlder: false,
                atLatest: false,
              });
              if (
                !page.nextCursor &&
                networks.get(c.view.networkId)?.features.history &&
                c.view.kind !== "status"
              ) {
                const oldest = timeline(c).messages[0];
                await execute(
                  c.view.networkId,
                  {
                    type: "history",
                    target: c.view.name,
                    limit: PAGE_SIZE,
                    ...(oldest?.serverId
                      ? { before: { serverId: oldest.serverId } }
                      : oldest?.serverTime !== undefined
                        ? { before: { serverTime: oldest.serverTime } }
                        : {}),
                  },
                  id,
                );
                deferred = true;
              }
            } finally {
              updateTimeline(c, { loadingOlder: false });
            }
            break;
          }
          case "history.latest": {
            const c = getConversation(action.conversationId);
            c.loaded = false;
            await loadRecent(c);
            result = { conversationId: c.view.id };
            break;
          }
          case "history.reveal": {
            const context = requireResult(
              await deps.history.context(action.messageId, 40, lifetime.signal),
            );
            const message = context.find((value) => value.id === action.messageId);
            if (!message) reject("unavailable", "Message is no longer stored.");
            const c = conversations.get(message.conversationId);
            if (!c) reject("unavailable", "Conversation is no longer configured.");
            c.closed = false;
            active = c.view.id;
            updateTimeline(c, { messages: context, atLatest: false });
            c.loaded = true;
            result = { conversationId: c.view.id, messageId: message.id };
            break;
          }
          case "history.delete": {
            const c = getConversation(action.conversationId);
            requireResult(await deps.history.deleteConversation(c.view.id, lifetime.signal));
            readPositions.delete(c.view.id);
            c.view = { ...c.view, unreadCount: 0, mentionCount: 0 };
            const { firstUnreadId: _unread, olderCursor: _older, ...base } = timeline(c);
            c.recent = [];
            c.model.publish({ ...base, messages: [], atLatest: true });
            break;
          }
          case "view.report": {
            const c = getConversation(action.conversationId);
            visibility.set(c.view.id, { focused: action.focused, atBottom: action.atBottom });
            if (
              active === c.view.id &&
              timeline(c).atLatest !== false &&
              action.focused &&
              action.atBottom &&
              action.lastVisibleMessageId &&
              timeline(c).messages.at(-1)?.id === action.lastVisibleMessageId
            ) {
              publishAfter = c.view.unreadCount > 0 || c.view.mentionCount > 0;
              await markRead(c, action.lastVisibleMessageId);
            }
            break;
          }
        }
        if (!deferred && !ephemeral) operation(id, "completed");
        if (publishAfter) publish();
        return ok({ operationId: id, ...result });
      } catch (cause) {
        const detail = safeError(cause);
        if (id && !ephemeral)
          operation(id, detail.code === "cancelled" ? "cancelled" : "failed", detail);
        report(detail);
        publish();
        return { ok: false, error: detail };
      }
    });

  const api: AppApi = {
    state: state.readable,
    settings: settingsModel.readable,
    operations: operations.readable,
    timeline(id) {
      const c = conversations.get(id);
      return c && !c.closed
        ? ok(c.model.readable)
        : { ok: false, error: error("unavailable", "Conversation is not open.") };
    },
    discovery(id) {
      return networks.has(id)
        ? ok(discovery(id).readable)
        : { ok: false, error: error("unavailable", "Network is not configured.") };
    },
    dispatch,
    async search(query, signal) {
      if (stopping) return { ok: false, error: error("unavailable", "OpenIRC is shutting down.") };
      return deps.history.search(query, signal);
    },
    saveSettings(change, expectedRevision, signal) {
      return serial(async () => {
        let id: OperationId | undefined;
        try {
          if (stopping) reject("unavailable", "OpenIRC is shutting down.");
          if (signal.aborted) reject("cancelled", "Operation cancelled.");
          id = newOperation();
          if (change.section === "user")
            for (const p of change.value.networks) {
              if (!p.endpoints.length || (p.sasl && p.endpoints.some((endpoint) => !endpoint.tls)))
                reject("invalid-input", "Authentication requires verified TLS for every endpoint.");
            }
          const saved = requireResult(await deps.settings.save(change, expectedRevision, signal));
          const previousIds = new Set(settings.user.networks.map((p) => p.id));
          settings = saved;
          settingsModel.publish(saved);
          for (const id of previousIds)
            if (!saved.user.networks.some((p) => p.id === id)) {
              await disconnect(id);
              networks.delete(id);
              for (const c of conversations.values())
                if (c.view.networkId === id) {
                  c.closed = true;
                  if (active === c.view.id) active = undefined;
                }
            }
          for (const p of saved.user.networks)
            if (!networks.has(p.id)) {
              networks.set(p.id, {
                id: p.id,
                name: p.name,
                phase: "disconnected",
                nick: p.identity.nick,
                secure: false,
                authenticated: false,
                features: FEATURES,
              });
              const c = ensureConversation(p.id, "status", p.name);
              if (!active) active = c.view.id;
              if (p.autoConnect) startNetwork(p.id);
            } else networks.set(p.id, { ...networks.get(p.id)!, name: p.name });
          await persist();
          await saveWorkspace();
          operation(id, "completed");
          publish();
          return ok(id);
        } catch (cause) {
          const detail = safeError(cause);
          if (id) operation(id, "failed", detail);
          report(detail);
          publish();
          return { ok: false, error: detail };
        }
      });
    },
    async storeSecret(value, signal) {
      if (stopping) return { ok: false, error: error("unavailable", "OpenIRC is shutting down.") };
      return deps.secrets.store(value, signal);
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        stopping = true;
        rootSignal.removeEventListener("abort", onAbort);
        for (const controller of typingControllers.values()) controller.abort();
        typingControllers.clear();
        let failure: AppError | undefined;
        const closing = [...attempts.values()];
        attempts.clear();
        for (const attempt of closing) attempt.controller.abort();
        await Promise.all(
          closing.map(async (attempt) => {
            try {
              const result = await attempt.session?.close("Leaving OpenIRC");
              if (result && !result.ok) failure = result.error;
            } catch {
              failure = error("network", "A connection did not close cleanly.");
            }
          }),
        );
        await tail;
        if (boot === "ready") {
          for (const [id] of pending) await updateSend(id, "uncertain");
          const workspace = await saveWorkspace();
          if (!workspace.ok) failure = workspace.error;
        }
        lifetime.abort();
        try {
          const closed = await deps.history.close();
          if (!closed.ok) failure = closed.error;
        } catch {
          failure = error("storage", "History could not be closed safely.");
        }
        state.dispose();
        settingsModel.dispose();
        operations.dispose();
        for (const c of conversations.values()) c.model.dispose();
        for (const read of discoveries.values()) read.dispose();
        return failure ? { ok: false, error: failure } : ok(undefined);
      })();
      return shutdownPromise;
    },
  };
  function onAbort() {
    void api.shutdown();
  }
  rootSignal.addEventListener("abort", onAbort, { once: true });
  try {
    if (rootSignal.aborted) reject("cancelled", "Startup cancelled.");
    settings = requireResult(await deps.settings.load(rootSignal));
    settingsModel.publish(settings);
    for (const p of settings.user.networks)
      networks.set(p.id, {
        id: p.id,
        name: p.name,
        phase: "disconnected",
        nick: p.identity.nick,
        secure: false,
        authenticated: false,
        features: FEATURES,
      });
    const records = requireResult(await deps.history.loadConversations(rootSignal));
    const workspace = requireResult(await deps.history.loadWorkspace(rootSignal));
    for (const record of records)
      if (networks.has(record.networkId)) {
        const c = createConversation(record);
        c.closed = !workspace.conversationOrder.includes(record.id);
        c.view = { ...c.view, muted: workspace.mutedConversations.includes(record.id) };
      }
    for (const position of requireResult(await deps.history.loadReadPositions(rootSignal)))
      readPositions.set(position.conversationId, position);
    for (const p of settings.user.networks) ensureConversation(p.id, "status", p.name);
    for (const draft of workspace.drafts) {
      const c = conversations.get(draft.conversationId);
      if (c && settings.user.history.persistDrafts && canPersist(c))
        updateTimeline(c, { draft: draft.text });
    }
    active =
      workspace.activeConversationId && !conversations.get(workspace.activeConversationId)?.closed
        ? workspace.activeConversationId
        : [...conversations.values()].find((c) => !c.closed)?.view.id;
    const retention = settings.user.history.retentionDays;
    if (retention !== null) {
      const pruned = await deps.history.prune(deps.clock.now() - retention * 86400000, rootSignal);
      if (!pruned.ok) report(pruned.error);
    }
    if (active && conversations.has(active)) await loadRecent(conversations.get(active)!);
    if (rootSignal.aborted || stopping) reject("cancelled", "Startup cancelled.");
    boot = "ready";
    await persist();
    await saveWorkspace();
    publish();
    for (const p of settings.user.networks) if (p.autoConnect) startNetwork(p.id);
    return ok(api);
  } catch (cause) {
    const detail = safeError(cause);
    boot = "failed";
    await api.shutdown();
    return { ok: false, error: detail };
  }
};
