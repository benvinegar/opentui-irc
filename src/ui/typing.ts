import type { ConversationId } from "../contracts/common";

export interface TypingContext {
  readonly conversationId?: ConversationId;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly focused: boolean;
  readonly hasText: boolean;
}
interface Announcement {
  active: boolean;
  lastReport: number;
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** UI-owned, bounded timers. Restored drafts never announce activity. */
export function createTypingReporter(options: {
  report: (conversationId: ConversationId, active: boolean) => void;
  now?: () => number;
  refreshMs?: number;
  idleMs?: number;
}) {
  const now = options.now ?? Date.now;
  // IRCv3 throttles *all* typing notifications, including done. Leave the same
  // scheduling margin as active refreshes; the session also guards actual writes.
  const refreshMs = Math.max(3000, options.refreshMs ?? 4_000);
  const idleMs = options.idleMs ?? 6_000;
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
  };
  const announce = (id: ConversationId, entry: Announcement, active: boolean) => {
    entry.active = active;
    entry.lastReport = now();
    options.report(id, active);
  };
  const stop = () => {
    clearIdle();
    const id = current;
    current = undefined;
    if (!id) return;
    const entry = announcements.get(id);
    if (!entry?.active || entry.stopTimer !== undefined) return;
    const delay = Math.max(0, refreshMs - (now() - entry.lastReport));
    if (!delay) announce(id, entry, false);
    else {
      const timer = setTimeout(() => {
        if (announcements.get(id) !== entry || entry.stopTimer !== timer) return;
        delete entry.stopTimer;
        if (entry.active) announce(id, entry, false);
      }, delay);
      entry.stopTimer = timer;
    }
  };
  const allowed = (context: TypingContext) =>
    context.enabled &&
    context.available &&
    context.focused &&
    context.hasText &&
    !!context.conversationId;
  return {
    configure(context: TypingContext) {
      if (!allowed(context) || current !== context.conversationId) stop();
    },
    activity(context: TypingContext) {
      if (!allowed(context)) {
        stop();
        return;
      }
      const id = context.conversationId!;
      if (current && current !== id) stop();
      for (const [key, entry] of announcements)
        if (!entry.active && entry.stopTimer === undefined && now() - entry.lastReport >= refreshMs)
          announcements.delete(key);
      let entry = announcements.get(id);
      if (!entry) {
        // Optional presence never creates an unbounded timer/cache on rapid switching.
        if (announcements.size >= 16) return;
        entry = { active: false, lastReport: -Infinity };
        announcements.set(id, entry);
      }
      clearStop(entry);
      current = id;
      if (now() - entry.lastReport >= refreshMs) announce(id, entry, true);
      clearIdle();
      idleTimer = setTimeout(stop, idleMs);
    },
    stop,
    messageSent(id: ConversationId) {
      if (current === id) {
        clearIdle();
        current = undefined;
      }
      const entry = announcements.get(id);
      if (entry) {
        clearStop(entry);
        // The chat itself clears peer indicators; no redundant done packet.
        entry.active = false;
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
