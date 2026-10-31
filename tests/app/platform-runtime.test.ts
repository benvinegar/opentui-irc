import { afterEach, describe, expect, test, vi } from "vitest";
import { randomIds, systemClock } from "../../src/app/platform-independent-runtime";

afterEach(() => {
  vi.useRealTimers();
});

describe("system clock", () => {
  test("now reports wall-clock milliseconds", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    expect(systemClock.now()).toBe(1_700_000_000_000);
  });

  test("sleep resolves after the delay and detaches its abort listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let settled = false;
    const sleeping = systemClock.sleep(1_000, controller.signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(settled).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("an already-aborted signal rejects without scheduling a timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await expect(systemClock.sleep(1_000, controller.signal)).rejects.toThrow("Cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("aborting mid-sleep rejects promptly and clears the pending timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = systemClock.sleep(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(sleeping).rejects.toThrow("Cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("random ids", () => {
  test("produce distinct opaque UUID identifiers", () => {
    const first = randomIds.next<"operation">();
    const second = randomIds.next<"operation">();
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
  });
});
