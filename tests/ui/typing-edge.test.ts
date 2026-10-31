import { afterEach, expect, test, vi } from "vitest";
import { createTypingReporter, type TypingContext } from "../../src/ui/typing";
import { conversationId } from "../fixtures/scenario";

const context: TypingContext = {
  conversationId,
  enabled: true,
  available: true,
  focused: true,
  hasText: true,
};
afterEach(() => vi.useRealTimers());

test("sending while still typing ends presence without a later paused or done packet", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const report = vi.fn();
  const typing = createTypingReporter({ report });
  typing.activity(context);
  typing.messageSent(conversationId);
  vi.advanceTimersByTime(60_000);
  expect(report.mock.calls).toEqual([[conversationId, "active"]]);
  typing.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
