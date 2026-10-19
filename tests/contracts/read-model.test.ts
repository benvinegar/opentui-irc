import { describe, expect, it, vi } from "vitest";
import { createReadModel } from "../../src/app/read-model";

describe("framework-neutral read model contract", () => {
  it("retains identity until an actual commit and notifies after commit", () => {
    const initial = { count: 0 };
    const model = createReadModel(initial, () => {});
    const listener = vi.fn(() => expect(model.readable.getSnapshot().count).toBe(1));
    const unsubscribe = model.readable.subscribe(listener);
    model.publish(initial);
    expect(listener).not.toHaveBeenCalled();
    model.publish({ count: 1 });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    unsubscribe();
    model.publish({ count: 2 });
    expect(listener).toHaveBeenCalledOnce();
  });
  it("isolates listener errors and disposes idempotently", () => {
    const errors = vi.fn();
    const model = createReadModel(0, errors);
    model.readable.subscribe(() => {
      throw new Error("UI listener failed");
    });
    const listener = vi.fn();
    model.readable.subscribe(listener);
    model.publish(1);
    expect(errors).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    model.dispose();
    model.dispose();
    model.publish(2);
    expect(model.readable.getSnapshot()).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
  });
});
