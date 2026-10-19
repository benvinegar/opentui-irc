import type {
  AppError,
  ConfigRevision,
  ConversationId,
  Cursor,
  MessageId,
  NetworkId,
  OperationId,
  Readable,
  Result,
  SecretRef,
} from "./common";
import type { AppSnapshot, TimelineSnapshot } from "./model";
import type { DiscoverySnapshot } from "./discovery";
import type { SettingsChange, SettingsDocument } from "./settings";
import type { SessionCommand } from "./session";
import type { Page, SearchQuery } from "./storage";
import type { Message } from "./model";

export type UserIrcCommand = Extract<
  SessionCommand,
  { readonly type: "nick" | "away" | "whois" | "list" | "topic" }
>;

/** All user intent flows through this union, whether initiated by mouse, keyboard or commands. */
export type AppAction =
  | {
      readonly type: "irc.request";
      readonly networkId: NetworkId;
      readonly command: UserIrcCommand;
    }
  | { readonly type: "network.connect"; readonly networkId: NetworkId }
  | { readonly type: "network.disconnect"; readonly networkId: NetworkId }
  | { readonly type: "network.reconnect"; readonly networkId: NetworkId }
  | { readonly type: "conversation.activate"; readonly conversationId: ConversationId }
  | { readonly type: "conversation.close"; readonly conversationId: ConversationId }
  | {
      readonly type: "conversation.join";
      readonly networkId: NetworkId;
      readonly channel: string;
      readonly key?: SecretRef;
    }
  | { readonly type: "conversation.query"; readonly networkId: NetworkId; readonly nick: string }
  | {
      readonly type: "conversation.mute";
      readonly conversationId: ConversationId;
      readonly muted: boolean;
    }
  | { readonly type: "draft.set"; readonly conversationId: ConversationId; readonly text: string }
  | {
      readonly type: "message.send";
      readonly conversationId: ConversationId;
      readonly text: string;
      readonly kind: "text" | "action" | "notice";
      readonly replyTo?: MessageId;
    }
  | {
      readonly type: "message.react";
      readonly messageId: MessageId;
      readonly value: string;
      readonly remove: boolean;
    }
  | { readonly type: "message.redact"; readonly messageId: MessageId }
  | {
      readonly type: "typing.set";
      readonly conversationId: ConversationId;
      readonly active: boolean;
    }
  | {
      readonly type: "history.load-older";
      readonly conversationId: ConversationId;
      readonly cursor?: Cursor;
    }
  | { readonly type: "history.latest"; readonly conversationId: ConversationId }
  | { readonly type: "history.reveal"; readonly messageId: MessageId }
  | { readonly type: "history.delete"; readonly conversationId: ConversationId }
  | {
      readonly type: "view.report";
      readonly conversationId: ConversationId;
      readonly focused: boolean;
      readonly atBottom: boolean;
      readonly lastVisibleMessageId?: MessageId;
    };

export interface ActionReceipt {
  readonly operationId: OperationId;
  /** Present for locally created conversations/messages; later state comes through read models. */
  readonly conversationId?: ConversationId;
  readonly messageId?: MessageId;
}

export interface OperationView {
  readonly id: OperationId;
  readonly state: "accepted" | "completed" | "failed" | "cancelled";
  readonly error?: AppError;
}

/** Sole UI-facing facade. No sockets, SQL, raw IRC frames, or framework-specific state. */
export interface AppApi {
  readonly state: Readable<AppSnapshot>;
  readonly settings: Readable<SettingsDocument | null>;
  /** Bounded recent operations, so async failures remain observable outside the active channel. */
  readonly operations: Readable<readonly OperationView[]>;
  /** App-owned stable readable for the lifetime of an open conversation. */
  timeline(conversationId: ConversationId): Result<Readable<TimelineSnapshot>>;
  discovery(networkId: NetworkId): Result<Readable<DiscoverySnapshot>>;
  dispatch(action: AppAction, signal: AbortSignal): Promise<Result<ActionReceipt>>;
  search(query: SearchQuery, signal: AbortSignal): Promise<Result<Page<Message>>>;
  /** Validates and revision-checks settings saves; secret values use secure input separately. */
  saveSettings(
    change: SettingsChange,
    expectedRevision: ConfigRevision,
    signal: AbortSignal,
  ): Promise<Result<OperationId>>;
  /** Reload validated disk settings only if its revision still equals the inspected revision. */
  reloadSettings(
    expectedRevision: ConfigRevision,
    signal: AbortSignal,
  ): Promise<Result<OperationId>>;
  /** Sole secret-string ingress from secure input. Never observable or logged; clear UI input afterward. */
  storeSecret(value: string, signal: AbortSignal): Promise<Result<SecretRef>>;
  /** Idempotent; rejects new work, disconnects, flushes persistence and disposes adapters. */
  shutdown(): Promise<Result<void>>;
}
