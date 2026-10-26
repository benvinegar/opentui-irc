import type { AppError, NetworkId, OperationId, Result, Timestamp } from "./common";
import type { ConnectionPhase, FeatureSet, SendState } from "./model";
import type { ChannelListing, UserDetails } from "./discovery";
import type { ProtocolSupport } from "./protocol";
import type { NetworkProfile } from "./settings";

export interface SessionIdentity {
  readonly networkId: NetworkId;
  /** Monotonically increasing per network. New attempt = new generation. */
  readonly generation: number;
}

export interface ChatEnvelope {
  readonly target: string;
  readonly sender: { readonly nick: string; readonly account?: string };
  readonly kind: "text" | "action" | "notice";
  readonly text: string;
  readonly receivedAt: Timestamp;
  readonly serverTime?: Timestamp;
  readonly serverId?: string;
  readonly replyToServerId?: string;
  readonly source: "live" | "playback";
  /** Only set when reliably correlated to an outgoing operation (never by text alone). */
  readonly operationId?: OperationId;
}

export type SessionPayload =
  | {
      readonly type: "state";
      readonly phase: ConnectionPhase;
      readonly nick: string;
      readonly secure: boolean;
      readonly authenticated: boolean;
    }
  | { readonly type: "support"; readonly support: ProtocolSupport; readonly features: FeatureSet }
  | { readonly type: "chat"; readonly message: ChatEnvelope }
  | {
      readonly type: "membership";
      readonly channel: string;
      readonly change:
        | { readonly kind: "join"; readonly nick: string; readonly prefixes: readonly string[] }
        | { readonly kind: "remove"; readonly nick: string; readonly reason: string }
        | {
            readonly kind: "prefixes";
            readonly nick: string;
            readonly prefixes: readonly string[];
          };
    }
  | { readonly type: "nick"; readonly previous: string; readonly next: string }
  | { readonly type: "quit"; readonly nick: string; readonly reason: string }
  | { readonly type: "topic"; readonly channel: string; readonly text: string }
  | { readonly type: "away"; readonly nick: string; readonly away: boolean }
  | { readonly type: "account"; readonly nick: string; readonly account: string | null }
  | {
      readonly type: "reaction";
      readonly target: string;
      readonly serverId: string;
      readonly nick: string;
      readonly value: string;
      readonly remove: boolean;
    }
  | {
      readonly type: "typing";
      readonly target: string;
      readonly nick: string;
      readonly active: boolean;
    }
  | { readonly type: "read-marker"; readonly target: string; readonly serverTime: Timestamp }
  | { readonly type: "redaction"; readonly target: string; readonly serverId: string }
  | {
      readonly type: "send-state";
      readonly operationId: OperationId;
      readonly state: Exclude<SendState, "pending">;
      readonly error?: AppError;
    }
  | {
      readonly type: "history-complete";
      readonly operationId: OperationId;
      readonly target: string;
      readonly hasMore: boolean;
    }
  | {
      readonly type: "directory-item";
      readonly operationId: OperationId;
      readonly item: ChannelListing;
    }
  | { readonly type: "directory-complete"; readonly operationId: OperationId }
  | {
      readonly type: "user-details";
      readonly operationId: OperationId;
      readonly details: UserDetails;
    }
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "error"; readonly error: AppError; readonly operationId?: OperationId };

export interface SessionEvent extends SessionIdentity {
  /** Strictly increasing within one generation, starts at 1. No events after iterator completion. */
  readonly sequence: number;
  readonly payload: SessionPayload;
}

export type SessionCommand =
  | { readonly type: "join"; readonly channel: string; readonly key?: import("./common").SecretRef }
  | { readonly type: "part"; readonly channel: string; readonly reason?: string }
  | {
      readonly type: "send";
      readonly target: string;
      readonly text: string;
      readonly kind: "text" | "action" | "notice";
      readonly replyToServerId?: string;
    }
  | { readonly type: "nick"; readonly nick: string }
  | { readonly type: "away"; readonly reason: string | null }
  | { readonly type: "whois"; readonly nick: string }
  | { readonly type: "list" }
  | { readonly type: "topic"; readonly channel: string; readonly text?: string }
  | {
      readonly type: "typing";
      readonly target: string;
      readonly active: boolean;
      /** With `active: false`, sends IRCv3 `paused` (draft kept) instead of `done`. */
      readonly paused?: boolean;
    }
  | {
      readonly type: "reaction";
      readonly target: string;
      readonly serverId: string;
      readonly value: string;
      readonly remove: boolean;
    }
  | { readonly type: "redact"; readonly target: string; readonly serverId: string }
  | { readonly type: "mark-read"; readonly target: string; readonly serverTime: Timestamp }
  | {
      readonly type: "history";
      readonly target: string;
      readonly before?: { readonly serverId: string } | { readonly serverTime: Timestamp };
      readonly limit: number;
    };

export interface IrcSession {
  readonly identity: SessionIdentity;
  /** One ordered consumer. Bounded; overflow is a visible fatal error, never dropped chat. */
  readonly events: AsyncIterable<SessionEvent>;
  /** Accept into a bounded queue. Success is not socket write, echo, or delivery. */
  execute(
    command: SessionCommand,
    operationId: OperationId,
    signal: AbortSignal,
  ): Promise<Result<void>>;
  /** Idempotent; cancels timers/queues/transport, completes events; best-effort QUIT only. */
  close(reason?: string): Promise<Result<void>>;
}

export interface SessionFactory {
  /** A session is ONE connection attempt; app owns retry policy. Secrets resolved privately. */
  open(
    profile: NetworkProfile,
    identity: SessionIdentity,
    signal: AbortSignal,
  ): Promise<Result<IrcSession>>;
}
