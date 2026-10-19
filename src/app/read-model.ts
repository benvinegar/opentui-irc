import type { Readable } from "../contracts/common";

export interface ReadModel<T> {
  readonly readable: Readable<T>;
  /** Publish immutable snapshots only; no-op if Object.is equal. App is the sole writer. */
  publish(snapshot: T): void;
  dispose(): void;
}

/** Framework-independent bridge; Solid adapters subscribe and dispose with their component scope. */
export function createReadModel<T>(
  initial: T,
  onListenerError: (error: unknown) => void,
): ReadModel<T> {
  let current = initial;
  let disposed = false;
  const listeners = new Set<() => void>();
  return {
    readable: {
      getSnapshot: () => current,
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish(snapshot) {
      if (disposed || Object.is(current, snapshot)) return;
      current = snapshot;
      for (const listener of Array.from(listeners)) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
