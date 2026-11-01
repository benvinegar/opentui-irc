import type { Result } from "./common";

/** @public Private to transport/session. Application/UI must never receive these bytes. */
export interface ConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly timeoutMs: number;
}

export interface ByteConnection {
  /** Single consumer. Bounded buffering; chunks may split CRLF/UTF-8 arbitrarily. */
  readonly incoming: AsyncIterable<Uint8Array>;
  /** Resolves when accepted by the local socket, NOT delivered to a user/server. */
  write(bytes: Uint8Array, signal: AbortSignal): Promise<Result<void>>;
  /** Idempotent; terminates iterator and pending writes. */
  close(): Promise<Result<void>>;
}

export interface TransportFactory {
  /** Abort remains attached for the connection lifetime. TLS always verifies hostname/certificate. */
  connect(options: ConnectOptions, signal: AbortSignal): Promise<Result<ByteConnection>>;
}
