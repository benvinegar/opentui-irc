import { describe, expect, it, vi } from "vitest";
import { keyStep, runKeyBinding, type KeyBinding, type KeyPress } from "../../src/ui/keys";

function press(name: string, modifiers: Partial<Pick<KeyPress, "ctrl" | "meta" | "shift">> = {}) {
  const preventDefault = vi.fn();
  const event: KeyPress = {
    name,
    ctrl: modifiers.ctrl ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
    preventDefault,
  };
  return { event, preventDefault };
}

describe("key binding tables", () => {
  it("runs only the first matching binding and consumes its key", () => {
    const first = vi.fn();
    const second = vi.fn();
    const bindings: KeyBinding[] = [
      { name: ["up", "down"], run: first },
      { name: ["up"], run: second },
    ];
    const { event, preventDefault } = press("up");
    expect(runKeyBinding(event, bindings)).toBe(true);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves unmatched keys alone", () => {
    const run = vi.fn();
    const { event, preventDefault } = press("x");
    expect(runKeyBinding(event, [{ name: ["y"], run }])).toBe(false);
    expect(runKeyBinding(event, [])).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("requires listed modifiers but ignores unlisted ones", () => {
    const ctrl = vi.fn();
    const meta = vi.fn();
    const plain = vi.fn();
    const bindings: KeyBinding[] = [
      { name: ["k"], ctrl: true, run: ctrl },
      { name: ["k"], meta: true, run: meta },
      { name: ["k"], run: plain },
    ];
    runKeyBinding(press("k", { ctrl: true, meta: true }).event, bindings);
    expect(ctrl).toHaveBeenCalledOnce();
    runKeyBinding(press("k", { meta: true }).event, bindings);
    expect(meta).toHaveBeenCalledOnce();
    runKeyBinding(press("k", { shift: true }).event, bindings);
    expect(plain).toHaveBeenCalledOnce();
    expect(ctrl).toHaveBeenCalledOnce();
  });

  it("falls through to later bindings when a condition fails", () => {
    const guarded = vi.fn();
    const fallback = vi.fn();
    let allowed = false;
    const bindings: KeyBinding[] = [
      { name: ["return"], when: () => allowed, run: guarded },
      { name: ["return"], run: fallback },
    ];
    runKeyBinding(press("return").event, bindings);
    expect(guarded).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
    allowed = true;
    runKeyBinding(press("return").event, bindings);
    expect(guarded).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("does not consume a key whose only binding is disabled", () => {
    const { event, preventDefault } = press("up", { ctrl: true });
    expect(
      runKeyBinding(event, [{ name: ["up"], ctrl: true, when: () => false, run: vi.fn() }]),
    ).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("maps backward keys to -1 and everything else to 1", () => {
    expect(["up", "left", "pageup"].map(keyStep)).toEqual([-1, -1, -1]);
    expect(["down", "right", "pagedown", "x"].map(keyStep)).toEqual([1, 1, 1, 1]);
  });
});
