import { describe, expect, it } from "vitest";
import {
  isJsonObject,
  isJsonValue,
  parseControlRequest,
  parseControlResponse,
} from "../../src/control/protocol";

const request = {
  version: 1,
  id: "request-1",
  method: "status",
  params: {},
  permissions: ["inspect"],
};

describe("control protocol validation", () => {
  it("accepts known envelopes and deeply valid finite JSON", () => {
    expect(parseControlRequest(request)).toEqual({ ok: true, value: request });
    expect(isJsonValue({ text: "你好 😀", values: [null, false, 12, { nested: true }] })).toBe(
      true,
    );
    expect(isJsonObject([])).toBe(false);
    expect(parseControlResponse({ version: 1, id: "request-1", ok: true, result: null }).ok).toBe(
      true,
    );
    expect(
      parseControlResponse({
        version: 1,
        id: "request-1",
        ok: false,
        error: {
          code: "timeout",
          message: "Request timed out.",
          retryable: false,
          outcome: "unknown",
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown fields, versions, methods, permissions, duplicate permissions and bounded IDs", () => {
    for (const invalid of [
      null,
      [],
      { ...request, extra: true },
      { ...request, version: 2 },
      { ...request, method: "irc.raw" },
      { ...request, params: [] },
      { ...request, permissions: ["root"] },
      { ...request, permissions: ["inspect", "inspect"] },
      { ...request, id: "" },
      { ...request, id: "x".repeat(129) },
      { ...request, id: "secret\n" },
      { ...request, permissions: "inspect" },
      { version: 1, id: "id", method: "status", params: {} },
    ])
      expect(parseControlRequest(invalid).ok).toBe(false);
  });

  it("rejects cyclic/exotic/accessor/sparse/nonfinite/deep/unsafe JSON without invoking getters", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let invoked = false;
    const accessor = Object.defineProperty({}, "bad", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    const arrayAccessor = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    let deep: unknown = null;
    for (let depth = 0; depth < 66; depth++) deep = { deep };
    for (const invalid of [
      NaN,
      Infinity,
      undefined,
      1n,
      new Date(),
      cycle,
      accessor,
      arrayAccessor,
      Array(2),
      deep,
      JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'),
      { constructor: {} },
      { [Symbol("key")]: 1 },
      Object.create({ inherited: true }),
      Array(100_001).fill(0),
    ])
      expect(isJsonValue(invalid)).toBe(false);
    expect(invoked).toBe(false);
  });

  it("validates response IDs/version/envelope and never echoes rejected values", () => {
    const good = {
      version: 1,
      id: "id",
      ok: false,
      error: { code: "internal", message: "Safe failure.", retryable: false },
    };
    for (const invalid of [
      { ...good, id: 12 },
      { ...good, version: 3 },
      { ...good, extra: true },
      { ...good, error: { ...good.error, code: "secret-raw-error" } },
      { ...good, error: { ...good.error, message: "secret-raw-error\u001b[2J" } },
      { ...good, error: { ...good.error, retryable: "yes" } },
      { ...good, error: { ...good.error, outcome: "known" } },
      { ...good, error: { ...good.error, stack: "secret-raw-error" } },
      { version: 1, id: "id", ok: true, result: Infinity },
    ]) {
      const result = parseControlResponse(invalid);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret-raw-error");
    }
  });
});
