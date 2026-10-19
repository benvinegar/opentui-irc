import type { Result } from "./common";

/** Internal wire representation. This may contain secrets: never expose it to UI or logs. */
export interface IrcFrame {
  readonly tags: Readonly<Record<string, string | null>>;
  readonly prefix?: string;
  readonly command: string;
  readonly params: readonly string[];
}

export interface ProtocolLimits {
  /** Includes CRLF; tags have their own budget. Values validated by the implementation. */
  readonly maxCommandBytes: number;
  readonly maxTagBytes: number;
  readonly maxBufferedBytes: number;
}

export interface IrcCodec {
  /** Stateful framing and decoding, one codec per socket. Fatal malformed input returns an error. */
  push(chunk: Uint8Array): Result<readonly IrcFrame[]>;
  /** Detect unfinished input at EOF and release buffers. */
  finish(): Result<void>;
  /** Reject CR/LF/NUL injection and over-budget output; no silent truncation. */
  encode(frame: IrcFrame): Result<Uint8Array>;
}

export interface ProtocolSupport {
  readonly casemapping: "ascii" | "rfc1459" | "strict-rfc1459";
  readonly channelTypes: string;
  readonly prefixModes: string;
  readonly prefixSymbols: string;
  readonly channelModeGroups: readonly [string, string, string, string];
  readonly capabilities: Readonly<Record<string, string | null>>;
}
