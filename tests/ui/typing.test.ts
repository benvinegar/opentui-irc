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
  test("never announces a restored draft; refreshes at four seconds and stops after idle", () => {
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
    expect(report).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5999);
    expect(report).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(report.mock.calls.at(-1)).toEqual([conversationId, false]);
    typing.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  test.each(["enabled", "available", "focused", "hasText"] as const)(
    "%s=false schedules a stop without violating the typing rate limit",
    (key) => {
      vi.useFakeTimers();
      const report = vi.fn();
      const typing = createTypingReporter({ report });
      typing.activity({ ...context, [key]: false });
      expect(report).not.toHaveBeenCalled();
      typing.activity(context);
      typing.configure({ ...context, [key]: false });
      expect(report.mock.calls).toEqual([[conversationId, true]]);
      vi.advanceTimersByTime(3999);
      expect(report).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(report.mock.calls.at(-1)).toEqual([conversationId, false]);
      vi.runAllTimers();
      expect(report).toHaveBeenCalledTimes(2);
    },
  );
  test("switching targets schedules the old stop; disposal cancels every owned timer", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    const second = entityId<"conversation">("second");
    typing.activity(context);
    typing.activity({ ...context, conversationId: second });
    vi.advanceTimersByTime(4000);
    expect(report.mock.calls).toEqual([
      [conversationId, true],
      [second, true],
      [conversationId, false],
    ]);
    typing.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(report).toHaveBeenCalledTimes(3);
  });
  test("new activity cancels a pending stop for the same target", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    typing.activity(context);
    typing.configure({ ...context, focused: false });
    vi.advanceTimersByTime(2000);
    typing.activity(context);
    vi.advanceTimersByTime(2000);
    expect(report.mock.calls).toEqual([[conversationId, true]]);
    typing.activity(context);
    expect(report.mock.calls.at(-1)).toEqual([conversationId, true]);
    typing.dispose();
  });
  test("accepted chat replaces the stop, while preserving the target's cooldown", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    typing.activity(context);
    typing.stop();
    typing.messageSent(conversationId);
    vi.advanceTimersByTime(2000);
    typing.activity(context);
    expect(report.mock.calls).toEqual([[conversationId, true]]);
    vi.advanceTimersByTime(2000);
    typing.activity(context);
    expect(report.mock.calls).toEqual([
      [conversationId, true],
      [conversationId, true],
    ]);
    typing.dispose();
  });
  test("rapid switching bounds pending presence targets and timers", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const typing = createTypingReporter({ report });
    for (let index = 0; index < 100; index++)
      typing.activity({ ...context, conversationId: entityId<"conversation">(`target-${index}`) });
    expect(report).toHaveBeenCalledTimes(16);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(16);
    vi.runAllTimers();
    expect(report).toHaveBeenCalledTimes(32);
    typing.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
