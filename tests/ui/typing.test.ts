import { afterEach, describe, expect, test, vi } from "vitest";
import { createTypingReporter, type TypingContext } from "../../src/ui/typing";
import { entityId } from "../../src/contracts/common";
import { conversationId } from "../fixtures/scenario";

const context: TypingContext = {
  conversationId,
  enabled: true,
  available: true,
  focused: true,
  hasText: true,
};
afterEach(() => vi.useRealTimers());
describe("UI typing reporter", () => {
  test("never announces a restored draft; emits at most one refresh per four seconds and stops after idle", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    typing.configure(context);
    expect(report).not.toHaveBeenCalled();
    typing.activity(context);
    for (let index = 0; index < 39; index++) {
      vi.advanceTimersByTime(100);
      typing.activity(context);
    }
    expect(report.mock.calls).toEqual([[conversationId, true]]);
    vi.advanceTimersByTime(100);
    typing.activity(context);
    expect(report.mock.calls).toEqual([
      [conversationId, true],
      [conversationId, true],
    ]);
    vi.advanceTimersByTime(5999);
    expect(report).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(report.mock.calls.at(-1)).toEqual([conversationId, false]);
    typing.dispose();
    expect(report).toHaveBeenCalledTimes(3);
  });
  test.each(["enabled", "available", "focused", "hasText"] as const)(
    "%s=false prevents and stops announcements",
    (key) => {
      vi.useFakeTimers();
      const report = vi.fn();
      const typing = createTypingReporter({ report });
      typing.activity({ ...context, [key]: false });
      expect(report).not.toHaveBeenCalled();
      typing.activity(context);
      typing.configure({ ...context, [key]: false });
      expect(report.mock.calls).toEqual([
        [conversationId, true],
        [conversationId, false],
      ]);
      vi.runAllTimers();
      expect(report).toHaveBeenCalledTimes(2);
    },
  );
  test("switching targets stops the previous conversation; disposal clears the only timer", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    const second = entityId<"conversation">("second");
    typing.activity(context);
    typing.activity({ ...context, conversationId: second });
    typing.dispose();
    expect(report.mock.calls).toEqual([
      [conversationId, true],
      [conversationId, false],
      [second, true],
      [second, false],
    ]);
    vi.runAllTimers();
    expect(report).toHaveBeenCalledTimes(4);
  });
});
