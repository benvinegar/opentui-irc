import type {
  AppError,
  ConversationId,
  Cursor,
  MessageId,
  NetworkId,
  Timestamp,
  UserId,
} from "./common";

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "registering"
  | "authenticating"
  | "ready"
  | "reconnecting";

/** Semantic features, not a raw CAP list. The session computes dependencies/limits. */
export interface FeatureSet {
  readonly history: boolean;
  readonly replies: boolean;
  readonly reactions: boolean;
  readonly typing: boolean;
  readonly readMarkers: boolean;
  readonly redaction: boolean;
  readonly multiline: boolean;
}

export interface NetworkView {
  readonly id: NetworkId;
  readonly name: string;
  readonly phase: ConnectionPhase;
  readonly nick: string;
  readonly secure: boolean;
  readonly authenticated: boolean;
  readonly features: FeatureSet;
  readonly lastError?: AppError;
}

export interface ConversationView {
  readonly id: ConversationId;
  readonly networkId: NetworkId;
  readonly kind: "channel" | "direct" | "status";
  readonly name: string;
  readonly topic: string;
  readonly joined: boolean;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly muted: boolean;
}

export interface UserView {
  readonly id: UserId;
  readonly nick: string;
  readonly account?: string;
  readonly away: boolean;
  readonly prefixes: readonly string[];
}

export type SendState = "pending" | "written" | "echo-observed" | "failed" | "uncertain";

/** Server identity must always be scoped by network. Local IDs remain stable on echo merge. */
export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly networkId: NetworkId;
  readonly serverId?: string;
  readonly sender: { readonly nick: string; readonly userId?: UserId; readonly account?: string };
  readonly kind: "text" | "action" | "notice" | "event";
  /** Sanitized plain text, not terminal escape sequences or pre-styled UI nodes. */
  readonly text: string;
  readonly receivedAt: Timestamp;
  readonly serverTime?: Timestamp;
  readonly source: "live" | "playback" | "local";
  readonly sendState?: SendState;
  readonly replyTo?: { readonly serverId: string; readonly localId?: MessageId };
  readonly reactions: readonly {
    readonly value: string;
    readonly count: number;
    readonly reactedBySelf: boolean;
  }[];
  readonly redacted: boolean;
}

export interface TimelineSnapshot {
  readonly conversationId: ConversationId;
  /** Bounded window, in stable display order. Never use array offsets as message identities. */
  readonly messages: readonly Message[];
  readonly members: readonly UserView[];
  readonly typing: readonly UserId[];
  readonly firstUnreadId?: MessageId;
  readonly olderCursor?: Cursor;
  readonly loadingOlder: boolean;
  /** False for an older/search window; absent means latest for revision-1 consumers. */
  readonly atLatest?: boolean;
  readonly draft: string;
}

export interface AppSnapshot {
  readonly revision: number;
  readonly networks: readonly NetworkView[];
  readonly conversations: readonly ConversationView[];
  readonly activeConversationId?: ConversationId;
  readonly boot: "loading" | "ready" | "failed";
  readonly error?: AppError;
}
