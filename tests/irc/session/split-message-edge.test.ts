import { expect, test } from "vitest";
import { splitMessage } from "../../../src/irc/session/split-message";

const options = {
  target: "#room",
  kind: "text" as const,
  maxCommandBytes: 512,
  sourcePrefixBytes: 128,
  maxBytes: 131_072,
  maxFragments: 256,
};

test("a target that leaves room for fewer bytes than one character fails instead of splitting it", () => {
  const overhead = new TextEncoder().encode("PRIVMSG #room :\r\n").length;
  const tight = { ...options, sourcePrefixBytes: options.maxCommandBytes - overhead - 2 };
  expect(splitMessage({ ...tight, text: "ab" })).toMatchObject({ ok: true });
  expect(splitMessage({ ...tight, text: "🐈" })).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});

test("long text beyond the fragment limit fails rather than sending a truncated message", () => {
  const text = "x".repeat(1000);
  expect(splitMessage({ ...options, maxFragments: 2, text })).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
  const allowed = splitMessage({ ...options, maxFragments: 4, text });
  expect(allowed.ok && allowed.value.pieces.join("")).toBe(text);
});
