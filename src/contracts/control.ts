import type { AppError, Result } from "./common";

/** Versioned local-only control protocol. No raw IRC, shell commands or secret retrieval. */
export const CONTROL_VERSION = 1;
export const CONTROL_METHODS = [
  "capabilities",
  "status",
  "config.schema",
  "config.get",
  "config.plan",
  "config.apply",
  "config.reload",
  "networks.list",
  "conversations.list",
  "operations.list",
  "action.dispatch",
  "timeline.get",
  "history.search",
  "discovery.get",
  "secrets.store",
  "app.shutdown",
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];
export type ControlPermission =
  | "inspect"
  | "configure"
  | "network"
  | "read-messages"
  | "send-messages"
  | "destructive";
export const DEFAULT_CONTROL_PERMISSIONS: readonly ControlPermission[] = [
  "inspect",
  "configure",
  "network",
];
export const ALL_CONTROL_PERMISSIONS: readonly ControlPermission[] = [
  "inspect",
  "configure",
  "network",
  "read-messages",
  "send-messages",
  "destructive",
];
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Untrusted method parameters are JSON, then validated into typed domain values by the service. */
export interface ControlRequest {
  readonly version: 1;
  readonly id: string;
  readonly method: ControlMethod;
  readonly params: JsonObject;
  /** Explicit caller intent; effective rights are intersected with the server's launch policy. */
  readonly permissions: readonly ControlPermission[];
}
export interface ControlError {
  readonly code: AppError["code"] | "permission-denied" | "protocol" | "timeout";
  readonly message: string;
  readonly retryable: boolean;
  /** Transport timeout/disconnect after submission cannot prove a mutation did not happen. */
  readonly outcome?: "unknown";
}
export type ControlResponse =
  | { readonly version: 1; readonly id: string; readonly ok: true; readonly result: JsonValue }
  | { readonly version: 1; readonly id: string; readonly ok: false; readonly error: ControlError };
export type ControlHandler = (
  request: ControlRequest,
  signal: AbortSignal,
) => Promise<ControlResponse>;

export interface ControlClient {
  /** One request, no automatic retries or offline fallback on ambiguous transport failure. */
  request(
    request: ControlRequest,
    signal: AbortSignal,
  ): Promise<Result<ControlResponse, ControlError>>;
}
export interface ControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/** A section can be replaced, or deep-patched (arrays replace; null is literal). */
export type ConfigEdit =
  | { readonly section: "user" | "tui"; readonly value: JsonObject }
  | {
      readonly section: "user" | "tui";
      readonly patch: JsonObject;
      readonly unset?: readonly string[];
    };

export interface ConfigEffect {
  readonly path: string;
  readonly effect:
    | "immediate"
    | "reconnect"
    | "restart"
    | "destructive"
    | "network"
    | "unsupported";
  readonly description: string;
}
