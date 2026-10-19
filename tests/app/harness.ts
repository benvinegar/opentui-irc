import type { AppDependencies } from "../../src/contracts/runtime";
import type { AppError, Id, NetworkId, Result } from "../../src/contracts/common";
import { entityId } from "../../src/contracts/common";
import type { Message } from "../../src/contracts/model";
import type {
  IrcSession,
  SessionCommand,
  SessionEvent,
  SessionIdentity,
  SessionPayload,
} from "../../src/contracts/session";
import type { ConversationRecord, ReadPosition, WorkspaceState } from "../../src/contracts/storage";
import type { SettingsDocument } from "../../src/contracts/settings";
import { settings as fixtureSettings } from "../fixtures/scenario";

export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const failure = (
  code: AppError["code"],
  message = "Expected test failure",
): Result<never> => ({ ok: false, error: { code, message, retryable: false } });

export class FakeSession implements IrcSession {
  private queue: SessionEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private sequence = 0;
  readonly commands: { command: SessionCommand; operationId: string }[] = [];
  executeResult: Result<void> = success(undefined);
  readonly events: AsyncIterable<SessionEvent>;
  constructor(readonly identity: SessionIdentity) {
    this.events = { [Symbol.asyncIterator]: () => this.stream() };
  }
  private async *stream() {
    while (!this.done || this.queue.length) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
  emit(payload: SessionPayload, identity: Partial<SessionIdentity> = {}) {
    if (this.done) return;
    this.queue.push({ ...this.identity, ...identity, sequence: ++this.sequence, payload });
    this.wake?.();
    this.wake = undefined;
  }
  async execute(command: SessionCommand, operationId: Id<"operation">, signal: AbortSignal) {
    if (signal.aborted) return failure("cancelled");
    this.commands.push({ command, operationId });
    return this.executeResult;
  }
  async close() {
    this.done = true;
    this.wake?.();
    return success(undefined);
  }
}

export function harness(initialSettings: SettingsDocument = fixtureSettings) {
  let settings = structuredClone(initialSettings);
  let nextId = 0;
  let now = 1_700_000_001_000;
  const sessions: FakeSession[] = [];
  const messages = new Map<string, Message>();
  const records = new Map<string, ConversationRecord>();
  const readPositions = new Map<string, ReadPosition>();
  let workspace: WorkspaceState = { conversationOrder: [], mutedConversations: [], drafts: [] };
  let closed = 0;
  const sleeps: { due: number; resolve: () => void; signal: AbortSignal }[] = [];
  const notifications: unknown[] = [];
  const diagnostics: unknown[] = [];
  const deps: AppDependencies = {
    clock: {
      now: () => now,
      sleep(ms, signal) {
        return new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          const abort = () => reject(new Error("aborted"));
          signal.addEventListener("abort", abort, { once: true });
          sleeps.push({
            due: now + ms,
            signal,
            resolve: () => {
              signal.removeEventListener("abort", abort);
              resolve();
            },
          });
        });
      },
    },
    ids: { next: <Kind extends string>() => entityId<Kind>(`generated-${++nextId}`) },
    diagnostics: {
      record: (value) => {
        diagnostics.push(value);
      },
    },
    sessions: {
      async open(_profile, identity, signal) {
        const session = new FakeSession(identity);
        sessions.push(session);
        signal.addEventListener(
          "abort",
          () => {
            void session.close();
          },
          { once: true },
        );
        return success(session);
      },
    },
    notifications: {
      async notify(value) {
        notifications.push(value);
        return success(undefined);
      },
    },
    secrets: {
      async resolve() {
        return success("private-value");
      },
      async store() {
        return success(entityId<"secret-ref">("env:TEST"));
      },
    },
    settings: {
      async load() {
        return success(settings);
      },
      async save(change, revision, signal) {
        if (signal.aborted) return failure("cancelled");
        if (revision !== settings.revision) return failure("conflict");
        settings = {
          ...settings,
          [change.section]: change.value,
          revision: entityId<"config-revision">(`revision-${++nextId}`),
        };
        return success(settings);
      },
    },
    history: {
      async commit(batch) {
        for (const item of batch.conversations) records.set(item.id, item);
        for (const item of batch.messages) messages.set(item.id, item);
        for (const item of batch.readPositions) readPositions.set(item.conversationId, item);
        return success(undefined);
      },
      async page(id, options) {
        return success({
          items: [...messages.values()]
            .filter((message) => message.conversationId === id)
            .slice(-options.limit),
        });
      },
      async search(query) {
        return success({
          items: [...messages.values()].filter((message) => message.text.includes(query.text)),
        });
      },
      async context(id) {
        const message = messages.get(id);
        return message
          ? success(
              [...messages.values()].filter(
                (item) => item.conversationId === message.conversationId,
              ),
            )
          : failure("unavailable");
      },
      async findByServerId(networkId, conversationId, serverId) {
        return success(
          [...messages.values()].find(
            (message) =>
              message.networkId === networkId &&
              message.conversationId === conversationId &&
              message.serverId === serverId,
          ) ?? null,
        );
      },
      async loadConversations() {
        return success([...records.values()]);
      },
      async loadReadPositions() {
        return success([...readPositions.values()]);
      },
      async loadWorkspace() {
        return success(workspace);
      },
      async saveWorkspace(value) {
        workspace = value;
        return success(undefined);
      },
      async deleteConversation(id) {
        for (const message of messages.values())
          if (message.conversationId === id) messages.delete(message.id);
        readPositions.delete(id);
        return success(undefined);
      },
      async prune(before) {
        let count = 0;
        for (const message of messages.values())
          if ((message.serverTime ?? message.receivedAt) < before) {
            messages.delete(message.id);
            count++;
          }
        return success(count);
      },
      async close() {
        closed++;
        return success(undefined);
      },
    },
  };
  return {
    deps,
    sessions,
    messages,
    records,
    readPositions,
    notifications,
    diagnostics,
    get workspace() {
      return workspace;
    },
    get closed() {
      return closed;
    },
    advance(ms: number) {
      now += ms;
      for (const sleep of sleeps.splice(0)) {
        if (sleep.due <= now && !sleep.signal.aborted) sleep.resolve();
        else if (!sleep.signal.aborted) sleeps.push(sleep);
      }
    },
    session(networkId: NetworkId) {
      const value = sessions.filter((s) => s.identity.networkId === networkId).at(-1);
      if (!value) throw new Error("No session");
      return value;
    },
  };
}

export async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
