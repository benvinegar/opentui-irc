/** In-process contracts, revision 1. No runtime/framework dependencies. */
declare const idBrand: unique symbol;
export type Id<Kind extends string> = string & { readonly [idBrand]: Kind };
export type NetworkId = Id<"network">;
export type ConversationId = Id<"conversation">;
export type MessageId = Id<"message">;
export type UserId = Id<"user">;
export type OperationId = Id<"operation">;
export type Cursor = Id<"cursor">;
export type ConfigRevision = Id<"config-revision">;
export type SecretRef = Id<"secret-ref">;

/** Construct at trusted boundaries; IDs are opaque, never derived from folded nicknames. */
export function entityId<Kind extends string>(value: string): Id<Kind> {
  if (
    value.length === 0 ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    throw new TypeError("Invalid opaque ID");
  }
  return value as Id<Kind>;
}

/** Milliseconds since Unix epoch, not a duration or IRC server-time string. */
export type Timestamp = number;
export type Unsubscribe = () => void;
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Safe, user-displayable details only. Never include raw lines, passwords or Error.cause. */
export interface AppError {
  readonly code:
    | "cancelled"
    | "invalid-input"
    | "unsupported"
    | "unavailable"
    | "conflict"
    | "authentication"
    | "tls"
    | "network"
    | "storage"
    | "rate-limited"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
}

/** Snapshot identity is stable until changed; callbacks have no payload and run after commit. */
export interface Readable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): Unsubscribe;
}

export interface Clock {
  now(): Timestamp;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface IdGenerator {
  next<Kind extends string>(): Id<Kind>;
}

/** Only controlled fields; never accept arbitrary protocol objects for logging. */
export interface Diagnostics {
  record(entry: {
    readonly level: "info" | "warn" | "error";
    readonly code: string;
    readonly networkId?: NetworkId;
    readonly operationId?: OperationId;
  }): void;
}
