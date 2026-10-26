import type { ConversationId } from "../contracts/common";

export interface TypingContext {
  readonly conversationId?: ConversationId;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly focused: boolean;
  readonly hasText: boolean;
}
/** IRCv3 typing states: `paused` keeps a draft, `done` means it was cleared without sending. */
export type TypingState = "active" | "paused" | "done";
interface Announcement {
  state: TypingState;
  lastReport: number;
  /** A paused/done notification waiting for the three-second spacing. */
  pending?: "paused" | "done";
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** UI-owned, bounded timers. Restored drafts never announce activity. */
export function createTypingReporter(options: {
  report: (conversationId: ConversationId, state: TypingState) => void;
  now?: () => number;
  refreshMs?: number;
  idleMs?: number;
}) {
  const now = options.now ?? Date.now;
  // IRCv3 throttles *all* typing notifications, including paused/done. Leave the same
  // scheduling margin as active refreshes; the session also guards actual writes.
  const refreshMs = Math.max(3000, options.refreshMs ?? 4_000);
  const idleMs = options.idleMs ?? 6_000;
  // Peers drop a paused indicator after 30 seconds, so a later `done` is no longer needed.
  const pausedMs = 30_000;
  const announcements = new Map<ConversationId, Announcement>();
  let current: ConversationId | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const clearStop = (entry: Announcement) => {
    if (entry.stopTimer !== undefined) clearTimeout(entry.stopTimer);
    delete entry.stopTimer;
    delete entry.pending;
  };
  const announce = (id: ConversationId, entry: Announcement, state: TypingState) => {
    entry.state = state;
    entry.lastReport = now();
    options.report(id, state);
  };
  /** Moves an announced target to paused or done, each sent at most once and never early. */
  const settle = (id: ConversationId, target: "paused" | "done") => {
    const entry = announcements.get(id);
    const effective = entry?.pending ?? entry?.state;
    if (!entry || effective === "done" || effective === target) return;
    entry.pending = target;
    if (entry.stopTimer !== undefined) return;
    const send = () => {
      const state = entry.pending;
      delete entry.pending;
      if (state) announce(id, entry, state);
    };
    const delay = Math.max(0, refreshMs - (now() - entry.lastReport));
    if (!delay) send();
    else {
      const timer = setTimeout(() => {
        if (announcements.get(id) !== entry || entry.stopTimer !== timer) return;
        delete entry.stopTimer;
        send();
      }, delay);
      entry.stopTimer = timer;
    }
  };
  const stop = (paused = false) => {
    clearIdle();
    const id = current;
    current = undefined;
    if (id) settle(id, paused ? "paused" : "done");
  };
  const allowed = (context: TypingContext) =>
    context.enabled &&
    context.available &&
    context.focused &&
    context.hasText &&
    !!context.conversationId;
  const configure = (context: TypingContext) => {
    if (!allowed(context) || current !== context.conversationId)
      // Leaving a draft behind (blur, switching away) pauses; clearing it or opting out is done.
      stop(
        context.enabled &&
          context.available &&
          (current !== context.conversationId || context.hasText),
      );
    if (context.conversationId && !context.hasText) settle(context.conversationId, "done");
  };
  return {
    configure,
    activity(context: TypingContext) {
      if (!allowed(context)) {
        configure(context);
        return;
      }
      const id = context.conversationId!;
      if (current && current !== id) stop(true);
      for (const [key, entry] of announcements)
        if (
          entry.stopTimer === undefined &&
          (entry.state === "done" ||
            (entry.state === "paused" && now() - entry.lastReport >= pausedMs)) &&
          now() - entry.lastReport >= refreshMs
        )
          announcements.delete(key);
      let entry = announcements.get(id);
      if (!entry) {
        // Optional presence never creates an unbounded timer/cache on rapid switching.
        if (announcements.size >= 16) return;
        entry = { state: "done", lastReport: -Infinity };
        announcements.set(id, entry);
      }
      clearStop(entry);
      current = id;
      if (now() - entry.lastReport >= refreshMs) announce(id, entry, "active");
      clearIdle();
      idleTimer = setTimeout(() => stop(true), idleMs);
    },
    /** Submitting a draft: clears presence unless `messageSent` follows. */
    stop: () => stop(),
    messageSent(id: ConversationId) {
      if (current === id) {
        clearIdle();
        current = undefined;
      }
      const entry = announcements.get(id);
      if (entry) {
        clearStop(entry);
        // The chat itself clears peer indicators; no redundant done packet.
        entry.state = "done";
      }
    },
    dispose() {
      clearIdle();
      current = undefined;
      for (const entry of announcements.values()) clearStop(entry);
      announcements.clear();
    },
  };
}
