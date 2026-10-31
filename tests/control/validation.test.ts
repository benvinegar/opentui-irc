import { describe, expect, it } from "vitest";
import {
  boolean,
  choice,
  ControlFault,
  integer,
  json,
  jsonObject,
} from "../../src/control/validation";

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (cause) {
    return cause instanceof ControlFault ? cause.detail.code : "unexpected";
  }
  return undefined;
}

describe("control input validation helpers", () => {
  it("accepts only real booleans", () => {
    expect(boolean(false)).toBe(false);
    for (const value of ["true", 1, null, undefined])
      expect(code(() => boolean(value))).toBe("invalid-input");
  });
  it("accepts only safe integers inside the inclusive range", () => {
    expect(integer(1, 1, 3)).toBe(1);
    expect(integer(3, 1, 3)).toBe(3);
    for (const value of [0, 4, 1.5, "2", Number.NaN, 2 ** 53, null])
      expect(code(() => integer(value, 1, 3))).toBe("invalid-input");
  });
  it("matches enumerations exactly", () => {
    expect(choice("b", ["a", "b"])).toBe("b");
    expect(code(() => choice("B", ["a", "b"]))).toBe("invalid-input");
  });
  it("accepts plain JSON objects only", () => {
    expect(jsonObject({ a: [1, "x", null] })).toEqual({ a: [1, "x", null] });
    for (const value of [[], "x", null, new Map(), { x: () => 1 }])
      expect(code(() => jsonObject(value))).toBe("invalid-input");
  });
});

describe("bounded control output copies", () => {
  it("rejects prototype-like keys instead of copying them", () => {
    for (const name of ["constructor", "prototype"])
      expect(code(() => json({ [name]: 1 }))).toBe("internal");
  });
  it("rejects nesting deeper than 64 levels", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < 64; level++) deep = [deep];
    expect(json(deep)).toBeDefined();
    expect(code(() => json([deep]))).toBe("internal");
  });
  it("bounds the total size of object keys", () => {
    const keys = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`${index}`.padEnd(1_000_000, "k"), 0]),
    );
    expect(code(() => json(keys))).toBe("internal");
  });
  it("bounds the encoded byte size, not only the character count", () => {
    expect(code(() => json("é".repeat(3_000_000)))).toBe("internal");
    expect(json("é".repeat(1000))).toBe("é".repeat(1000));
  });
});
