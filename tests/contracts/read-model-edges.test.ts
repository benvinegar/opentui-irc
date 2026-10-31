import { describe, expect, it, vi } from "vitest";
import { createReadModel } from "../../src/app/read-model";
import { mentionsNick } from "../../src/domain/message-policy";

describe("read model edge cases", () => {
  it("subscriptions after dispose are inert and their unsubscribe is safe", () => {
    const model = createReadModel("a", () => {});
    model.dispose();
    const listener = vi.fn();
    const unsubscribe = model.readable.subscribe(listener);
    model.publish("b");
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(model.readable.getSnapshot()).toBe("a");
  });

  it("a listener removed by an earlier listener during a commit is not notified", () => {
    const model = createReadModel(0, () => {});
    const late = vi.fn();
    let unsubscribeLate = () => {};
    const early = vi.fn(() => unsubscribeLate());
    model.readable.subscribe(early);
    unsubscribeLate = model.readable.subscribe(late);
    model.publish(1);
    expect(early).toHaveBeenCalledOnce();
    expect(late).not.toHaveBeenCalled();
  });
});

describe("mention detection", () => {
  it("an empty nickname never mentions anyone", () => {
    expect(mentionsNick("anything at all", "", "rfc1459")).toBe(false);
  });

  it("keeps scanning past embedded occurrences to find a bounded one", () => {
    expect(mentionsNick("bobby bob", "bob", "ascii")).toBe(true);
    expect(mentionsNick("bobby bobs", "bob", "ascii")).toBe(false);
  });
});
