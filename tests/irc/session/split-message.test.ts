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
test("long UTF-8 lines split without dropping characters or confusing LF with commands", () => {
  const first = "🐈日本語".repeat(300);
  const result = splitMessage({ ...options, text: `${first}\n/quit\nlast` });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.pieces.slice(0, -2).join("")).toBe(first);
  expect(result.value.pieces.slice(-2)).toEqual(["/quit", "last"]);
  for (const piece of result.value.pieces) {
    expect(piece).not.toContain("\n");
    expect(piece).not.toContain("�");
    expect(
      new TextEncoder().encode(`PRIVMSG #room :${piece}\r\n`).length + options.sourcePrefixBytes,
    ).toBeLessThanOrEqual(options.maxCommandBytes);
  }
});
test("leading, consecutive and trailing empty lines each produce one explicit blank message", () => {
  expect(splitMessage({ ...options, text: "\n\na\n\n" })).toEqual({
    ok: true,
    value: { pieces: [" ", " ", "a", " ", " "], emptyLines: 4 },
  });
  expect(splitMessage({ ...options, text: "\n" })).toEqual({
    ok: true,
    value: { pieces: [" ", " "], emptyLines: 2 },
  });
  expect(splitMessage({ ...options, text: "" }).ok).toBe(false);
});
test("whole-operation byte and fragment caps are checked without truncation", () => {
  expect(splitMessage({ ...options, text: "🐈🐈", maxBytes: 7 }).ok).toBe(false);
  expect(splitMessage({ ...options, text: "a\nb\nc", maxFragments: 2 }).ok).toBe(false);
  expect(splitMessage({ ...options, text: "a\nb", maxFragments: 2 })).toMatchObject({
    ok: true,
    value: { pieces: ["a", "b"] },
  });
  for (const text of ["hello\r\n/quit", "hello\0world"])
    expect(splitMessage({ ...options, text }).ok).toBe(false);
});
