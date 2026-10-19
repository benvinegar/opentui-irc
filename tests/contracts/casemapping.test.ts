import { describe, expect, it } from "vitest";
import { foldIdentifier } from "../../src/domain/irc-identifiers";

describe("IRC identifier equivalence", () => {
  it("folds only ASCII letters in ASCII mode", () => {
    expect(foldIdentifier("Nick[\\]^Ä", "ascii")).toBe("nick[\\]^Ä");
  });
  it("respects RFC1459 punctuation equivalence", () => {
    expect(foldIdentifier("Nick[\\]^", "rfc1459")).toBe("nick{|}~");
    expect(foldIdentifier("Nick[\\]^", "strict-rfc1459")).toBe("nick{|}^");
  });
  it("is idempotent", () => {
    const folded = foldIdentifier("Nick[\\]^", "rfc1459");
    expect(foldIdentifier(folded, "rfc1459")).toBe(folded);
  });
});
