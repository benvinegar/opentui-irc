import type { ConversationId, Cursor, MessageId, NetworkId, Result, Timestamp } from "./common";
import type { Message } from "./model";

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor;
}

export interface SearchQuery {
  readonly text: string;
  readonly networkId?: NetworkId;
  readonly conversationId?: ConversationId;
  readonly sender?: string;
  readonly after?: Timestamp;
  readonly before?: Timestamp;
  readonly cursor?: Cursor;
  readonly limit: number;
}

export interface ConversationRecord {
  readonly id: ConversationId;
  readonly networkId: NetworkId;
  readonly kind: "channel" | "direct" | "status";
  readonly name: string;
}

export interface WorkspaceState {
  readonly activeConversationId?: ConversationId;
  readonly conversationOrder: readonly ConversationId[];
  readonly mutedConversations: readonly ConversationId[];
  /** Empty unless persistDrafts is enabled; exclusions apply here too. */
  readonly drafts: readonly { readonly conversationId: ConversationId; readonly text: string }[];
}

export interface ReadPosition {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly readAt: Timestamp;
}

/** Single writer (app). Every batch is atomic; retrying identical upserts is idempotent. */
export interface HistoryRepository {
  commit(
    batch: {
      readonly conversations: readonly ConversationRecord[];
      readonly messages: readonly Message[];
      readonly readPositions: readonly ReadPosition[];
    },
    signal: AbortSignal,
  ): Promise<Result<void>>;
  /** Chronological items; nextCursor requests older messages. Cursor is query-bound and opaque. */
  page(
    conversationId: ConversationId,
    options: { readonly cursor?: Cursor; readonly limit: number },
    signal: AbortSignal,
  ): Promise<Result<Page<Message>>>;
  /** Newest matches first, deterministic tie-break; parameterized literal text search, not SQL. */
  search(query: SearchQuery, signal: AbortSignal): Promise<Result<Page<Message>>>;
  context(
    messageId: MessageId,
    radius: number,
    signal: AbortSignal,
  ): Promise<Result<readonly Message[]>>;
  loadConversations(signal: AbortSignal): Promise<Result<readonly ConversationRecord[]>>;
  loadReadPositions(signal: AbortSignal): Promise<Result<readonly ReadPosition[]>>;
  loadWorkspace(signal: AbortSignal): Promise<Result<WorkspaceState>>;
  saveWorkspace(state: WorkspaceState, signal: AbortSignal): Promise<Result<void>>;
  /** Local only, also removes associated search/read records. Never a protocol redaction. */
  deleteConversation(conversationId: ConversationId, signal: AbortSignal): Promise<Result<void>>;
  prune(before: Timestamp, signal: AbortSignal): Promise<Result<number>>;
  /** Flush/close once; further calls fail with unavailable. */
  close(): Promise<Result<void>>;
}
