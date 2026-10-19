import type { AppError, Result } from "../contracts/common";

export function failure(
  code: AppError["code"],
  message: string,
): { readonly ok: false; readonly error: AppError } {
  return {
    ok: false,
    error: { code, message, retryable: code === "storage" || code === "conflict" },
  };
}
export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
export class StorageFault extends Error {
  constructor(
    readonly code: AppError["code"],
    message: string,
  ) {
    super(message);
  }
}
export function safeFailure(error: unknown): ReturnType<typeof failure> {
  return error instanceof StorageFault
    ? failure(error.code, error.message)
    : failure("storage", "Local storage operation failed.");
}
