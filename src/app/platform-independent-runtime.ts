import { entityId } from "../contracts/common";
import type { Clock, IdGenerator } from "../contracts/common";

/** Runtime globals only; no Bun adapter or UI dependency. All timer listeners are removed. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new Error("Cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
  },
};

export const randomIds: IdGenerator = {
  next: <Kind extends string>() => entityId<Kind>(crypto.randomUUID()),
};
