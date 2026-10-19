import type { ConversationId } from "../contracts/common";

export interface TypingContext {
  readonly conversationId?: ConversationId;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly focused: boolean;
  readonly hasText: boolean;
}

/** One UI-owned timer; never emits on merely restoring/focusing a saved draft. */
export function createTypingReporter(options: {
  report: (conversationId: ConversationId, active: boolean) => void;
  now?: () => number;
  refreshMs?: number;
  idleMs?: number;
}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 4_000;
  const idleMs = options.idleMs ?? 6_000;
  let current: ConversationId | undefined;
  let lastReport = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (current) {
      const id = current;
      current = undefined;
      options.report(id, false);
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
      if (!current || now() - lastReport >= refreshMs) {
        current = id;
        lastReport = now();
        options.report(id, true);
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(stop, idleMs);
    },
    dispose: stop,
  };
}
