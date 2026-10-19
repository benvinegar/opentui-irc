import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { Readable } from "../contracts/common";

/** Mount-scoped bridge: disposal never tears down the app-owned readable. */
export function useReadable<T>(model: Readable<T>): Accessor<T> {
  const [snapshot, setSnapshot] = createSignal(model.getSnapshot());
  const unsubscribe = model.subscribe(() => setSnapshot(() => model.getSnapshot()));
  onCleanup(unsubscribe);
  return snapshot;
}
