/* eslint-disable no-control-regex -- IRC and terminal controls must be matched explicitly at this trust boundary. */
import type { AppError, Result } from "../../contracts/common";
import type { SessionEvent, SessionIdentity, SessionPayload } from "../../contracts/session";

export const ok = (): Result<void> => ({ ok: true, value: undefined });
export const problem = (code: AppError["code"], message: string): AppError => ({
  code,
  message,
  retryable: code === "network" || code === "unavailable" || code === "rate-limited",
});
export const failure = <T>(code: AppError["code"], message: string): Result<T> => ({
  ok: false,
  error: problem(code, message),
});
/** Strip terminal escape strings before stripping their introducers and all remaining C0/C1. */
export function plain(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?/g, "")
    .replace(/\x04(?:[0-9A-Fa-f]{6}(?:,[0-9A-Fa-f]{6})?)?/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}
export const plainMultiline = (value: string) => value.split("\n").map(plain).join("\n");
export const atom = (value: string) =>
  value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f,:]/.test(value);
export const content = (value: string) => !/[\r\n\0]/.test(value);

export function eventStream(identity: SessionIdentity, maximum: number, overflow: () => void) {
  const queue: SessionEvent[] = [];
  let sequence = 0;
  let ended = false;
  let consumer = false;
  let wake: (() => void) | undefined;
  function emit(payload: SessionPayload, reserved = false): boolean {
    if (ended) return false;
    if (!reserved && queue.length >= maximum) {
      overflow();
      return false;
    }
    queue.push({ ...identity, sequence: ++sequence, payload });
    wake?.();
    wake = undefined;
    return true;
  }
  return {
    emit,
    finish() {
      ended = true;
      wake?.();
      wake = undefined;
    },
    events: {
      async *[Symbol.asyncIterator]() {
        if (consumer) throw new Error("Session events have one consumer.");
        consumer = true;
        try {
          while (true) {
            if (queue.length) yield queue.shift()!;
            else if (ended) return;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          if (!ended) overflow();
        }
      },
    },
  };
}
