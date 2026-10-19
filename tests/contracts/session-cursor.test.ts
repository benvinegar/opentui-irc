import { describe, expect, it } from "vitest";
import { entityId } from "../../src/contracts/common";
import type { SessionEvent } from "../../src/contracts/session";
import { admitSessionEvent, startSessionCursor } from "../../src/domain/session-cursor";

const networkId = entityId<"network">("network-1");
const initial = startSessionCursor({ networkId, generation: 2 });
const event = (sequence: number, generation = 2): SessionEvent => ({
  networkId,
  generation,
  sequence,
  payload: { type: "notice", text: "safe text" },
});

describe("session event admission contract", () => {
  it("accepts ordered events without mutating the prior cursor", () => {
    const first = admitSessionEvent(initial, event(1));
    expect(first.accepted).toBe(true);
    if (!first.accepted) throw new Error("Expected acceptance");
    expect(admitSessionEvent(first.cursor, event(2)).accepted).toBe(true);
    expect(initial.sequence).toBe(0);
    expect(admitSessionEvent(first.cursor, event(1))).toEqual({
      accepted: false,
      reason: "duplicate",
    });
  });
  it("rejects callbacks from old AND unallocated future generations", () => {
    for (const generation of [1, 3]) {
      expect(admitSessionEvent(initial, event(1, generation))).toEqual({
        accepted: false,
        reason: "wrong-generation",
      });
    }
  });
  it("detects dropped events and cross-network routing", () => {
    expect(admitSessionEvent(initial, event(2))).toEqual({
      accepted: false,
      reason: "sequence-gap",
    });
    expect(
      admitSessionEvent(initial, { ...event(1), networkId: entityId<"network">("other") }),
    ).toEqual({ accepted: false, reason: "wrong-network" });
    expect(admitSessionEvent(initial, event(Number.NaN))).toEqual({
      accepted: false,
      reason: "sequence-gap",
    });
  });
  it("requires valid generation IDs", () => {
    expect(() => startSessionCursor({ networkId, generation: 0 })).toThrow();
  });
});
