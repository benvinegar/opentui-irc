import type { AppError, NetworkId, OperationId } from "./common";

export interface ChannelListing {
  readonly channel: string;
  readonly userCount: number;
  readonly topic: string;
}

export interface UserDetails {
  readonly nick: string;
  readonly username?: string;
  readonly hostname?: string;
  readonly realname?: string;
  readonly account?: string;
  readonly channels: readonly string[];
  readonly awayReason?: string;
}

export interface DiscoverySnapshot {
  readonly networkId: NetworkId;
  /** LIST results capped by application policy; omitted excess is explicitly indicated. */
  readonly directory: {
    readonly operationId?: OperationId;
    readonly state: "idle" | "loading" | "ready" | "failed";
    readonly items: readonly ChannelListing[];
    readonly truncated: boolean;
    readonly error?: AppError;
  };
  /** Most recently requested WHOIS. Stale replies must not overwrite a newer request. */
  readonly user: {
    readonly operationId?: OperationId;
    readonly state: "idle" | "loading" | "ready" | "failed";
    readonly details?: UserDetails;
    readonly error?: AppError;
  };
}
